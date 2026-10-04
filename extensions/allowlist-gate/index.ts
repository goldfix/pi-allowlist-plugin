/**
 * Pi extension: applicative allowlist gate for dispositive tool calls.
 *
 * A single `tool_call` handler gates file modifications and active
 * interactions with external services (shell commands, MCP calls, …):
 * - allowlist match → passes silently
 * - denylist match → blocked, the model receives the reason
 * - anything else gated → a UI dialog asks for approval
 *   ("Allow once" / "Allow for session" / "Allow & save rule (project)..." /
 *   "Deny"); without a UI (print/JSON mode) gated calls are blocked fail-safe
 * - read-only tools (`read`, `grep`, `find`, `ls`, MCP resource tools, …) →
 *   never touched
 *
 * Rule syntax (`scope:pattern`, core-like `*`/`?` wildcards) is documented in
 * `policy.ts`. `edit:<pattern>` covers both `edit` and `write`; `shell:<…>`
 * covers `bash` and `powershell`; `mcp:<server>` covers a whole MCP server.
 *
 * Session approvals live only in memory and are dropped on every
 * `session_start` (new/resume/fork/reload). Persistence goes through the
 * allowlist files only: edit them by hand, or pick "Allow & save rule
 * (project)..." to append rules to the project file (never the global one).
 */
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionAPI,
  type ToolCallEvent,
  type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import {
  CONFIG_FILE_NAME,
  buildStatusReport,
  ensureGlobalConfigFile,
  loadConfig,
  saveProjectRules,
} from "./config.ts";
import { classifyPath } from "./paths.ts";
import {
  evaluate,
  mcpServerOf,
  normalizeCustomRule,
  shellKindOf,
  splitCommands,
} from "./policy.ts";

const EXTENSION_NAME = "allowlist-gate";

const ALLOW_ONCE = "Allow once";
const ALLOW_SESSION = "Allow for session";
const ALLOW_SAVE = "Allow & save rule (project)...";
const DENY = "Deny";

/** What the policy needs to know about one tool call. */
interface CallTarget {
  resources: string[];
  /** Target outside the project directory: always asks (deny still wins). */
  outside: boolean;
  /** Why the call asks despite a matching allow rule, shown in the dialog. */
  hint?: string;
}

