/**
 * Configuration resolution: JSON files + environment, no other persistence.
 *
 * Two JSON files are merged (project wins, lists replaced wholesale):
 * - global:  `<agent-dir>/extensions/allowlist-gate.json`
 * - project: `<cwd>/.pi/allowlist-gate.json` (CONFIG_DIR_NAME from the host).
 *   Read only when the project is trusted: an untrusted repository must not be
 *   able to widen its own allowlist.
 *
 * Shape of each file:
 * ```json
 * {
 *   "enabled": true,
 *   "allow": ["shell:git pull *", "mcp:docs-mcp-server"],
 *   "deny": ["shell:rm -rf *"]
 * }
 * ```
 *
 * Environment fallback (same names as the OpenCode sibling plugin):
 * - `ALLOWLIST_GATE_ALLOW` / `ALLOWLIST_GATE_DENY`: comma- or newline-separated
 *   rule lists. Used only when the merged files do not define that list.
 * - `ALLOWLIST_GATE_ENABLED`: `1/true/yes/on` or `0/false/no/off`.
 *
 * Defaults are intentionally minimal: a few read-only shell commands pass,
 * everything else gated asks. An explicit `"allow": []` disables the defaults.
 *
 * Fail-safe: an unreadable/invalid file never widens access. It is treated as
 * `{ "allow": [] }` (nothing is auto-allowed, everything gated asks) and a
 * warning is reported through {@link GateConfig.warnings}.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RuleLists } from "./policy.ts";

export const CONFIG_FILE_NAME = "allowlist-gate.json";

export interface GateConfig extends RuleLists {
  enabled: boolean;
  /** Human-readable problems found while loading (invalid file, untrusted project, …). */
  warnings: string[];
}

/** Partial shape accepted from JSON files (unknown fields ignored). */
export interface FileConfig {
  enabled?: unknown;
  allow?: unknown;
  deny?: unknown;
}

export interface LoadedFile {
  config: FileConfig;
  warning?: string;
}

const DEFAULT_ALLOW: string[] = [
  "shell:git status *",
  "shell:git diff *",
  "shell:git log *",
  "shell:ls *",
  "shell:cat *",
  "shell:pwd *",
  "shell:echo *",
  "mcp:docs-mcp-server",
];

function toStringList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return String(value)
    .split(/[\n,]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function toBool(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return fallback;
}

/** Combine file-level settings with the environment fallback and defaults. */
export function resolveConfig(fileConfig: FileConfig, env: NodeJS.ProcessEnv = {}): Omit<GateConfig, "warnings"> {
  return {
    enabled: toBool(fileConfig.enabled ?? env.ALLOWLIST_GATE_ENABLED, true),
    allow: toStringList(fileConfig.allow ?? env.ALLOWLIST_GATE_ALLOW) ?? [...DEFAULT_ALLOW],
    deny: toStringList(fileConfig.deny ?? env.ALLOWLIST_GATE_DENY) ?? [],
  };
}

/** Merge global and project file configs; project lists replace wholesale. */
export function mergeFileConfigs(globalConfig: FileConfig, projectConfig: FileConfig): FileConfig {
  return {
    enabled: projectConfig.enabled ?? globalConfig.enabled,
    allow: projectConfig.allow ?? globalConfig.allow,
    deny: projectConfig.deny ?? globalConfig.deny,
  };
}

/** Read one JSON config file; a missing file yields `{}`, an invalid one fails safe. */
export function loadFileConfig(path: string): LoadedFile {
  if (!existsSync(path)) return { config: {} };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { config: { allow: [] }, warning: `${path}: top-level JSON must be an object; nothing is auto-allowed` };
    }
    return { config: parsed as FileConfig };
  } catch (error) {
    return { config: { allow: [] }, warning: `${path}: cannot be read (${error}); nothing is auto-allowed` };
  }
}

export function globalConfigPath(agentDir: string): string {
  return join(agentDir, "extensions", CONFIG_FILE_NAME);
}

export function projectConfigPath(cwd: string, configDirName: string): string {
  return join(cwd, configDirName, CONFIG_FILE_NAME);
}

export interface LoadConfigOptions {
  cwd: string;
  agentDir: string;
  /** Host `CONFIG_DIR_NAME` (`.pi`). */
  configDirName: string;
  /** Whether the project config file may be honored. */
  projectTrusted: boolean;
  env?: NodeJS.ProcessEnv;
}

/** Full resolution for one working directory: files + env. */
export function loadConfig(options: LoadConfigOptions): GateConfig {
  const warnings: string[] = [];
  const globalFile = loadFileConfig(globalConfigPath(options.agentDir));
  if (globalFile.warning) warnings.push(globalFile.warning);

  let projectConfig: FileConfig = {};
  const projectPath = projectConfigPath(options.cwd, options.configDirName);
  if (!options.projectTrusted) {
    if (existsSync(projectPath)) warnings.push(`${projectPath}: ignored because the project is not trusted`);
  } else {
    const projectFile = loadFileConfig(projectPath);
    projectConfig = projectFile.config;
    if (projectFile.warning) warnings.push(projectFile.warning);
  }

  const merged = mergeFileConfigs(globalFile.config, projectConfig);
  return { ...resolveConfig(merged, options.env ?? process.env), warnings };
}
