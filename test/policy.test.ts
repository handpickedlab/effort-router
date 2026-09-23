import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";
import { BUNDLED, clampEffort, mergeLive } from "../src/catalog.js";
import { GEARS, type RouteInput, type Session, TARGETS, TIERS, TOP_GEAR, decide, render, score } from "../src/policy.js";

const plugin = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugin");

function frontmatter(file: string): Record<string, string> {
  const block = /^---\n([\s\S]*?)\n---/.exec(readFileSync(file, "utf8"))?.[1] ?? "";
  return Object.fromEntries(
    block.split("\n").map((line) => {
      const i = line.indexOf(":");
      return [line.slice(0, i).trim(), line.slice(i + 1).trim().replace(/^"(.*)"$/, "$1")];
    }),
  );
}

const input = (extra: Partial<RouteInput> & Pick<RouteInput, "kind">): RouteInput => ({ task: "t", ...extra });
const opus = (effort: Session["effort"]): Session => ({ model: "claude-opus-5-5", effort });

describe("score", () => {
  test("base tiers per kind", () => {
    assert.equal(score(input({ kind: "lookup" })).tier, "quick");
    assert.equal(score(input({ kind: "mechanical" })).tier, "quick");
    assert.equal(score(input({ kind: "implement" })).tier, "standard");
    assert.equal(score(input({ kind: "design" })).tier, "deep");
  });

  test("one modifier on hard work stays deep; stacked modifiers reach max", () => {
    assert.equal(score(input({ kind: "design", ambiguity: "high" })).tier, "deep");
    assert.equal(score(input({ kind: "design", ambiguity: "high", risk: "high" })).tier, "max");
  });

  test("a large rename stays quick", () => {
    assert.equal(score(input({ kind: "mechanical", scope: "large" })).tier, "quick");
    assert.equal(score(input({ kind: "implement", scope: "large" })).tier, "deep");
  });

  test("failed attempts escalate", () => {
    assert.equal(score(input({ kind: "debug", failed_attempts: 1 })).tier, "standard");
    assert.equal(score(input({ kind: "debug", failed_attempts: 2 })).tier, "deep");
    assert.equal(score(input({ kind: "design", failed_attempts: 2 })).tier, "max");
    assert.equal(score(input({ kind: "mechanical", failed_attempts: 3 })).tier, "max");
  });
});

describe("score with Jev", () => {
  const jev = (tier: "quick" | "standard" | "deep" | "max", confidence: number, stuck = 0) => ({ model: "jev-1.13.0", tier, confidence, stuck });

  test("a confident Jev overrides the heuristic", () => {
    const s = score(input({ kind: "design", ambiguity: "high", risk: "high" }), jev("deep", 0.98));
    assert.equal(s.tier, "deep");
    assert.match(s.reasons.join("; "), /jev-1.13.0: deep \(0.98\); heuristic: max/);
  });

  test("an unsure Jev leaves the heuristic in charge", () => {
    assert.equal(score(input({ kind: "design" }), jev("quick", 0.23)).tier, "deep");
  });

  test("Jev saying stuck counts as two failed attempts", () => {
    const s = score(input({ kind: "debug" }), jev("quick", 0.23, 0.76));
    assert.equal(s.tier, "deep");
    assert.match(s.reasons.join("; "), /says stuck \(0.76\)/);
    assert.equal(score(input({ kind: "debug", failed_attempts: 3 }), jev("quick", 0.9, 0.76)).tier, "max");
  });

  test("a stuck verdict switches to the fresh-eyes brief", () => {
    const d = decide(input({ kind: "debug" }), opus("medium"), undefined, jev("standard", 0.9, 0.8));
    assert.match(d.action.type === "delegate" ? d.action.brief : "", /fresh pair of eyes/);
  });
});

