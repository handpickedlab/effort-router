import { open } from "node:fs/promises";
import { type Effort, isEffort } from "./catalog.js";

/** What the plugin's hooks send to the `observe` tool; every field is a substituted hook-input path. */
export interface HookEvent {
  event: string;
  agent_id?: string;
  tool_name?: string;
  command?: string;
  file_path?: string;
  error?: string;
  effort?: string;
  prompt?: string;
  transcript_path?: string;
  /** Agent tool: the brief, the agent type, the model passed, and the result as a JSON content array. */
  brief?: string;
  subagent_type?: string;
  model?: string;
  result?: string;
  status?: string;
  /** Stop: Claude's final text of the turn, and "true" when a stop hook already made it continue. */
  last_message?: string;
  stop_hook_active?: string;
  /** PostToolUseFailure: "true" when the user interrupted the tool. */
  is_interrupt?: string;
  /** NotebookEdit's path field. */
  notebook_path?: string;
  /** SessionStart: startup, resume, clear or compact. */
  source?: string;
}

/**
 * The model of the newest main-thread reply in a Claude Code transcript. Hooks get no model
 * field on tool events, but every assistant line in the transcript records one. Reads the tail only.
 */
export async function modelFromTranscript(file: string, tailBytes = 256 * 1024): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(file, "r");
    const { size } = await handle.stat();
    const start = Math.max(0, size - tailBytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"assistant"')) continue;
      try {
        const entry = JSON.parse(lines[i]) as { type?: string; isSidechain?: boolean; message?: { model?: unknown } };
        const model = entry.message?.model;
        if (entry.type === "assistant" && !entry.isSidechain && typeof model === "string" && model.startsWith("claude-")) return model;
      } catch {
        // A line cut off by the tail window, or not JSON: keep looking.
      }
    }
  } catch {
    // No transcript (yet), or unreadable.
  } finally {
    await handle?.close();
  }
  return undefined;
}

export type Signal =
  | { type: "stuck"; agent?: string; subject: string; same: number; total: number; level: 1 | 2; lastError: string }
  /** The user wrote right after a turn that changed code or hit failures; Jev judges whether they say it didn't work. */
  | { type: "followup"; prompt: string; edited: string[]; failures: number }
  /** The user's reply was judged "it still doesn't work". */
  | { type: "frustration"; count: number }
  /** A delegated effort-router agent returned; worth checking against its brief. */
  | { type: "delegated"; agent: string; model?: string; brief: string; result: string }
  /** The turn is ending after edits: the files, and the commands that passed after the last edit, for Jev to judge. */
  | { type: "turn-end"; files: string[]; checks: string[]; lastMessage: string }
  /** Something that took several failed attempts finally worked: a lesson worth keeping, maybe. */
  | { type: "solved"; subject: string; attempts: number };

/** Failed attempts before a success counts as hard-won. */
const HARD_WON = 3;


/** The text of an Agent result, which hooks deliver as a JSON array of content blocks. */
function resultText(result: string): string {
  try {
    const blocks = JSON.parse(result) as { type?: string; text?: string }[];
    if (Array.isArray(blocks)) return blocks.map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("\n").trim();
  } catch {
    // Not JSON: use it as is.
  }
  return result;
}

/** A hook-input path that doesn't exist arrives empty; treat unexpanded placeholders the same way. */
export function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "undefined" || trimmed === "null" || /^\$\{[^}]*\}$/.test(trimmed)) return undefined;
  return trimmed;
}

// Commands whose non-zero exit is an answer, not a failure: grep finding nothing, diff finding a difference.
const PROBES = new Set([
  "grep", "egrep", "fgrep", "rg", "ag", "ack", "find", "fd", "ls", "cat", "head", "tail", "wc", "test", "[", "[[",
  "which", "command", "type", "stat", "file", "diff", "cmp", "true", "false", "sleep", "pgrep", "ps", "lsof", "echo",
  "printf", "jq",
]);
const GIT_PROBES = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "grep", "branch", "remote", "describe", "merge-base", "cat-file"]);
/** Polling commands exit non-zero while they wait, e.g. `gh pr checks` with checks still pending. */
const GH_POLLS = new Set(["pr checks", "run watch", "run view"]);
const WRAPPERS = new Set(["time", "sudo", "env", "nice", "nohup", "exec"]);
const SETUP = /^(cd|pushd|popd|export|source|\.|set|unset|trap)(\s|$)/;

/** Drops heredoc bodies, so `git commit -m "$(cat <<'EOF' … EOF)"` keys as `git commit`. */
function withoutHeredocs(command: string): string {
  return command.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, "");
}

const basename = (word: string) => word.split("/").at(-1) ?? word;

/**
 * A stable name for "the same command", e.g. `npm test` for `cd app && npm test -- --watch=false 2>&1 | tail`:
 * up to three words of the first command that isn't setup or a probe, skipping flags, paths, files and
 * shell syntax. Undefined when nothing but setup and probes ran.
 */
