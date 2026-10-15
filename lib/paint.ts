/**
 * A painted cover for one text, on the server: the scene the classifier
 * wrote, as a two-colour risograph print in its topic's inks. The title is
 * never in the prompt, or the model letters it onto the picture.
 *
 * Together is the default image host. COVERS_BASE_URL / COVERS_MODEL point at
 * an OpenAI-compatible images endpoint, and FEATURE_COVERS=0 turns painting off.
 */

import { TOPIC, type TopicKey } from "./library";
import { APP_UA, isTogetherBase, llmSettings } from "./llm";

const SIZE = 640;
/**
 * What one cover costs, charged to the free allowance. FLUX.2 [dev] at 640px:
 * an estimate on the high side until Together's per-megapixel price is checked.
 */
export const COVER_USD = 0.02;

const TOGETHER_MODEL = "black-forest-labs/FLUX.2-dev";

type Env = Record<string, string | undefined>;

export type CoverSettings =
  | { enabled: false; reason: string }
  | { enabled: true; url: string; model: string; apiKey: string; together: boolean; provider: string };

export function coverSettings(env: Env = process.env): CoverSettings {
  if (env.FEATURE_COVERS === "0") return { enabled: false, reason: "Painted covers are turned off." };
  const llm = llmSettings(env);
  const base = (env.COVERS_BASE_URL?.trim() || llm.baseUrl).replace(/\/+$/, "");
  const together = isTogetherBase(base);
  const model = env.COVERS_MODEL?.trim() || (together ? TOGETHER_MODEL : "");
  if (!model) return { enabled: false, reason: "Painted covers need COVERS_MODEL, or set FEATURE_COVERS=0." };
  return {
    enabled: true,
    url: `${base}/images/generations`,
    model,
    apiKey: env.COVERS_API_KEY?.trim() || llm.apiKey,
    together,
    provider: together ? "Together" : "the image provider",
  };
}

export function buildCoverRequest(req: { scene: string; topic: TopicKey; apiKey?: string }, env: Env = process.env): { ok: true; url: string; headers: Record<string, string>; body: Record<string, unknown>; provider: string } | { ok: false; error: string } {
  const settings = coverSettings(env);
  if (!settings.enabled) return { ok: false, error: settings.reason };
  const apiKey = req.apiKey?.trim() || settings.apiKey;
  if (!apiKey) return { ok: false, error: "No API key for painted covers." };
  const prompt = `Editorial risograph print. ${req.scene.replace(/\.?$/, ".")} Two-colour palette of ${TOPIC[req.topic].inks} ink on warm cream paper filling the whole image, grain and halftone texture, mid-century book-cover illustration, wordless, no lettering, no border.`;
  const body = settings.together
    ? { model: settings.model, prompt, width: SIZE, height: SIZE, n: 1, response_format: "base64", prompt_upsampling: false }
    : { model: settings.model, prompt, n: 1, size: "1024x1024", response_format: "b64_json" };
  return {
    ok: true,
    url: settings.url,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, "User-Agent": APP_UA },
    body,
    provider: settings.provider,
  };
}

export async function paintCover(req: { scene: string; topic: TopicKey; apiKey?: string; signal?: AbortSignal }, env: Env = process.env): Promise<{ ok: true; jpeg: Uint8Array } | { ok: false; error: string }> {
  const built = buildCoverRequest(req, env);
  if (!built.ok) return built;
  let res: Response;
  try {
    res = await fetch(built.url, { method: "POST", signal: req.signal, headers: built.headers, body: JSON.stringify(built.body) });
  } catch (e) {
    return { ok: false, error: `Could not reach ${built.provider === "Together" ? "Together" : "the image provider"}: ${String(e)}` };
  }
  const j = (await res.json().catch(() => ({}))) as { data?: { b64_json?: string }[]; error?: { message?: string } };
  const b64 = j.data?.[0]?.b64_json;
  if (!res.ok || !b64) return { ok: false, error: j.error?.message ?? `${built.provider === "Together" ? "Together" : "The image provider"} answered ${res.status}.` };
  return { ok: true, jpeg: Uint8Array.from(Buffer.from(b64, "base64")) };
}
