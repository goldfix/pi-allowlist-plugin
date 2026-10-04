/**
 * Pure allowlist/denylist policy for dispositive tool calls.
 *
 * Rule syntax is `scope:pattern`, where scope is one of:
 * - `shell` → the `bash` and `powershell` tools; the pattern is tested against
 *              each sub-command of the invoked command line (see
 *              {@link splitCommands}). `shell:git pull *` passes while
 *              `shell:git push *` asks.
 * - `edit`  → the `edit` and `write` tools (they share this scope); the
 *              pattern is tested against the target file path.
 *              Example: `edit:docs/*`.
 * - `mcp`   → MCP servers, never single tools; the pattern is a server name
 *              and wildcards are allowed (`mcp:docs-mcp-server`,
 *              `mcp:docs-*`). Matching is done on the server segment of the
 *              Pi tool name `mcp__<server>__<tool>`.
 * - any other scope → exact tool name. Only whole-tool rules (`my-tool`,
 *              `my-tool:*`) are meaningful: the gate derives no resources for
 *              other tools, so a rule carrying a pattern never matches.
 *
 * A rule without `:` (or with pattern `*`) covers the whole action.
 *
 * Decision order: deny wins over allow, allow wins over ask.
 * - deny:  ANY resource matching a deny rule blocks the operation.
 * - allow: EVERY resource must be covered by an allow rule. A compound shell
 *          command (`git status && git push`) is split into one resource per
 *          sub-command, so a single allowed part must not let the rest through.
 * - read-only tools (SAFE_PASSTHROUGH) are never touched.
 * - everything else gated asks.
 *
 * Exceptions (always ask, only the denylist can hard-block them):
 * - shell commands containing a redirection (`>`, `>>`, `2>`, `&>`, …): they
 *   can write files, so they always ask whatever the allowlist says. The check
 *   is deliberately coarse — a `>` inside quotes also asks.
 * - calls flagged `forceAsk` by the caller (paths outside the project).
 */

export type Decision = "allow" | "deny" | "ask" | "passthrough";

export interface RuleLists {
  allow: string[];
  deny: string[];
}

export interface Evaluation {
  decision: Decision;
}

export interface EvaluateOptions {
  /** Ask even when the allowlist covers the call (deny still wins). */
  forceAsk?: boolean;
}

export interface ParsedRule {
  scope: string;
  pattern: string;
}

/** Shell dialect understood by {@link splitCommands}. */
export type ShellKind = "posix" | "powershell";

/**
 * Tool names the gate never touches (read-only or self-gating).
 * - `codemode` runs scripts in a sandbox without fs/network access; every tool
 *   a script calls goes through `tool_call` again (with `parentToolCallId`),
 *   so the nested calls are gated individually.
 * - `tool_search` only looks up and activates tools; `question` only asks the user.
 */
export const SAFE_PASSTHROUGH: ReadonlySet<string> = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "question",
  "codemode",
  "tool_search",
  // Built-in MCP resource tools are read-only (list/read, never call).
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
]);

/** Pi tool names carrying a shell command line. */
const SHELL_TOOLS: ReadonlySet<string> = new Set(["bash", "powershell"]);

/** Pi tool names sharing the `edit` rule scope. */
const EDIT_TOOLS: ReadonlySet<string> = new Set(["edit", "write"]);

/** Prefix/split markers of Pi MCP tool names (`mcp__<server>__<tool>`). */
const MCP_PREFIX = "mcp__";
const MCP_SEPARATOR = "__";

const REDIRECTION = ">";

/** Shell dialect for a Pi shell tool name. */
export function shellKindOf(toolName: string): ShellKind {
  return toolName === "powershell" ? "powershell" : "posix";
}

/**
 * Normalize an MCP server name for comparison, keeping `*`/`?` wildcards
 * intact so server patterns can use them. Dashes become underscores because
 * Pi accepts both spellings (`mcp__dev-radius` / `mcp__dev_radius`) and
 * tool names use the underscore form.
 */
export function namespaceServer(server: string): string {
  return String(server ?? "")
    .replace(/-/g, "_")
    .replace(/[^A-Za-z0-9_*?]/g, "_");
}

export function parseRule(raw: string): ParsedRule | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const idx = text.indexOf(":");
  if (idx === -1) return { scope: text, pattern: "*" };
  const scope = text.slice(0, idx).trim();
  const pattern = text.slice(idx + 1).trim() || "*";
  if (!scope) return null;
  return { scope, pattern };
}

// Same semantics as OpenCode core Wildcard.match: `*` → `.*`, `?` → `.`,
// plus the trailing " *" shorthand also matching the bare prefix. Like core,
// matching is case-insensitive on Windows (case-insensitive file system).
export function wildcardMatch(input: string, pattern: string): boolean {
  const normalized = String(input).replaceAll("\\", "/");
  let escaped = String(pattern)
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?";
  return new RegExp("^" + escaped + "$", process.platform === "win32" ? "si" : "s").test(normalized);
}

/**
 * Split a shell command line into one sub-command per segment. Pi reports the
 * whole command text in `input.command` (OpenCode core used to split compound
 * commands for us), so the gate does it here.
 *
 * Segments are separated by `&&`, `||`, `;`, `|`, `&`, newlines and
 * parentheses. Command substitutions (`$(...)`, and backticks in posix) are
 * scanned recursively — also inside double quotes, where the shell still runs
 * them — and every inner command becomes a segment of its own, while the
 * enclosing segment keeps the raw substitution text. Single/double quotes and
 * the dialect's escape character (`\` in posix, backtick in PowerShell) are
 * respected so quoted separators do not split.
 *
 * The parser is deliberately conservative: when in doubt it splits more, so
 * the result can only make a command harder to allow, never easier.
 */
