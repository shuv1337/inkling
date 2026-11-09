import { blockText, type Block, type BriefData } from "./article";

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

/** Navigation uses the same readable blocks as playback, skipping images and empty text. */
export function spokenBlocks(blocks: Block[]): Block[] {
  return blocks.filter((b) => ["p", "h2", "h3", "quote", "li", "note"].includes(b.type) && blockText(b).trim());
}

export function adjacentSpokenBlock(blocks: Block[], current: string | null, direction: -1 | 1): string | null {
  return adjacentUnit(spokenBlocks(blocks), current, direction);
}

/** The passage before or after the current one, skipping any with nothing to say. */
export function adjacentUnit(units: { id: string; text?: string }[], current: string | null, direction: -1 | 1): string | null {
  const spoken = units.filter((u) => u.text !== "");
  const at = spoken.findIndex((u) => u.id === current);
  return at < 0 ? null : spoken[at + direction]?.id ?? null;
}

/** A passage to speak, with the id the highlight follows. */
export type SpokenUnit = { id: string; text: string };

/** Model Markdown as it should sound: no key-answer marks, citations, emphasis or list markers. */
export function speakable(s: string): string {
  return s
    .replace(/==/g, "")
    .replace(/\s?\[\s*¶[^\]]{0,60}\]/g, "")
    .replace(/\s?\[\d{1,2}(?:\s*,\s*\d{1,2})*\]/g, "")
    .replace(/^\s*([-*•]|\d+[.)])\s+/gm, "")
    .replace(/[*`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The brief as it is read aloud: the gist, then each claim and caveat, with the headings spoken once. */
export function briefUnits(data: BriefData): SpokenUnit[] {
  const out: SpokenUnit[] = [{ id: "brief:gist", text: speakable(data.gist) }];
  data.claims.forEach((c, i) => out.push({ id: `brief:claim:${i}`, text: `${i === 0 ? "Key claims. " : ""}${speakable(c.text)}` }));
  (data.caveats ?? []).forEach((c, i) => out.push({ id: `brief:caveat:${i}`, text: `${i === 0 ? "Keep in mind. " : ""}${speakable(c.text)}` }));
  return out.filter((u) => u.text);
}
