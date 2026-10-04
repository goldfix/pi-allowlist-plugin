/**
 * Extension wiring tests: the handlers of `index.ts` against a fake Pi API and
 * fake UI. Config isolation goes through `PI_CODING_AGENT_DIR` (honored by the
 * host's `getAgentDir()`) plus temp working directories.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    notifications: string[];
    /** Choice returned by the next dialogs. */
    nextChoice: string | undefined;
    select(title: string, options: string[]): Promise<string | undefined>;
    notify(message: string): void;
  };
}

type ToolCallHandler = (event: ToolCallEvent, ctx: FakeCtx) => Promise<ToolCallEventResult | undefined>;

function makeCtx(cwd: string, hasUI: boolean, trusted = true): FakeCtx {
  const ui: FakeCtx["ui"] = {
    selectCalls: [],
    notifications: [],
    nextChoice: undefined,
    async select(title, options) {
      ui.selectCalls.push({ title, options });
      // Yield so that concurrent calls really interleave.
      await new Promise((resolve) => setImmediate(resolve));
      return ui.nextChoice;
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
  let savedEnv: Record<string, string | undefined>;
  let ctx: FakeCtx;

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ENV_KEYS) delete process.env[key];
    agentDir = mkdtempSync(join(tmpdir(), "allowlist-gate-agent-"));
    cwd = mkdtempSync(join(tmpdir(), "allowlist-gate-proj-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const handlers = new Map<string, (...args: never[]) => unknown>();
    const fakePi = {
      on(event: string, h: (...args: never[]) => unknown) {
        handlers.set(event, h);
        return () => undefined;
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
      assert.deepEqual(uiCtx.ui.selectCalls[0].options, ["Allow once", "Allow for session", "Deny"]);
      // Not remembered: the same call asks again.
      await handler(bash("git push origin main"), uiCtx);
      assert.equal(uiCtx.ui.selectCalls.length, 2);
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
});