export function splitCommands(command: string, shell: ShellKind = "posix"): string[] {
  const segments: string[] = [];
  scan(String(command ?? ""), 0, null, shell, segments);
  return segments;
}

/**
 * Scan `text` from `start` until the end or the `closer` of a substitution,
 * appending the segments found to `out`. Returns the index just past the
 * consumed input (past the closer when one was found).
 */
function scan(text: string, start: number, closer: ")" | "`" | null, shell: ShellKind, out: string[]): number {
  const escape = shell === "powershell" ? "`" : "\\";
  const backtickSubstitution = shell === "posix";
  let current = "";
  let i = start;

  const flush = (): void => {
    const segment = current.trim();
    if (segment) out.push(segment);
    current = "";
  };

  /** Consume a substitution starting at `from`, keeping its raw text in `current`. */
  const substitute = (from: number, bodyStart: number, end: ")" | "`"): number => {
    const next = scan(text, bodyStart, end, shell, out);
    current += text.slice(from, next);
    return next;
  };

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (closer !== null && ch === closer) {
      flush();
      return i + 1;
    }
    if (ch === escape && i + 1 < text.length) {
      current += ch + next;
      i += 2;
    } else if (ch === "$" && next === "(") {
      i = substitute(i, i + 2, ")");
    } else if (ch === "`" && backtickSubstitution) {
      i = substitute(i, i + 1, "`");
    } else if (ch === "'") {
      // Single quotes: verbatim up to the next single quote, no substitutions.
      const close = text.indexOf("'", i + 1);
      const end = close === -1 ? text.length : close + 1;
      current += text.slice(i, end);
      i = end;
    } else if (ch === '"') {
      current += ch;
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === escape && i + 1 < text.length) {
          current += text[i] + text[i + 1];
          i += 2;
        } else if (text[i] === "$" && text[i + 1] === "(") {
          i = substitute(i, i + 2, ")");
        } else if (text[i] === "`" && backtickSubstitution) {
          i = substitute(i, i + 1, "`");
        } else {
          current += text[i++];
        }
      }
      if (i < text.length) current += text[i++]; // closing quote
    } else if (ch === "&" || ch === "|") {
      flush();
      i += next === ch ? 2 : 1; // `&&` / `||`
    } else if (ch === ";" || ch === "\n" || ch === "(" || ch === ")") {
      flush();
      i++;
    } else {
      current += ch;
      i++;
    }
  }
  flush();
  return i;
}

/** Extract the server segment from a Pi MCP tool name, or null when not one. */
export function mcpServerOf(toolName: string): string | null {
  if (!toolName.startsWith(MCP_PREFIX)) return null;
  const rest = toolName.slice(MCP_PREFIX.length);
  const sep = rest.indexOf(MCP_SEPARATOR);
  if (sep === -1) return null;
  const server = rest.slice(0, sep).trim();
  return server ? namespaceServer(server) : null;
}

type Applicability = "whole" | "resource";

/** How a rule applies to a tool: whole-tool, per-resource, or not at all. */
function applicability(rule: ParsedRule, toolName: string): Applicability | null {
  if (rule.scope === "mcp") {
    const server = mcpServerOf(toolName);
    if (server === null) return null;
    return wildcardMatch(server, namespaceServer(rule.pattern)) ? "whole" : null;
  }
  if (rule.scope === "shell") {
    if (!SHELL_TOOLS.has(toolName)) return null;
  } else if (rule.scope === "edit") {
    if (!EDIT_TOOLS.has(toolName)) return null;
  } else if (rule.scope !== toolName) {
    return null;
  }
  if (rule.pattern === "*") return "whole";
  return "resource";
}

interface ApplicableRule {
  pattern: string;
  kind: Applicability;
}

function applicable(rules: string[], toolName: string): ApplicableRule[] {
  const out: ApplicableRule[] = [];
  for (const raw of rules) {
    const rule = parseRule(raw);
    if (!rule) continue;
    const kind = applicability(rule, toolName);
    if (kind) out.push({ pattern: rule.pattern, kind });
  }
  return out;
}

export function evaluate(
  toolName: string,
  resources: string[],
  lists: RuleLists,
  options: EvaluateOptions = {},
): Evaluation {
  const allow = applicable(lists?.allow ?? [], toolName);
  const deny = applicable(lists?.deny ?? [], toolName);
  const res = (resources ?? []).map(String);

  const denied = deny.some((rule) => rule.kind === "whole" || res.some((r) => wildcardMatch(r, rule.pattern)));
  if (denied) return { decision: "deny" };

  if (options.forceAsk) return { decision: "ask" };
  if (SHELL_TOOLS.has(toolName) && res.some((r) => r.includes(REDIRECTION))) return { decision: "ask" };

  const allowed =
    allow.some((rule) => rule.kind === "whole") ||
    (res.length > 0 && res.every((r) => allow.some((rule) => wildcardMatch(r, rule.pattern))));
  if (allowed) return { decision: "allow" };

  if (SAFE_PASSTHROUGH.has(toolName)) return { decision: "passthrough" };
  return { decision: "ask" };
}
