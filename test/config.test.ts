import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_ALLOW,
  buildStatusReport,
  ensureGlobalConfigFile,
  formatStatusReport,
  globalConfigPath,
  loadConfig,
  loadFileConfig,
  mergeFileConfigs,
  projectConfigPath,
  resolveConfig,
} from "../extensions/allowlist-gate/config.ts";

describe("resolveConfig", () => {
  it("applies minimal defaults", () => {
    const config = resolveConfig({});
    assert.equal(config.enabled, true);
    assert.ok(config.allow.includes("shell:git status *"));
    assert.ok(config.allow.includes("shell:wc *"));
    assert.ok(config.allow.includes("shell:grep *"));
    assert.ok(config.allow.includes("shell:tail *"));
    assert.ok(config.allow.includes("mcp:docs-mcp-server"));
    assert.deepEqual(config.deny, []);
  });
  it("keeps explicit lists as-is", () => {
    const config = resolveConfig({ allow: ["shell:git pull *"], deny: ["shell:rm -rf *"], enabled: false });
    assert.deepEqual(config.allow, ["shell:git pull *"]);
    assert.deepEqual(config.deny, ["shell:rm -rf *"]);
    assert.equal(config.enabled, false);
  });
  it("accepts comma/newline separated string lists", () => {
    const config = resolveConfig({ allow: "shell:a *,shell:b *\nshell:c *" });
    assert.deepEqual(config.allow, ["shell:a *", "shell:b *", "shell:c *"]);
  });
  it("explicit empty allow disables defaults", () => {
    assert.deepEqual(resolveConfig({ allow: [] }).allow, []);
  });
  it("parses the enabled flag, coercing non-boolean junk to the default", () => {
    assert.equal(resolveConfig({ enabled: false }).enabled, false);
    assert.equal(resolveConfig({ enabled: "off" }).enabled, false);
    assert.equal(resolveConfig({ enabled: "garbage" }).enabled, true);
  });
});

describe("mergeFileConfigs", () => {
  it("project lists replace wholesale, missing keys fall back to global", () => {
    const merged = mergeFileConfigs(
      { allow: ["shell:a *"], deny: ["shell:x *"], enabled: true },
      { allow: ["shell:b *"] },
    );
    assert.deepEqual(merged.allow, ["shell:b *"]);
    assert.deepEqual(merged.deny, ["shell:x *"]);
    assert.equal(merged.enabled, true);
  });
});

describe("loadFileConfig", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "allowlist-config-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  it("returns an empty config for missing files", () => {
    assert.deepEqual(loadFileConfig(join(dir, "nope.json")), { config: {} });
  });
  it("fails safe (nothing auto-allowed) and warns on invalid JSON or non-objects", () => {
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{oops");
    const broken = loadFileConfig(bad);
    assert.deepEqual(broken.config, { allow: [] });
    assert.match(broken.warning ?? "", /cannot be read/);
    const list = join(dir, "list.json");
    writeFileSync(list, "[]");
    const notObject = loadFileConfig(list);
    assert.deepEqual(notObject.config, { allow: [] });
    assert.match(notObject.warning ?? "", /must be an object/);
  });
  it("loads plain objects", () => {
    const file = join(dir, "ok.json");
    writeFileSync(file, JSON.stringify({ allow: ["shell:a *"], enabled: false }));
    assert.deepEqual(loadFileConfig(file), { config: { allow: ["shell:a *"], enabled: false } });
  });
});

describe("loadConfig", () => {
  let agentDir: string;
  let cwd: string;
  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "allowlist-agent-"));
    cwd = mkdtempSync(join(tmpdir(), "allowlist-proj-"));
  });
  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });
  const load = (projectTrusted: boolean) => loadConfig({ cwd, agentDir, configDirName: ".pi", projectTrusted });
  const writeGlobal = (value: unknown) => {
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    writeFileSync(globalConfigPath(agentDir), typeof value === "string" ? value : JSON.stringify(value));
  };
  const writeProject = (value: unknown) => {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(projectConfigPath(cwd, ".pi"), JSON.stringify(value));
  };

  it("resolves paths under agent dir and .pi", () => {
    assert.equal(globalConfigPath(agentDir), join(agentDir, "extensions", "allowlist-gate.json"));
    assert.equal(projectConfigPath(cwd, ".pi"), join(cwd, ".pi", "allowlist-gate.json"));
  });
  it("falls back to defaults without files", () => {
    const config = load(true);
    assert.ok(config.allow.includes("shell:git status *"));
    assert.deepEqual(config.warnings, []);
  });
  it("merges global then project files over defaults", () => {
    writeGlobal({ allow: ["shell:global *"] });
    writeProject({ deny: ["shell:nope *"] });
    const config = load(true);
    assert.deepEqual(config.allow, ["shell:global *"]);
    assert.deepEqual(config.deny, ["shell:nope *"]);
  });
  it("project allow replaces global allow wholesale", () => {
    writeGlobal({ allow: ["shell:global *"] });
    writeProject({ allow: ["shell:local *"] });
    assert.deepEqual(load(true).allow, ["shell:local *"]);
  });
  it("ignores the project file when the project is not trusted, and says so", () => {
    writeGlobal({ allow: ["shell:global *"] });
    writeProject({ allow: ["shell:*"], enabled: false });
    const config = load(false);
    assert.deepEqual(config.allow, ["shell:global *"]);
    assert.equal(config.enabled, true);
    assert.equal(config.warnings.length, 1);
    assert.match(config.warnings[0], /not trusted/);
  });
  it("an invalid global file disables the defaults instead of widening access", () => {
    writeGlobal("{oops");
    const config = load(true);
    assert.deepEqual(config.allow, []);
    assert.equal(config.warnings.length, 1);
  });
});

