import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { Activity, describeOverlap, repoOf } from "./activity.js";
import { BUNDLED, type Catalog, EFFORTS, dataDir, loadLiveCatalog } from "./catalog.js";
import { FACT_SCOPES, type FactVerdict, judge, keySource, judgeDone, judgeFollowup, judgeKnowledge, judgeResult, rankOptions } from "./jev.js";
import { CONFIG_FILE, projectJevAccess } from "./privacy.js";
import { SESSION, logDecision, stateDir } from "./state.js";
import { type HookEvent, Observer, type Signal, modelFromTranscript } from "./observe.js";
import { KINDS, LEVELS, SCOPES, type Session, TARGETS, TIERS, type Tier, decide, describe, render, renderCatalog } from "./policy.js";

export const VERSION = "0.1.0";

const INSTRUCTIONS = `effort-router picks the model and reasoning effort for the work in front of you; its route tool asks Jev (TypeSafe AI) to judge the task. It has three levers: gear skills (effort-router:gear-xhigh, effort-router:gear-max) that raise this session's effort until the user's next prompt, subagents (effort-router:low … effort-router:max) that run on a chosen model at a fixed effort, and advice you relay to the user. You can't switch your own model: a stronger or cheaper model always means a subagent.

It also has two consult tools. knowledge: before you save a memory, or when a hard-won fix lands, pass the candidate lessons; it says which are worth keeping and where. rank: when choosing between approaches, pass the goal and up to 50 candidates; it returns the probability each works, best first. One candidate makes it a sanity check.

Call its route tool (load it with ToolSearch if it is deferred):
- when the user gives you a task that will take more than a few tool calls;
- before you delegate work to a subagent;
- when you have failed twice at the same problem.

Pass an honest assessment, plus current_model from your system prompt and current_effort if you know it. Then follow the "do:" line. When it names an Agent, pass exactly the model it gives: the agent file only fixes the effort. Relay a /effort suggestion to the user in one line.

To turn Jev off for a project, run \`jev off <path>\` with Bash (\`jev status\` shows the state). Never handle the TypeSafe key yourself: \`jev key\` prints the command the user runs in their own terminal.

Notes that start with [effort-router] come from this plugin's hooks: a command keeps failing, or the user says it still doesn't work.`;

/** Below this, a lesson isn't worth a memory. */
const KEEP = 0.5;

const WHERE: Record<keyof typeof FACT_SCOPES, string> = {
  session: "nowhere: it only matters in this conversation",
  project: "project memory (your memory directory), shared by every session and worktree of this repo",
  user: "user memory; if it matters in every project, ~/.claude/CLAUDE.md, after asking the user",
  tooling: "~/.claude/CLAUDE.md (loads in every project), after asking the user; project memory if it's specific to this repo",
  repo_docs: "the repo's CLAUDE.md or AGENTS.md: that changes it for every contributor, so propose it to the user rather than committing it",
};

function renderKnowledge(model: string, verdicts: FactVerdict[]): string {
  const lines = verdicts.map((v, i) => {
    const keep = v.keep >= KEEP && v.scope !== "session";
    return `${i + 1}. ${keep ? "KEEP" : "skip"} (${v.keep.toFixed(2)}) → ${keep ? `${v.scope}: ${WHERE[v.scope]}` : "not worth a memory"}${keep && v.scopeConfidence < 0.6 ? ` [scope unsure: ${v.scopeConfidence.toFixed(2)}]` : ""}\n   ${v.fact}`;
  });
  return [`knowledge (judged by ${model}):`, ...lines, "Write kept lessons as one fact each, with why it matters. Don't save what the code or git history already says."].join("\n");
}

