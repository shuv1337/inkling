/**
 * How a passage is split before it is spoken. Safe on the client: no keys
 * and no network. The provider lives in lib/tts.ts.
 */

/** One request's worth of text. Paragraphs past this are split at sentence ends. */
export const TTS_MAX_CHARS = 1200;

/**
 * Paragraphs are split at sentence ends. The very first clip is short, so
 * the voice starts quickly. Pieces that are still too long are cut to the limit.
 */
export function passageChunks(text: string, first: boolean): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+["'”’)\]]*\s*|[^.!?]+$/g) ?? [text];
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    const limit = first && out.length === 0 ? 220 : TTS_MAX_CHARS;
    if (cur && (cur + s).length > limit) {
      out.push(cur.trim());
      cur = "";
    }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.flatMap((c) => (c.length > TTS_MAX_CHARS ? c.match(new RegExp(`[\\s\\S]{1,${TTS_MAX_CHARS}}`, "g")) ?? [] : [c]));
}
