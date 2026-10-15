/**
 * OpenAI-compatible chat. Together stays the default; LLM_BASE_URL points
 * the same requests at another provider. Server-side only.
 *
 * chat_template_kwargs is a Together field. It is sent only for that host,
 * unless LLM_EXTRA_BODY sets the extra JSON explicitly.
 */

import { resolveModel, type ModelEntry } from "./models";

export const APP_UA = "Gloss/0.1";
export const TOGETHER_API_BASE = "https://api.together.xyz/v1";

type Env = Record<string, string | undefined>;

const TOGETHER_HOST = new URL(TOGETHER_API_BASE).host;

export function isTogetherBase(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).host === TOGETHER_HOST;
  } catch {
    return false;
  }
}

export type LlmSettings = {
  baseUrl: string;
  apiKey: string;
  together: boolean;
  /** Short name for error text. */
  provider: string;
};

export function llmSettings(env: Env = process.env): LlmSettings {
  const baseUrl = (env.LLM_BASE_URL?.trim() || TOGETHER_API_BASE).replace(/\/+$/, "");
  const together = isTogetherBase(baseUrl);
  return {
    baseUrl,
    apiKey: env.LLM_API_KEY?.trim() || env.TOGETHER_API_KEY?.trim() || "",
    together,
    provider: together ? "Together" : "the model provider",
  };
}

/** Extra JSON merged into a chat body. Invalid LLM_EXTRA_BODY is an error string. */
export function chatExtras(env: Env, thinking: boolean): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  const raw = env.LLM_EXTRA_BODY?.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, error: "LLM_EXTRA_BODY must be a JSON object." };
      return { ok: true, body: parsed as Record<string, unknown> };
    } catch {
      return { ok: false, error: "LLM_EXTRA_BODY is not valid JSON." };
    }
  }
  if (isTogetherBase((env.LLM_BASE_URL?.trim() || TOGETHER_API_BASE).replace(/\/+$/, ""))) {
    return { ok: true, body: { chat_template_kwargs: { enable_thinking: thinking } } };
  }
  return { ok: true, body: {} };
}

export type ChatRequestInput = {
  /** A model key ("flash") or already a wire id. Resolved against the env catalog. */
  model: unknown;
  messages: unknown;
  apiKey?: string;
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
  tools?: readonly unknown[];
  toolChoice?: "auto" | "none";
  thinking?: boolean;
  responseFormat?: unknown;
};

export type BuiltChat =
  | {
      ok: true;
      url: string;
      headers: Record<string, string>;
      body: Record<string, unknown>;
      entry: ModelEntry;
      provider: string;
    }
  | { ok: false; error: string };

export function buildChatRequest(req: ChatRequestInput, env: Env = process.env): BuiltChat {
  const settings = llmSettings(env);
  const apiKey = req.apiKey?.trim() || settings.apiKey;
  if (!apiKey) return { ok: false, error: "No API key. Set LLM_API_KEY or TOGETHER_API_KEY, or add your own key." };
  const extras = chatExtras(env, Boolean(req.thinking));
  if (!extras.ok) return extras;
  const { entry } = resolveModel(req.model, env);
  const body: Record<string, unknown> = {
    model: entry.id,
    temperature: req.temperature ?? 0.4,
    max_tokens: req.maxTokens ?? 900,
    messages: req.messages,
    ...extras.body,
  };
  if (req.stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  if (req.responseFormat) body.response_format = req.responseFormat;
  if (req.tools) {
    body.tools = req.tools;
    body.tool_choice = req.toolChoice ?? "auto";
  }
  return {
    ok: true,
    url: `${settings.baseUrl}/chat/completions`,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "User-Agent": APP_UA,
    },
    body,
    entry,
    provider: settings.provider,
  };
}

export function providerError(provider: string, status: number, raw: string): string {
  let msg = raw.slice(0, 280);
  try {
    const j = JSON.parse(raw) as { error?: { message?: string } | string; message?: string };
    if (typeof j.error === "string") msg = j.error;
    else if (j.error?.message) msg = j.error.message;
    else if (j.message) msg = j.message;
  } catch {
    /* not JSON */
  }
  const name = provider === "Together" ? "Together" : "The model provider";
  if (status === 401) return `${name} rejected that API key. Check it and try again.`;
  if (status === 429) return provider === "Together" ? "Together is rate limiting this key. Wait a moment, or use your own key." : `${name} is rate limiting this key. Wait a moment and try again.`;
  return `${provider === "Together" ? "Together" : "Model"} API ${status}: ${msg}`;
}

export type VisionSettings =
  | { enabled: false; reason: string }
  | { enabled: true; model: string; layoutModel: string; apiKey: string; baseUrl: string; together: boolean; provider: string };

/** Scanned-page reading. On Together the known vision models are the default; elsewhere set VISION_MODEL, or turn it off. */
export function visionSettings(env: Env = process.env): VisionSettings {
  const settings = llmSettings(env);
  if (env.FEATURE_VISION === "0") return { enabled: false, reason: "Scanned PDF reading is turned off." };
  const model = env.VISION_MODEL?.trim() || (settings.together ? "Qwen/Qwen3.8-Flash" : "");
  const layoutModel = env.VISION_LAYOUT_MODEL?.trim() || (settings.together ? "Qwen/Qwen3.5-9B" : model);
  if (!model) return { enabled: false, reason: "Scanned PDF reading needs VISION_MODEL, or set FEATURE_VISION=0." };
  return { enabled: true, model, layoutModel, apiKey: settings.apiKey, baseUrl: settings.baseUrl, together: settings.together, provider: settings.provider };
}

export function modelsUrl(env: Env = process.env): string {
  return `${llmSettings(env).baseUrl}/models`;
}
