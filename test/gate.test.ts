/**
 * Extension wiring tests: the handlers of `index.ts` against a fake Pi API and
 * fake UI. Config isolation goes through `PI_CODING_AGENT_DIR` (honored by the
 * host's `getAgentDir()`) plus temp working directories.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import allowlistGate from "../extensions/allowlist-gate/index.ts";

interface FakeCtx {
  cwd: string;
  hasUI: boolean;
  signal: AbortSignal | undefined;
  isProjectTrusted(): boolean;
  ui: {
    selectCalls: Array<{ title: string; options: string[] }>;
    editorCalls: Array<{ title: string; prefill: string | undefined }>;
    notifications: string[];
    /** Choice returned by the next dialogs. */
    nextChoice: string | undefined;
    /** Answer of the rules editor: receives the prefilled text, undefined = cancelled. */
    editorAnswer: (prefill: string | undefined) => string | undefined;
    select(title: string, options: string[]): Promise<string | undefined>;
    editor(title: string, prefill?: string): Promise<string | undefined>;
    notify(message: string): void;
  };
}

interface CommandRegistration {
  description?: string;
  handler: (args: string, ctx: FakeCtx) => Promise<void>;
}

type ToolCallHandler = (event: ToolCallEvent, ctx: FakeCtx) => Promise<ToolCallEventResult | undefined>;

function makeCtx(cwd: string, hasUI: boolean, trusted = true): FakeCtx {
  const ui: FakeCtx["ui"] = {
    selectCalls: [],
    editorCalls: [],
    notifications: [],
    nextChoice: undefined,
    editorAnswer: () => undefined,
    async select(title, options) {
      ui.selectCalls.push({ title, options });
      // Yield so that concurrent calls really interleave.
      await new Promise((resolve) => setImmediate(resolve));
      return ui.nextChoice;
    },
    async editor(title, prefill) {
      ui.editorCalls.push({ title, prefill });
      await new Promise((resolve) => setImmediate(resolve));
      return ui.editorAnswer(prefill);
    },
    notify(message) {
      ui.notifications.push(message);
    },
  };
  return { cwd, hasUI, signal: undefined, isProjectTrusted: () => trusted, ui };
}

function makeEvent(toolName: string, input: Record<string, unknown>): ToolCallEvent {
  return { type: "tool_call", toolCallId: "test-1", toolName, input } as ToolCallEvent;
}

const ENV_KEYS = ["PI_CODING_AGENT_DIR"];

