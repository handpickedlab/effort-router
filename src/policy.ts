import { BUNDLED, type Catalog, EFFORTS, type Effort, clampEffort, familyOf } from "./catalog.js";

export const KINDS = ["lookup", "mechanical", "implement", "debug", "design", "review"] as const;
export type Kind = (typeof KINDS)[number];
export const LEVELS = ["low", "medium", "high"] as const;
export type Level = (typeof LEVELS)[number];
export const SCOPES = ["small", "medium", "large"] as const;
export type Scope = (typeof SCOPES)[number];

export const TIERS = ["quick", "standard", "deep", "max"] as const;
export type Tier = (typeof TIERS)[number];

export interface Target {
  model: string;
  effort: Effort;
  agent: string;
}

/**
 * The table to edit when retuning. Models are Claude Code aliases, so a new release in a
 * family is used as soon as Claude Code resolves the alias to it. Each agent file carries the
 * same model and effort in its frontmatter (test/policy.test.ts keeps them in sync); the Agent
 * call passes `model` explicitly as well, because frontmatter is the only place effort can be set.
 */
export const TARGETS: Record<Tier, Target> = {
  quick: { model: "sonnet", effort: "low", agent: "effort-router:low" },
  standard: { model: "sonnet", effort: "high", agent: "effort-router:high" },
  deep: { model: "opus", effort: "xhigh", agent: "effort-router:xhigh" },
  max: { model: "fable", effort: "max", agent: "effort-router:max" },
};

const BASE: Record<Kind, number> = { lookup: 0, mechanical: 0, implement: 1, debug: 1, review: 2, design: 2 };

export interface Gear {
  skill: string;
  effort: Effort;
}

/**
 * Skills whose frontmatter `effort` overrides the session until the user's next prompt, weakest
 * first. They change effort only: a skill's `model` frontmatter is ignored when Claude invokes the
 * skill mid-turn (verified on v2.1.280), so a stronger model always goes through delegation.
 */
export const GEARS: Gear[] = [
  { skill: "effort-router:gear-xhigh", effort: "xhigh" },
  { skill: "effort-router:gear-max", effort: "max" },
];

/** Typed by the user, it does switch model for that turn; Claude can't invoke it. */
export const TOP_GEAR = { skill: "effort-router:gear-top", model: "best", effort: "max" as Effort };

export interface RouteInput {
  task: string;
  kind: Kind;
  ambiguity?: Level;
  risk?: Level;
  scope?: Scope;
  failed_attempts?: number;
  needs_context?: boolean;
}

export interface Session {
  model?: string;
  effort?: Effort;
  /** True when the effort came from hook events rather than from the caller. */
  effortObserved?: boolean;
}

export type Action =
  | { type: "inline"; note: string }
  | { type: "gear"; skill: string; note: string }
  | { type: "delegate"; agent: string; model: string; brief: string };

export interface Decision {
  tier: Tier;
  target: { model: string; effort?: Effort };
  reasons: string[];
  action: Action;
  alternative?: Action;
  notes: string[];
}

const BRIEF =
  "It does not see this conversation: give it a self-contained brief with the goal, the relevant paths, constraints, and what to report back.";
const STUCK_BRIEF =
  "Brief it as a fresh pair of eyes: the goal and what done looks like, the exact failing command and its full error, every attempt so far and why it failed, the relevant files and constraints. Ask for the root cause with evidence before any fix, tell it not to repeat the listed attempts, then verify its fix yourself.";
const LOOKUP_BRIEF = "Say what to find and how thorough to be; ask for file paths and line numbers.";

/** Scope only raises work whose difficulty grows with size; a large rename stays mechanical. */
const SCOPE_MATTERS = new Set<Kind>(["implement", "debug", "design"]);

/** Points to tier: max is reached by stacking modifiers on hard work, or by being stuck. */
function tierFor(points: number): Tier {
  if (points <= 0) return "quick";
  if (points === 1) return "standard";
  return points <= 3 ? "deep" : "max";
}

/** Jev's judgement of the task, when it could be asked (see src/jev.ts). */
export interface Judged {
  model: string;
  tier: Tier;
  confidence: number;
  /** Probability that the agent is stuck repeating attempts that don't work. */
  stuck: number;
}

/** Below this, Jev's tier is a guess and the heuristic decides. */
const JEV_CONFIDENT = 0.5;
/** At or above this, Jev's stuck verdict counts as two failed attempts. */
const JEV_STUCK = 0.6;

