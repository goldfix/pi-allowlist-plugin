import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  globalConfigPath,
  loadConfig,
  loadFileConfig,
  mergeFileConfigs,
  projectConfigPath,
  resolveConfig,
} from "../extensions/allowlist-gate/config.ts";

describe("resolveConfig", () => {
  it("applies minimal defaults", () => {
    const config = resolveConfig({}, {});
    assert.equal(config.enabled, true);
    assert.ok(config.allow.includes("shell:git status *"));
    assert.ok(config.allow.includes("mcp:docs-mcp-server"));
    assert.deepEqual(config.deny, []);
  });
  it("options win over env", () => {
    const config = resolveConfig(
      { allow: ["shell:git pull *"], deny: ["shell:rm -rf *"], enabled: false },
      {
        ALLOWLIST_GATE_ALLOW: "shell:ls *",
        ALLOWLIST_GATE_DENY: "shell:cat *",
        ALLOWLIST_GATE_ENABLED: "true",
      },
    );
    assert.deepEqual(config.allow, ["shell:git pull *"]);
    assert.deepEqual(config.deny, ["shell:rm -rf *"]);
    assert.equal(config.enabled, false);
  });
  it("env is comma/newline separated", () => {
    const config = resolveConfig(
      {},
      { ALLOWLIST_GATE_ALLOW: "shell:a *,shell:b *\nshell:c *" },
    );
    assert.deepEqual(config.allow, ["shell:a *", "shell:b *", "shell:c *"]);
  });
  it("explicit empty allow disables defaults", () => {
    assert.deepEqual(resolveConfig({ allow: [] }, {}).allow, []);
  });
  it("parses enabled flag variants", () => {
    assert.equal(resolveConfig({}, { ALLOWLIST_GATE_ENABLED: "0" }).enabled, false);
    assert.equal(resolveConfig({}, { ALLOWLIST_GATE_ENABLED: "off" }).enabled, false);
    assert.equal(resolveConfig({ enabled: true }, { ALLOWLIST_GATE_ENABLED: "0" }).enabled, true);
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
  const load = (projectTrusted: boolean) => loadConfig({ cwd, agentDir, configDirName: ".pi", projectTrusted, env: {} });
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
