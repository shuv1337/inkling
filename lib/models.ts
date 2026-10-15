/**
 * The model allow-list and wire types. Safe to import on the client: no keys,
 * no fetches. lib/llm.ts does the network side.
 */
import { isTogetherBase } from "./llm";

export type ModelEntry = {
  id: string;
  label: string;
  short: string;
  blurb: string;
  inPerM: number;
  cachedPerM: number;
  outPerM: number;
};

/**
 * The allow-list. Route and UI both read it. Bake-off 2026-10-09: 3 sample
 * texts x 8 tasks on the real prompts, answers scored blind by a judge.
 *   V4.1 Flash  0.23s to first token, $0.0006 an answer, 7.3/10, best in 11 of 24
 *   V4 Pro      0.58s, $0.0052, 6.5/10
 *   Kimi K3     0.86s, $0.0096, 6.3/10 (best gloss summaries, weak on Related)
 *   GLM-5.3     0.36s at reasoning_effort low, $0.0048, 6.3/10, 3 of the 4 factual errors
 * GLM-5.3 ignores every thinking-off flag (default effort: a 60s summary).
 * Also left out: Qwen3.8 (prints its reasoning into content with thinking off).
 *
 * Flash won on quality as well as speed and cost, so it answers everything:
 * there was a "Deep" choice (V4 Pro, then Kimi K3) and it was dropped
 * 2026-10-09. Older answers and settings may still name "pro"; anything that
 * looks a model up goes through modelOf(), which falls back to Flash.
 */
export const MODELS = {
  flash: {
    id: "deepseek-ai/DeepSeek-V4.1-Flash",
    label: "DeepSeek V4.1 Flash",
    short: "Quick",
    blurb: "Answers in about half a second. Best for most questions.",
    inPerM: 0.3,
    cachedPerM: 0.006,
    outPerM: 1.2,
  },
} as const satisfies Record<string, ModelEntry>;

export type ModelKey = keyof typeof MODELS;
export const DEFAULT_MODEL: ModelKey = "flash";

type Env = Record<string, string | undefined>;

export function isModelKey(v: unknown): v is ModelKey {
  return typeof v === "string" && v in MODELS;
}

/** A model key that is still on the list: a saved "pro" from before Deep was dropped becomes Flash. */
export const modelOf = (v: unknown): ModelKey => (isModelKey(v) ? v : DEFAULT_MODEL);

export type Usage = {
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  costUsd: number;
};

/** Dollars for a run. Cached prompt tokens bill at the cached rate. */
export function costFor(key: ModelKey, prompt: number, cached: number, completion: number): number {
  return costOf(MODELS[key], prompt, cached, completion);
}

export function costOf(entry: ModelEntry, prompt: number, cached: number, completion: number): number {
  const fresh = Math.max(0, prompt - cached);
  return (fresh * entry.inPerM + cached * entry.cachedPerM + completion * entry.outPerM) / 1_000_000;
}

/**
 * `LLM_MODELS=key:id:label,key:id:label`. The id may contain colons; the label is the last field.
 * Prices come from LLM_PRICE_IN/OUT, or 0 away from Together, which turns the free-budget math off.
 */
export function parseModelList(raw: string | undefined, price: Pick<ModelEntry, "inPerM" | "cachedPerM" | "outPerM">): Record<string, ModelEntry> | null {
  if (!raw?.trim()) return null;
  const out: Record<string, ModelEntry> = {};
  for (const part of raw.split(",")) {
    const piece = part.trim();
    if (!piece) continue;
    const first = piece.indexOf(":");
    const last = piece.lastIndexOf(":");
    if (first <= 0 || last <= first) continue;
    const key = piece.slice(0, first).trim();
    const id = piece.slice(first + 1, last).trim();
    const label = piece.slice(last + 1).trim();
    if (!key || !id || !label) continue;
    out[key] = { id, label, short: label, blurb: label, ...price };
  }
  return Object.keys(out).length ? out : null;
}

function prices(env: Env, together: boolean): Pick<ModelEntry, "inPerM" | "cachedPerM" | "outPerM"> {
  const hasIn = env.LLM_PRICE_IN != null && env.LLM_PRICE_IN !== "";
  const hasOut = env.LLM_PRICE_OUT != null && env.LLM_PRICE_OUT !== "";
  if (!hasIn && !hasOut) {
    if (together) return { inPerM: MODELS.flash.inPerM, cachedPerM: MODELS.flash.cachedPerM, outPerM: MODELS.flash.outPerM };
    return { inPerM: 0, cachedPerM: 0, outPerM: 0 };
  }
  return {
    inPerM: Number(env.LLM_PRICE_IN) || 0,
    cachedPerM: Number(env.LLM_PRICE_CACHED) || 0,
    outPerM: Number(env.LLM_PRICE_OUT) || 0,
  };
}

/** What the server may call. The client keeps the static MODELS list for labels. */
export function modelCatalog(env: Env = process.env): Record<string, ModelEntry> {
  const base = env.LLM_BASE_URL?.trim().replace(/\/+$/, "") ?? "";
  const together = !base || isTogetherBase(base);
  const price = prices(env, together);
  const parsed = parseModelList(env.LLM_MODELS, price);
  if (parsed) return parsed;
  const id = env.LLM_MODEL?.trim() || MODELS.flash.id;
  const catalog: Record<string, ModelEntry> = { flash: { ...MODELS.flash, id, ...price } };
  const fast = env.LLM_MODEL_FAST?.trim();
  if (fast) catalog.fast = { ...MODELS.flash, id: fast, label: fast, short: "Fast", blurb: fast, ...price };
  return catalog;
}

export function resolveModel(key: unknown, env: Env = process.env): { key: string; entry: ModelEntry } {
  const catalog = modelCatalog(env);
  const fallback = Object.keys(catalog)[0] ?? DEFAULT_MODEL;
  const chosen = typeof key === "string" && catalog[key] ? key : fallback;
  return { key: chosen, entry: catalog[chosen] ?? MODELS.flash };
}

/** A web result an answer can cite as [n]. */
export type Source = { n: number; title: string; url: string; site: string; date?: string };

export type StreamEvent =
  | { type: "meta"; model: string }
  | { type: "searching" }
  /** The model asked for a tool (web search); the route runs it and asks again. Never sent to the browser. */
  | { type: "tool"; id: string; name: string; args: string }
  /** Drop what was written so far: a line before a tool call ("I'll look that up") that the real answer replaces. */
  | { type: "reset" }
  | { type: "sources"; sources: Source[] }
  | { type: "content"; text: string }
  | { type: "usage"; usage: Usage }
  | { type: "done" }
  | { type: "error"; text: string };
