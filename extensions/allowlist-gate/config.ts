/**
 * Configuration resolution: JSON files only, no other persistence.
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
 * Defaults are intentionally minimal: a few read-only shell commands pass,
 * everything else gated asks. An explicit `"allow": []` disables the defaults.
 *
 * Fail-safe: an unreadable/invalid file never widens access. It is treated as
 * `{ "allow": [] }` (nothing is auto-allowed, everything gated asks) and a
 * warning is reported through {@link GateConfig.warnings}.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

/** Built-in allowlist, used as the default and as the seed for a new global file. */
export const DEFAULT_ALLOW: string[] = [
  "shell:git status *",
  "shell:git diff *",
  "shell:git log *",
  "shell:ls *",
  "shell:cat *",
  "shell:pwd *",
  "shell:echo *",
  "shell:wc *",
  "shell:grep *",
  "shell:tail *",
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

/** Combine file-level settings with the built-in defaults. */
export function resolveConfig(fileConfig: FileConfig): Omit<GateConfig, "warnings"> {
  return {
    enabled: toBool(fileConfig.enabled, true),
    allow: toStringList(fileConfig.allow) ?? [...DEFAULT_ALLOW],
    deny: toStringList(fileConfig.deny) ?? [],
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

/**
 * Create the global config file with the built-in defaults when it is missing,
 * so the user finds it ready to edit. Never overwrites an existing file (the
 * `wx` flag makes the creation atomic under concurrent tool calls).
 * Returns a warning when the file cannot be created, otherwise `undefined`.
 */
export function ensureGlobalConfigFile(agentDir: string): string | undefined {
  const path = globalConfigPath(agentDir);
  if (existsSync(path)) return undefined;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const seed = { enabled: true, allow: [...DEFAULT_ALLOW], deny: [] as string[] };
    writeFileSync(path, JSON.stringify(seed, null, 2) + "\n", { flag: "wx" });
    return undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "EEXIST") return undefined; // won by a concurrent call
    return `${path}: cannot create the default config (${error}); using built-in defaults`;
  }
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
}

/** Full resolution for one working directory: global + project files. */
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
  return { ...resolveConfig(merged), warnings };
}
