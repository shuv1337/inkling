/**
 * Read a reader's library for their agent: the shelf, the full text, marks,
 * questions, and the brief. Writes are highlights and notes, stored the same
 * way the browser syncs them. Server-side only.
 */

import { randomBytes } from "node:crypto";
import { blockText, type Block } from "./article";
import { db } from "./db";
import { isTopic, type TopicKey } from "./library";
import type { Anchor } from "./store";

const LIST_DEFAULT = 20;
const LIST_MAX = 50;
const SEARCH_DEFAULT = 10;
const SEARCH_MAX = 20;
const CHARS_DEFAULT = 8_000;
const CHARS_MAX = 40_000;
const NOTE_MAX = 4_000;
const QUOTE_MAX = 2_000;
const MARKERS = ["yellow", "green", "blue", "pink"] as const;
type Marker = (typeof MARKERS)[number];

export type ShelfCard = {
  id: string;
  title: string;
  author?: string;
  source?: string;
  url?: string;
  words: number;
  added: string;
  topic: TopicKey;
};

export type TextPage = { text: string; offset: number; nextOffset: number | null; total: number };

type RowData = Record<string, unknown>;

export function newId(): string {
  return randomBytes(6).toString("hex");
}

export function encodeCursor(at: Date, id: string): string {
  return `${at.toISOString()}|${id}`;
}

export function decodeCursor(cursor: string): { at: Date; id: string } | null {
  const bar = cursor.indexOf("|");
  if (bar <= 0) return null;
  const at = new Date(cursor.slice(0, bar));
  const id = cursor.slice(bar + 1);
  if (!id || Number.isNaN(at.getTime())) return null;
  return { at, id };
}

function limitOf(value: unknown, fallback: number, max: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(max, Math.floor(n));
}

function charsOf(value: unknown): number {
  return limitOf(value, CHARS_DEFAULT, CHARS_MAX);
}

function offsetOf(value: unknown, total: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : 0;
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), total);
}

