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
  | { type: "frustration"; count: number }
  /** A delegated effort-router agent returned; worth checking against its brief. */
  | { type: "delegated"; agent: string; model?: string; brief: string; result: string }
  /** The turn is ending after code edits with no successful check since the last one. */
  | { type: "unverified"; files: string[]; lastMessage: string }
  /** Something that took several failed attempts finally worked: a lesson worth keeping, maybe. */
  | { type: "solved"; subject: string; attempts: number };

/** Failed attempts before a success counts as hard-won. */
const HARD_WON = 3;

/** Commands that count as checking the work: tests, builds, type checks, linters. */
const VERIFY =
  /\b(test|tests|vitest|jest|pytest|mocha|ava|playwright|cypress|tsc|typecheck|type-check|lint|eslint|biome|build|check|clippy|rspec|phpunit|xcodebuild)\b|\bgo (test|build|vet)\b|\bmake\b/;
/** Edits that need no check: prose, and scratch files outside the project. */
const UNCHECKED = /\.(md|mdx|txt|rst)$|^\/(private\/)?tmp\//;

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

const SALIENT = /error|fail|exception|cannot|can't|not found|undefined|expected|denied|refused|timed out|panic/i;

/** Runner boilerplate that is identical for every failure, and Claude Code's interrupt marker. */
const NOISE = /^(npm (error|ERR!)|ELIFECYCLE|\[Request interrupted)/i;
const INTERRUPTED = "[Request interrupted by user";

const normalise = (line: string) =>
  line
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/0x[0-9a-f]+/gi, "#")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ");

/**
 * The set of error lines with volatile parts (colours, numbers, addresses) removed. A set, sorted, so
 * a new error next to pre-existing ones reads as progress, and only an identical repeat compares equal.
 */
export function errorSignature(error: string): string {
  const lines = error.split("\n").map((line) => line.trim()).filter((line) => line && !NOISE.test(line) && !/^Exit code \d+$/.test(line));
  const salient = lines.filter((line) => SALIENT.test(line));
  const picked = salient.length ? salient.slice(0, 40) : lines.slice(-3);
  return [...new Set(picked.map(normalise))].sort().join(" | ").slice(0, 2000);
}

function firstErrorLine(error: string): string {
  const lines = error.split("\n").map((line) => line.trim()).filter((line) => line && !NOISE.test(line) && !/^Exit code \d+$/.test(line));
  return (lines.find((line) => SALIENT.test(line)) ?? lines[0] ?? "").slice(0, 200);
}

// Persistence tied to an earlier attempt, not a first bug report or a spec: "werkt niet" is a new task,
// "werkt nog steeds niet" is not, and "the same error format as the API" is a requirement.
const FRUSTRATION = [
  /\bnog\s+(steeds|altijd)\s+(niet|kapot|fout|fouten|errors?|stuk|rood)\b/i,
  /\b(faalt|falen|kapot|crasht|crashen)\s+(het\s+|hij\s+|ze\s+)?nog\s+(steeds|altijd)\b/i,
  /\bwerkt\s+(alsnog|weer|nog\s+steeds|nog\s+altijd)\s+niet\b/i,
  /\b(de\s+)?zelfde\s+(fout|error|foutmelding)(?![-\w])(?!\s+(format|afhandeling|als\s+bij))/i,
  /\b(weer|opnieuw)\s+(kapot|stuk)\b/i,
  /\b(helpt|hielp)\s+niet\b/i,
  /\brondjes\b/i,
  /\bblijft\s+(falen|mislukken|crashen)\b/i,
  /\bstill\s+(not\b|broken|failing|fails|failed|erroring|crashing|crashes|red\b|wrong\b|the\s+same\b|getting\b|seeing\b|doesn't|does\s+not|isn't|won't)/i,
  /\bsame\s+(error|failure|problem|issue|bug)\s+(again|as\s+before|as\s+last\s+time)\b/i,
  /\b(didn't|did\s+not|doesn't|does\s+not)\s+(fix|help)\s+(it|anything|the)\b/i,
  /\bgo(ing)?\s+in\s+circles\b/i,
];

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

/** Only the user's own words count; pasted logs and code are fenced by Claude Code. */
export function isFrustrated(prompt: string): boolean {
  if (!typedByUser(prompt)) return false;
  const own = withoutPastes(prompt).slice(0, 4000);
  return FRUSTRATION.some((pattern) => pattern.test(own));
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

/**
 * Per-session state fed by hook events. Claude Code starts one stdio server per session, so
 * this in-memory state is scoped to one session; subagents are kept apart by `agent_id`.
 */
export class Observer {
  private readonly streaks = new Map<string, Streak>();
  /** When each recent frustration signal came; older than the streak window they no longer count. */
  private frustrations: number[] = [];
  /** Main-thread activity since the user's last prompt, to tell whether edits were checked. */
  private turn = { step: 0, lastEdit: -1, lastCheck: -1, edited: new Set<string>(), nudged: false };

  constructor(private readonly now: () => number = Date.now) {}

  /** `/clear` keeps the server process but starts a new conversation. */
  private reset(): void {
    this.streaks.clear();
    this.frustrations = [];
    this.turn = { step: 0, lastEdit: -1, lastCheck: -1, edited: new Set(), nudged: false };
    this.effort = undefined;
    this.transcriptPath = undefined;
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
      this.turn.lastEdit = ++this.turn.step;
      this.turn.edited.add(file);
    } else if (tool === "Bash" && command && VERIFY.test(command)) {
      this.turn.lastCheck = ++this.turn.step;
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
        const { lastEdit, lastCheck, edited, nudged } = this.turn;
        if (nudged || present(event.stop_hook_active) === "true" || lastEdit <= lastCheck) return undefined;
        const files = [...edited].filter((file) => !UNCHECKED.test(file));
        if (!files.length) return undefined;
        this.turn.nudged = true;
        return { type: "unverified", files, lastMessage: present(event.last_message) ?? "" };
      }
      case "UserPromptSubmit": {
        this.turn = { step: 0, lastEdit: -1, lastCheck: -1, edited: new Set(), nudged: false };
        // Effort is per turn: a gear from the last turn is gone, and the next tool event reports the new level.
        this.effort = undefined;
        const prompt = present(event.prompt);
        if (!prompt || !isFrustrated(prompt)) return undefined;
        const at = this.now();
        this.frustrations = [...this.frustrations.filter((t) => at - t <= STREAK_WINDOW_MS), at];
        return { type: "frustration", count: this.frustrations.length };
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
