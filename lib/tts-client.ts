/** What /api/speak tells the browser. No secrets. */

export const TTS_VOICE_KEY = "gloss:tts-voice";

export type TtsPublic = {
  enabled: boolean;
  provider: "together" | "openai-compatible" | "off";
  needsKey: boolean;
  voice: string;
  voices: { id: string; label: string }[];
  reason?: string;
};

const fallback: TtsPublic = { enabled: true, provider: "together", needsKey: true, voice: "", voices: [] };

let pending: Promise<TtsPublic> | null = null;

export function loadTtsPublic(): Promise<TtsPublic> {
  if (typeof window === "undefined") return Promise.resolve(fallback);
  pending ??= fetch("/api/speak")
    .then((r) => r.json() as Promise<TtsPublic>)
    .catch(() => fallback);
  return pending;
}

export function savedVoice(): string | undefined {
  try {
    const v = localStorage.getItem(TTS_VOICE_KEY)?.trim();
    return v || undefined;
  } catch {
    return undefined;
  }
}

export function saveVoice(id: string) {
  try {
    localStorage.setItem(TTS_VOICE_KEY, id);
  } catch {
    /* private mode */
  }
}
