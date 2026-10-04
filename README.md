# pi-allowlist-plugin

---

Support me – buy me a coffee! :)
[PayPal](https://www.paypal.com/donate/?hosted_button_id=F34KU49T4UQGL)

---

A [Pi](https://pi.dev) extension that puts **dispositive tool calls under applicative control**:
file modifications, shell commands and MCP calls only run if they are on your **allowlist** —
anything else asks you for approval in a dialog. Enforcement lives in the extension's
`tool_call` handler, so the model cannot talk its way past it.

It is the Pi port of the OpenCode plugin `opencode-allowlist-plugin`, adapted to Pi's extension model.

| Situation | What happens |
|---|---|
| Call matches the **allowlist** | Runs silently |
| Call matches the **denylist** | Blocked, no dialog; the model receives the reason |
| Anything else that can change things | A dialog asks: **Allow once** · **Allow for session** · **Deny** |
| Read-only tools (`read`, `grep`, `find`, `ls`, MCP resource tools, …) | Never touched |
| No UI available (print/JSON mode) | Gated calls are **blocked** (fail-safe) |

Precedence: **deny wins over allow, allow wins over ask.** Dismissing the dialog counts as *Deny*.

## Requirements

- [Pi](https://pi.dev) (`@earendil-works/pi-coding-agent`)
- Node.js `>= 22.19` (already required by Pi)

## Installation

Pi installs this repository as a **Pi package** — no build step, the `.ts` sources load
directly. Pick one source. Pi packages run with your permissions, so review the source of
anything you install.

### From npm

```bash
pi install npm:pi-allowlist-plugin              # personal (~/.pi/agent/settings.json)
pi install -l npm:pi-allowlist-plugin           # project-only (.pi/settings.json)
```

Pin a version with `npm:pi-allowlist-plugin@0.1.0`.

### From GitHub

```bash
pi install git:github.com/goldfix/pi-allowlist-plugin
pi install git:github.com/goldfix/pi-allowlist-plugin@main
```

Tags and commits are pinned: later
`pi update <source>` reconciles the checkout but does not move the configured ref.
A plain URL (`https://github.com/goldfix/pi-allowlist-plugin`) works the same way.

### From a local checkout

```bash
git clone https://github.com/goldfix/pi-allowlist-plugin.git
pi install ./pi-allowlist-plugin
```

Local packages are loaded from the resolved path without copying, so the install
follows your checkout (update with `git pull`, then `/reload` in Pi).

### Try without installing

```bash
pi -e npm:pi-allowlist-plugin
pi -e ./pi-allowlist-plugin
pi -e /path/to/pi-allowlist-plugin/extensions/allowlist-gate
```

### Manual copy (fallback)

```bash
cp -r /path/to/pi-allowlist-plugin/extensions/allowlist-gate ~/.pi/agent/extensions/allowlist-gate
```

On Windows (PowerShell):

```powershell
Copy-Item -Recurse pi-allowlist-plugin\extensions\allowlist-gate $env:USERPROFILE\.pi\agent\extensions\
```

If you set `PI_CODING_AGENT_DIR`, use `<that dir>/extensions/` instead of `~/.pi/agent/extensions/`.
After a manual copy run `/reload` inside Pi (or restart it).

### Managing the install

```bash
pi list                  # show configured packages
pi remove <source>      # remove a package and its settings entry
pi update --extensions   # reconcile installed packages
pi update <source>      # update one package
```

Personal installs are written to `~/.pi/agent/settings.json`; `-l` / `--local` writes to
`.pi/settings.json` of the current project. Project packages load only after
[project trust](https://pi.dev/docs/security#understand-project-trust) is granted —
review project package declarations before trusting a folder.

> Avoid loading the extension twice (for example a package *and* a manual copy in
> `extensions/`): each copy would gate every call and ask twice.

## Rule syntax

Rules are strings of the form `scope:pattern`. Patterns use the wildcards `*` (anything) and
`?` (one character). A trailing ` *` also matches the bare command (`shell:git pull *` matches
`git pull` and `git pull origin main`). On Windows matching is case-insensitive.

| Rule | Covers | Matched against |
|---|---|---|
| `shell:<pattern>` | `bash` **and** `powershell` | each sub-command of the command line |
| `edit:<pattern>` | `edit` **and** `write` | the target file path |
| `mcp:<server>` | every tool of one MCP server (`mcp__<server>__<tool>`) | the server name; wildcards allowed |
| `<tool>` or `<tool>:*` | a whole tool, by exact name (extension tools, …) | — |

A rule without `:` means the whole tool. Examples: `shell:git pull *`, `edit:docs/*`,
`mcp:docs-*`, `write`.

### Shell commands

The command line is split into sub-commands at `&&`, `||`, `;`, `|`, `&`, newlines and
parentheses. Commands inside `$(…)` and backticks are extracted too, including inside double
quotes. Quotes and the shell's escape character are respected. Then:

- **allow** requires **every** sub-command to match an allow rule
  (`git status && git push` is not covered by `shell:git status *`);
- **deny** triggers when **any** sub-command matches a deny rule.

**Redirections always ask.** Any `>` in a command (`>`, `>>`, `2>`, `&>`, …) can write a file,
so it asks even if the command is allowlisted (`shell:echo *` passes `echo x` but `echo x > f`
asks). The check is deliberately coarse: a `>` inside quotes or `2>&1` also asks. Only the
denylist can hard-block such a command.

### File edits

`edit:<pattern>` is matched against the path **relative to the project** (`/` separators),
whatever spelling the model used (`./docs/a.md`, an absolute path inside the project, `@docs/a.md`
all become `docs/a.md`). Note `*` also matches `/`, and patterns are anchored at the start:
`edit:.env*` covers `.env` but not `sub/.env` — use `edit:*.env*` for that.

**Targets outside the project always ask**, no matter the allowlist (`../x`, absolute paths,
`~/…`). Only the denylist can hard-block them; write such patterns as absolute paths with
forward slashes (`edit:C:/Users/me/.ssh/*`).

### MCP servers

Rules are per server, never per tool: `mcp:docs-mcp-server` allows every tool of that server.
Dashes and underscores are interchangeable (Pi exposes `mcp__docs_mcp_server__fetch_url`).
Servers not listed ask.

### Other tools

Any tool not covered above (extension tools, …) asks unless a whole-tool rule allows it.
Pattern rules for such tools (`my-tool:foo*`) never match, because the gate derives no resources
from their input. `codemode` and `tool_search` pass through: scripts run in a sandbox and every
tool a script calls goes through the gate individually.

## Configuration

Two JSON files with the same shape, both optional. Project values override global ones **key by
key, and lists replace wholesale** (a project `allow` must repeat everything you want).

The global file is **created automatically with the built-in defaults the first time the
gate runs**, so the user finds it ready to edit.

| File | Scope |
|---|---|
| `<agent-dir>/extensions/allowlist-gate.json` (`~/.pi/agent/extensions/…`) | global (auto-created) |
| `<project>/.pi/allowlist-gate.json` | project — read **only if the project is trusted** |

```jsonc
{
  "enabled": true,
  "allow": [
    "shell:git pull *",
    "shell:git status *",
    "shell:npm test *",
    "edit:docs/*",
    "mcp:docs-mcp-server"
  ],
  "deny": [
    "shell:rm -rf *",
    "shell:npm publish *",
    "edit:.env*"
  ]
}
```

The files are re-read on every tool call, so edits apply immediately (no `/reload`).

**Defaults** (used for any list the files do not define): allow
`git status/diff/log`, `ls`, `cat`, `pwd`, `echo`, `wc`, `grep`, `tail` and
`mcp:docs-mcp-server`; deny nothing.
An explicit `"allow": []` disables the default allowlist.

**Fail-safe loading.** An invalid file never widens access: it is treated as `{"allow": []}`
(nothing is auto-allowed, everything gated asks) and a warning is shown once. A project file in
an untrusted project is ignored, with a warning — otherwise a cloned repository could allow
itself everything.

### "Allow for session"

Session approvals exist **only in memory**: they match the exact same call (tool + target) and
are dropped on every new/resumed/forked session and on reload. To make something permanent, add
a rule to the allowlist file.

## Known limitations

The gate is a guard rail against mistakes and careless prompts, **not a sandbox**.

- The analysis is static and textual. Wrappers that hide the real command are not unwrapped:
  `bash -c "rm -rf x"`, `sudo …`, `env …`, `xargs …`, `eval`, script blocks (`{ … }`), aliases.
  An allow rule like `shell:bash *` or `shell:sudo *` defeats the gate — don't write them.
- Absolute paths *outside* the project inside an in-project shell command are not detected
  (only the command text is available); rely on allow/deny rules for those.
- Symbolic links inside the project that point outside are not resolved.
- Scope: the gate protects against *dispositive* operations (file changes, shell commands) and
  calls to *external services* (MCP, extension tools) that may have side effects or costs. Reading
  is out of scope by design: `read`, `grep`, `find` and `ls` are never gated, including reads
  outside the project. Use a `deny` rule (e.g. `read`) if you need to block them.
- For stronger isolation combine it with an OS-level sandbox (see Pi's `sandbox` example).

## Development

```bash
npm install
npm run check        # typecheck (tsc) + tests (node --test)
```

TypeScript is loaded as-is by Pi (via `jiti`) and by Node's type-stripping in the tests: there is
no build step. That requires *erasable syntax only* (no `enum`, no constructor parameter
properties, `import type` for types) and relative imports with explicit `.ts` extensions.

```
extensions/allowlist-gate/
  index.ts    extension entry: the tool_call / session_start handlers, approval dialog
  policy.ts   pure matching: rules, wildcards, splitCommands(), evaluate()
  paths.ts    pure path normalization and inside/outside-project classification
  config.ts   JSON file configuration: defaults, global+project merge, fail-safe loading
test/         node --test suites (policy, paths, config, gate wiring with a fake Pi API)
```

## Contributing & extending

Issues and pull requests are welcome. Please run `npm run check` before submitting and keep
changes focused, commented in English where behavior is not obvious, and covered by tests.

Common extension points:

- **A new rule scope** (e.g. `web:<url>` for a fetch tool): add the tool to the derivation in
  `targetOf()` (`index.ts`) so it produces resources, then map the scope to the tool names in
  `applicability()` (`policy.ts`).
- **A new read-only tool**: add its name to `SAFE_PASSTHROUGH` (`policy.ts`). A `deny` rule
  still overrides it.
- **A new configuration key**: extend `FileConfig`/`resolveConfig()` (`config.ts`) and keep
  the invalid-file behavior fail-safe.
- **Changing the splitter**: `splitCommands()` must only ever err on the side of *splitting more*
  — an under-split command can slip past an allowlist. Add a regression test for every bypass.

## License

[MIT](LICENSE)