export function score(input: RouteInput, judged?: Judged): { tier: Tier; reasons: string[] } {
  const heuristic = heuristicTier(input);
  let tier = heuristic.tier;
  let reasons = heuristic.reasons;
  if (judged && judged.confidence >= JEV_CONFIDENT) {
    tier = judged.tier;
    reasons = [`${judged.model}: ${judged.tier} (${judged.confidence.toFixed(2)})`, `heuristic: ${heuristic.tier}`];
  } else if (judged) {
    reasons = [`${judged.model} unsure (${judged.confidence.toFixed(2)}), heuristic used`, ...reasons];
  }

  let failed = input.failed_attempts ?? 0;
  if (judged && judged.stuck >= JEV_STUCK && failed < 2) {
    failed = 2;
    reasons.push(`${judged.model} says stuck (${judged.stuck.toFixed(2)})`);
  }
  if (failed >= 3) {
    tier = "max";
    reasons.push(`${failed} failed attempts → max`);
  } else if (failed === 2) {
    tier = TIERS[Math.min(Math.max(TIERS.indexOf(tier) + 1, 2), TIERS.length - 1)];
    reasons.push(`2 failed attempts → ${tier}`);
  }
  return { tier, reasons };
}

function heuristicTier(input: RouteInput): { tier: Tier; reasons: string[] } {
  let points = BASE[input.kind];
  const reasons = [`${input.kind} ${points}`];
  if (input.ambiguity === "high") {
    points += 1;
    reasons.push("high ambiguity +1");
  }
  if (input.risk === "high") {
    points += 1;
    reasons.push("high risk +1");
  }
  if (input.scope === "large" && SCOPE_MATTERS.has(input.kind)) {
    points += 1;
    reasons.push("large scope +1");
  }
  return { tier: tierFor(points), reasons };
}

function rankOf(model: string | undefined, catalog: Catalog): number | undefined {
  if (!model) return undefined;
  const name = model.toLowerCase();
  const ranks = Object.values(catalog.families).map((f) => f.rank);
  if (name === "best") return Math.max(...ranks);
  const family = familyOf(name) ?? Object.keys(catalog.families).find((f) => name.includes(f));
  return family === undefined ? undefined : catalog.families[family]?.rank;
}

/**
 * One family step counts as two effort steps. The effort scale is calibrated per model, so this
 * is a heuristic for "is the session already at least as strong as the target".
 */
function strength(model: string | undefined, effort: Effort | undefined, catalog: Catalog): number | undefined {
  const rank = rankOf(model, catalog);
  if (rank === undefined) return undefined;
  if (effort !== undefined) return rank * 2 + EFFORTS.indexOf(effort);
  // A model that takes no effort parameter runs at its default, which counts as high.
  return effortsFor(model, catalog).length === 0 ? rank * 2 + EFFORTS.indexOf("high") : undefined;
}

function effortsFor(model: string | undefined, catalog: Catalog): readonly Effort[] {
  if (!model) return EFFORTS;
  const family = familyOf(model) ?? Object.keys(catalog.families).find((f) => model.toLowerCase().includes(f));
  return (family && catalog.families[family]?.efforts) || EFFORTS;
}

function gearNote(gear: Gear): string {
  return `raises this session to ${gear.effort} effort for the rest of this turn; it resets at the user's next prompt. Changing effort re-reads the conversation once without cache (Fable 5.1 keeps it).`;
}

/**
 * The weakest gear that reaches `need` on the session's own model, else the strongest gear that still
 * raises effort. Gears at or below the session's current effort would do nothing and are skipped.
 */
function pickGear(session: Session, tier: Tier, need: number, catalog: Catalog): { gear?: Gear; reaches: boolean } {
  const current = session.effort ? EFFORTS.indexOf(session.effort) : -1;
  const raising = GEARS.filter((gear) => EFFORTS.indexOf(clampEffort(gear.effort, effortsFor(session.model, catalog)) ?? "low") > current);
  // Without the session model the strength can't be computed: xhigh for deep work, max for max.
  if (!session.model) return { gear: tier === "max" ? raising.at(-1) : raising[0], reaches: true };
  for (const gear of raising) {
    const reached = strength(session.model, clampEffort(gear.effort, effortsFor(session.model, catalog)), catalog);
    if (reached !== undefined && reached >= need) return { gear, reaches: true };
  }
  return { gear: raising.at(-1), reaches: false };
}

/** On Fable, changing effort keeps the prompt cache, so raising it in place costs nothing extra. */
const cacheFreeEffort = (model: string | undefined) => !!model && /fable/i.test(model);