describe("allowlist gate", () => {
  let agentDir: string;
  let cwd: string;
  let handler: ToolCallHandler;
  let sessionStart: () => void;
  let commands: Map<string, CommandRegistration>;
  let savedEnv: Record<string, string | undefined>;
  let ctx: FakeCtx;

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ENV_KEYS) delete process.env[key];
    agentDir = mkdtempSync(join(tmpdir(), "allowlist-gate-agent-"));
    cwd = mkdtempSync(join(tmpdir(), "allowlist-gate-proj-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const handlers = new Map<string, (...args: never[]) => unknown>();
    commands = new Map<string, CommandRegistration>();
    const fakePi = {
      on(event: string, h: (...args: never[]) => unknown) {
        handlers.set(event, h);
        return () => undefined;
      },
      registerCommand(name: string, options: CommandRegistration) {
        commands.set(name, options);
      },
    } as unknown as ExtensionAPI;
    allowlistGate(fakePi);
    handler = handlers.get("tool_call") as unknown as ToolCallHandler;
    sessionStart = handlers.get("session_start") as unknown as () => void;
    assert.ok(handler, "extension must register a tool_call handler");
    assert.ok(sessionStart, "extension must register a session_start handler");
    ctx = makeCtx(cwd, false);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  const bash = (command: string): ToolCallEvent => makeEvent("bash", { command });
  const writeTo = (path: string): ToolCallEvent => makeEvent("write", { path, content: "x" });

  function writeGlobalConfig(value: unknown): void {
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    writeFileSync(
      join(agentDir, "extensions", "allowlist-gate.json"),
      typeof value === "string" ? value : JSON.stringify(value),
    );
  }

  describe("shell commands", () => {
    it("allowlisted commands pass without any UI", async () => {
      assert.equal(await handler(bash("git status"), ctx), undefined);
      assert.equal(ctx.ui.selectCalls.length, 0);
    });

    it("unlisted commands are blocked fail-safe without UI", async () => {
      const result = await handler(bash("git push origin main"), ctx);
      assert.equal(result?.block, true);
      assert.match(result?.reason ?? "", /requires approval/);
    });

    it("denylisted commands are blocked without asking", async () => {
      writeGlobalConfig({ deny: ["shell:rm -rf *"] });
      const uiCtx = makeCtx(cwd, true);
      const result = await handler(bash("rm -rf /tmp/x"), uiCtx);
      assert.equal(result?.block, true);
      assert.match(result?.reason ?? "", /denylist/);
      assert.equal(uiCtx.ui.selectCalls.length, 0);
    });

    it("a denied command cannot hide inside a substitution behind an allowed one", async () => {
      writeGlobalConfig({ allow: ["shell:echo *"], deny: ["shell:rm -rf *"] });
      for (const command of ['echo "$(rm -rf x)"', "echo $(ls; rm -rf x)", "echo `rm -rf x`", "(rm -rf x)"]) {
        const result = await handler(bash(command), makeCtx(cwd, true));
        assert.match(result?.reason ?? "", /denylist/, command);
      }
    });

    it("powershell is gated by the shell rules with PowerShell quoting", async () => {
      writeGlobalConfig({ allow: ["shell:echo *"], deny: ["shell:rm -rf *"] });
      const result = await handler(makeEvent("powershell", { command: 'echo "C:\\dir\\"; rm -rf x' }), ctx);
      assert.match(result?.reason ?? "", /denylist/);
    });

    it("redirections ask even for allowlisted commands, and say why", async () => {
      const uiCtx = makeCtx(cwd, true);
      uiCtx.ui.nextChoice = "Deny";
      const result = await handler(bash("echo hi > file.txt"), uiCtx);
      assert.equal(result?.block, true);
      assert.equal(uiCtx.ui.selectCalls.length, 1);
      assert.match(uiCtx.ui.selectCalls[0].title, /redirection/);
    });
  });

  describe("approval dialog", () => {
    it("'Allow once' passes a single call", async () => {
      const uiCtx = makeCtx(cwd, true);
      uiCtx.ui.nextChoice = "Allow once";
      assert.equal(await handler(bash("git push origin main"), uiCtx), undefined);
      assert.deepEqual(uiCtx.ui.selectCalls[0].options, [
        "Allow once",
        "Allow for session",
        "Allow & save rule (project)...",
        "Deny",
      ]);
      // Not remembered: the same call asks again.
      await handler(bash("git push origin main"), uiCtx);
      assert.equal(uiCtx.ui.selectCalls.length, 2);
    });

    it("untrusted projects do not offer the save-rule option", async () => {
      const untrustedCtx = makeCtx(cwd, true, false);
      untrustedCtx.ui.nextChoice = "Deny";
      await handler(bash("git push origin main"), untrustedCtx);
      assert.deepEqual(untrustedCtx.ui.selectCalls[0].options, ["Allow once", "Allow for session", "Deny"]);
    });

    it("'Deny' (or dialog dismissal) blocks the call", async () => {
      const uiCtx = makeCtx(cwd, true);
      uiCtx.ui.nextChoice = "Deny";
      assert.equal((await handler(bash("git push origin main"), uiCtx))?.block, true);
      uiCtx.ui.nextChoice = undefined; // dismissed
      assert.equal((await handler(bash("git push origin main"), uiCtx))?.block, true);
    });

    it("'Allow for session' covers identical calls only", async () => {
      const uiCtx = makeCtx(cwd, true);
      uiCtx.ui.nextChoice = "Allow for session";
      assert.equal(await handler(bash("git push origin main"), uiCtx), undefined);
      // Identical call passes even without UI afterwards; a different call still asks.
      assert.equal(await handler(bash("git push origin main"), makeCtx(cwd, false)), undefined);
      assert.equal((await handler(bash("git push other"), makeCtx(cwd, false)))?.block, true);
    });

    it("session approvals are dropped on session_start", async () => {
      const uiCtx = makeCtx(cwd, true);
      uiCtx.ui.nextChoice = "Allow for session";
      await handler(bash("git push origin main"), uiCtx);
      sessionStart();
      assert.equal((await handler(bash("git push origin main"), makeCtx(cwd, false)))?.block, true);
    });

    it("parallel identical calls open a single dialog", async () => {
      const uiCtx = makeCtx(cwd, true);
      uiCtx.ui.nextChoice = "Allow for session";
      const results = await Promise.all([
        handler(bash("git push origin main"), uiCtx),
        handler(bash("git push origin main"), uiCtx),
        handler(bash("git push origin main"), uiCtx),
      ]);
      assert.deepEqual(results, [undefined, undefined, undefined]);
      assert.equal(uiCtx.ui.selectCalls.length, 1);
    });
  });

  describe("saving project rules", () => {
    const SAVE = "Allow & save rule (project)...";
    const projectFile = () => join(cwd, ".pi", "allowlist-gate.json");
    const savedAllow = () => (JSON.parse(readFileSync(projectFile(), "utf-8")) as { allow: string[] }).allow;
    /** Every check below drops the session approvals first: only the saved file may allow. */
    const passesFromFileOnly = async (event: ToolCallEvent) => {
      sessionStart();
      return handler(event, makeCtx(cwd, false));
    };

    it("offers the editor with the full command and seeds the project file from the global config", async () => {
      const uiCtx = makeCtx(cwd, true);
      uiCtx.ui.nextChoice = SAVE;
      uiCtx.ui.editorAnswer = (prefill) => prefill; // user accepts the proposal as-is

      assert.equal(await handler(bash("git push origin main"), uiCtx), undefined);
      assert.equal(uiCtx.ui.editorCalls[0].prefill, "shell:git push origin main");
      assert.ok(savedAllow().includes("shell:git push origin main"));
      assert.ok(savedAllow().includes("shell:git status *"), "global rules are replicated");
      assert.ok(uiCtx.ui.notifications.some((n) => n.includes("saved 1 rule")));
      assert.equal(await passesFromFileOnly(bash("git push origin main")), undefined);
    });

    it("a compound command is saved as one rule per sub-command, and then really passes", async () => {
      const uiCtx = makeCtx(cwd, true);
      uiCtx.ui.nextChoice = SAVE;
      uiCtx.ui.editorAnswer = (prefill) => prefill;

      await handler(bash("git add . && git commit -m wip"), uiCtx);
      assert.equal(uiCtx.ui.editorCalls[0].prefill, "shell:git add .\nshell:git commit -m wip");
      assert.equal(await passesFromFileOnly(bash("git add . && git commit -m wip")), undefined);
    });

    it("lets the user generalize or delete proposed lines", async () => {
      const uiCtx = makeCtx(cwd, true);
      uiCtx.ui.nextChoice = SAVE;
      uiCtx.ui.editorAnswer = () => "shell:git commit *"; // dropped `git add .`, added a wildcard

      await handler(bash("git add . && git commit -m wip"), uiCtx);
      assert.ok(savedAllow().includes("shell:git commit *"));
      assert.ok(!savedAllow().includes("shell:git add ."));
      assert.equal((await passesFromFileOnly(bash("git add . && git commit -m wip")))?.block, true);
      assert.equal(await passesFromFileOnly(bash("git commit -m other")), undefined);
    });

    it("adds the missing scope prefix", async () => {
      const uiCtx = makeCtx(cwd, true);
      uiCtx.ui.nextChoice = SAVE;
      uiCtx.ui.editorAnswer = () => "git push *"; // forgot "shell:"

      await handler(bash("git push origin main"), uiCtx);
      assert.ok(savedAllow().includes("shell:git push *"));
    });

    it("cancelling the editor, or saving nothing, blocks the call and writes nothing", async () => {
      const uiCtx = makeCtx(cwd, true);
      uiCtx.ui.nextChoice = SAVE;
      uiCtx.ui.editorAnswer = () => undefined; // Escape
      const cancelled = await handler(bash("git push origin main"), uiCtx);
      assert.match(cancelled?.reason ?? "", /cancelled/);

      uiCtx.ui.editorAnswer = () => "  \n "; // every line deleted
      const empty = await handler(bash("git push origin main"), uiCtx);
      assert.match(empty?.reason ?? "", /no rule to save/);
      assert.equal(existsSync(projectFile()), false);
    });

    it("saves edit/write targets as project-relative paths", async () => {
      const uiCtx = makeCtx(cwd, true);
      uiCtx.ui.nextChoice = SAVE;
      uiCtx.ui.editorAnswer = (prefill) => prefill;

      await handler(writeTo(join(cwd, "notes", "new.txt")), uiCtx);
      assert.equal(uiCtx.ui.editorCalls[0].prefill, "edit:notes/new.txt");
      assert.equal(await passesFromFileOnly(writeTo("notes/new.txt")), undefined);
    });

    it("saves an MCP call as its server", async () => {
      const uiCtx = makeCtx(cwd, true);
      uiCtx.ui.nextChoice = SAVE;
      uiCtx.ui.editorAnswer = (prefill) => prefill;

      await handler(makeEvent("mcp__db__query", {}), uiCtx);
      assert.equal(uiCtx.ui.editorCalls[0].prefill, "mcp:db");
      assert.equal(await passesFromFileOnly(makeEvent("mcp__db__other_tool", {})), undefined);
    });

    it("is not offered when a rule could never take effect (redirection, outside the project)", async () => {
      const uiCtx = makeCtx(cwd, true);
      uiCtx.ui.nextChoice = "Deny";
      await handler(bash("echo hi > out.txt"), uiCtx);
      await handler(writeTo(join(tmpdir(), "elsewhere", "f.txt")), uiCtx);
      for (const call of uiCtx.ui.selectCalls) assert.ok(!call.options.includes(SAVE), call.title);
    });

    it("a sibling call covered by a rule saved meanwhile does not ask again", async () => {
      const uiCtx = makeCtx(cwd, true);
      uiCtx.ui.nextChoice = SAVE;
      uiCtx.ui.editorAnswer = () => "shell:git push *";

      const results = await Promise.all([
        handler(bash("git push origin a"), uiCtx),
        handler(bash("git push origin b"), uiCtx),
      ]);
      assert.deepEqual(results, [undefined, undefined]);
      assert.equal(uiCtx.ui.selectCalls.length, 1);
    });

    it("an unreadable project file is never overwritten; the approved call runs once", async () => {
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      writeFileSync(projectFile(), "{broken, my precious deny rules");
      const uiCtx = makeCtx(cwd, true);
      uiCtx.ui.nextChoice = SAVE;
      uiCtx.ui.editorAnswer = (prefill) => prefill;

      assert.equal(await handler(bash("git push origin main"), uiCtx), undefined);
      assert.equal(readFileSync(projectFile(), "utf-8"), "{broken, my precious deny rules");
      assert.ok(uiCtx.ui.notifications.some((n) => /cannot save the rule/.test(n)));
      // Nothing was remembered: the next identical call asks again.
      uiCtx.ui.nextChoice = "Deny";
      assert.equal((await handler(bash("git push origin main"), uiCtx))?.block, true);
    });
  });

  describe("file edits", () => {
    it("outside-project targets ask even when allowlisted", async () => {
      writeGlobalConfig({ allow: ["edit:*"] });
      const uiCtx = makeCtx(cwd, true);
      uiCtx.ui.nextChoice = "Deny";
      const result = await handler(writeTo(join(tmpdir(), "elsewhere", "hosts")), uiCtx);
      assert.equal(result?.block, true);
      assert.equal(uiCtx.ui.selectCalls.length, 1);
      assert.match(uiCtx.ui.selectCalls[0].title, /outside the project/);
    });

    it("~ and ../ targets are recognized as outside the project", async () => {
      writeGlobalConfig({ allow: ["edit:*"] });
      for (const path of ["~/.bashrc", "@~/.bashrc", "../sibling/file", "src/../../x"]) {
        const result = await handler(writeTo(path), ctx);
        assert.match(result?.reason ?? "", /outside the project/, path);
      }
    });

    it("'Allow for session' also covers an outside-project target", async () => {
      const uiCtx = makeCtx(cwd, true);
      uiCtx.ui.nextChoice = "Allow for session";
      const target = join(tmpdir(), "elsewhere", "file.txt");
      assert.equal(await handler(writeTo(target), uiCtx), undefined);
      assert.equal(await handler(writeTo(target), makeCtx(cwd, false)), undefined);
    });

    it("the denylist hard-blocks outside-project targets", async () => {
      writeGlobalConfig({ deny: ["edit:**/elsewhere/*"] });
      const uiCtx = makeCtx(cwd, true);
      const result = await handler(writeTo(join(tmpdir(), "elsewhere", "file.txt")), uiCtx);
      assert.match(result?.reason ?? "", /denylist/);
      assert.equal(uiCtx.ui.selectCalls.length, 0);
    });

    it("in-project edits honor the allowlist, also for absolute paths", async () => {
      writeGlobalConfig({ allow: ["edit:notes/*"] });
      const uiCtx = makeCtx(cwd, true);
      assert.equal(await handler(writeTo("notes/a.txt"), uiCtx), undefined);
      assert.equal(await handler(writeTo(join(cwd, "notes", "b.txt")), uiCtx), undefined);
      assert.equal(uiCtx.ui.selectCalls.length, 0);
    });

    it("deny rules see normalized paths (./ and absolute spellings)", async () => {
      writeGlobalConfig({ allow: ["edit:*"], deny: ["edit:.env*"] });
      for (const path of [".env", "./.env", "src/../.env", join(cwd, ".env")]) {
        const result = await handler(writeTo(path), ctx);
        assert.match(result?.reason ?? "", /denylist/, path);
      }
    });
  });

  describe("other tools", () => {
    it("read-only and self-gating tools never trigger the gate", async () => {
      const uiCtx = makeCtx(cwd, true);
      for (const tool of ["read", "grep", "find", "ls", "read_mcp_resource", "codemode", "tool_search"]) {
        assert.equal(await handler(makeEvent(tool, {}), uiCtx), undefined, tool);
      }
      assert.equal(uiCtx.ui.selectCalls.length, 0);
    });

    it("MCP servers gate per server", async () => {
      writeGlobalConfig({ allow: ["mcp:docs-mcp-server"] });
      const uiCtx = makeCtx(cwd, true);
      assert.equal(await handler(makeEvent("mcp__docs_mcp_server__fetch_url", {}), uiCtx), undefined);
      uiCtx.ui.nextChoice = "Deny";
      const blocked = await handler(makeEvent("mcp__db__query", { sql: "select 1" }), uiCtx);
      assert.equal(blocked?.block, true);
    });

    it("unknown extension tools ask", async () => {
      assert.equal((await handler(makeEvent("my-tool", {}), ctx))?.block, true);
    });
  });

  describe("configuration", () => {
    it("seeds the global config file on first use", async () => {
      const target = join(agentDir, "extensions", "allowlist-gate.json");
      assert.equal(await handler(bash("git status"), ctx), undefined);
      const seeded = JSON.parse(readFileSync(target, "utf-8")) as { allow: string[] };
      assert.ok(seeded.allow.includes("shell:git status *"));
    });

    it("a disabled gate passes everything", async () => {
      mkdirSync(join(agentDir, "extensions"), { recursive: true });
      writeFileSync(join(agentDir, "extensions", "allowlist-gate.json"), JSON.stringify({ enabled: false }));
      assert.equal(await handler(bash("git push origin main"), ctx), undefined);
      assert.equal(ctx.ui.selectCalls.length, 0);
    });

    it("the project file is ignored when the project is not trusted", async () => {
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      writeFileSync(join(cwd, ".pi", "allowlist-gate.json"), JSON.stringify({ allow: ["shell:*"] }));
      const untrusted = makeCtx(cwd, true, false);
      untrusted.ui.nextChoice = "Deny";
      assert.equal((await handler(bash("git push origin main"), untrusted))?.block, true);
      assert.match(untrusted.ui.notifications[0] ?? "", /not trusted/);

      const trusted = makeCtx(cwd, true, true);
      assert.equal(await handler(bash("git push origin main"), trusted), undefined);
    });

    it("an invalid config file fails safe and warns only once", async () => {
      writeGlobalConfig("{oops");
      const uiCtx = makeCtx(cwd, true);
      uiCtx.ui.nextChoice = "Deny";
      // Even the former default `git status` now asks.
      assert.equal((await handler(bash("git status"), uiCtx))?.block, true);
      await handler(bash("git status"), uiCtx);
      assert.equal(uiCtx.ui.notifications.length, 1);
      assert.match(uiCtx.ui.notifications[0], /cannot be read/);
    });
  });

  describe("/allowlist command", () => {
    it("registers the /allowlist slash command", () => {
      assert.ok(commands.has("allowlist"));
      assert.match(commands.get("allowlist")?.description ?? "", /allowlist/i);
    });

    it("shows status, project trust, global config and default rules", async () => {
      const cmd = commands.get("allowlist");
      assert.ok(cmd);
      await cmd.handler("", ctx);
      assert.equal(ctx.ui.notifications.length, 1);
      const report = ctx.ui.notifications[0];
      assert.match(report, /Allowlist Gate:\s*ENABLED/);
      assert.match(report, /Project trust:\s*Trusted/);
      assert.match(report, /Global:\s*.+allowlist-gate\.json/);
      assert.match(report, /Project:\s*\(none\)/);
      assert.match(report, /Deny rules \(0\)/);
      assert.match(report, /Allow rules \(11\)/);
      assert.match(report, /shell:git status \*/);
      assert.match(report, /Session approvals \(0\)/);
    });

    it("shows project configuration when project is trusted", async () => {
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      writeFileSync(join(cwd, ".pi", "allowlist-gate.json"), JSON.stringify({ allow: ["shell:ls *"], deny: ["shell:rm *"] }));
      const cmd = commands.get("allowlist");
      assert.ok(cmd);
      await cmd.handler("", ctx);
      const report = ctx.ui.notifications[0];
      assert.match(report, /Project:\s*.+\.pi[/\\]allowlist-gate\.json/);
      assert.doesNotMatch(report, /IGNORED/);
      assert.match(report, /Deny rules \(1\)/);
      assert.match(report, /shell:rm \*/);
      assert.match(report, /Allow rules \(1\)/);
      assert.match(report, /shell:ls \*/);
    });

    it("flags project config as ignored when project is untrusted", async () => {
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      writeFileSync(join(cwd, ".pi", "allowlist-gate.json"), JSON.stringify({ allow: ["shell:*"] }));
      const untrustedCtx = makeCtx(cwd, true, false);
      const cmd = commands.get("allowlist");
      assert.ok(cmd);
      await cmd.handler("", untrustedCtx);
      const report = untrustedCtx.ui.notifications[0];
      assert.match(report, /Project trust:\s*Untrusted/);
      assert.match(report, /IGNORED: untrusted project/);
      assert.match(report, /Warnings:/);
      assert.match(report, /ignored because the project is not trusted/);
    });

    it("lists active session approvals", async () => {
      const uiCtx = makeCtx(cwd, true);
      uiCtx.ui.nextChoice = "Allow for session";
      await handler(bash("git push origin main"), uiCtx);
      const cmd = commands.get("allowlist");
      assert.ok(cmd);
      await cmd.handler("", uiCtx);
      const report = uiCtx.ui.notifications[uiCtx.ui.notifications.length - 1];
      assert.match(report, /Session approvals \(1\)/);
      assert.match(report, /bash git push origin main/);
    });

    it("shows DISABLED when gate is disabled", async () => {
      writeGlobalConfig({ enabled: false });
      const cmd = commands.get("allowlist");
      assert.ok(cmd);
      await cmd.handler("", ctx);
      const report = ctx.ui.notifications[0];
      assert.match(report, /Allowlist Gate:\s*DISABLED/);
    });

    it("shows config warnings when JSON is invalid", async () => {
      writeGlobalConfig("{bad-json");
      const cmd = commands.get("allowlist");
      assert.ok(cmd);
      await cmd.handler("", ctx);
      const report = ctx.ui.notifications[0];
      assert.match(report, /Warnings:/);
      assert.match(report, /cannot be read/);
    });
  });
});