function renderRanking(model: string, verdicts: { option: string; viable: number; best: number; criteria: number[] }[], criteria: string[]): string {
  if (verdicts.length === 1) {
    const [v] = verdicts;
    const verdict = v.viable >= 0.6 ? "looks sound" : v.viable >= 0.35 ? "is doubtful" : "looks unlikely to work";
    const extra = criteria.map((c, i) => `   ${c} → ${v.criteria[i].toFixed(2)}`);
    return [`sanity check (judged by ${model}): ${verdict} (${v.viable.toFixed(2)})`, `   ${v.option}`, ...extra].join("\n");
  }
  const sorted = [...verdicts].sort((a, b) => b.viable - a.viable || b.best - a.best);
  const header = `rank (judged by ${model}): viable = sound and likely to work; best = share of the best-option vote${criteria.map((c, i) => `; c${i + 1} = ${c}`).join("")}`;
  const rows = sorted.map((v, i) => {
    const extra = v.criteria.map((p, c) => ` c${c + 1} ${p.toFixed(2)}`).join("");
    return `${String(i + 1).padStart(2)}. viable ${v.viable.toFixed(2)}  best ${v.best.toFixed(2)}${extra}  ${v.option}`;
  });
  return [header, ...rows, "These are Jev's odds from the text given, not a test result: check the top one against the code before committing to it."].join("\n");
}