export function decide(input: RouteInput, session: Session, catalog: Catalog = BUNDLED, judged?: Judged): Decision {
  const { tier, reasons } = score(input, judged);
  const target = TARGETS[tier];
  const effort = clampEffort(target.effort, catalog.families[target.model]?.efforts ?? EFFORTS);
  const scope = input.scope ?? "small";
  const stuck = (input.failed_attempts ?? 0) >= 2 || (judged?.stuck ?? 0) >= JEV_STUCK;
  const notes: string[] = [];
  const delegate: Action = { type: "delegate", agent: target.agent, model: target.model, brief: stuck ? STUCK_BRIEF : BRIEF };
  const decision = (action: Action, alternative?: Action): Decision => ({
    tier,
    target: { model: target.model, effort },
    reasons,
    action,
    alternative,
    notes,
  });

  if (tier === "quick") {
    if (input.kind === "lookup" && scope !== "small") {
      return decision({ type: "delegate", agent: "Explore", model: "haiku", brief: LOOKUP_BRIEF });
    }
    if (scope === "large" || (input.kind === "mechanical" && scope === "medium")) return decision(delegate);
    return decision({ type: "inline", note: "routine work: act directly and keep deliberation short." });
  }

  if (tier === "standard") {
    if (scope === "large" && !input.needs_context) {
      return decision(delegate, { type: "inline", note: "do it yourself if writing the brief would take longer than the work." });
    }
    return decision({ type: "inline", note: "your session covers this; just do the work." });
  }

  // deep and max: escalate unless the session is already strong enough. Deep work that isn't stuck
  // allows one effort step of slack, because a mid-session effort change costs an uncached re-read.
  const need = (strength(target.model, effort, catalog) ?? 0) - (tier === "deep" && !stuck ? 1 : 0);
  const current = strength(session.model, session.effort, catalog);
  if (current !== undefined && current >= need) {
    const note = stuck
      ? "your session already meets this level, so more effort won't help: change approach. List hypotheses, test the cheapest one first, question assumptions the failures depend on, or ask the user for the missing fact."
      : "your session covers this level; reason it through before editing.";
    return decision({ type: "inline", note }, stuck ? delegate : undefined);
  }

  const known = rankOf(session.model, catalog) !== undefined;
  if (current === undefined) notes.push(`session level unknown: skip the escalation if you already run at ${describe(target.model, effort)} or above.`);
  const { gear, reaches } = pickGear(session, tier, need, catalog);
  const gearAction: Action | undefined = gear && { type: "gear", skill: gear.skill, note: gearNote(gear) };
  if (known && !reaches) {
    notes.push(
      `${gear ? `raising effort on ${session.model} stays` : `${session.model} is already at its highest effort,`} below ${describe(target.model, effort)}. Only the delegate runs on ${target.model}; the user can also type /${TOP_GEAR.skill} <task> to run one turn on the most capable model.`,
    );
  }
  if (!gearAction) return decision(delegate);
  if (input.needs_context || (reaches && cacheFreeEffort(session.model))) return decision(gearAction, delegate);
  return decision(delegate, gearAction);
}

export function describe(model: string, effort: Effort | undefined): string {
  return effort ? `${model} @ ${effort}` : model;
}

function describeSession(session: Session): string {
  if (!session.model && !session.effort) return "unknown (pass current_model and current_effort)";
  const effort = session.effort ? `${session.effort}${session.effortObserved ? " (seen by hooks)" : ""}` : "effort unknown";
  return `${session.model ?? "model unknown"} @ ${effort}`;
}

function renderAction(action: Action): string {
  switch (action.type) {
    case "inline":
      return `inline — ${action.note}`;
    case "gear":
      return `Skill("${action.skill}") — ${action.note}`;
    case "delegate":
      return `Agent(subagent_type: "${action.agent}", model: "${action.model}") — ${action.brief}`;
  }
}

export function render(decision: Decision, session: Session): string {
  const lines = [
    `effort-router: ${decision.tier.toUpperCase()} (${describe(decision.target.model, decision.target.effort)})`,
    `why: ${decision.reasons.join("; ")}`,
    `session: ${describeSession(session)}`,
    `do: ${renderAction(decision.action)}`,
  ];
  if (decision.alternative) lines.push(`or: ${renderAction(decision.alternative)}`);
  for (const note of decision.notes) lines.push(`note: ${note}`);
  return lines.join("\n");
}

export function renderCatalog(catalog: Catalog): string {
  const source =
    catalog.source === "models-api"
      ? `models-api (fetched ${catalog.fetchedAt})`
      : "bundled: no API credentials, so versions and effort levels are the snapshot in src/catalog.ts. Claude Code's aliases still resolve to the newest release in each family.";
  const families = Object.entries(catalog.families)
    .sort(([, a], [, b]) => b.rank - a.rank)
    .map(([alias, f]) => `  ${alias.padEnd(7)} rank ${f.rank}  ${f.latest.padEnd(18)} effort: ${f.efforts.length ? f.efforts.join(", ") : "none"}`);
  const tiers = TIERS.map((tier) => {
    const t = TARGETS[tier];
    return `  ${tier.padEnd(9)} ${describe(t.model, clampEffort(t.effort, catalog.families[t.model]?.efforts ?? EFFORTS)).padEnd(15)} agent ${t.agent}`;
  });
  const lines = [`source: ${source}`, "families:", ...families, "tiers:", ...tiers];
  if (catalog.unranked.length) {
    lines.push(
      `unranked new families: ${catalog.unranked.map((u) => `${u.family} (${u.latest})`).join(", ")}. Add a rank in src/catalog.ts to route to them.`,
    );
  }
  return lines.join("\n");
}
