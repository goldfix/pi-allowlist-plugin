# AGENTS.md — Instructions for AI Agents (Pi-Agent)

## 1. Project goal

Build a **Pi extension** (`allowlist-gate`, package `pi-allowlist-plugin`) that enforces an
**applicative** gate over dispositive tool calls — file modifications and active interactions
with external services (shell commands, MCP calls, …). Unlisted operations ask the user for
approval through a **UI dialog** (`ctx.ui.select`). Enforcement is applicative (the `tool_call`
handler blocks the call), never delegated to the model.

Port the feature set of the sibling OpenCode plugin kept under `source_app/opencode-allowlist-plugin/`
(read-only reference — never modify it), adapted to Pi's extension model (see §4 for the mapping).

## 2. Stack and technical constraints

- **Language: TypeScript (strict), no build step.** Pi loads `.ts` extensions directly via `jiti`;
  tests run under plain Node type-stripping (`node --test`). Therefore:
  - Use **erasable syntax only** (no enums, no parameter properties, `import type` for types).
  - Relative imports use **explicit `.ts` extensions** (`./policy.ts`).
  - `tsconfig.json`: `allowImportingTsExtensions: true` + `noEmit: true`.
- **Node `>=22.19`** (`engines`). Type-stripping and `node --test` on `.ts` files rely on it.
- **npm**. Host packages (`@earendil-works/pi-coding-agent`) go in `peerDependencies: "*"`
  (never in `dependencies` — a physical copy would bypass Pi's extension module mapping);
  repeat them in `devDependencies` (pinned) for `tsc` + tests, plus `typescript` itself.
- Tests with Node's native runner on **explicit `.ts` file lists** (`node --test test/….test.ts`,
  the list lives in the `test` script of `package.json` — add new test files there),
  zero external test frameworks. Cover important/critical behavior without over-testing.
- For Pi API doubts, consult the local Pi installation docs (`docs/*.md`, `examples/extensions/`;
  exact machine path is recorded in `MEMORY.md`) and the `docs-mcp-server` MCP tooling. The
  authoritative typings are `dist/core/extensions/types.d.ts` of the `pi-coding-agent` package.

## 3. Project structure

```
extensions/
  allowlist-gate/
    index.ts    → extension entry (default factory): `tool_call` + `session_start` handlers,
                  `/allowlist` command, dialog
    policy.ts   → pure allowlist/denylist matching, `splitCommands()` (no external dependencies)
    paths.ts    → pure path normalization + inside/outside-project classification
    config.ts   → configuration resolution (JSON files), status report, fail-safe loading
test/
  policy.test.ts  → pure matching: wildcards, splitCommands (bypass regressions, posix/powershell),
                    shell/edit/MCP/generic, deny-wins, forceAsk, passthrough
  paths.test.ts   → `~`/`@`/`../`/absolute normalization, inside vs outside the project
  config.test.ts  → file resolution, global+project merge, trust, fail-safe on invalid files
  gate.test.ts    → handler wiring with fake Pi API/UI: allow/ask/deny, session approvals,
                    serialized dialogs, outside-project, redirections, MCP, trust, disabled gate
```

`source_app/` is **read-only reference material** (the OpenCode sibling plugin): never modify it.
`README.md` is the user-facing documentation (install, rules, config, limitations, contributing):
keep it in sync with every behavior change. The OpenCode-era `scripts/install.*` were removed
(`pi install <path>` / `pi -e` cover local installs).

## 4. Architecture

Main handler: `pi.on("tool_call", …)`. It derives `(toolName, resources)` from the typed
`ToolCallEvent` (`targetOf()` in `index.ts`), runs `evaluate()`, and maps the decision:

- allowlist match → return `undefined` (passes silently)
- denylist match → `{ block: true, reason }` (no dialog; the model receives the reason)
- anything else gated → `ctx.ui.select("Allow once" | "Allow for session" | "Deny")`;
  dismissal counts as deny. Without UI (`!ctx.hasUI`: print/JSON mode) gated calls are
  **blocked fail-safe**.
- safe read-only tools → untouched (`undefined`, no dialog).

A second handler, `session_start`, clears the in-memory session approvals.

The extension also registers a slash command `pi.registerCommand("allowlist", …)` that displays a
live status report: enabled state, project trust status, global and project configuration file paths
(flagging untrusted project files as ignored), effective deny and allow rules, active session approvals,
and any syntax or permission warnings.

Rule syntax is `scope:pattern` with OpenCode-like wildcards (`*`, `?`):