export function commandKey(command: string): string | undefined {
  for (const segment of withoutHeredocs(command).split(/&&|\|\||;|\n/)) {
    const first = segment.split("|")[0].trim().replace(/^[({]+\s*/, "").replace(/\s*[)}]+$/, "");
    if (!first || SETUP.test(first)) continue;
    const words = first.split(/\s+/).filter((word) => word && !/^\w+=/.test(word));
    while (words.length && WRAPPERS.has(basename(words[0]))) words.shift();
    if (!words.length) continue;
    const program = basename(words[0]);
    if (PROBES.has(program)) continue;
    if (program === "git" && GIT_PROBES.has(words[1] ?? "")) continue;
    if (program === "gh" && GH_POLLS.has(`${words[1]} ${words[2]}`)) continue;

    const key = [program];
    for (const word of words.slice(1)) {
      if (key.length === 3) break;
      if (word.startsWith("-") || word.includes("/") || /[<>&|$`"'()=*]/.test(word) || /\.\w{1,5}$/.test(word)) continue;
      key.push(word);
    }
    return key.join(" ");
  }
  return undefined;
}

/** Claude Code's own markers in tool errors: the exit-code line, and the one it adds when the user interrupts. */
const EXIT_LINE = /^Exit code \d+$/;
const INTERRUPTED = "[Request interrupted by user";

const normalise = (line: string) =>
  line
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/0x[0-9a-f]+/gi, "#")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ");

const outputLines = (error: string) =>
  error.split("\n").map((line) => line.trim()).filter((line) => line && !EXIT_LINE.test(line) && !line.startsWith(INTERRUPTED));

/**
 * The whole error output as a set of lines with volatile parts (colours, numbers, addresses) removed.
 * A set, sorted: a new error next to pre-existing ones reads as progress, only an identical repeat is equal.
 */
export function errorSignature(error: string): string {
  return [...new Set(outputLines(error).slice(0, 200).map(normalise))].sort().join(" | ").slice(0, 4000);
}

function firstErrorLine(error: string): string {
  return (outputLines(error)[0] ?? "").slice(0, 200);
}

/** Hook-delivered text that the user didn't type: slash commands, task notifications, system notices. */
function typedByUser(prompt: string): boolean {
  return !/^\s*[/<[]/.test(prompt) && !prompt.includes("<task-notification>");
}

/** Removes Claude Code's pasted-content blocks in one linear pass; an unclosed block runs to the end. */
function withoutPastes(prompt: string): string {
  const open = '<pasted_content id="';
  let own = "";
  let from = 0;
  for (;;) {
    const start = prompt.indexOf(open, from);
    const idEnd = start < 0 ? -1 : prompt.indexOf('">', start);
    if (idEnd < 0) return own + prompt.slice(from);
    own += `${prompt.slice(from, start)} `;
    const close = `</pasted_content id="${prompt.slice(start + open.length, idEnd)}">`;
    const end = prompt.indexOf(close, idEnd);
    if (end < 0) return own;
    from = end + close.length;
  }
}

/** The user's own words: Claude Code fences pasted logs and code, and marks prompts it generates itself. */
export function ownWords(prompt: string): string | undefined {
  if (!typedByUser(prompt)) return undefined;
  return withoutPastes(prompt).trim().slice(0, 2000) || undefined;
}

interface Streak {
  signature: string;
  same: number;
  total: number;
  nudged: number;
  at: number;
}

/** Failures further apart than this belong to different episodes, not one stuck streak. */
const STREAK_WINDOW_MS = 30 * 60 * 1000;

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

const freshTurn = () => ({ edited: new Set<string>(), checks: [] as string[], failures: 0, nudged: false });

/**
 * Per-session state fed by hook events. Claude Code starts one stdio server per session, so
 * this in-memory state is scoped to one session; subagents are kept apart by `agent_id`.
 */
export class Observer {
  private readonly streaks = new Map<string, Streak>();
  /** When each recent frustration signal came; older than the streak window they no longer count. */
  private frustrations: number[] = [];
  /** Main-thread activity since the user's last prompt: the facts Jev judges at the end of the turn. */
  private turn = freshTurn();

  constructor(private readonly now: () => number = Date.now) {}

  /** `/clear` keeps the server process but starts a new conversation. */
  private reset(): void {
    this.streaks.clear();
    this.frustrations = [];
    this.turn = freshTurn();
    this.effort = undefined;
    this.transcriptPath = undefined;
  }

  /** Called when Jev judged a follow-up as "it still doesn't work"; returns how many in the window. */
  recordFrustration(): number {
    const at = this.now();
    this.frustrations = [...this.frustrations.filter((t) => at - t <= STREAK_WINDOW_MS), at];
    return this.frustrations.length;
  }
  /** Last effort level reported by a main-thread tool event. */
  effort: Effort | undefined;
  /** The main conversation's transcript, where the session's current model can be read. */
  transcriptPath: string | undefined;

  private subject(event: HookEvent): { key: string; label: string } | undefined {
    const agent = present(event.agent_id) ?? "main";
    const tool = present(event.tool_name);
    if (tool === "Bash") {
      const command = present(event.command);
      const key = command && commandKey(command);
      return key ? { key: `${agent}|bash|${key}`, label: `\`${key}\`` } : undefined;
    }
    const file = present(event.file_path) ?? present(event.notebook_path);
    if (tool && FILE_TOOLS.has(tool) && file) return { key: `${agent}|${tool}|${file}`, label: `${tool} on \`${file}\`` };
    return undefined;
  }

  private track(event: HookEvent): void {
    const tool = present(event.tool_name);
    const file = present(event.file_path) ?? present(event.notebook_path);
    const command = present(event.command);
    if (tool && FILE_TOOLS.has(tool) && file) {
      this.turn.edited.add(file);
      this.turn.checks = [];
    } else if (tool === "Bash" && command && this.turn.edited.size && this.turn.checks.length < 20) {
      this.turn.checks.push(command.slice(0, 300));
    }
  }

  private delegated(event: HookEvent): Signal | undefined {
    const agent = present(event.subagent_type);
    const brief = present(event.brief);
    const result = present(event.result);
    if (!agent?.startsWith("effort-router:") || present(event.status) !== "completed" || !brief || !result) return undefined;
    // Max is the escalation path: nothing above it to retry on, but its diagnosis is often worth keeping.
    if (agent === "effort-router:max") return { type: "solved", subject: "the effort-router:max escalation", attempts: 0 };
    return { type: "delegated", agent, model: present(event.model), brief, result: resultText(result) };
  }

  observe(event: HookEvent): Signal | undefined {
    const agent = present(event.agent_id);
    if (!agent) {
      const effort = present(event.effort);
      if (isEffort(effort)) this.effort = effort;
      this.transcriptPath = present(event.transcript_path) ?? this.transcriptPath;
    }

    switch (event.event) {
      case "PostToolUseFailure": {
        const subject = this.subject(event);
        if (!subject) return undefined;
        const error = present(event.error) ?? "";
        // The user stopping a command is a redirect, not the agent failing.
        if (present(event.is_interrupt) === "true" || error.includes(INTERRUPTED)) return undefined;
        if (!agent) this.turn.failures++;
        const signature = errorSignature(error);
        const at = this.now();
        const stored = this.streaks.get(subject.key);
        const previous = stored && at - stored.at <= STREAK_WINDOW_MS ? stored : undefined;
        const same = previous?.signature === signature ? previous.same + 1 : 1;
        const total = (previous?.total ?? 0) + 1;
        // Same error three times means stuck; five failures with shifting errors means churning.
        const level = same >= 5 || total >= 8 ? 2 : same >= 3 || total >= 5 ? 1 : 0;
        const nudged = previous?.nudged ?? 0;
        this.streaks.set(subject.key, { signature, same, total, nudged: Math.max(nudged, level), at });
        if (level <= nudged) return undefined;
        return { type: "stuck", agent, subject: subject.label, same, total, level: level as 1 | 2, lastError: firstErrorLine(error) };
      }
      case "PostToolUse": {
        if (present(event.tool_name) === "Agent") return agent ? undefined : this.delegated(event);
        const subject = this.subject(event);
        const streak = subject && this.streaks.get(subject.key);
        if (subject) this.streaks.delete(subject.key);
        if (agent) return undefined;
        this.track(event);
        if (streak && streak.total >= HARD_WON && this.now() - streak.at <= STREAK_WINDOW_MS) {
          return { type: "solved", subject: subject.label, attempts: streak.total };
        }
        return undefined;
      }
      case "Stop": {
        const { edited, checks, nudged } = this.turn;
        if (nudged || present(event.stop_hook_active) === "true" || !edited.size) return undefined;
        this.turn.nudged = true;
        return { type: "turn-end", files: [...edited], checks: [...checks], lastMessage: present(event.last_message) ?? "" };
      }
      case "UserPromptSubmit": {
        const previous = this.turn;
        this.turn = freshTurn();
        // Effort is per turn: a gear from the last turn is gone, and the next tool event reports the new level.
        this.effort = undefined;
        const prompt = ownWords(present(event.prompt) ?? "");
        // Only a reply to a turn that changed code or hit failures can say "it still doesn't work".
        if (!prompt || (!previous.edited.size && !previous.failures)) return undefined;
        return { type: "followup", prompt, edited: [...previous.edited], failures: previous.failures };
      }
      case "SessionStart": {
        if (present(event.source) === "clear") this.reset();
        return undefined;
      }
      default:
        return undefined;
    }
  }
}
