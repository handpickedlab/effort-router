import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/**
 * State every session shares: the activity registry and the decision log. A fixed path rather than
 * the plugin data directory, so it doesn't depend on how the plugin is installed.
 */
export function stateDir(): string {
  return process.env.EFFORT_ROUTER_STATE_DIR || path.join(homedir(), ".local", "state", "effort-router");
}

/** Identifies this session's server process in the registry and the log. */
export const SESSION = `${process.pid}-${Date.now().toString(36)}`;

const LOG_LIMIT_BYTES = 5 * 1024 * 1024;

/**
 * One JSON line per decision or hook signal, for tuning thresholds later (`npm run stats`).
 * Local only. Rotates to decisions.1.jsonl at 5 MB.
 */
export async function logDecision(entry: Record<string, unknown>): Promise<void> {
  const file = path.join(stateDir(), "decisions.jsonl");
  try {
    await mkdir(stateDir(), { recursive: true });
    const size = await stat(file).then((s) => s.size, () => 0);
    if (size > LOG_LIMIT_BYTES) await rename(file, path.join(stateDir(), "decisions.1.jsonl"));
    await appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), session: SESSION, ...entry })}\n`);
  } catch {
    // The log is for tuning only; never let it break a hook.
  }
}
