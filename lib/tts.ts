/**
 * Read aloud. Together, an OpenAI-compatible speech endpoint (Kokoro-FastAPI
 * and others), or off. The request is the same shape for both providers:
 * POST {base}/audio/speech with model, voice, input, and response_format mp3.
 * The browser still chunks long texts (lib/voice.ts) and plays the MP3.
 */

import { APP_UA, TOGETHER_API_BASE } from "./llm";
import { TTS_MAX_CHARS } from "./voice";

export type TtsProvider = "together" | "openai-compatible" | "off";

export type TtsVoice = { id: string; label: string };

export type TtsSettings = {
  provider: TtsProvider;
  enabled: boolean;
  baseUrl: string;
  model: string;
  voice: string;
  voices: TtsVoice[];
  apiKey: string;
  /** Together with no TTS_API_KEY still asks the reader for a key. */
  needsUserKey: boolean;
  reason?: string;
};

type Env = Record<string, string | undefined>;

const TOGETHER_MODEL = "cartesia/sonic-3";
/** "Marian - Poised Narrator" on Together. */
const TOGETHER_VOICE = "26403c37-80c1-4a1a-8692-540551ca2ae5";
/** Kokoro-FastAPI's model id and a default voice. Not a host. */
const COMPAT_MODEL = "kokoro";
const COMPAT_VOICE = "af_heart";

function providerOf(raw: string | undefined): TtsProvider | "invalid" {
  if (raw == null || raw.trim() === "" || raw.trim() === "together") return "together";
  if (raw.trim() === "openai-compatible") return "openai-compatible";
  if (raw.trim() === "off") return "off";
  return "invalid";
}

/** `id:Label,id:Label` or a bare id. With nothing set, the single default voice is the list. */
export function parseVoices(raw: string | undefined, fallback: string): TtsVoice[] {
  if (!raw?.trim()) return fallback ? [{ id: fallback, label: fallback }] : [];
  const voices: TtsVoice[] = [];
  for (const part of raw.split(",")) {
    const piece = part.trim();
    if (!piece) continue;
    const colon = piece.indexOf(":");
    if (colon === -1) voices.push({ id: piece, label: piece });
    else {
      const id = piece.slice(0, colon).trim();
      const label = piece.slice(colon + 1).trim() || id;
      if (id) voices.push({ id, label });
    }
  }
  return voices.length ? voices : fallback ? [{ id: fallback, label: fallback }] : [];
}

const off = (reason: string): TtsSettings => ({
  provider: "off",
  enabled: false,
  baseUrl: "",
  model: "",
  voice: "",
  voices: [],
  apiKey: "",
  needsUserKey: false,
  reason,
});

export function ttsSettings(env: Env = process.env): TtsSettings {
  const provider = providerOf(env.TTS_PROVIDER);
  switch (provider) {
    case "invalid":
      return off("TTS_PROVIDER must be together, openai-compatible, or off.");
    case "off":
      return off("Reading aloud is turned off.");
    case "together": {
      const voice = env.TTS_VOICE?.trim() || TOGETHER_VOICE;
      const apiKey = env.TTS_API_KEY?.trim() || "";
      return {
        provider,
        enabled: true,
        baseUrl: (env.TTS_BASE_URL?.trim() || TOGETHER_API_BASE).replace(/\/+$/, ""),
        model: env.TTS_MODEL?.trim() || TOGETHER_MODEL,
        voice,
        voices: parseVoices(env.TTS_VOICES, voice),
        apiKey,
        needsUserKey: !apiKey,
      };
    }
    case "openai-compatible": {
      const baseUrl = env.TTS_BASE_URL?.trim().replace(/\/+$/, "") ?? "";
      if (!baseUrl) return off("Set TTS_BASE_URL for TTS_PROVIDER=openai-compatible.");
      const voice = env.TTS_VOICE?.trim() || COMPAT_VOICE;
      const apiKey = env.TTS_API_KEY?.trim() || "";
      return {
        provider,
        enabled: true,
        baseUrl,
        model: env.TTS_MODEL?.trim() || COMPAT_MODEL,
        voice,
        voices: parseVoices(env.TTS_VOICES, voice),
        apiKey,
        needsUserKey: false,
      };
    }
    default: {
      const neverProvider: never = provider;
      return neverProvider;
    }
  }
}

/** What the browser may know. No base URL and no key. */
export function ttsPublic(env: Env = process.env) {
  const s = ttsSettings(env);
  return { enabled: s.enabled, provider: s.provider, needsKey: s.needsUserKey, voice: s.voice, voices: s.voices, ...(s.reason ? { reason: s.reason } : {}) };
}

function pickVoice(settings: TtsSettings, requested?: string): string {
  const want = requested?.trim();
  if (want && settings.voices.some((v) => v.id === want)) return want;
  return settings.voice;
}

export type SpeechCall =
  | { ok: true; url: string; headers: Record<string, string>; body: { model: string; voice: string; input: string; response_format: "mp3" } }
  | { ok: false; status: number; error: string; code?: string };

export function buildSpeechRequest(input: { text: string; voice?: string; apiKey?: string }, env: Env = process.env): SpeechCall {
  const settings = ttsSettings(env);
  if (!settings.enabled) return { ok: false, status: 501, error: settings.reason ?? "Reading aloud is turned off.", code: "off" };
  const text = input.text.trim();
  if (!text) return { ok: false, status: 400, error: "Nothing to read." };
  if (text.length > TTS_MAX_CHARS + 200) return { ok: false, status: 413, error: "That passage is too long to read in one go." };
  const apiKey = input.apiKey?.trim() || settings.apiKey;
  if (settings.needsUserKey && !apiKey) return { ok: false, status: 401, error: "Reading aloud needs an API key. Add it to listen.", code: "need_key" };
  const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": APP_UA };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return {
    ok: true,
    url: `${settings.baseUrl}/audio/speech`,
    headers,
    body: { model: settings.model, voice: pickVoice(settings, input.voice), input: text, response_format: "mp3" },
  };
}

export async function requestSpeech(
  input: { text: string; voice?: string; apiKey?: string },
  deps: { fetch?: typeof fetch; env?: Env; signal?: AbortSignal } = {}
): Promise<{ ok: true; response: Response } | { ok: false; status: number; error: string; code?: string }> {
  const built = buildSpeechRequest(input, deps.env ?? process.env);
  if (!built.ok) return built;
  const fetchImpl = deps.fetch ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(built.url, { method: "POST", signal: deps.signal, headers: built.headers, body: JSON.stringify(built.body) });
  } catch {
    return { ok: false, status: 502, error: "Could not reach the voice. Check your connection." };
  }
  if (!res.ok || !res.body) {
    let msg = `The voice answered ${res.status}.`;
    try {
      const j = (await res.json()) as { error?: { message?: string } | string };
      msg = typeof j.error === "string" ? j.error : j.error?.message ?? msg;
    } catch {
      /* body was not JSON */
    }
    if (res.status === 401) msg = "The voice rejected that API key. Check it and try again.";
    return { ok: false, status: res.status === 401 || res.status === 429 ? res.status : 502, error: msg };
  }
  return { ok: true, response: res };
}
