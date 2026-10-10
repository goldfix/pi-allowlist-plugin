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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
  "shell:rg -n *",
  "shell:find *",
  "shell:head -n *",
  "shell:pi mcp list"
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

export interface StatusReportOptions {
  enabled: boolean;
  projectTrusted: boolean;
  globalPath: string;
  globalExists: boolean;
  projectPath: string;
  projectExists: boolean;
  deny: readonly string[];
  allow: readonly string[];
  sessionApproved?: readonly string[];
  warnings?: readonly string[];
}

/** Formats a multi-line diagnostic report of the effective gate configuration. */
export function formatStatusReport(options: StatusReportOptions): string {
  const lines: string[] = [
    `Allowlist Gate: ${options.enabled ? "ENABLED" : "DISABLED"}`,
    `Project trust:  ${options.projectTrusted ? "Trusted" : "Untrusted (project config ignored)"}`,
    "",
    "Config files:",
    `  Global:  ${options.globalExists ? options.globalPath : `${options.globalPath} (not found)`}`,
  ];

  if (!options.projectExists) {
    lines.push("  Project: (none)");
  } else if (options.projectTrusted) {
    lines.push(`  Project: ${options.projectPath}`);
  } else {
    lines.push(`  Project: ${options.projectPath} (IGNORED: untrusted project)`);
  }

  lines.push("", `Deny rules (${options.deny.length}):`);
  if (options.deny.length > 0) {
    for (const rule of options.deny) lines.push(`  - ${rule}`);
  } else {
    lines.push("  (none)");
  }

  lines.push("", `Allow rules (${options.allow.length}):`);
  if (options.allow.length > 0) {
    for (const rule of options.allow) lines.push(`  - ${rule}`);
  } else {
    lines.push("  (none)");
  }

  const session = options.sessionApproved ?? [];
  lines.push("", `Session approvals (${session.length}):`);
  if (session.length > 0) {
    for (const item of session) lines.push(`  - ${item}`);
  } else {
    lines.push("  (none)");
  }

  const warnings = options.warnings ?? [];
  if (warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const warning of warnings) lines.push(`  ! ${warning}`);
  }

  return lines.join("\n");
}

export interface BuildStatusReportOptions extends LoadConfigOptions {
  sessionApproved?: readonly string[];
  seedWarning?: string;
}

/** Resolves configuration and formats the full status report. */
export function buildStatusReport(options: BuildStatusReportOptions): string {
  const config = loadConfig(options);
  if (options.seedWarning) config.warnings.unshift(options.seedWarning);

  const gPath = globalConfigPath(options.agentDir);
  const pPath = projectConfigPath(options.cwd, options.configDirName);

  return formatStatusReport({
    enabled: config.enabled,
    projectTrusted: options.projectTrusted,
    globalPath: gPath,
    globalExists: existsSync(gPath),
    projectPath: pPath,
    projectExists: existsSync(pPath),
    deny: config.deny,
    allow: config.allow,
    sessionApproved: options.sessionApproved,
    warnings: config.warnings,
  });
}

export interface SaveProjectRulesOptions {
  cwd: string;
  agentDir: string;
  configDirName: string;
  rules: string[];
}

/**
 * Append rules to the project allowlist (`<cwd>/<configDirName>/allowlist-gate.json`);
 * the global file is never touched. Returns the project file path.
 *
 * Project lists replace the global ones wholesale, so the new allowlist is
 * built from the list the project *effectively* has now: its own `allow` when
 * defined, otherwise the global one. A missing project file is seeded with the
 * whole effective global config. A project file that cannot be parsed is never
 * overwritten (it may hold rules the user wants to fix by hand): this throws.
 */
export function saveProjectRules(options: SaveProjectRulesOptions): string {
  const path = projectConfigPath(options.cwd, options.configDirName);

  let projectConfig: FileConfig | undefined;
  if (existsSync(path)) {
    const loaded = loadFileConfig(path);
    if (loaded.warning) throw new Error(`${loaded.warning}; fix or remove it, then retry`);
    projectConfig = loaded.config;
  }

  ensureGlobalConfigFile(options.agentDir);
  const globalFile = loadFileConfig(globalConfigPath(options.agentDir));
  const effective = resolveConfig(mergeFileConfigs(globalFile.config, projectConfig ?? {}));

  const allow = [...effective.allow];
  for (const rule of options.rules) {
    if (!allow.includes(rule)) allow.push(rule);
  }
  const next: FileConfig = projectConfig
    ? { ...projectConfig, allow }
    : { enabled: effective.enabled, allow, deny: effective.deny };

  mkdirSync(dirname(path), { recursive: true });
  // Write-then-rename, so a crash never leaves a half-written config behind.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf-8");
  renameSync(tmp, path);
  return path;
}
