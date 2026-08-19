# Code architecture

This document describes the implementation contracts for maintainers of
`simple-cursor-cli`. It intentionally describes the code that exists in the
repository; it is not a design proposal for future Cursor features.

## Package boundary

The package has one public entry point, `src/index.ts`. It re-exports the
client, process runner, parsers, validation helpers, diagnostic helpers, error
types, and the public input/output/event types. The build entry in
`tsup.config.ts` produces ESM, CommonJS, and declaration outputs in `dist`.

The published package currently contains `dist`, `README.md`, and `LICENSE`.
The repository-level `docs` directory is documentation for the source
repository and is intentionally not added to the package `files` list.

## Module map

| Module                             | Responsibility                                                                    | Boundary               |
| ---------------------------------- | --------------------------------------------------------------------------------- | ---------------------- |
| `src/index.ts`                     | Stable package exports                                                            | Public API             |
| `src/lib/cursor/client.ts`         | Coordinates validation, argument building, execution, parsing, and result shaping | Public client          |
| `src/lib/cursor/command-runner.ts` | Starts the external process and emits stdout, stderr, and close events            | Process boundary       |
| `src/lib/cursor/parsers.ts`        | Converts text, JSON, and stream-JSON output into typed results/events             | Cursor output boundary |
| `src/lib/cursor/validation.ts`     | Validates input values, option combinations, and credential flags                 | Safety boundary        |
| `src/lib/cursor/errors.ts`         | Creates categorized results/errors and sanitizes diagnostics                      | Error boundary         |
| `src/lib/cursor/types.ts`          | Defines inputs, results, events, diagnostics, and runner contracts                | Type contract          |

## Request and response flow

An aggregate operation follows this sequence:

1. `CursorCliClient` validates constructor options and operation input.
2. `buildCursorCliArgs()` translates the validated input into a deterministic
   array beginning with `--print` and an explicit output format.
3. `CursorCommandRunner` starts the configured executable with
   `node:child_process.spawn` and `shell: false`.
4. The runner collects stdout/stderr and the exit event for aggregate calls, or
   exposes process events for incremental streaming.
5. `parsers.ts` normalizes text, JSON, stream-JSON, version, model, and MCP
   output. Unknown stream events preserve their original `raw` value.
6. `client.ts` returns a discriminated `CursorResult<T>` for aggregate calls
   or yields `CursorStreamEvent` values for streaming.
7. `errors.ts` classifies non-zero exits and runner failures, sanitizes
   diagnostics, and maps process failures to stable error categories.

`health()` is a deliberate two-command diagnostic: it first detects the CLI
version, then checks the Cursor authentication status. Model and MCP discovery
use their dedicated list commands and the same parser/error boundaries.

## Process lifecycle and safety

`CursorCommandRunner` owns the child-process lifecycle. It supports:

- deterministic executable and argument separation;
- the standard Windows `agent.cmd`/`agent.ps1` wrapper without enabling general
  shell interpolation;
- stdout and stderr collection;
- timeouts;
- `AbortSignal` cancellation;
- an async event queue for incremental output;
- cleanup when a consumer stops iterating;
- categorized failures for unavailable executables, timeouts, aborts, and spawn
  errors.

The runner receives environment and working-directory values from the client
but does not turn them into result data. Credential-bearing arguments are
rejected in validation before the process is started. `sanitizeDiagnostic()`
removes ANSI control sequences, redacts common credential formats, collapses
whitespace, and limits the resulting diagnostic length.

## Parsing contract

`parseCursorOutput()` handles the three public output formats:

- `text` returns trimmed text with no parsed events;
- `json` accepts a JSON result, one event, or an array of events;
- `stream-json` parses one JSON event per non-empty line.

`parseCursorStreamEvent()` canonicalizes known event names into system,
assistant, tool-call, and result events. It retains unknown event types and
their raw values for forward compatibility. Result aggregation carries session,
request, model, duration, API duration, output format, normalized events, and
the original raw value.

The model and MCP parsers accept documented JSON list structures and common
line-oriented output. They fail with a parse result when the output is empty or
contains no usable entries.

## Validation and errors

`validateCursorRunInput()` checks required text, model selections, modes,
output formats, approval combinations, session options, paths, timeouts,
stream settings, and extra arguments. It rejects credential flags whether they
are supplied as separate values or assignment forms.

`CursorResult<T>` keeps expected operation failures in data:

```ts
type CursorResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: CursorError };
```

Streaming has a different consumer contract: it yields events and raises
`CursorCliError` for process, timeout, abort, exit-code, or parse failures.
Keep this distinction when adding a new convenience method.

## Extension points

Applications and tests can inject a `CursorCommandRunnerLike`. The interface
requires aggregate `execute()` support and permits an incremental `stream()`
implementation. This lets offline tests provide deterministic stdout/stderr
fixtures without installing or authenticating Cursor.

New Cursor options should be added as typed input only when their semantics are
documented and stable enough to validate. Version-specific documented flags can
remain available through `extraArgs`, but credential-related flags must remain
blocked. New output event types should preserve their raw representation until
their normalized contract is intentionally defined.

## Tests and packaging

The unit and parser tests live beside the implementation in
`src/lib/cursor/*.spec.ts`. They cover argument construction, validation,
process lifecycle, parsers, errors, streaming, and packaging-facing behavior
without a live Cursor installation.

The local suite in `tests/e2e/cursor-cli.e2e.spec.ts` is intentionally separate
from `npm test`. It invokes the real `agent` executable with authenticated,
read-only requests and is never part of GitHub Actions.

The supported offline checks are:

```bash
npm run typecheck
npm test
npm run lint
npm run format:check
npm run pack:check
```

`tsup` builds ESM, CommonJS, declarations, and source maps. Changes to public
types or comments must continue to compile under the strict TypeScript
configuration and preserve both package export paths.

## Maintainer checklist

When changing this library:

- update the public TSDoc and both documentation guides when behavior or
  contracts change;
- keep README examples aligned with the exported symbols and package scripts;
- preserve shell-free argument passing and credential rejection;
- add offline fixtures before relying on a new Cursor output shape;
- keep live E2E explicit, read-only, and outside CI;
- run the complete offline validation path before publishing a branch.