/** Minimal slice of the extension context used by the dialog. */
interface AskContext {
  cwd: string;
  hasUI: boolean;
  signal: AbortSignal | undefined;
  isProjectTrusted(): boolean;
  ui: {
    select(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined>;
    editor(title: string, prefill?: string): Promise<string | undefined>;
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
}

function targetOf(event: ToolCallEvent, cwd: string): CallTarget {
  const input = event.input as Record<string, unknown>;
  if (event.toolName === "bash" || event.toolName === "powershell") {
    const command = String(input.command ?? "");
    return {
      resources: splitCommands(command, shellKindOf(event.toolName)),
      outside: false,
      hint: command.includes(">") ? "contains a redirection" : undefined,
    };
  }
  if (event.toolName === "edit" || event.toolName === "write") {
    const { resource, outside } = classifyPath(String(input.path ?? ""), cwd);
    return { resources: [resource], outside, hint: outside ? "outside the project directory" : undefined };
  }
  return { resources: [], outside: false };
}

function describeCall(toolName: string, resources: string[]): string {
  const detail = resources.length > 0 ? ` ${resources.join(" | ")}` : "";
  return `${toolName}${detail}`;
}

function sessionKey(toolName: string, resources: string[]): string {
  return `${toolName}\n${resources.join("\n")}`;
}

function block(reason: string): ToolCallEventResult {
  return { block: true, reason };
}

/**
 * Rule scope plus the full rules proposed for saving, one per gated resource:
 * the policy matches each sub-command separately, so a rule for a whole
 * compound command line would never match. MCP has no finer unit than the server.
 */
function proposedRules(toolName: string, resources: string[]): { scope: string; rules: string[] } {
  if (toolName === "bash" || toolName === "powershell") {
    return { scope: "shell", rules: resources.map((r) => `shell:${r}`) };
  }
  if (toolName === "edit" || toolName === "write") {
    return { scope: "edit", rules: resources.map((r) => `edit:${r}`) };
  }
  const server = mcpServerOf(toolName);
  if (server) return { scope: "mcp", rules: [`mcp:${server}`] };
  return { scope: toolName, rules: [toolName] };
}

export default function allowlistGate(pi: ExtensionAPI): void {
  /** Exact tool calls approved via "Allow for session" (in-memory only). */
  const sessionAllowed = new Set<string>();
  /** Config warnings already shown, so a broken file does not notify on every call. */
  const reportedWarnings = new Set<string>();
  /** Tail of the dialog queue: parallel tool calls must not open overlapping dialogs. */
  let dialogQueue: Promise<unknown> = Promise.resolve();

  function currentConfig(ctx: { cwd: string; isProjectTrusted(): boolean }) {
    return loadConfig({
      cwd: ctx.cwd,
      agentDir: getAgentDir(),
      configDirName: CONFIG_DIR_NAME,
      projectTrusted: ctx.isProjectTrusted(),
    });
  }

  function serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = dialogQueue.then(task, task);
    dialogQueue = run.catch(() => undefined);
    return run;
  }

  /** "Allow & save rule": let the user edit the proposed rules, then persist them. */
  async function saveRules(
    ctx: AskContext,
    toolName: string,
    resources: string[],
  ): Promise<ToolCallEventResult | undefined> {
    const { scope, rules: proposed } = proposedRules(toolName, resources);
    const edited = await ctx.ui.editor(
      "Allowlist gate: rules to save in the project allowlist (one per line; edit or delete lines)",
      proposed.join("\n"),
    );
    if (edited === undefined) return block(`Blocked by ${EXTENSION_NAME}: rule save was cancelled by the user`);

    const rules = edited
      .split(/\r?\n/)
      .map((line) => normalizeCustomRule(line, scope))
      .filter(Boolean);
    if (rules.length === 0) return block(`Blocked by ${EXTENSION_NAME}: no rule to save`);

    try {
      saveProjectRules({ cwd: ctx.cwd, agentDir: getAgentDir(), configDirName: CONFIG_DIR_NAME, rules });
    } catch (error) {
      // The user did approve this call; only the persistence failed.
      ctx.ui.notify(`${EXTENSION_NAME}: cannot save the rule (${error}); allowed once`, "error");
      return undefined;
    }
    sessionAllowed.add(sessionKey(toolName, resources));
    ctx.ui.notify(`${EXTENSION_NAME}: saved ${rules.length} rule(s) to ${CONFIG_DIR_NAME}/${CONFIG_FILE_NAME}`, "info");
    return undefined;
  }

  async function ask(
    ctx: AskContext,
    toolName: string,
    resources: string[],
    hint: string | undefined,
  ): Promise<ToolCallEventResult | undefined> {
    const call = describeCall(toolName, resources);
    const where = hint ? ` (${hint})` : "";
    if (!ctx.hasUI) {
      return block(`Blocked by ${EXTENSION_NAME}: ${call}${where} requires approval (no UI available)`);
    }

    // A hint means the call asks regardless of the allowlist (redirection,
    // outside the project): a saved rule could never take effect, so don't offer it.
    const options = [ALLOW_ONCE, ALLOW_SESSION];
    if (ctx.isProjectTrusted() && !hint) options.push(ALLOW_SAVE);
    options.push(DENY);

    const choice = await ctx.ui.select(`Allowlist gate: allow ${call}${where}?`, options, { signal: ctx.signal });
    if (choice === ALLOW_ONCE) return undefined;
    if (choice === ALLOW_SESSION) {
      sessionAllowed.add(sessionKey(toolName, resources));
      return undefined;
    }
    if (choice === ALLOW_SAVE) return saveRules(ctx, toolName, resources);
    return block(`Blocked by ${EXTENSION_NAME}: ${call} was not approved by the user`);
  }

  // Approvals never outlive the session they were granted in.
  pi.on("session_start", () => {
    sessionAllowed.clear();
  });

  function describeSessionApproval(key: string): string {
    const parts = key.split("\n");
    const toolName = parts[0] ?? "";
    const resources = parts.slice(1).filter((r) => r.length > 0);
    return describeCall(toolName, resources);
  }

  pi.registerCommand("allowlist", {
    description: "Show effective allowlist gate configuration and active rules",
    handler: async (_args, ctx) => {
      const seedWarning = ensureGlobalConfigFile(getAgentDir());
      const report = buildStatusReport({
        cwd: ctx.cwd,
        agentDir: getAgentDir(),
        configDirName: CONFIG_DIR_NAME,
        projectTrusted: ctx.isProjectTrusted(),
        sessionApproved: Array.from(sessionAllowed).map(describeSessionApproval),
        seedWarning,
      });
      ctx.ui.notify(report, "info");
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    const seedWarning = ensureGlobalConfigFile(getAgentDir());
    const config = currentConfig(ctx);
    if (seedWarning) config.warnings.unshift(seedWarning);
    if (ctx.hasUI) {
      for (const warning of config.warnings) {
        if (reportedWarnings.has(warning)) continue;
        reportedWarnings.add(warning);
        ctx.ui.notify(`${EXTENSION_NAME}: ${warning}`, "warning");
      }
    }
    if (!config.enabled) return undefined;

    const { toolName } = event;
    const { resources, outside, hint } = targetOf(event, ctx.cwd);
    const verdict = evaluate(toolName, resources, config, { forceAsk: outside });

    if (verdict.decision === "allow" || verdict.decision === "passthrough") return undefined;
    if (verdict.decision === "deny") {
      return block(`Blocked by ${EXTENSION_NAME} denylist: ${describeCall(toolName, resources)}`);
    }

    // "ask": inside the queue, re-check what an earlier dialog may have granted
    // meanwhile — a session approval, or a rule saved to the project file — so
    // parallel sibling calls do not ask twice for the same thing.
    const key = sessionKey(toolName, resources);
    return serialized(async () => {
      if (sessionAllowed.has(key)) return undefined;
      const fresh = evaluate(toolName, resources, currentConfig(ctx), { forceAsk: outside });
      if (fresh.decision === "allow") return undefined;
      if (fresh.decision === "deny") {
        return block(`Blocked by ${EXTENSION_NAME} denylist: ${describeCall(toolName, resources)}`);
      }
      return ask(ctx, toolName, resources, hint);
    });
  });
}
