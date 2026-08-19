# Library guide

`simple-cursor-cli` is a standalone TypeScript library for invoking an
installed Cursor Agent headless CLI from a Node.js application. It owns the
typed process boundary and output normalization; authentication, permissions,
and the interactive terminal experience remain Cursor's responsibility.

This guide is for consumers of the package. The implementation and maintenance
contracts are described in [Code architecture](./code.md).

## At a glance

| Fact                 | Supported contract                                          |
| -------------------- | ----------------------------------------------------------- |
| Runtime              | Node.js 22 or newer                                         |
| Module formats       | ESM and CommonJS                                            |
| Type declarations    | Included in the package                                     |
| Runtime dependencies | None                                                        |
| Default executable   | `agent`                                                     |
| Authentication       | Managed by Cursor's normal CLI or environment configuration |
| Published files      | `dist`, `README.md`, and `LICENSE`                          |

## Prerequisites

Before using the library:

1. Install the Cursor Agent CLI and make the `agent` executable available on
   `PATH`. A custom executable can be selected explicitly in the client
   options.
2. Complete Cursor's normal authentication flow on the machine that will run
   the child process.
3. Use documented headless flags that match the installed Cursor CLI version.
   The library always passes `--print` and an explicit `--output-format`.

The library does not log in, log out, accept API keys as client options, or
manage worker credentials. See Cursor's [installation
documentation](https://cursor.com/docs/cli/installation) and
[headless CLI documentation](https://cursor.com/docs/cli/headless) for the
external prerequisite.

## Installation

Install the published package in an application:

```bash
npm install simple-cursor-cli
```

## Creating a client

The default client invokes the executable named `agent`:

```ts
import { CursorCliClient } from 'simple-cursor-cli';

const client = new CursorCliClient();
```

The constructor accepts a custom executable, default timeout, working
directory, environment overlay, or injectable runner:

```ts
const client = new CursorCliClient({
  executable: 'cursor-agent',
  timeoutMs: 120_000,
  cwd: '/projects/example',
});
```

`cursor-agent` is only used when configured explicitly. There is no implicit
fallback from `agent`, so a missing installation remains visible to the
caller.

## ESM and CommonJS

ESM applications can import the public client directly:

```ts
import { CursorCliClient } from 'simple-cursor-cli';

const client = new CursorCliClient();
const result = await client.run({
  prompt: 'Summarize the public API of this project.',
  model: 'sonnet',
});

if (result.ok) {
  console.log(result.data.text);
} else {
  console.error(result.error.category, result.error.message);
  process.exitCode = 1;
}
```

CommonJS applications use the same public API:

```js
const { CursorCliClient } = require('simple-cursor-cli');

async function main() {
  const client = new CursorCliClient();
  const result = await client.ask({
    prompt: 'Explain the error handling here.',
  });

  if (!result.ok) {
    throw new Error(result.error.category + ': ' + result.error.message);
  }
  console.log(result.data.text);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

## Headless operations

### `run()`

`run()` is the general aggregate operation. Its default output format is
`json`. Use `text` when only rendered text is needed and `stream-json` when
the complete event stream should be parsed after process completion.

```ts
const result = await client.run({
  prompt: 'Summarize the selected change.',
  outputFormat: 'json',
});
```

The operation supports Agent, Plan, and Ask modes, explicit model selection,
session continuation, workspace/worktree options, partial stream output,
timeouts, cancellation, and version-specific `extraArgs`. Known options are
validated and translated into a deterministic argument array.

### `plan()` and `ask()`

These convenience methods select their respective Cursor modes and do not
expose the write-approval shortcuts:

```ts
const plan = await client.plan({
  prompt: 'Create a migration plan for the authentication module.',
});

const answer = await client.ask({
  prompt: 'What does the selected function return?',
  model: { id: 'sonnet', variant: 'sonnet-thinking-high' },
});
```

The model object passes its exact `variant` value to Cursor. The library does
not invent model names or reasoning flags.

### `stream()`

`stream()` always requests `stream-json` and exposes normalized events through
an `AsyncIterable<CursorStreamEvent>`:

```ts
const controller = new AbortController();

for await (const event of client.stream({
  prompt: 'Review the current branch.',
  streamPartialOutput: true,
  signal: controller.signal,
  timeoutMs: 120_000,
})) {
  if (event.type === 'assistant' || event.type === 'result') {
    process.stdout.write(event.text);
  } else if (event.type === 'tool_call') {
    console.error('tool:', event.toolName, event.status);
  }
}
```

Known system, assistant, tool-call, and result events are normalized. Unknown
event types remain available through `raw` so consumers can tolerate a newer
Cursor event before this package is updated. Process failures, timeouts,
abort, non-zero exits, and malformed stream JSON raise `CursorCliError`.
Breaking out of the iterator cleans up the child process.

## Sessions, workspaces, and worktrees

Session continuation is expressed as structured input:

```ts
await client.run({
  prompt: 'Continue from the previous implementation.',
  resume: 'session-id-from-cursor',
});

await client.run({
  prompt: 'Continue the most recent session in this workspace.',
  continue: true,
  workspace: '/projects/example',
  worktree: 'cursor-review',
});
```

`resume` and `continue` are mutually exclusive. Prompts, paths, worktree
names, models, and additional arguments reject empty values and NUL
characters.

## Diagnostics and discovery

### Health

`health()` runs version detection and authentication status separately:

```ts
const health = await client.health();

if (health.ok) {
  console.log(health.data.cli.version);
  console.log(health.data.authentication.status);
  console.log(health.data.canRun);
} else {
  console.error(health.error.category, health.error.message);
}
```

An unavailable executable is returned as `cli_unavailable`. If the executable
is present but authentication fails, a successful health result reports
`unauthenticated` or `unknown` and includes a sanitized diagnostic.

### Models and MCP servers

```ts
const models = await client.listModels();
const servers = await client.listMcpServers();

if (models.ok) {
  for (const model of models.data) {
    console.log(model.id, model.name);
  }
}

if (servers.ok) {
  for (const server of servers.data) {
    console.log(server.name, server.status);
  }
}
```

These operations accept the documented JSON list shapes and common text list
output. Each summary preserves its original item in `raw`. Empty or
structurally unsupported output is reported as a categorized parse error
instead of silently becoming an empty list.

## Configuration and safety

The client and per-operation inputs expose these boundaries:

- `timeoutMs` controls the process timeout and must be a positive integer.
- `signal` cancels a running operation.
- `cwd` selects the child process working directory.
- `env` supplies an environment overlay only to the child process.
- `runner` allows tests or applications to inject a deterministic process
  implementation.
- `extraArgs` carries newer documented flags after the library's known flags.
- Credential-bearing flags such as `-a`, `--api-key`, `--auth-token`,
  `--token`, `--password`, and `--secret` are rejected, including assignment
  forms.

The runner passes an argument array to Node's child-process API with
`shell: false`. Shell metacharacters are data, not shell syntax. Diagnostics
are ANSI-cleaned, length-limited, and redacted for common token, bearer,
secret, password, and API-key patterns.

`force` and `yolo` are mutually exclusive write-approval shortcuts for
write-oriented Agent runs. They are not valid for `plan()` or `ask()`.
The library does not bypass Cursor permissions, install capabilities, or
authenticate on behalf of the caller.

## Results and errors

Aggregate methods return the discriminated union `CursorResult<T>`:

```ts
const result = await client.run({ prompt: 'test' });

if (result.ok) {
  console.log(result.data.text);
} else {
  switch (result.error.category) {
    case 'authentication':
    case 'cli_unavailable':
    case 'timeout':
    case 'parse':
      console.error('Actionable failure:', result.error.message);
      break;
  }
}
```

The categorized error space includes validation, executable unavailability,
authentication, permission, missing command, invalid model, timeout, abort,
non-zero CLI exit, parse, and unknown failures. `stderr` and messages are
sanitized before they are returned.

## Development and validation

The repository's offline validation path is:

```bash
npm run typecheck
npm test
npm run lint
npm run format:check
npm run build
npm run pack:check
```

These checks do not install Cursor, log in, or require credentials. The
separate local E2E suite is deliberately opt-in:

```bash
npm run test:e2e
```

The E2E suite uses the real `agent` executable by default, requires normal
Cursor authentication, performs read-only health/Ask/stream checks, and can
consume account quota. It is not part of `npm test` or GitHub Actions. Use
`CURSOR_E2E_EXECUTABLE`, `CURSOR_E2E_MODEL`, and
`CURSOR_E2E_TIMEOUT_MS` only for an intentionally started local run.

## Compatibility and scope

The package targets the documented headless Cursor CLI surface and passes
`--print` plus an explicit output format. Cursor flags and event schemas can
change; use `extraArgs` for newer documented flags and consult the installed
CLI documentation before relying on them.

This library slice does not implement the Cursor TUI, ACP/JSON-RPC sessions,
interactive terminal handoff, Shell Mode, plugin/skill/rule/MCP management,
hooks, sandbox policy, background tasks, subagents, image context, workers,
or Cloud Agent APIs.

For the repository's maintainer model and module responsibilities, see
[Code architecture](./code.md). The public API is re-exported from
`src/index.ts`.