describe("decide", () => {
  test("small routine work stays inline", () => {
    const d = decide(input({ kind: "lookup" }), opus("max"));
    assert.equal(d.action.type, "inline");
  });

  test("broad lookups go to Explore on haiku", () => {
    const d = decide(input({ kind: "lookup", scope: "large" }), opus("max"));
    assert.deepEqual(d.action, { type: "delegate", agent: "Explore", model: "haiku", brief: (d.action as { brief: string }).brief });
  });

  test("large mechanical work is delegated down", () => {
    const d = decide(input({ kind: "mechanical", scope: "large" }), opus("max"));
    assert.equal(d.action.type, "delegate");
    assert.equal(d.action.type === "delegate" && d.action.agent, "effort-router:low");
    assert.equal(d.action.type === "delegate" && d.action.model, "sonnet");
  });

  test("deep work in a medium session that needs the conversation raises effort in place", () => {
    const d = decide(input({ kind: "design", needs_context: true }), opus("medium"));
    assert.equal(d.tier, "deep");
    assert.equal(d.action.type === "gear" && d.action.skill, "effort-router:gear-xhigh");
    assert.equal(d.alternative?.type, "delegate");
  });

  test("self-contained deep work is delegated, with the gear as alternative", () => {
    const d = decide(input({ kind: "review" }), opus("medium"));
    assert.equal(d.action.type === "delegate" && d.action.agent, "effort-router:xhigh");
    assert.equal(d.alternative?.type, "gear");
  });

  test("a session one effort step below deep is close enough", () => {
    assert.equal(decide(input({ kind: "design" }), opus("high")).action.type, "inline");
    assert.equal(decide(input({ kind: "design" }), opus("xhigh")).action.type, "inline");
  });

  test("stuck at opus max escalates to fable with a fresh-eyes brief", () => {
    const d = decide(input({ kind: "debug", failed_attempts: 3 }), opus("max"));
    assert.equal(d.tier, "max");
    assert.ok(d.action.type === "delegate" && d.action.agent === "effort-router:max" && d.action.model === "fable");
    assert.match(d.action.type === "delegate" ? d.action.brief : "", /fresh pair of eyes/);
    // Already at max: a gear would change nothing, so none is offered.
    assert.equal(d.alternative, undefined);
    assert.match(d.notes.join(" "), /claude-opus-5-5 is already at its highest effort, below fable @ max/);
  });

  test("an opus@xhigh session that is stuck still gets gear-max as the in-place option", () => {
    const d = decide(input({ kind: "debug", failed_attempts: 3 }), opus("xhigh"));
    assert.equal(d.alternative?.type === "gear" && d.alternative.skill, "effort-router:gear-max");
    assert.match(d.notes.join(" "), /raising effort on claude-opus-5-5 stays below fable @ max/);
  });

  test("stuck deep work gets no one-step slack", () => {
    const d = decide(input({ kind: "debug", failed_attempts: 2 }), opus("high"));
    assert.equal(d.tier, "deep");
    assert.equal(d.action.type, "delegate");
  });

  test("a Fable session raises effort in place, since that keeps the cache", () => {
    const d = decide(input({ kind: "debug", failed_attempts: 3 }), { model: "claude-fable-5-1", effort: "xhigh" });
    assert.equal(d.action.type === "gear" && d.action.skill, "effort-router:gear-max");
    assert.equal(d.alternative?.type, "delegate");
  });

  test("an unranked session model only gets the unknown note", () => {
    const d = decide(input({ kind: "design" }), { model: "claude-saga-1", effort: "medium" });
    assert.match(d.notes.join(" "), /session level unknown/);
    assert.doesNotMatch(d.notes.join(" "), /stays below/);
  });

  test("a target family without effort levels still escalates by rank", () => {
    const catalog = structuredClone(BUNDLED);
    catalog.families.opus.efforts = [];
    catalog.families.fable.efforts = [];
    assert.notEqual(decide(input({ kind: "design" }), { model: "claude-sonnet-5", effort: "low" }, catalog).action.type, "inline");
  });

  test("stuck on work that needs the conversation raises effort in place and names the stronger model", () => {
    const d = decide(input({ kind: "debug", failed_attempts: 3, needs_context: true }), opus("high"));
    assert.equal(d.action.type === "gear" && d.action.skill, "effort-router:gear-max");
    assert.equal(d.alternative?.type === "delegate" && d.alternative.model, "fable");
    assert.match(d.notes.join(" "), /\/effort-router:gear-top <task>/);
  });

  test("stuck at the ceiling changes approach instead of adding effort", () => {
    const d = decide(input({ kind: "debug", failed_attempts: 3 }), { model: "claude-fable-5-1", effort: "max" });
    assert.equal(d.action.type, "inline");
    assert.match(d.action.type === "inline" ? d.action.note : "", /change approach/);
    assert.equal(d.alternative?.type, "delegate");
  });

  test("a sonnet session needs max effort to cover deep work", () => {
    const d = decide(input({ kind: "design", needs_context: true }), { model: "sonnet", effort: "high" });
    assert.equal(d.action.type === "gear" && d.action.skill, "effort-router:gear-max");
  });

  test("an unknown session escalates conditionally, without switching model for deep work", () => {
    const d = decide(input({ kind: "design", needs_context: true }), {});
    assert.equal(d.action.type === "gear" && d.action.skill, "effort-router:gear-xhigh");
    assert.match(d.notes.join(" "), /session level unknown/);
    const stuck = decide(input({ kind: "debug", failed_attempts: 3, needs_context: true }), {});
    assert.equal(stuck.action.type === "gear" && stuck.action.skill, "effort-router:gear-max");
  });

  test("render names the exact call to make", () => {
    const text = render(decide(input({ kind: "debug", failed_attempts: 3 }), opus("max")), opus("max"));
    assert.match(text, /^effort-router: MAX \(fable @ max\)/);
    assert.match(text, /do: Agent\(subagent_type: "effort-router:max", model: "fable"\)/);
    assert.doesNotMatch(text, /gear-max/);
  });
});

