#!/usr/bin/env node
// Summarises decisions.jsonl, to tune effort-router's thresholds on real sessions.
// usage: npm run stats [-- 7]   or, in any Claude Code session: /effort-router:stats [7]
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const dir = process.env.EFFORT_ROUTER_STATE_DIR || path.join(homedir(), ".local", "state", "effort-router");
// Days as a bare number or after --days; 30 by default.
const days = Number(process.argv.slice(2).find((arg) => /^\d+$/.test(arg))) || 30;
const since = Date.now() - days * 86_400_000;

const entries = ["decisions.1.jsonl", "decisions.jsonl"]
  .map((name) => path.join(dir, name))
  .filter(existsSync)
  .flatMap((file) => readFileSync(file, "utf8").split("\n"))
  .filter(Boolean)
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return undefined;
    }
  })
  .filter((e) => e && Date.parse(e.at) >= since);

if (!entries.length) {
  console.log(`No decisions logged in ${dir} in the last ${days} days.`);
  process.exit(0);
}

const count = (list, key) => list.reduce((acc, e) => ((acc[key(e)] = (acc[key(e)] ?? 0) + 1), acc), {});
const pct = (n, of) => (of ? `${Math.round((100 * n) / of)}%` : "-");
const show = (title, counts) => {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`${title} (${total})`);
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(5)}  ${pct(v, total).padStart(4)}  ${k}`);
};
const histogram = (title, values) => {
  if (!values.length) return;
  const buckets = [0, 0, 0, 0, 0];
  for (const v of values) buckets[Math.min(4, Math.floor(v * 5))]++;
  console.log(`${title} (${values.length}): ${buckets.map((n, i) => `${(i / 5).toFixed(1)}-${((i + 1) / 5).toFixed(1)}: ${n}`).join("  ")}`);
};

const sessions = new Set(entries.map((e) => e.session)).size;
console.log(`effort-router, last ${days} days: ${entries.length} entries from ${sessions} sessions (${dir})\n`);

const routes = entries.filter((e) => e.kind === "route");
if (routes.length) {
  show("route: tier", count(routes, (e) => e.tier));
  show("route: action", count(routes, (e) => e.action));
  const judged = routes.filter((e) => e.jev);
  console.log(`route: Jev answered ${judged.length}/${routes.length} (${pct(judged.length, routes.length)})`);
  histogram("route: Jev tier confidence", judged.map((e) => e.jev.confidence));
  histogram("route: Jev stuck", judged.map((e) => e.jev.stuck));
  const agree = judged.filter((e) => e.jev.confidence >= 0.5 && e.jev.tier === e.tier).length;
  console.log(`route: final tier equals Jev's tier ${agree}/${judged.length}`);
  console.log(`route: other sessions active in the repo ${routes.filter((e) => e.nearby).length}/${routes.length}\n`);
}

const signals = entries.filter((e) => e.kind === "signal");
if (signals.length) {
  show("hook signals", count(signals, (e) => `${e.signal}${e.level ? ` level ${e.level}` : ""}${e.subagent ? " (subagent)" : ""}${e.injected ? "" : " (no nudge)"}`));
  console.log();
}

const delegated = entries.filter((e) => e.kind === "delegated" && typeof e.accomplished === "number");
if (delegated.length) {
  histogram("delegated: Jev 'accomplished'", delegated.map((e) => e.accomplished));
  console.log(`delegated: retried one tier up ${delegated.filter((e) => e.retry).length}/${delegated.length}`);
  show("delegated: by agent", count(delegated, (e) => e.agent));
  console.log();
}

const unverified = entries.filter((e) => e.kind === "unverified");
if (unverified.length) {
  histogram("done check: Jev 'claims done'", unverified.filter((e) => typeof e.claimsDone === "number").map((e) => e.claimsDone));
  console.log(`done check: nudged ${unverified.filter((e) => e.nudged).length}/${unverified.length}\n`);
}

const overlaps = entries.filter((e) => e.kind === "overlap");
if (overlaps.length) show("overlaps with other sessions", count(overlaps, (e) => e.overlap));

const consults = entries.filter((e) => e.kind === "knowledge" || e.kind === "rank");
if (consults.length) show("consult tools", count(consults, (e) => e.kind));
