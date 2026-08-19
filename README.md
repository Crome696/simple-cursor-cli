# simple-cursor-cli

`simple-cursor-cli` is a standalone TypeScript library for invoking the
installed Cursor Agent CLI from Node.js applications. It focuses on a safe,
headless process boundary and exposes normalized results without taking
ownership of Cursor authentication, permissions, or the terminal UI.

The package has no runtime dependencies, targets Node.js 22 and newer, ships
ESM and CommonJS entry points, and includes TypeScript declarations.

## Prerequisites

1. Install the Cursor Agent CLI and make the `agent` executable available on
   `PATH`. A custom executable can be selected explicitly with
   `new CursorCliClient({ executable: 'cursor-agent' })` or an absolute path.
2. Complete authentication using Cursor's normal CLI or environment
   configuration for the machine that runs the process.
3. Use a Cursor CLI version whose documented headless options match the
   options you select. The library always passes `--print` and an explicit
   `--output-format` so that application code does not depend on an installed
   CLI default.

See Cursor's current documentation for [installation](https://cursor.com/docs/cli/installation),
[headless usage](https://cursor.com/docs/cli/headless), and
[general CLI usage](https://cursor.com/docs/cli/using).

The library never manages login, logout, API keys, tokens, or worker
credentials. Credential-bearing arguments such as `-a`, `--api-key`, and
`--auth-token` are rejected, including assignment forms. Environment values
are passed only to the child process and are not included in results or error
diagnostics.

## Installation

```bash
npm install simple-cursor-cli
```

## ESM

```ts
import { CursorCliClient } from 'simple-cursor-cli';

const client = new CursorCliClient();
const result = await client.run({
  prompt: 'Summarize the public API of this project.',
  model: 'sonnet',
});

if (!result.ok) {
  console.error(result.error.category, result.error.message);
  process.exitCode = 1;
} else {
  console.log(result.data.text);
}
```

The default executable is exactly `agent`. There is no implicit fallback to
`cursor-agent`, because silently selecting a different installation can hide a
deployment error.

## CommonJS

The same package can be loaded from a CommonJS project:

```js
const { CursorCliClient } = require('simple-cursor-cli');

async function main() {
  const client = new CursorCliClient();
  const result = await client.ask({ prompt: 'Explain the error handling here.' });

  if (!result.ok) {
    throw new Error(`${result.error.category}: ${result.error.message}`);
  }
  console.log(result.data.text);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

## Headless operations

### `run`

`run()` is the general aggregate operation. The default output mode is
`json`; select `text` when only the rendered response is needed or
`stream-json` when the complete event stream should be parsed after process
completion.

```ts
const result = await client.run({
  prompt: 'Implement the requested change and summarize the result.',
  mode: 'agent',
  outputFormat: 'json',
  force: true,
});
```

`force` and `yolo` are approval shortcuts for write-oriented execution. They
are mutually exclusive and are not accepted by `plan()` or `ask()`.

### `plan` and `ask`

These convenience methods select their respective modes and do not expose
write approval flags:

```ts
const plan = await client.plan({
  prompt: 'Create a migration plan for the authentication module.',
});

const answer = await client.ask({
  prompt: 'What does the selected function return?',
  model: { id: 'sonnet', variant: 'sonnet-thinking-high' },
});
```

The object model form passes `variant` as the exact full model value accepted
by the installed CLI. The library does not invent model names or add an
undocumented reasoning flag; use a raw string when a newer CLI introduces a
model value that this package does not know about.

### Streaming

`stream()` always requests `stream-json` and yields normalized events as they
arrive. Unknown event types remain available through `raw`, so a newer Cursor
CLI can be adopted before a new library release is published.

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
    console.error(`tool: ${event.toolName ?? 'unknown'} (${event.status ?? 'update'})`);
  } else if (event.type !== 'system') {
    console.error('new Cursor event:', event.type, event.raw);
  }
}
```

The async iterator raises `CursorCliError` for process failures, timeouts,
abort, non-zero exits, or malformed stream JSON. Breaking out of iteration
causes the child process to be cleaned up.

### Sessions, workspaces, and worktrees

Cursor session continuation is passed as structured options:

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

`resume` and `continue` cannot be combined. Paths, worktree names, prompts,
models, and extra arguments are checked for empty values and NUL characters.
Arguments are passed to `node:child_process.spawn` as an array with
`shell: false`; shell metacharacters are therefore data, not executable shell
syntax.

## Diagnostics

### Health

`health()` separates executable/version detection from authentication:

```ts
const health = await client.health();

if (health.ok) {
  console.log(health.data.cli.version);
  console.log(health.data.authentication.status);
  // `canRun` is true only when the status command succeeded.
} else {
  console.error(health.error.category, health.error.message);
}
```

An unavailable executable is returned as `cli_unavailable`. An installed CLI
with a failed login check returns a successful health result with
`authentication.status` set to `unauthenticated` or `unknown`, allowing a
deployment diagnostic to distinguish those cases.

### Models and MCP servers

```ts
const models = await client.listModels();
const mcpServers = await client.listMcpServers();

if (models.ok) {
  for (const model of models.data) console.log(model.id, model.name);
}
if (mcpServers.ok) {
  for (const server of mcpServers.data) {
    console.log(server.name, server.status);
  }
}
```

Both operations return stable summaries and preserve the original item in
`raw`. The parser accepts documented JSON responses as well as common text
list output, but an empty or structurally unsupported response is reported as
a categorized `parse` error instead of being silently converted to an empty
list.

## Capabilities and version-specific flags

The optional `capabilities` object is metadata for an explicit context hint in
the prompt. It does not install or enable a skill, plugin, MCP server, rule,
subagent, or file, and it does not bypass Cursor permissions:

```ts
await client.run({
  prompt: 'Review the selected files.',
  capabilities: {
    rules: ['review.mdc'],
    files: ['src/index.ts', 'src/client.ts'],
    mcpServers: ['filesystem'],
  },
});
```

Newer documented flags can be supplied through `extraArgs`:

```ts
await client.run({
  prompt: 'Use the current CLI feature.',
  extraArgs: ['--documented-new-flag', 'value'],
});
```

Known options should be preferred because the builder validates their
combinations and keeps argument ordering deterministic. Credential-related
flags are rejected even when supplied through `extraArgs`.

## Errors and process control

Aggregate operations return a discriminated `CursorResult<T>`:

```ts
const result = await client.run({ prompt: 'test' });
if (!result.ok) {
  switch (result.error.category) {
    case 'authentication':
    case 'cli_unavailable':
    case 'timeout':
    case 'parse':
      // Route to an actionable deployment or retry diagnostic.
      break;
  }
}
```

Possible categories include validation, executable unavailability,
authentication, permission, invalid model, timeout, abort, non-zero CLI exit,
parse, and unknown failures. Diagnostics are ANSI-cleaned, length-limited,
and redacted for common API-key, token, bearer, secret, and password forms.

`cwd`, `env`, `timeoutMs`, and `AbortSignal` can be set per operation or in the
client constructor. Environment overlays are never copied into result objects
or error messages.

## Public API

The package root exports:

- `CursorCliClient` and `CursorCommandRunner`
- `CursorCommandRunnerLike` and all process/input/output/event/error types
- `buildCursorCliArgs`
- `parseCursorOutput`, `parseCursorStreamEvent`, `parseCursorVersion`,
  `parseCursorModels`, and `parseCursorMcpServers`
- capability, model-formatting, validation, and diagnostic helpers

The lower-level runner is injectable, which makes applications and tests
independent from a live Cursor installation:

```ts
const client = new CursorCliClient({
  runner: {
    async execute(args) {
      // Return a fixture in tests; production uses the default runner.
      return {
        exitCode: 0,
        stdout: '{"type":"result","result":"ok"}',
        stderr: '',
        durationMs: 1,
      };
    },
  },
});
```

## Development and validation

```bash
npm run typecheck
npm test
npm run lint
npm run format:check
npm run build
npm run pack:check
```

The commands above are the offline validation path. They do not install or
authenticate Cursor and are the checks executed by GitHub Actions. The CI
workflow intentionally does not run the real Cursor CLI or require Cursor
credentials.

### Local Cursor CLI E2E tests

The repository also contains a separate E2E suite that is not included in
`npm test`. It invokes the real `agent` executable through `CursorCliClient`,
checks the installed CLI and authentication status, performs a read-only Ask
request with JSON output, and verifies a streaming request ends with a
normalized `result` event.

The suite makes real Cursor requests and may consume account quota. Complete
Cursor's normal authentication flow first; the library does not perform login
or accept credentials as E2E arguments. The test prompts explicitly request no
file writes or shell commands, and the tests never pass `force` or `yolo`.

Run the E2E suite directly when you intentionally want to make the real local
CLI requests:

```bash
npm run test:e2e
```

In PowerShell:

```powershell
npm run test:e2e
```

The default executable is `agent`. On Windows, the runner resolves Cursor's
standard `agent.cmd`/`agent.ps1` shim without enabling general shell execution.
The E2E request includes Cursor's `--trust` workspace acknowledgement, but no
write-enabling flag such as `--force` or `--yolo`.
Use `CURSOR_E2E_EXECUTABLE` when a custom executable or absolute path is
required. `CURSOR_E2E_MODEL` selects a specific model, and
`CURSOR_E2E_TIMEOUT_MS` overrides the 120-second per-request timeout. These
variables affect only a deliberately started local E2E run.

The final acceptance test of the local Cursor installation and account is
intentionally left to the library user; a live E2E run is not claimed as part
of CI validation.

## Scope and future slices

This first package slice is the reusable headless execution core. It does not
rebuild Cursor's TUI or slash-command interface and does not implement ACP,
interactive terminal handoff, Shell Mode, plugin/skill/rule/MCP management,
hooks, sandbox policies, background tasks, subagents, image context, workers,
or Cloud Agent APIs.

Those capabilities should be added only as separate slices after checking the
current `agent --help`, the official documentation, and the
[Cursor CLI changelog](https://cursor.com/docs/cli/changelog). The ACP protocol
is documented separately at
[Cursor ACP](https://cursor.com/docs/cli/acp), and Shell Mode has its own
[security and timeout behavior](https://cursor.com/docs/cli/shell-mode).