describe("plugin files match the policy", () => {
  test("agents carry the tier's model and effort", () => {
    for (const tier of TIERS) {
      const target = TARGETS[tier];
      const name = target.agent.split(":")[1];
      const fm = frontmatter(path.join(plugin, "agents", `${name}.md`));
      assert.equal(fm.name, name);
      assert.equal(fm.model, target.model, `${name}.md model`);
      assert.equal(fm.effort, target.effort, `${name}.md effort`);
    }
  });

  test("gear skills carry the gear's model and effort", () => {
    for (const gear of GEARS) {
      const name = gear.skill.split(":")[1];
      const fm = frontmatter(path.join(plugin, "skills", name, "SKILL.md"));
      assert.equal(fm.name, name);
      assert.equal(fm.effort, gear.effort, `${name} effort`);
      assert.equal(fm.model, undefined, `${name} must not set a model: Claude-invoked skills ignore it`);
    }
  });

  test("gear-top switches model only when the user types it", () => {
    const fm = frontmatter(path.join(plugin, "skills", TOP_GEAR.skill.split(":")[1], "SKILL.md"));
    assert.equal(fm.model, TOP_GEAR.model);
    assert.equal(fm.effort, TOP_GEAR.effort);
    assert.equal(fm["disable-model-invocation"], "true");
  });
});

describe("catalog", () => {
  test("clampEffort falls back to the highest supported level at or below", () => {
    assert.equal(clampEffort("xhigh", ["low", "medium", "high", "max"]), "high");
    assert.equal(clampEffort("low", ["medium", "high"]), "medium");
    assert.equal(clampEffort("max", []), undefined);
  });

  test("mergeLive takes the newest model per family and flags unranked families", () => {
    const caps = (levels: string[]) =>
      ({
        effort: {
          supported: levels.length > 0,
          ...Object.fromEntries(["low", "medium", "high", "xhigh", "max"].map((l) => [l, { supported: levels.includes(l) }])),
        },
      }) as unknown as Anthropic.ModelCapabilities;
    const model = (id: string, created: string, levels: string[]) =>
      ({ id, created_at: created, capabilities: caps(levels) }) as unknown as Anthropic.ModelInfo;
    const catalog = mergeLive([
      model("claude-opus-5", "2026-05-01T00:00:00Z", ["low", "high"]),
      model("claude-opus-6", "2026-11-01T00:00:00Z", ["low", "medium", "high", "xhigh", "max"]),
      model("claude-haiku-5", "2026-10-01T00:00:00Z", ["low", "medium", "high"]),
      model("claude-saga-1", "2026-12-01T00:00:00Z", ["low"]),
      model("claude-mythos-5-1", "2026-08-01T00:00:00Z", ["max"]),
      model("claude-3-5-sonnet-20241022", "2024-10-22T00:00:00Z", []),
    ]);
    assert.equal(catalog.source, "models-api");
    assert.equal(catalog.families.opus.latest, "claude-opus-6");
    assert.deepEqual(catalog.families.haiku.efforts, ["low", "medium", "high"]);
    assert.equal(catalog.families.fable.latest, BUNDLED.families.fable.latest);
    assert.deepEqual(catalog.unranked, [{ family: "saga", latest: "claude-saga-1" }]);
  });
});
