/**
 * Path handling for `edit`/`write` targets.
 *
 * Pi normalizes tool paths before using them (`@` prefix, `~`, `file://` URLs,
 * Git-Bash style `/c/...` on Windows). The gate must see the same final path
 * Pi will touch, otherwise `~/.bashrc` would look like an in-project file.
 * This mirrors the host's `resolvePath` (not exported by the package).
 */
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

export interface ClassifiedPath {
  /**
   * Rule-matching form: project-relative with `/` separators when inside the
   * project, absolute with `/` separators when outside.
   */
  resource: string;
  /** The target lies outside the project directory (cwd). */
  outside: boolean;
}

/** Convert Git Bash / MSYS / Cygwin / WSL drive paths (`/c/x`) to native Windows form. */
function normalizeWindowsShellPath(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return path;
  const match = path.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  if (!match) return path;
  return `${match[1].toUpperCase()}:\\${(match[2] ?? "").replaceAll("/", "\\")}`;
}

/** Absolute path Pi will operate on for a tool `path` argument. */
export function resolveToolPath(target: string, cwd: string): string {
  let path = String(target).replace(UNICODE_SPACES, " ");
  if (path.startsWith("@")) path = path.slice(1);
  if (process.platform === "win32") path = normalizeWindowsShellPath(path);
  if (path === "~") {
    path = homedir();
  } else if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"))) {
    path = join(homedir(), path.slice(2));
  }
  if (/^file:\/\//.test(path)) path = fileURLToPath(path);
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

export function classifyPath(target: string, cwd: string): ClassifiedPath {
  const absolute = resolveToolPath(target, cwd);
  const rel = relative(resolve(cwd), absolute);
  // `sep` matters: on Windows relative() returns backslash-separated paths,
  // and a different drive yields an absolute result.
  const outside = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  const resource = (outside ? absolute : rel || ".").replaceAll("\\", "/");
  return { resource, outside };
}