- `shell:<pattern>` — covers **both** `bash` and `powershell` (Pi has no single shell action).
  The entry splits `input.command` with `splitCommands(command, shellKind)`: allow requires
  **EVERY** segment to match, deny triggers on **ANY** match. The splitter is a small recursive
  scanner: separators `&&` `||` `;` `|` `&`, newlines and parentheses; `$(…)` and (posix only)
  backticks are scanned recursively, **also inside double quotes**, so inner commands become
  segments of their own while the outer segment keeps the raw text; quotes and the dialect's
  escape char (`\` for posix, backtick for PowerShell) are honored.
  **Invariant: the splitter may only err towards splitting more** — an under-split command can
  slip past an allowlist or evade a deny rule. Add a regression test for every bypass found.
  Wrappers (`bash -c`, `sudo`, `env`, `xargs`, `eval`) are deliberately not unwrapped
  (documented limitation).
- `edit:<pattern>` — covers **both** `edit` and `write` (shared scope, OpenCode parity).
  The resource comes from `classifyPath()`, which mirrors Pi's own path normalization
  (`@` prefix, `~`, `file://`, Git-Bash `/c/…`): project-relative with `/` separators when inside
  the project, absolute with `/` separators when outside.
- `mcp:<server>` — per-server on Pi tool names `mcp__<server>__<tool>`; dashes/underscores
  normalized, wildcards allowed. Resources ignored (server match is whole-tool).
- any other scope → exact tool name (generic fallback for extension tools): `*`/bare rules
  cover the whole tool, anything unlisted asks. Pattern rules never match (no resources derived).
- A rule without `:` means whole-action (e.g. `bash`).

Precedence: **deny wins over allow, allow wins over ask.**

Outside-project `edit`/`write` targets always ask, no matter the allowlist — only the denylist can
hard-block them (`evaluate(..., { forceAsk: true })`; deny is checked first). Same for shell
commands containing a redirection (`>`): they can write files, so they always ask (deliberately
coarse, quoted `>` included). Known gaps (documented for users): absolute outside paths *inside*
an in-project shell command, and symlinks pointing outside, are not detectable.

Read-only passthrough (`SAFE_PASSTHROUGH`): `read grep find ls question codemode tool_search` plus
the MCP resource tools. `codemode` is safe to skip because its sandbox has no fs/network and every
tool a script calls re-enters `tool_call` (nested calls carry `parentToolCallId`). A deny rule still
beats passthrough. **Scope decision (user):** the gate targets dispositive operations and calls to
external services (side effects / costs). Reads are out of scope, including reads outside the
project — a deliberate divergence from OpenCode, whose `external_directory` also asked for reads.
Do not add read gating unless the user asks.

Session approvals (`sessionAllowed`, created **inside the factory**, cleared on `session_start`)
live **only in memory** and match exact `(toolName, resources)` calls. The allowlist file is the
only persistence mechanism — tell users to add stable rules there. Dialogs are **serialized**
through a promise queue (Pi runs parallel tool calls; the session set is re-checked inside the
queue so an identical sibling call reuses the approval just granted) and receive `ctx.signal`
so an abort dismisses them.

Configuration (no `ctx.options` in Pi — follow the `sandbox` example pattern): JSON files
`allowlist-gate.json`, global (`<agent-dir>/extensions/`) merged with project
(`<cwd>/.pi/`, i.e. host `CONFIG_DIR_NAME`), **project lists replace wholesale**.
An explicit `"allow": []` disables the defaults.
Config is re-read on every `tool_call` (live edits, no reload). The global file is
**auto-created with the defaults** on first use (`ensureGlobalConfigFile()`, atomic `wx` creation).
**Security rules:** the project file is honored only when `ctx.isProjectTrusted()` (an untrusted
repo must not widen its own allowlist); an invalid file fails safe as `{ "allow": [] }` plus a
warning (`config.warnings`, shown once via `ctx.ui.notify`), never as the defaults.
`wildcardMatch` is case-insensitive on Windows (core parity).

## 5. Packaging (npm / Pi package)

Conventional Pi package layout: extension code under `extensions/allowlist-gate/` with an
`index.ts` entry needs **no manifest** — Pi discovers it. `package.json` publishes only
`extensions` (+ README/LICENSE, always included); `files: ["extensions"]`, keyword
`pi-package` for gallery eligibility. `prepublishOnly` runs `npm run check`. Verify the tarball
with `npm pack --dry-run`. Install paths (README Installation section): `pi install`
from npm, git, or a local checkout, `pi -e` to try without installing, manual copy as
fallback. The extension needs **no build step** (`.ts` loaded directly) and has no runtime
dependencies. `repository`/`homepage`/`bugs` point at `github.com/goldfix/pi-allowlist-plugin`.
Publishing, GitHub releases, and version bumps are the user's commands.

## 6. Operating rules

- **Stay inside this folder.** Never edit files outside it (no `~/.pi` writes, no `pi` binary
  runs, no server restarts). If something outside is needed, stop and describe the exact steps
  for the user instead.
- **Never perform operations against external accounts/services** (npm publish/login, git remote
  push/tag, or similar). Preparing and verifying up to that point (tests, typecheck, diffs,
  `npm pack --dry-run`) is fine; the final authenticated/external command is the user's.
- **Clean, lean, well-documented code**: comments in English, only where behavior isn't obvious
  (matching semantics, Pi naming quirks). Keep pure, testable logic (`policy.ts`, `paths.ts`,
  `config.ts`) separate from the extension entrypoint (`index.ts`).
- Verify through execution: run `npm run check` (typecheck + tests) after every implementation change.
  In this environment `node`/`npm` are not on the shell `PATH`: prepend Pi's bundled Node
  (`export PATH="/c/tc/Program/pi_agent/node:$PATH"`).
- On doubt: stop, document what is unclear, and ask. Consult `source_app/` and Pi docs before guessing.

## 7. Documentation languages

- `README.md` and `AGENTS.md` in **English**.
- `MEMORY.md` in **Italian** (working log; also useful if the session gets compacted).
