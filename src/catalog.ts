import Anthropic from "@anthropic-ai/sdk";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export function isEffort(value: unknown): value is Effort {
  return typeof value === "string" && (EFFORTS as readonly string[]).includes(value);
}

export interface FamilyInfo {
  /** Higher is more capable. The router only routes to ranked families. */
  rank: number;
  /** Newest model id seen for the family, e.g. `claude-opus-5-5`. Informational: Claude Code resolves the alias itself. */
  latest: string;
  /** Effort levels the newest model accepts. Empty means it takes no effort parameter. */
  efforts: Effort[];
}

export interface Catalog {
  source: "bundled" | "models-api";
  fetchedAt?: string;
  /** Keyed by Claude Code alias (`haiku`, `sonnet`, `opus`, `fable`). */
  families: Record<string, FamilyInfo>;
  /** Families the Models API lists that have no rank here yet. */
  unranked: { family: string; latest: string }[];
}

const ALL: Effort[] = [...EFFORTS];

// Checked on 2026-09-22 against Claude Code's "Adjust effort level" table. Only the
// ranking needs a human when a new family ships; versions come from the aliases.
export const BUNDLED: Catalog = {
  source: "bundled",
  families: {
    haiku: { rank: 1, latest: "claude-haiku-4-5", efforts: [] },
    sonnet: { rank: 2, latest: "claude-sonnet-5", efforts: ALL },
    opus: { rank: 3, latest: "claude-opus-5-5", efforts: ALL },
    fable: { rank: 4, latest: "claude-fable-5-1", efforts: ALL },
  },
  unranked: [],
};

/** Families Claude Code has no alias for, so the Agent tool cannot select them. */
const IGNORED_FAMILIES = new Set(["mythos"]);

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export function dataDir(): string {
  return process.env.CLAUDE_PLUGIN_DATA || path.join(homedir(), ".cache", "effort-router");
}

export function familyOf(modelId: string): string | undefined {
  return /^claude-([a-z]+)-/.exec(modelId)?.[1];
}

/** Highest supported level at or below `want`, the same fallback Claude Code applies. */
export function clampEffort(want: Effort, supported: readonly Effort[]): Effort | undefined {
  if (supported.length === 0) return undefined;
  for (let i = EFFORTS.indexOf(want); i >= 0; i--) {
    if (supported.includes(EFFORTS[i])) return EFFORTS[i];
  }
  return supported[0];
}

function effortsOf(capabilities: Anthropic.ModelCapabilities | null): Effort[] {
  const effort = capabilities?.effort;
  if (!effort?.supported) return [];
  return EFFORTS.filter((level) => effort[level]?.supported);
}

export function mergeLive(models: Anthropic.ModelInfo[], now = new Date()): Catalog {
  const newest = new Map<string, Anthropic.ModelInfo>();
  for (const model of models) {
    const family = familyOf(model.id);
    if (!family || IGNORED_FAMILIES.has(family)) continue;
    const previous = newest.get(family);
    if (!previous || Date.parse(model.created_at) > Date.parse(previous.created_at)) newest.set(family, model);
  }

  const families: Record<string, FamilyInfo> = structuredClone(BUNDLED.families);
  const unranked: Catalog["unranked"] = [];
  for (const [family, model] of newest) {
    const known = families[family];
    // No capability data (a gateway, or a new model) says nothing about effort: keep what is known.
    if (known) families[family] = { ...known, latest: model.id, efforts: model.capabilities ? effortsOf(model.capabilities) : known.efforts };
    else unranked.push({ family, latest: model.id });
  }
  return { source: "models-api", fetchedAt: now.toISOString(), families, unranked };
}

/** The cache holds the raw model list, so ranks always come from the current BUNDLED. */
interface Cached {
  fetchedAt: string;
  models: Anthropic.ModelInfo[];
}

async function readCache(file: string): Promise<Catalog | undefined> {
  try {
    const cached = JSON.parse(await readFile(file, "utf8")) as Cached;
    if (Array.isArray(cached.models) && Date.now() - Date.parse(cached.fetchedAt) < CACHE_TTL_MS) {
      return mergeLive(cached.models, new Date(cached.fetchedAt));
    }
  } catch {
    // No cache yet, or unreadable: fetch again.
  }
  return undefined;
}

/**
 * The live catalog from the Models API, cached for a day. Resolves to undefined when no
 * API credentials are available; the router then runs on BUNDLED plus Claude Code's aliases.
 */
export async function loadLiveCatalog(timeoutMs = 4000): Promise<Catalog | undefined> {
  const file = path.join(dataDir(), "models.json");
  const cached = await readCache(file);
  if (cached) return cached;

  const models: Anthropic.ModelInfo[] = [];
  try {
    const client = new Anthropic({ timeout: timeoutMs, maxRetries: 0 });
    for await (const model of client.models.list({ limit: 100 })) models.push(model);
  } catch {
    return undefined;
  }

  const fetchedAt = new Date();
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ fetchedAt: fetchedAt.toISOString(), models } satisfies Cached));
  } catch {
    // The cache is an optimisation only.
  }
  return mergeLive(models, fetchedAt);
}
