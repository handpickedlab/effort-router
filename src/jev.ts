import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { TypeSafeClient, choice, noul } from "@typesafe-ai/sdk";
import { projectJevAccess } from "./privacy.js";
import { type Judged, TIERS, type RouteInput, type Session, type Tier } from "./policy.js";

const QUESTIONS = {
  tier: choice("How much reasoning does this coding task need from an AI coding agent?", {
    quick: "routine lookup or mechanical edit",
    standard: "normal well-specified implementation or bug fix",
    deep: "hard: design, tricky logic, cross-cutting or risky change",
    max: "hardest, or the agent is stuck after repeated failures",
  }),
  stuck: noul("Is the agent stuck, repeating attempts that don't work?"),
};

export const KEY_FILE = path.join(homedir(), ".config", "effort-router", "typesafe-api-key");

function apiKey(): string | undefined {
  const fromEnv = (process.env.TYPESAFE_API_KEY ?? process.env.TYPESAFE_AI_API_KEY)?.trim();
  if (fromEnv) return fromEnv;
  try {
    return readFileSync(KEY_FILE, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

let client: TypeSafeClient | null | undefined;
/** After a failed call, skip Jev for a while instead of making every route wait for the timeout. */
let pausedUntil = 0;
const PAUSE_AFTER_FAILURE_MS = 5 * 60 * 1000;

/** A probability Jev reported, or undefined when the response is malformed. */
const probability = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined);

function jev(): TypeSafeClient | null {
  if (client !== undefined) return client;
  const key = apiKey();
  try {
    // The model defaults to jev-latest, so a new Jev release is used without a change here.
    client = key ? new TypeSafeClient({ apiKey: key, timeout: 3000, retry: { maxRetries: 0 }, logLevel: "off" }) : null;
  } catch {
    client = null;
  }
  return client;
}

type Questions = Parameters<TypeSafeClient["systemOne"]>[0]["questions"];

/** One systemOne call; undefined without a key, offline, or on any error, so callers fall back. */
async function ask<Q extends Questions>(state: Record<string, unknown>, questions: Q) {
  if (process.env.EFFORT_ROUTER_OFFLINE || Date.now() < pausedUntil || !projectJevAccess().allowed) return undefined;
  const typesafe = jev();
  if (!typesafe) return undefined;
  try {
    return await typesafe.systemOne({ state: JSON.parse(JSON.stringify(state)), questions });
  } catch {
    pausedUntil = Date.now() + PAUSE_AFTER_FAILURE_MS;
    return undefined;
  }
}

/** Keeps what leaves the machine, and the request, small. */
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)} …[clipped]` : text);

/** Jev's view of a task: which tier, and whether the session looks stuck. */
export async function judge(input: RouteInput, session: Session): Promise<Judged | undefined> {
  const response = await ask({ ...input, session_model: session.model ?? null, session_effort: session.effort ?? null }, QUESTIONS);
  if (!response) return undefined;
  // The SDK doesn't validate responses, and policy formats these numbers.
  const tier = response.answers?.tier?.choice;
  const confidence = probability(response.answers?.tier?.confidence);
  const stuck = probability(response.answers?.stuck?.noul);
  if (!(TIERS as readonly string[]).includes(tier) || confidence === undefined || stuck === undefined) return undefined;
  return { model: String(response.model), tier: tier as Tier, confidence, stuck };
}

/** Probability that a delegated agent's result does what its brief asked. */
export async function judgeResult(brief: string, result: string): Promise<{ model: string; accomplished: number } | undefined> {
  const response = await ask(
    { brief: clip(brief, 4000), result: clip(result, 6000) },
    {
      accomplished: noul("Does the result fully accomplish the task in the brief?", {
        true: "the brief's goal is met, or the result clearly explains why it can't be",
        false: "incomplete, off-target, or only partly done",
      }),
    },
  );
  const accomplished = probability(response?.answers?.accomplished?.noul);
  return response && accomplished !== undefined ? { model: String(response.model), accomplished } : undefined;
}

/** Jev's view of a finished turn that changed files. */
export interface DoneVerdict {
  model: string;
  /** The changes need a test, build, type check or lint before they can be called done. */
  needsCheck: number;
  /** One of the commands run after the last edit checked them. */
  checked: number;
  /** The final message presents the work as finished. */
  claimsDone: number;
}

export async function judgeDone(files: string[], checks: string[], message: string): Promise<DoneVerdict | undefined> {
  const response = await ask(
    { changed_files: files.slice(0, 30), commands_that_passed_after_the_last_edit: checks, final_message: clip(message, 3000) },
    {
      needs_check: noul("Do these file changes need a test, build, type check or lint before they can be called done?", {
        true: "code or config whose behaviour could break",
        false: "prose, notes, or scratch files",
      }),
      checked: noul("Did any of the commands that passed after the last edit actually check these changes (tests, build, type check, lint)?"),
      claims_done: noul("Does the final message present the work as finished or fixed?", {
        true: "says it is done, fixed, implemented or working",
        false: "asks a question, reports a problem, or says the work is unverified or incomplete",
      }),
    },
  );
  const needsCheck = probability(response?.answers?.needs_check?.noul);
  const checked = probability(response?.answers?.checked?.noul);
  const claimsDone = probability(response?.answers?.claims_done?.noul);
  if (!response || needsCheck === undefined || checked === undefined || claimsDone === undefined) return undefined;
  return { model: String(response.model), needsCheck, checked, claimsDone };
}

/** Probability that the user's reply says the previous attempt didn't solve the problem. */
export async function judgeFollowup(prompt: string, edited: string[], failures: number): Promise<{ model: string; persists: number } | undefined> {
  const response = await ask(
    { user_message: prompt, previous_turn: { changed_files: edited.slice(0, 20), failed_commands: failures } },
    {
      persists: noul("Does the user's message say the previous attempt did not solve the problem?", {
        true: "it is still broken, the same error, it didn't help",
        false: "a new request, a question, feedback on something else, or thanks",
      }),
    },
  );
  const persists = probability(response?.answers?.persists?.noul);
  return response && persists !== undefined ? { model: String(response.model), persists } : undefined;
}

/** Where a kept fact belongs, as Jev picks it. */
export const FACT_SCOPES = {
  session: "only this conversation",
  project: "memory for this project or repo",
  user: "the user's preferences, across all projects",
  tooling: "how tools (Claude Code, CLIs, SDKs, services) behave, across all projects",
  repo_docs: "a rule every contributor to this repo must follow (CLAUDE.md or AGENTS.md)",
} as const;
export type FactScope = keyof typeof FACT_SCOPES;

export interface FactVerdict {
  fact: string;
  keep: number;
  scope: FactScope;
  scopeConfidence: number;
}

/** Per fact: would it save a later session real time, and where does it belong. */
export async function judgeKnowledge(facts: string[], context: string): Promise<{ model: string; verdicts: FactVerdict[] } | undefined> {
  const questions: Questions = {};
  facts.forEach((fact, i) => {
    const text = clip(fact, 500);
    questions[`keep${i}`] = noul(`Would this save a future session or another agent real time, beyond the current task? Fact: ${text}`, {
      true: "a non-obvious lesson, decision, constraint or preference that will come up again",
      false: "only relevant now, trivial, or quick to rediscover",
    });
    questions[`scope${i}`] = choice(`Where does this belong? Fact: ${text}`, FACT_SCOPES);
  });
  const response = await ask({ context: clip(context, 3000) }, questions);
  if (!response) return undefined;
  const answers = response.answers as Record<string, { noul?: unknown; choice?: unknown; confidence?: unknown }>;
  const verdicts: FactVerdict[] = [];
  for (const [i, fact] of facts.entries()) {
    const keep = probability(answers[`keep${i}`]?.noul);
    const scope = answers[`scope${i}`]?.choice;
    const scopeConfidence = probability(answers[`scope${i}`]?.confidence);
    if (keep === undefined || scopeConfidence === undefined || typeof scope !== "string" || !(scope in FACT_SCOPES)) return undefined;
    verdicts.push({ fact, keep, scope: scope as FactScope, scopeConfidence });
  }
  return { model: String(response.model), verdicts };
}

export interface OptionVerdict {
  option: string;
  /** Probability the option is sound and likely to work for the goal. */
  viable: number;
  /** Share of "this is the best one" across all options; sums to one. */
  best: number;
  /** Probability per extra criterion, in the order given. */
  criteria: number[];
}

/** Scores every option on its own, and all of them against each other. */
export async function rankOptions(
  goal: string,
  context: string,
  options: string[],
  criteria: string[],
): Promise<{ model: string; verdicts: OptionVerdict[] } | undefined> {
  const clipped = options.map((option) => clip(option, 500));
  const questions: Questions = {};
  if (clipped.length > 1) {
    questions.best = choice("Which option best achieves the goal, given the context?", Object.fromEntries(clipped.map((o, i) => [`o${i}`, o])));
  }
  clipped.forEach((option, i) => {
    questions[`viable${i}`] = noul(`Is this option sound and likely to work for the goal, given the context? Option: ${option}`);
    criteria.forEach((criterion, c) => {
      questions[`c${c}_${i}`] = noul(`${clip(criterion, 200)} Option: ${option}`);
    });
  });
  const response = await ask({ goal: clip(goal, 1000), context: clip(context, 4000) }, questions);
  if (!response) return undefined;
  const answers = response.answers as Record<string, { noul?: unknown; probabilities?: Record<string, unknown> }>;
  const verdicts: OptionVerdict[] = [];
  for (const [i, option] of options.entries()) {
    const viable = probability(answers[`viable${i}`]?.noul);
    const best = options.length > 1 ? probability(answers.best?.probabilities?.[`o${i}`]) : 1;
    const scores = criteria.map((_, c) => probability(answers[`c${c}_${i}`]?.noul));
    if (viable === undefined || best === undefined || scores.some((s) => s === undefined)) return undefined;
    verdicts.push({ option, viable, best, criteria: scores as number[] });
  }
  return { model: String(response.model), verdicts };
}