function timeOf(value: unknown): Date | null | "bad" {
  if (value == null || value === "") return null;
  if (typeof value !== "string") return "bad";
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? "bad" : at;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function cardOf(id: string, data: RowData, updated: Date): ShelfCard {
  const topic = isTopic(data.topic) ? data.topic : "unsorted";
  const addedAt = Number(data.addedAt);
  return {
    id,
    title: typeof data.title === "string" ? data.title : "",
    author: typeof data.author === "string" ? data.author : undefined,
    source: typeof data.source === "string" ? data.source : undefined,
    url: typeof data.sourceUrl === "string" ? data.sourceUrl : undefined,
    words: Number(data.words) || 0,
    added: Number.isFinite(addedAt) && addedAt > 0 ? new Date(addedAt).toISOString() : updated.toISOString(),
    topic,
  };
}

function when(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

export function pageOf(text: string, offset: unknown, maxChars: unknown): TextPage {
  const total = text.length;
  const start = offsetOf(offset, total);
  const end = Math.min(total, start + charsOf(maxChars));
  return { text: text.slice(start, end), offset: start, nextOffset: end < total ? end : null, total };
}

function tableMarkdown(rows: string[][], head: boolean): string {
  if (!rows.length) return "";
  const line = (cells: string[]) => `| ${cells.map((cell) => cell.replace(/\|/g, "\\|").replace(/\n/g, " ")).join(" | ")} |`;
  if (!head) return rows.map(line).join("\n");
  const [header, ...body] = rows;
  if (!header?.length) return "";
  return [line(header), `| ${header.map(() => "---").join(" | ")} |`, ...body.map(line)].join("\n");
}

function blockMarkdown(block: Block): string {
  const text = blockText(block).trim();
  switch (block.type) {
    case "h2":
      return text ? `## ${text}` : "";
    case "h3":
      return text ? `### ${text}` : "";
    case "quote":
      return text ? text.split("\n").map((line) => `> ${line}`).join("\n") : "";
    case "li":
      return text ? `- ${text}` : "";
    case "pre":
      return `\`\`\`\n${blockText(block).replace(/\n$/, "")}\n\`\`\``;
    case "figure": {
      const alt = (block.alt || text || "image").replace(/[\[\]]/g, "");
      const image = block.src ? `![${alt}](${block.src})` : "";
      const caption = text && text !== block.alt ? text : "";
      return [image, caption].filter(Boolean).join("\n");
    }
    case "table":
      return tableMarkdown(block.rows ?? [], Boolean(block.head));
    case "note":
    case "p":
      return text;
    default: {
      const neverType: never = block.type;
      return neverType;
    }
  }
}

export function articleMarkdown(blocks: Block[]): string {
  return blocks.map(blockMarkdown).filter(Boolean).join("\n\n");
}

type Span = { block: Block; start: number; end: number };

function spansOf(blocks: Block[]): { spans: Span[]; total: number } {
  const spans: Span[] = [];
  let pos = 0;
  const visible = blocks.filter((block) => blockMarkdown(block).length > 0);
  visible.forEach((block, index) => {
    const md = blockMarkdown(block);
    spans.push({ block, start: pos, end: pos + md.length });
    pos += md.length;
    if (index < visible.length - 1) pos += 2;
  });
  return { spans, total: pos };
}

export function blocksPage(blocks: Block[], offset: unknown, maxChars: unknown): { blocks: Block[]; offset: number; nextOffset: number | null; total: number } {
  const { spans, total } = spansOf(blocks);
  const start = offsetOf(offset, total);
  const end = Math.min(total, start + charsOf(maxChars));
  return {
    blocks: spans.filter((span) => span.end > start && span.start < end).map((span) => span.block),
    offset: start,
    nextOffset: end < total ? end : null,
    total,
  };
}

/** The quote as it sits in one block, so the highlight's offsets match the text. */
export function findQuote(blocks: Block[], quote: string): Anchor | null {
  const needle = quote.trim();
  if (!needle) return null;
  const folded = needle.toLowerCase();
  for (const block of blocks) {
    const text = blockText(block);
    let at = text.indexOf(needle);
    if (at < 0) at = text.toLowerCase().indexOf(folded);
    if (at < 0) continue;
    const end = at + needle.length;
    return { start: { b: block.id, o: at }, end: { b: block.id, o: end }, quote: text.slice(at, end) };
  }
  return null;
}

function asBlocks(doc: unknown): Block[] | null {
  if (!doc || typeof doc !== "object") return null;
  const blocks = (doc as { blocks?: unknown }).blocks;
  if (!Array.isArray(blocks)) return null;
  return blocks.filter((block): block is Block => Boolean(block) && typeof block === "object" && typeof (block as Block).id === "string" && typeof (block as Block).type === "string");
}

function snippetAround(plain: string, query: string): string {
  const words = query.toLowerCase().split(/\s+/).map((word) => word.replace(/[^\p{L}\p{N}]+/gu, "")).filter((word) => word.length > 2);
  const lower = plain.toLowerCase();
  let at = -1;
  for (const word of words) {
    at = lower.indexOf(word);
    if (at >= 0) break;
  }
  const radius = 160;
  if (at < 0) return plain.slice(0, radius * 2).replace(/\s+/g, " ").trim();
  const start = Math.max(0, at - radius);
  const end = Math.min(plain.length, at + radius);
  const slice = plain.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${slice}${end < plain.length ? "…" : ""}`;
}

export async function listItems(
  userId: string,
  args: { topic?: unknown; since?: unknown; limit?: unknown; cursor?: unknown }
): Promise<{ ok: true; items: ShelfCard[]; nextCursor: string | null } | { ok: false; error: string }> {
  const topic = args.topic == null || args.topic === "" ? null : isTopic(args.topic) ? args.topic : "bad";
  if (topic === "bad") return { ok: false, error: "Unknown topic. Use a key from list_topics." };
  const since = timeOf(args.since);
  if (since === "bad") return { ok: false, error: "`since` must be a date." };
  let cursor: { at: Date; id: string } | null = null;
  if (typeof args.cursor === "string" && args.cursor.trim()) {
    cursor = decodeCursor(args.cursor.trim());
    if (!cursor) return { ok: false, error: "That cursor is not one this server issued." };
  }
  const limit = limitOf(args.limit, LIST_DEFAULT, LIST_MAX);
  const rows = await db().query(
    `select id, data, updated_at from articles
     where user_id = $1 and not deleted
       and ($2::text is null or coalesce(data->>'topic', 'unsorted') = $2)
       and ($3::timestamptz is null or updated_at >= $3)
       and ($4::timestamptz is null or updated_at < $4 or (updated_at = $4 and id < $5))
     order by updated_at desc, id desc
     limit $6`,
    [userId, topic, since, cursor?.at ?? null, cursor?.id ?? "", limit + 1]
  );
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const nextCursor = rows.length > limit && last ? encodeCursor(when(last.updated_at), String(last.id)) : null;
  return { ok: true, items: page.map((row) => cardOf(String(row.id), (row.data ?? {}) as RowData, when(row.updated_at))), nextCursor };
}

export async function searchItems(
  userId: string,
  args: { query?: unknown; limit?: unknown }
): Promise<{ ok: true; items: (ShelfCard & { snippet: string })[] } | { ok: false; error: string }> {
  const query = str(args.query);
  if (!query) return { ok: false, error: "Send the words to look for in `query`." };
  const limit = limitOf(args.limit, SEARCH_DEFAULT, SEARCH_MAX);
  const rows = await db().query(
    `select a.id, a.data, a.updated_at,
        left(coalesce((
          select string_agg(coalesce(run.value->>'text', ''), ' ' order by block.ord, run.ord)
          from jsonb_array_elements(coalesce(a.doc->'blocks', '[]'::jsonb)) with ordinality as block(value, ord)
          cross join lateral jsonb_array_elements(coalesce(block.value->'runs', '[]'::jsonb)) with ordinality as run(value, ord)
          where block.ord <= 80
        ), ''), 4000) as plain
     from articles a
     where a.user_id = $1 and not a.deleted
       and a.search @@ websearch_to_tsquery('english', $2)
     order by ts_rank(a.search, websearch_to_tsquery('english', $2)) desc, a.updated_at desc
     limit $3`,
    [userId, query.slice(0, 300), limit]
  );
  return {
    ok: true,
    items: rows.map((row) => ({ ...cardOf(String(row.id), (row.data ?? {}) as RowData, when(row.updated_at)), snippet: snippetAround(String(row.plain ?? ""), query) })),
  };
}

function titleOf(data: RowData, doc: unknown): string {
  if (typeof data.title === "string" && data.title) return data.title;
  if (doc && typeof doc === "object" && typeof (doc as { title?: unknown }).title === "string") return (doc as { title: string }).title;
  return "";
}

async function loadDoc(userId: string, id: string): Promise<{ blocks: Block[]; title: string } | { error: string }> {
  const rows = await db().query("select data, doc from articles where user_id = $1 and id = $2 and not deleted", [userId, id]);
  if (!rows.length) return { error: "That text is not in the library." };
  const blocks = asBlocks(rows[0].doc);
  if (!blocks) return { error: "This text has no full document on the server." };
  return { blocks, title: titleOf((rows[0].data ?? {}) as RowData, rows[0].doc) };
}

export async function getItem(
  userId: string,
  args: { id?: unknown; format?: unknown; offset?: unknown; max_chars?: unknown }
): Promise<
  | { ok: true; id: string; title: string; format: "markdown" | "blocks"; offset: number; nextOffset: number | null; total: number; text?: string; blocks?: Block[] }
  | { ok: false; error: string }
> {
  const id = str(args.id);
  if (!id) return { ok: false, error: "Send the text's id in `id`." };
  const format = args.format == null || args.format === "" || args.format === "markdown" ? "markdown" : args.format === "blocks" ? "blocks" : "bad";
  if (format === "bad") return { ok: false, error: '`format` must be "markdown" or "blocks".' };
  const loaded = await loadDoc(userId, id);
  if ("error" in loaded) return { ok: false, error: loaded.error };
  if (format === "blocks") {
    const page = blocksPage(loaded.blocks, args.offset, args.max_chars);
    return { ok: true, id, title: loaded.title, format, ...page };
  }
  const page = pageOf(articleMarkdown(loaded.blocks), args.offset, args.max_chars);
  return { ok: true, id, title: loaded.title, format, text: page.text, offset: page.offset, nextOffset: page.nextOffset, total: page.total };
}

function isoOf(value: unknown, fallback: Date): string {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return new Date(n).toISOString();
  return fallback.toISOString();
}

export async function getHighlights(
  userId: string,
  args: { id?: unknown; since?: unknown; limit?: unknown }
): Promise<{ ok: true; highlights: { id: string; articleId: string; quote: string; color?: string; anchor: unknown; note?: string; created: string }[] } | { ok: false; error: string }> {
  const since = timeOf(args.since);
  if (since === "bad") return { ok: false, error: "`since` must be a date." };
  const id = str(args.id) ?? null;
  const limit = limitOf(args.limit, 50, 100);
  const rows = await db().query(
    `select id, article_id, data, updated_at from highlights
     where user_id = $1 and not deleted
       and ($2::text is null or article_id = $2)
       and ($3::timestamptz is null or updated_at >= $3)
     order by updated_at desc, id desc
     limit $4`,
    [userId, id, since, limit]
  );
  return {
    ok: true,
    highlights: rows.map((row) => {
      const data = (row.data ?? {}) as RowData;
      const anchor = data.anchor as Anchor | undefined;
      return {
        id: String(row.id),
        articleId: String(row.article_id),
        quote: typeof anchor?.quote === "string" ? anchor.quote : "",
        color: typeof data.color === "string" ? data.color : undefined,
        anchor: anchor ?? null,
        note: typeof data.note === "string" ? data.note : undefined,
        created: isoOf(data.createdAt, when(row.updated_at)),
      };
    }),
  };
}

export async function getNotes(
  userId: string,
  args: { id?: unknown; since?: unknown; limit?: unknown }
): Promise<
  | { ok: true; notes: { id: string; articleId: string; question?: string; action?: string; turns: { role: string; content: string }[]; created: string }[] }
  | { ok: false; error: string }
> {
  const since = timeOf(args.since);
  if (since === "bad") return { ok: false, error: "`since` must be a date." };
  const id = str(args.id) ?? null;
  const limit = limitOf(args.limit, 50, 100);
  const rows = await db().query(
    `select id, article_id, data, updated_at from glosses
     where user_id = $1 and not deleted
       and ($2::text is null or article_id = $2)
       and ($3::timestamptz is null or updated_at >= $3)
     order by updated_at desc, id desc
     limit $4`,
    [userId, id, since, limit]
  );
  return {
    ok: true,
    notes: rows.map((row) => {
      const data = (row.data ?? {}) as RowData;
      const turns = Array.isArray(data.turns) ? data.turns : [];
      return {
        id: String(row.id),
        articleId: String(row.article_id),
        question: typeof data.question === "string" ? data.question : undefined,
        action: typeof data.action === "string" ? data.action : undefined,
        turns: turns
          .filter((turn): turn is { role?: unknown; content?: unknown } => Boolean(turn) && typeof turn === "object")
          .map((turn) => ({ role: typeof turn.role === "string" ? turn.role : "", content: typeof turn.content === "string" ? turn.content : "" })),
        created: isoOf(data.createdAt, when(row.updated_at)),
      };
    }),
  };
}

export async function getBrief(userId: string, args: { id?: unknown }): Promise<{ ok: true; brief: Record<string, unknown> | null } | { ok: false; error: string }> {
  const id = str(args.id);
  if (!id) return { ok: false, error: "Send the text's id in `id`." };
  const rows = await db().query("select data from briefs where user_id = $1 and id = $2 and not deleted", [userId, id]);
  if (!rows.length) return { ok: true, brief: null };
  const data = (rows[0].data ?? {}) as RowData;
  if (data.status === "ready" && data.data && typeof data.data === "object") {
    return { ok: true, brief: { status: "ready", ...(data.data as Record<string, unknown>) } };
  }
  return { ok: true, brief: { status: typeof data.status === "string" ? data.status : "unknown" } };
}

export async function addHighlight(
  userId: string,
  args: { id?: unknown; quote?: unknown; color?: unknown; note?: unknown }
): Promise<{ ok: true; highlight: { id: string; articleId: string; quote: string; color: Marker; anchor: Anchor } } | { ok: false; error: string }> {
  const id = str(args.id);
  const quote = str(args.quote);
  if (!id || !quote) return { ok: false, error: "Send the text's id and the quote to mark." };
  if (quote.length > QUOTE_MAX) return { ok: false, error: "That quote is too long to mark in one highlight." };
  const color = args.color == null || args.color === "" ? "yellow" : MARKERS.find((marker) => marker === args.color);
  if (!color) return { ok: false, error: "Color must be yellow, green, blue, or pink." };
  const note = str(args.note);
  if (note && note.length > NOTE_MAX) return { ok: false, error: "That note is too long." };
  const loaded = await loadDoc(userId, id);
  if ("error" in loaded) return { ok: false, error: loaded.error };
  const anchor = findQuote(loaded.blocks, quote);
  if (!anchor) return { ok: false, error: "That quote is not in one block of this text." };
  const highlightId = newId();
  const data = { id: highlightId, articleId: id, anchor, createdAt: Date.now(), color, ...(note ? { note } : {}) };
  await db().query(
    "insert into highlights (user_id, id, article_id, data, deleted, updated_at) values ($1, $2, $3, $4, false, now())",
    [userId, highlightId, id, data]
  );
  return { ok: true, highlight: { id: highlightId, articleId: id, quote: anchor.quote, color, anchor } };
}

export async function addNote(
  userId: string,
  args: { id?: unknown; question?: unknown; quote?: unknown }
): Promise<{ ok: true; note: { id: string; articleId: string; question: string } } | { ok: false; error: string }> {
  const id = str(args.id);
  const question = str(args.question);
  if (!id || !question) return { ok: false, error: "Send the text's id and the question." };
  if (question.length > NOTE_MAX) return { ok: false, error: "That question is too long." };
  const quote = str(args.quote);
  const loaded = await loadDoc(userId, id);
  if ("error" in loaded) return { ok: false, error: loaded.error };
  let anchor: Anchor | undefined;
  if (quote) {
    const found = findQuote(loaded.blocks, quote);
    if (!found) return { ok: false, error: "That quote is not in one block of this text." };
    anchor = found;
  }
  const noteId = newId();
  const data = {
    id: noteId,
    articleId: id,
    action: "ask",
    question,
    turns: [{ role: "user", content: question }],
    createdAt: Date.now(),
    ...(anchor ? { anchor } : {}),
  };
  await db().query("insert into glosses (user_id, id, article_id, data, deleted, updated_at) values ($1, $2, $3, $4, false, now())", [userId, noteId, id, data]);
  return { ok: true, note: { id: noteId, articleId: id, question } };
}
