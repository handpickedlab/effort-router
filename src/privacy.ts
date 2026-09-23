import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Which projects may send data to Jev. Kept outside the repositories, so a client repo needs no
 * committed file. A path covers everything below it: one entry covers all worktrees of a repo.
 *
 *   { "jev": "on",  "exclude": ["~/Documents/Projects/client-x"] }   on, except these
 *   { "jev": "off", "include": ["~/Documents/Projects/mine"] }        off, except these
 */
export interface PrivacyConfig {
  jev?: "on" | "off";
  include?: string[];
  exclude?: string[];
}

export const CONFIG_FILE = path.join(homedir(), ".config", "effort-router", "config.json");

export interface JevAccess {
  allowed: boolean;
  why: string;
}

function expand(entry: string): string {
  const full = path.resolve(entry.replace(/^~(?=$|\/)/, homedir()));
  try {
    return realpathSync(full);
  } catch {
    return full;
  }
}

const covers = (entry: string, dir: string) => {
  const root = expand(entry);
  return dir === root || dir.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
};

/** The decision for one project directory; the most specific (longest) matching entry wins. */
export function jevAccess(config: PrivacyConfig, dir: string): JevAccess {
  const where = expand(dir);
  const longest = (entries: string[] = []) => entries.filter((e) => covers(e, where)).sort((a, b) => expand(b).length - expand(a).length)[0];
  const included = longest(config.include);
  const excluded = longest(config.exclude);
  if (included && (!excluded || expand(included).length > expand(excluded).length)) return { allowed: true, why: `included by ${included}` };
  if (excluded) return { allowed: false, why: `excluded by ${excluded}` };
  return config.jev === "off" ? { allowed: false, why: 'default "off"' } : { allowed: true, why: 'default "on"' };
}

let cached: { mtimeMs: number; config: PrivacyConfig | Error } | undefined;

/** The config file, re-read when it changes. No file means Jev is on; an unreadable one means off. */
function loadConfig(file: string): PrivacyConfig | Error {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    return {};
  }
  if (cached?.mtimeMs === mtimeMs) return cached.config;
  let config: PrivacyConfig | Error;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as PrivacyConfig;
    const lists = [parsed.include, parsed.exclude].every((l) => l === undefined || (Array.isArray(l) && l.every((e) => typeof e === "string")));
    config = lists && (parsed.jev === undefined || parsed.jev === "on" || parsed.jev === "off") ? parsed : new Error("unexpected shape");
  } catch (error) {
    config = error instanceof Error ? error : new Error(String(error));
  }
  cached = { mtimeMs, config };
  return config;
}

/** Whether this session's project may send data to Jev. A broken config fails closed. */
export function projectJevAccess(dir = process.env.CLAUDE_PROJECT_DIR || process.cwd(), file = CONFIG_FILE): JevAccess & { dir: string } {
  const config = loadConfig(file);
  if (config instanceof Error) return { allowed: false, why: `${file} is invalid (${config.message}), so Jev stays off`, dir };
  return { ...jevAccess(config, dir), dir };
}