describe("ensureGlobalConfigFile", () => {
  let agentDir: string;
  const target = () => join(agentDir, "extensions", "allowlist-gate.json");
  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "allowlist-seed-"));
  });
  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
  });
  it("seeds a missing file with the built-in defaults", () => {
    assert.equal(ensureGlobalConfigFile(agentDir), undefined);
    const seeded = JSON.parse(readFileSync(target(), "utf-8")) as { allow: string[]; deny: string[] };
    assert.deepEqual(seeded.allow, DEFAULT_ALLOW);
    assert.deepEqual(seeded.deny, []);
  });
  it("never overwrites an existing file", () => {
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    writeFileSync(target(), JSON.stringify({ allow: ["shell:custom *"] }));
    assert.equal(ensureGlobalConfigFile(agentDir), undefined);
    assert.equal(readFileSync(target(), "utf-8"), JSON.stringify({ allow: ["shell:custom *"] }));
  });
});

describe("formatStatusReport and buildStatusReport", () => {
  let agentDir: string;
  let cwd: string;
  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "allowlist-report-agent-"));
    cwd = mkdtempSync(join(tmpdir(), "allowlist-report-proj-"));
  });
  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("formatStatusReport formats clean text with all sections", () => {
    const report = formatStatusReport({
      enabled: true,
      projectTrusted: true,
      globalPath: "/agent/allowlist-gate.json",
      globalExists: true,
      projectPath: "/proj/.pi/allowlist-gate.json",
      projectExists: false,
      deny: [],
      allow: ["shell:git status *"],
      sessionApproved: ["bash git push origin main"],
      warnings: ["test warning"],
    });

    assert.match(report, /Allowlist Gate:\s*ENABLED/);
    assert.match(report, /Project trust:\s*Trusted/);
    assert.match(report, /Global:\s*\/agent\/allowlist-gate\.json/);
    assert.match(report, /Project:\s*\(none\)/);
    assert.match(report, /Deny rules \(0\):\n\s*\(none\)/);
    assert.match(report, /Allow rules \(1\):\n\s*- shell:git status \*/);
    assert.match(report, /Session approvals \(1\):\n\s*- bash git push origin main/);
    assert.match(report, /Warnings:\n\s*! test warning/);
  });

  it("formatStatusReport flags untrusted project and disabled state", () => {
    const report = formatStatusReport({
      enabled: false,
      projectTrusted: false,
      globalPath: "/agent/allowlist-gate.json",
      globalExists: false,
      projectPath: "/proj/.pi/allowlist-gate.json",
      projectExists: true,
      deny: ["shell:rm *"],
      allow: [],
    });

    assert.match(report, /Allowlist Gate:\s*DISABLED/);
    assert.match(report, /Project trust:\s*Untrusted \(project config ignored\)/);
    assert.match(report, /Global:\s*\/agent\/allowlist-gate\.json \(not found\)/);
    assert.match(report, /Project:\s*\/proj\/\.pi\/allowlist-gate\.json \(IGNORED: untrusted project\)/);
    assert.match(report, /Deny rules \(1\):\n\s*- shell:rm \*/);
    assert.match(report, /Allow rules \(0\):\n\s*\(none\)/);
    assert.match(report, /Session approvals \(0\):\n\s*\(none\)/);
    assert.doesNotMatch(report, /Warnings:/);
  });

  it("buildStatusReport resolves live files and attaches warnings", () => {
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    writeFileSync(globalConfigPath(agentDir), JSON.stringify({ allow: ["shell:git status *"] }));

    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(projectConfigPath(cwd, ".pi"), JSON.stringify({ deny: ["shell:rm *"] }));

    const report = buildStatusReport({
      agentDir,
      cwd,
      configDirName: ".pi",
      projectTrusted: true,
      sessionApproved: ["write notes/todo.md"],
      seedWarning: "seeded global file",
    });

    assert.match(report, /Allowlist Gate:\s*ENABLED/);
    assert.match(report, /Project trust:\s*Trusted/);
    assert.match(report, /Deny rules \(1\)/);
    assert.match(report, /Allow rules \(1\)/);
    assert.match(report, /Session approvals \(1\)/);
    assert.match(report, /write notes\/todo\.md/);
    assert.match(report, /Warnings:\n\s*! seeded global file/);
  });
});
