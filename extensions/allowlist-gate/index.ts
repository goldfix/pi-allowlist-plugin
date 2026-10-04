/**
 * Pi extension: applicative allowlist gate for dispositive tool calls.
 *
 * A single `tool_call` handler gates file modifications and active
 * interactions with external services (shell commands, MCP calls, …):
 * - allowlist match → passes silently
 * - denylist match → blocked, the model receives the reason
 * - anything else gated → a UI dialog asks for approval
 *   ("Allow once" / "Allow for session" / "Deny"); without a UI
 *   (print/JSON mode) gated calls are blocked fail-safe
 * - read-only tools (`read`, `grep`, `find`, `ls`, MCP resource tools, …) →
 *   never touched
 *
 * Rule syntax (`scope:pattern`, core-like `*`/`?` wildcards) is documented in
 * `policy.ts`. `edit:<pattern>` covers both `edit` and `write`; `shell:<…>`
 * covers `bash` and `powershell`; `mcp:<server>` covers a whole MCP server.
 *
 * Session approvals live only in memory and are dropped on every
 * `session_start` (new/resume/fork/reload): nothing is persisted. The
 * allowlist file is the only persistence mechanism — add stable rules there
 * (see `config.ts`).
 */
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionAPI,
  type ToolCallEvent,
  type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { ensureGlobalConfigFile, loadConfig } from "./config.ts";
import { classifyPath } from "./paths.ts";
import { evaluate, shellKindOf, splitCommands } from "./policy.ts";

const EXTENSION_NAME = "allowlist-gate";

const ALLOW_ONCE = "Allow once";
const ALLOW_SESSION = "Allow for session";
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
  hasUI: boolean;
  signal: AbortSignal | undefined;
  ui: {
    select(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined>;
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

export default function allowlistGate(pi: ExtensionAPI): void {
  /** Exact tool calls approved via "Allow for session" (in-memory only). */
  const sessionAllowed = new Set<string>();
  /** Config warnings already shown, so a broken file does not notify on every call. */
  const reportedWarnings = new Set<string>();
  /** Tail of the dialog queue: parallel tool calls must not open overlapping dialogs. */
  let dialogQueue: Promise<unknown> = Promise.resolve();

  function serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = dialogQueue.then(task, task);
    dialogQueue = run.catch(() => undefined);
    return run;
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
    const choice = await ctx.ui.select(
      `Allowlist gate: allow ${call}${where}?`,
      [ALLOW_ONCE, ALLOW_SESSION, DENY],
      { signal: ctx.signal },
    );
    if (choice === ALLOW_ONCE) return undefined;
    if (choice === ALLOW_SESSION) {
      sessionAllowed.add(sessionKey(toolName, resources));
      return undefined;
    }
    return block(`Blocked by ${EXTENSION_NAME}: ${call} was not approved by the user`);
  }

  // Approvals never outlive the session they were granted in.
  pi.on("session_start", () => {
    sessionAllowed.clear();
  });

  pi.on("tool_call", async (event, ctx) => {
    const seedWarning = ensureGlobalConfigFile(getAgentDir());
    const config = loadConfig({
      cwd: ctx.cwd,
      agentDir: getAgentDir(),
      configDirName: CONFIG_DIR_NAME,
      projectTrusted: ctx.isProjectTrusted(),
    });
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

    // "ask": re-check the session approvals inside the queue, so a parallel
    // identical call is covered by the approval just granted for its sibling.
    const key = sessionKey(toolName, resources);
    return serialized(async () => {
      if (sessionAllowed.has(key)) return undefined;
      return ask(ctx, toolName, resources, hint);
    });
  });
}