/** With EFFORT_ROUTER_DEBUG set, every hook event is appended to <data dir>/debug.jsonl. */
async function debugLog(event: object): Promise<void> {
  try {
    await mkdir(dataDir(), { recursive: true });
    await appendFile(path.join(dataDir(), "debug.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
  } catch {
    // Debugging aid only.
  }
}

const text = (value: string): CallToolResult => ({ content: [{ type: "text", text: value }] });

const ROUTINE: Tier[] = ["quick", "standard"];
/** Below this, Jev thinks a delegated result missed its brief. */
const RESULT_OK = 0.35;
/** Jev's done check nudges when the change needs a check, none ran, and the message says done. */
const DONE = { needsCheck: 0.5, checked: 0.5, claimsDone: 0.6 };
/** At or above this, Jev reads the user's reply as "it still doesn't work". */
const PERSISTS = 0.6;
const ROUTINE_HINT_EVERY_MS = 30 * 60 * 1000;

/** File tools whose successful edits go into the activity registry. */
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export function createServer(options: { liveCatalog?: boolean; activity?: Activity } = {}): { server: McpServer; activity: Activity } {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const activity = options.activity ?? new Activity(path.join(stateDir(), "sessions"), SESSION, projectDir);
  let catalog: Catalog = BUNDLED;
  if (options.liveCatalog ?? !process.env.EFFORT_ROUTER_OFFLINE) {
    // In the background: the server must answer `initialize` before the network does.
    void loadLiveCatalog().then((live) => {
      if (live) catalog = live;
    });
  }

  const observer = new Observer();
  const recent: Tier[] = [];
  let lastModel: string | undefined;
  let routineHintAt = 0;
  let gears = 0;
  let persistentHintShown = false;
  let unrankedShown = false;

  /** What the caller says, else what the transcript and hooks show, else what the caller said before. */
  async function session(model?: string, effort?: Session["effort"]): Promise<Session> {
    const replied = !model && observer.transcriptPath ? await modelFromTranscript(observer.transcriptPath) : undefined;
    return {
      model: model ?? replied ?? lastModel,
      effort: effort ?? observer.effort,
      effortObserved: !effort && observer.effort !== undefined,
    };
  }

  async function escalation(signal: Signal): Promise<string | undefined> {
    if (signal.type === "delegated") return retryOneUp(signal);
    if (signal.type === "turn-end") return verifyFirst(signal);
    if (signal.type === "followup") {
      const verdict = await judgeFollowup(signal.prompt, signal.edited, signal.failures);
      void logDecision({ kind: "followup", persists: verdict?.persists ?? null });
      if (!verdict || verdict.persists < PERSISTS) return undefined;
      return escalation({ type: "frustration", count: observer.recordFrustration() });
    }
    if (signal.type === "solved") {
      const how = signal.attempts ? `passes after ${signal.attempts} failed attempts` : "came back with a diagnosis";
      return `[effort-router] ${signal.subject} ${how}. If the cause or the fix wasn't obvious, it's worth keeping for later sessions: call knowledge with one line per lesson (the cause and what fixed it). Skip it if it was a typo-level fix.`;
    }
    if (signal.type === "stuck" && signal.agent) {
      const same = signal.same >= 3 ? `, ${signal.same}× with the same error` : "";
      return `[effort-router] ${signal.subject} has failed ${signal.total}× in a row in this subagent${same}. Stop trying variations: re-read the full error and question your assumptions. If you still can't resolve it, return to the caller with the exact error and what you tried.`;
    }
    const head =
      signal.type === "stuck"
        ? `[effort-router] ${signal.subject} has failed ${signal.total}× in a row${signal.same >= 3 ? `, ${signal.same}× with the same error` : " with shifting errors"} (last: ${signal.lastError || "no output"}). You look stuck: stop trying small variations and escalate.`
        : `[effort-router] The user says the problem persists (signal ${signal.count} this session). Treat it as a failed attempt, not a new request: work out why the last change didn't help before you change anything else.`;
    const failed = signal.type === "stuck" ? signal.level + 2 : signal.count + 1;
    const current = await session();
    const decision = decide({ task: "unblock the current problem", kind: "debug", failed_attempts: failed }, current, catalog);
    const tail =
      signal.type === "stuck" && signal.level === 2
        ? "If an escalation already ran, stop and ask the user for the missing fact (logs, environment, expected behaviour) instead."
        : "If this isn't a debugging problem, call route with your own assessment instead.";
    return [head, render(decision, current), tail].join("\n");
  }

  /** Jev checks a cheap tier's result against its brief; a miss goes back out one tier up. */
  async function retryOneUp(signal: Extract<Signal, { type: "delegated" }>): Promise<string | undefined> {
    const verdict = await judgeResult(signal.brief, signal.result);
    void logDecision({ kind: "delegated", agent: signal.agent, accomplished: verdict?.accomplished ?? null, retry: !!verdict && verdict.accomplished < RESULT_OK });
    if (!verdict || verdict.accomplished >= RESULT_OK) return undefined;
    const tier = TIERS.findIndex((t) => TARGETS[t].agent === signal.agent);
    const next = TARGETS[TIERS[Math.min(tier + 1, TIERS.length - 1)]];
    const ran = describe(signal.model ?? TARGETS[TIERS[tier]].model, TARGETS[TIERS[tier]].effort);
    return `[effort-router] ${verdict.model} judges that ${signal.agent} (${ran}) did not accomplish its brief (${verdict.accomplished.toFixed(2)}). Don't build on this result. Retry one tier up: Agent(subagent_type: "${next.agent}", model: "${next.model}") with the same brief, plus what the first attempt returned and where it fell short. If you can see the result is actually fine, carry on.`;
  }

  /** Jev judges the finished turn; without Jev there is no done check. */
  async function verifyFirst(signal: Extract<Signal, { type: "turn-end" }>): Promise<string | undefined> {
    const verdict = await judgeDone(signal.files, signal.checks, signal.lastMessage);
    const nudge = !!verdict && verdict.needsCheck >= DONE.needsCheck && verdict.checked < DONE.checked && verdict.claimsDone >= DONE.claimsDone;
    void logDecision({ kind: "turn-end", files: signal.files.length, checks: signal.checks.length, verdict: verdict ?? null, nudged: nudge });
    if (!nudge) return undefined;
    const files = signal.files.length > 3 ? `${signal.files.slice(0, 3).join(", ")} and ${signal.files.length - 3} more` : signal.files.join(", ");
    return `[effort-router] ${verdict.model} reads this as "done", but you changed ${files} this turn and nothing that ran after the last edit checked it. Run the project's usual check now. If there is none, or it can't run here, say plainly that the change is unverified.`;
  }

  const server = new McpServer({ name: "effort-router", version: VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "route",
    {
      title: "Route a task to a model and effort",
      description:
        "Decide which model and reasoning effort a task needs, and how to get there from this session: work inline, invoke a gear skill for the rest of the turn, or delegate to a subagent. Returns a short plan with a do: line to follow.",
      inputSchema: {
        task: z.string().describe("One line: what needs doing."),
        kind: z
          .enum(KINDS)
          .describe(
            "lookup: find, read or explain code. mechanical: fully specified edits (renames, boilerplate, config, formatting). implement: build or change behaviour to a clear spec. debug: find and fix the cause of a bug or failing check. design: architecture, API or data-model design, planning, trade-offs. review: code review, security or correctness audit.",
          ),
        ambiguity: z.enum(LEVELS).optional().describe("How underspecified the task is. Default medium."),
        risk: z
          .enum(LEVELS)
          .optional()
          .describe("Blast radius if it's wrong: auth, data loss, migrations, security, money, production are high. Default low."),
        scope: z.enum(SCOPES).optional().describe("small: one or two files. large: many files or a whole subsystem. Default small."),
        failed_attempts: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Attempts at this same problem that didn't work: tests still failing, or the user says it's still broken."),
        needs_context: z
          .boolean()
          .optional()
          .describe("True when the work depends on this conversation (decisions, preferences) so much that a fresh agent with a brief couldn't do it."),
        current_model: z.string().optional().describe('Your model, from your system prompt, e.g. "claude-opus-5-5".'),
        current_effort: z.enum(EFFORTS).optional().describe("Your effort level if you know it ($CLAUDE_EFFORT in Bash)."),
      },
      // It asks Jev, on api.typesafe.ai, about the task.
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) => {
      if (input.current_model) lastModel = input.current_model;
      const current = await session(input.current_model, input.current_effort);
      const judged = await judge(input, current);
      const decision = decide(input, current, catalog, judged);
      const jev = projectJevAccess();
      if (!jev.allowed) decision.notes.push(`Jev is off for this project (${jev.why}); the heuristic decided.`);
      const repo = await repoOf(projectDir);
      const nearby = repo ? await activity.inRepo(repo.common) : [];
      if (nearby.length) {
        const list = nearby.map((s) => `${s.branch || s.projectDir} (${s.files.slice(0, 3).join(", ")}${s.files.length > 3 ? ", …" : ""})`).join("; ");
        decision.notes.push(`other sessions changed files in this repo in the last hour: ${list}. Check for overlap before starting.`);
      }
      void logDecision({
        kind: "route",
        input: { kind: input.kind, ambiguity: input.ambiguity, risk: input.risk, scope: input.scope, failed: input.failed_attempts, needs_context: input.needs_context },
        session: { model: current.model, effort: current.effort },
        jev: judged ? { tier: judged.tier, confidence: judged.confidence, stuck: judged.stuck } : null,
        tier: decision.tier,
        action: decision.action.type === "delegate" ? `delegate:${decision.action.agent}` : decision.action.type === "gear" ? `gear:${decision.action.skill}` : "inline",
        nearby: nearby.length,
      });

      recent.push(decision.tier);
      if (recent.length > 3) recent.shift();
      const routineStretch = recent.length === 3 && recent.every((tier) => ROUTINE.includes(tier));
      if (routineStretch && (current.effort === "xhigh" || current.effort === "max") && Date.now() - routineHintAt > ROUTINE_HINT_EVERY_MS) {
        routineHintAt = Date.now();
        decision.notes.push(
          `three routine tasks in a row while the session runs at ${current.effort}. Tell the user once, in one line: lowering to medium with /effort (press s for this session only) saves tokens here, and effort-router raises effort per turn when a hard task comes.`,
        );
      }
      if (decision.action.type === "gear" && ++gears >= 3 && !persistentHintShown) {
        persistentHintShown = true;
        decision.notes.push("this session keeps needing escalation. Suggest to the user once: /effort xhigh for the rest of the session.");
      }
      if (catalog.unranked.length && !unrankedShown) {
        unrankedShown = true;
        decision.notes.push(
          `new model families are available but not ranked yet: ${catalog.unranked.map((u) => u.latest).join(", ")}. Mention it to the user; the models tool has details.`,
        );
      }
      return text(render(decision, current));
    },
  );

  server.registerTool(
    "knowledge",
    {
      title: "Decide which lessons to keep, and where",
      description:
        "Pass candidate lessons from this work (one fact per entry). Jev judges which would save a later session or another agent real time, and where each belongs: nowhere, project memory, user memory, cross-project tooling notes, or the repo's CLAUDE.md/AGENTS.md. Use it before saving a memory, and after a fix that took several attempts.",
      inputSchema: {
        facts: z.array(z.string().min(1)).min(1).max(20).describe("One self-contained lesson per entry: the fact and, briefly, why it matters."),
        context: z.string().describe("One or two lines: the project and what you were doing."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ facts, context }) => {
      const jev = projectJevAccess();
      if (!jev.allowed) return text(`Jev is off for this project (${jev.why}), so nothing was judged. Keep only what a later session couldn't rediscover quickly.`);
      const judged = await judgeKnowledge(facts, context);
      void logDecision({ kind: "knowledge", facts: facts.length, kept: judged?.verdicts.filter((v) => v.keep >= KEEP && v.scope !== "session").length ?? null });
      if (!judged) return text("Jev couldn't be asked right now. Keep only what a later session couldn't rediscover quickly.");
      return text(renderKnowledge(judged.model, judged.verdicts));
    },
  );

  server.registerTool(
    "rank",
    {
      title: "Rank candidate approaches",
      description:
        "Pass a goal, the context, and 1 to 50 candidate approaches or ideas. Jev scores each on whether it is sound and likely to work, and how much of the 'best option' vote it gets; extra yes/no criteria are optional. Returns them best first. With one candidate it is a sanity check.",
      inputSchema: {
        goal: z.string().min(1).describe("What the approach has to achieve."),
        context: z.string().describe("Constraints and facts that matter: stack, what exists, what was tried, what must not change."),
        options: z.array(z.string().min(1)).min(1).max(50).describe("The candidates, one per entry."),
        criteria: z
          .array(z.string().min(1))
          .max(3)
          .optional()
          .describe('Extra yes/no questions asked of every option, e.g. "Can this be done without changing the shared package?"'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ goal, context, options, criteria = [] }) => {
      const jev = projectJevAccess();
      if (!jev.allowed) return text(`Jev is off for this project (${jev.why}), so rank can't run here.`);
      const ranked = await rankOptions(goal, context, options, criteria);
      void logDecision({ kind: "rank", options: options.length, criteria: criteria.length, ok: !!ranked });
      if (!ranked) return text("Jev couldn't be asked right now; rank has no fallback. Try again in a few minutes.");
      return text(renderRanking(ranked.model, ranked.verdicts, criteria));
    },
  );

  server.registerTool(
    "models",
    {
      title: "Model catalog",
      description:
        "Show the model families effort-router routes to, their newest version and supported effort levels, whether that came from the live Models API or the bundled snapshot, and the tier table.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const jev = projectJevAccess();
      return text(`jev: ${jev.allowed ? "on" : "off"} for ${jev.dir} (${jev.why}; ${CONFIG_FILE}); ${keySource()}\n${renderCatalog(catalog)}`);
    },
  );

  server.registerTool(
    "observe",
    {
      title: "Hook events (internal)",
      description: "Internal: receives hook events from the effort-router plugin. Never call this yourself.",
      inputSchema: {
        event: z.string(),
        agent_id: z.string().optional(),
        tool_name: z.string().optional(),
        command: z.string().optional(),
        file_path: z.string().optional(),
        error: z.string().optional(),
        effort: z.string().optional(),
        prompt: z.string().optional(),
        transcript_path: z.string().optional(),
        brief: z.string().optional(),
        subagent_type: z.string().optional(),
        model: z.string().optional(),
        result: z.string().optional(),
        status: z.string().optional(),
        last_message: z.string().optional(),
        stop_hook_active: z.string().optional(),
        is_interrupt: z.string().optional(),
        notebook_path: z.string().optional(),
        source: z.string().optional(),
      },
      annotations: { openWorldHint: false },
    },
    async (event: HookEvent) => {
      if (process.env.EFFORT_ROUTER_DEBUG) await debugLog(event);
      const signal = observer.observe(event);
      const parts: string[] = [];
      const context = signal && (await escalation(signal));
      if (signal) void logDecision({ kind: "signal", signal: signal.type, level: signal.type === "stuck" ? signal.level : undefined, subagent: signal.type === "stuck" ? !!signal.agent : undefined, injected: !!context });
      if (context) parts.push(context);
      const file = event.file_path || event.notebook_path;
      if (event.event === "PostToolUse" && event.tool_name && EDIT_TOOLS.has(event.tool_name) && file && !/^\$\{/.test(file)) {
        for (const overlap of await activity.edited(file)) {
          parts.push(describeOverlap(overlap));
          void logDecision({ kind: "overlap", overlap: overlap.kind, minutesAgo: overlap.minutesAgo });
        }
      }
      if (!parts.length) return text("{}");
      return text(JSON.stringify({ hookSpecificOutput: { hookEventName: event.event, additionalContext: parts.join("\n\n") } }));
    },
  );

  return { server, activity };
}
