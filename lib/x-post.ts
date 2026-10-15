/**
 * One X or Twitter status, as an article. fxtwitter first, then the X API
 * when X_BEARER_TOKEN is set. X_FETCH is the order, default "fx,api".
 * A deleted or protected post stops there. A network failure or a 5xx tries
 * the next source. Profile URLs are not statuses and are not fetched.
 */

import { blockText, tidyTitle, undash, type Article, type Block, type Run } from "./article";
import { APP_UA } from "./llm";

export type XFetchResult = { ok: true; article: Article } | { ok: false; error: string; status: number };

type Env = Record<string, string | undefined>;
type FetchLike = typeof fetch;

const HOSTS = new Set(["x.com", "twitter.com", "mobile.twitter.com"]);
const FX = "https://api.fxtwitter.com";
const X_API = "https://api.x.com/2/tweets";

type ProviderName = "fx" | "api";

type Attempt = { ok: true; article: Article } | { ok: false; error: string; status: number; terminal: boolean };

type Quote = { authorName?: string; screen?: string; text: string };

type NormalPost = {
  id: string;
  text: string;
  authorName?: string;
  screen?: string;
  createdAt?: string;
  title?: string;
  blocks: Block[];
  photos: string[];
  quote?: Quote;
  dek?: string;
};

/** The numeric status id, or null for profiles and every other URL. */
export function xStatusId(raw: string): string | null {
  let url: URL;
  try {
    const trimmed = raw.trim();
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  if (!HOSTS.has(host)) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  const at = parts.findIndex((part) => part === "status" || part === "statuses");
  if (at < 0) return null;
  const id = parts[at + 1] ?? "";
  return /^\d{6,22}$/.test(id) ? id : null;
}

function providers(env: Env): ProviderName[] {
  const raw = env.X_FETCH?.trim() || "fx,api";
  const list = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part): part is ProviderName => part === "fx" || part === "api");
  return list.length ? [...new Set(list)] : ["fx", "api"];
}

function publishedOf(raw: string | undefined): string | undefined {
  if (!raw?.trim()) return undefined;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? raw.trim() : new Date(ms).toISOString();
}

function longest(parts: (string | undefined)[]): string {
  return parts.filter((part): part is string => Boolean(part?.trim())).sort((a, b) => b.length - a.length)[0]?.trim() ?? "";
}

function paragraphs(text: string): Block[] {
  const blocks: Block[] = [];
  for (const line of undash(text).split(/\n+/)) {
    const piece = line.trim();
    if (piece) blocks.push({ id: `b${blocks.length + 1}`, type: "p", runs: [{ text: piece }] });
  }
  return blocks;
}

type DraftRange = { offset?: number; length?: number; key?: number | string };
type DraftBlock = { text?: string; type?: string; entityRanges?: DraftRange[] };
type DraftEntity = { type?: string; data?: { url?: string; href?: string } };

function blockType(type: string): Block["type"] {
  switch (type) {
    case "header-one":
    case "header-two":
      return "h2";
    case "header-three":
    case "header-four":
    case "header-five":
    case "header-six":
      return "h3";
    case "blockquote":
      return "quote";
    case "unordered-list-item":
    case "ordered-list-item":
      return "li";
    case "code-block":
      return "pre";
    default:
      return "p";
  }
}

function runsOf(text: string, ranges: DraftRange[] | undefined, entities: Record<string, DraftEntity>): Run[] {
  const sorted = [...(ranges ?? [])].filter((range) => typeof range.offset === "number" && typeof range.length === "number").sort((a, b) => (a.offset ?? 0) - (b.offset ?? 0));
  if (!sorted.length) return text.trim() ? [{ text: text.trim() }] : [];
  const runs: Run[] = [];
  let cursor = 0;
  for (const range of sorted) {
    const start = Math.max(0, range.offset ?? 0);
    const end = Math.min(text.length, start + (range.length ?? 0));
    if (start > cursor && text.slice(cursor, start)) runs.push({ text: text.slice(cursor, start) });
    const slice = text.slice(start, end);
    const entity = entities[String(range.key)];
    const href = entity?.type === "LINK" ? entity.data?.url || entity.data?.href : undefined;
    if (slice) runs.push(href ? { text: slice, href } : { text: slice });
    cursor = Math.max(cursor, end);
  }
  if (cursor < text.length && text.slice(cursor)) runs.push({ text: text.slice(cursor) });
  return runs.filter((run) => run.text);
}

/** Draft.js article body, as fxtwitter returns it. */
export function draftBlocks(content: { blocks?: DraftBlock[]; entityMap?: Record<string, DraftEntity> } | undefined): Block[] {
  if (!content?.blocks?.length) return [];
  const entities = content.entityMap ?? {};
  const blocks: Block[] = [];
  for (const block of content.blocks) {
    const type = block.type ?? "unstyled";
    if (type === "atomic") {
      const key = block.entityRanges?.[0]?.key;
      const entity = key != null ? entities[String(key)] : undefined;
      const url = entity?.data?.url || entity?.data?.href;
      if (entity?.type === "MEDIA" && url) blocks.push({ id: `b${blocks.length + 1}`, type: "figure", runs: [], src: url });
      continue;
    }
    const text = (block.text ?? "").replace(/\u00a0/g, " ");
    const runs = runsOf(text, block.entityRanges, entities);
    if (!runs.length) continue;
    blocks.push({ id: `b${blocks.length + 1}`, type: blockType(type), runs });
  }
  return blocks.map((block, index) => ({ ...block, id: `b${index + 1}` }));
}

function renumber(blocks: Block[]): Block[] {
  return blocks.map((block, index) => ({ ...block, id: `b${index + 1}` }));
}

function toArticle(post: NormalPost): Article | null {
  const title = tidyTitle((post.title || post.text.split("\n")[0] || "Post on X").trim().slice(0, 180));
  let blocks = post.blocks.length ? post.blocks : paragraphs(post.text);
  if (blocks.length > 1 && (blocks[0].type === "h2" || blocks[0].type === "p") && blockText(blocks[0]).trim() === title) blocks = blocks.slice(1);
  const have = new Set(blocks.filter((block) => block.src).map((block) => block.src));
  for (const src of post.photos) {
    if (!have.has(src)) blocks.push({ id: "", type: "figure", runs: [], src });
  }
  if (post.quote?.text.trim()) {
    const who = post.quote.screen ? `@${post.quote.screen}` : post.quote.authorName;
    const text = undash(who ? `${who}: ${post.quote.text.trim()}` : post.quote.text.trim());
    blocks.push({ id: "", type: "quote", runs: [{ text }] });
  }
  blocks = renumber(blocks);
  if (!blocks.length) return null;
  const screen = post.screen && /^[A-Za-z0-9_]{1,15}$/.test(post.screen) ? post.screen : undefined;
  const author = [post.authorName, screen ? `(@${screen})` : ""].filter(Boolean).join(" ").slice(0, 120) || undefined;
  const opening = blockText(blocks.find((block) => block.type === "p") ?? blocks[0]).trim();
  const dek = post.dek && post.dek.trim() && !opening.startsWith(post.dek.trim().slice(0, 40)) ? post.dek.trim().slice(0, 280) : undefined;
  return {
    id: `x-${post.id}`,
    title: title || "Post on X",
    author,
    published: publishedOf(post.createdAt),
    dek,
    source: "X",
    sourceUrl: screen ? `https://x.com/${screen}/status/${post.id}` : `https://x.com/i/status/${post.id}`,
    blocks,
    origin: "url",
    addedAt: Date.now(),
  };
}

type FxTweet = {
  id?: string;
  text?: string;
  raw_text?: { text?: string };
  note_tweet?: { text?: string };
  created_at?: string;
  author?: { name?: string; screen_name?: string };
  media?: { photos?: { url?: string }[]; videos?: { thumbnail_url?: string }[] };
  quote?: FxTweet;
  article?: { title?: string; preview_text?: string; content?: { blocks?: DraftBlock[]; entityMap?: Record<string, DraftEntity> } };
};

function fromFxTweet(tweet: FxTweet, fallbackId: string): Attempt {
  const id = String(tweet.id ?? fallbackId);
  const articleBlocks = draftBlocks(tweet.article?.content);
  const text = longest([tweet.note_tweet?.text, tweet.raw_text?.text, tweet.text]);
  const photos = [...(tweet.media?.photos ?? []).map((photo) => photo.url), ...(tweet.media?.videos ?? []).map((video) => video.thumbnail_url)].filter((url): url is string => Boolean(url));
  const quote = tweet.quote?.text?.trim()
    ? { authorName: tweet.quote.author?.name, screen: tweet.quote.author?.screen_name, text: longest([tweet.quote.note_tweet?.text, tweet.quote.text]) }
    : undefined;
  const article = toArticle({
    id,
    text,
    authorName: tweet.author?.name,
    screen: tweet.author?.screen_name,
    createdAt: tweet.created_at,
    title: tweet.article?.title,
    blocks: articleBlocks,
    photos,
    quote,
    dek: tweet.article?.preview_text,
  });
  if (!article) return { ok: false, error: "That post has no text to read.", status: 422, terminal: true };
  return { ok: true, article };
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function terminalKind(status: number, message: string, source: "fx" | "api"): { error: string; status: number } | null {
  const text = message.toLowerCase();
  if (status === 404 || text.includes("not_found") || text.includes("not found")) return { error: "That post was deleted or is not available.", status: 404 };
  if (text.includes("private_tweet") || text.includes("protected") || (source === "fx" && (status === 401 || status === 403))) return { error: "That post is protected.", status: 403 };
  if (source === "api" && (status === 401 || status === 403)) return { error: "The X API rejected the bearer token.", status: 401 };
  return null;
}

async function fromFx(id: string, fetchImpl: FetchLike, signal?: AbortSignal): Promise<Attempt> {
  let res: Response;
  try {
    res = await fetchImpl(`${FX}/status/${id}`, { signal, headers: { Accept: "application/json", "User-Agent": APP_UA } });
  } catch {
    return { ok: false, error: "Could not reach fxtwitter.", status: 502, terminal: false };
  }
  const body = (await readJson(res)) as { code?: number; message?: string; tweet?: FxTweet } | null;
  const code = body?.code ?? res.status;
  const stopped = terminalKind(code, body?.message ?? "", "fx");
  if (stopped) return { ok: false, ...stopped, terminal: true };
  if (!res.ok || !body?.tweet) {
    const terminal = res.status >= 400 && res.status < 500 && res.status !== 429;
    return { ok: false, error: `fxtwitter answered ${res.status}.`, status: 502, terminal };
  }
  return fromFxTweet(body.tweet, id);
}

type ApiTweet = {
  id?: string;
  text?: string;
  created_at?: string;
  author_id?: string;
  note_tweet?: { text?: string; note_tweet?: { text?: string } };
  article?: { title?: string; preview_text?: string; plain_text?: string; content?: { blocks?: DraftBlock[]; entityMap?: Record<string, DraftEntity> } };
  attachments?: { media_keys?: string[] };
  referenced_tweets?: { type?: string; id?: string }[];
};

function fromApiBody(body: { data?: ApiTweet; includes?: { users?: { id?: string; name?: string; username?: string }[]; tweets?: ApiTweet[]; media?: { media_key?: string; type?: string; url?: string; preview_image_url?: string }[] } }, fallbackId: string): Attempt {
  const data = body.data;
  if (!data) return { ok: false, error: "The X API returned no post.", status: 502, terminal: false };
  const author = body.includes?.users?.find((user) => user.id === data.author_id);
  const quoteRef = data.referenced_tweets?.find((ref) => ref.type === "quoted");
  const quoted = quoteRef ? body.includes?.tweets?.find((tweet) => tweet.id === quoteRef.id) : undefined;
  const quotedAuthor = quoted?.author_id ? body.includes?.users?.find((user) => user.id === quoted.author_id) : undefined;
  const keys = new Set(data.attachments?.media_keys ?? []);
  const photos = (body.includes?.media ?? [])
    .filter((media) => media.media_key && keys.has(media.media_key))
    .map((media) => (media.type === "photo" ? media.url : media.preview_image_url))
    .filter((url): url is string => Boolean(url));
  const article = toArticle({
    id: String(data.id ?? fallbackId),
    text: longest([data.note_tweet?.text, data.note_tweet?.note_tweet?.text, data.article?.plain_text, data.text]),
    authorName: author?.name,
    screen: author?.username,
    createdAt: data.created_at,
    title: data.article?.title,
    blocks: draftBlocks(data.article?.content),
    photos,
    quote: quoted?.text ? { authorName: quotedAuthor?.name, screen: quotedAuthor?.username, text: longest([quoted.note_tweet?.text, quoted.text]) } : undefined,
    dek: data.article?.preview_text,
  });
  if (!article) return { ok: false, error: "That post has no text to read.", status: 422, terminal: true };
  return { ok: true, article };
}

async function fromApi(id: string, token: string, fetchImpl: FetchLike, signal?: AbortSignal): Promise<Attempt> {
  if (!token) return { ok: false, error: "X_BEARER_TOKEN is not set.", status: 401, terminal: false };
  const query = new URLSearchParams({
    "tweet.fields": "created_at,note_tweet,article,attachments,referenced_tweets,author_id",
    expansions: "author_id,attachments.media_keys,referenced_tweets.id",
    "user.fields": "name,username",
    "media.fields": "url,preview_image_url,type",
  });
  let res: Response;
  try {
    res = await fetchImpl(`${X_API}/${id}?${query}`, { signal, headers: { Accept: "application/json", Authorization: `Bearer ${token}`, "User-Agent": APP_UA } });
  } catch {
    return { ok: false, error: "Could not reach the X API.", status: 502, terminal: false };
  }
  const body = (await readJson(res)) as { data?: ApiTweet; errors?: { title?: string; detail?: string; status?: number }[]; includes?: { users?: { id?: string; name?: string; username?: string }[]; tweets?: ApiTweet[]; media?: { media_key?: string; type?: string; url?: string; preview_image_url?: string }[] } } | null;
  if (body?.errors?.length && !body.data) {
    const error = body.errors[0];
    const stopped = terminalKind(error?.status ?? res.status, `${error?.title ?? ""} ${error?.detail ?? ""}`, "api");
    if (stopped) return { ok: false, ...stopped, terminal: true };
  }
  const stopped = terminalKind(res.status, "", "api");
  if (stopped && !body?.data) return { ok: false, ...stopped, terminal: true };
  if (!res.ok || !body) return { ok: false, error: `The X API answered ${res.status}.`, status: 502, terminal: res.status < 500 && res.status !== 429 };
  return fromApiBody(body, id);
}

async function attempt(name: ProviderName, id: string, env: Env, fetchImpl: FetchLike, signal?: AbortSignal): Promise<Attempt> {
  switch (name) {
    case "fx":
      return fromFx(id, fetchImpl, signal);
    case "api":
      return fromApi(id, env.X_BEARER_TOKEN?.trim() ?? "", fetchImpl, signal);
    default: {
      const neverName: never = name;
      return neverName;
    }
  }
}

export async function fetchXPost(raw: string, deps: { fetch?: FetchLike; env?: Env; signal?: AbortSignal } = {}): Promise<XFetchResult> {
  const id = xStatusId(raw);
  if (!id) return { ok: false, error: "That is not a link to a single post.", status: 422 };
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetch ?? fetch;
  let last: { error: string; status: number } = { error: "Could not fetch that post.", status: 502 };
  for (const name of providers(env)) {
    const result = await attempt(name, id, env, fetchImpl, deps.signal);
    if (result.ok) return result;
    if (result.terminal) return { ok: false, error: result.error, status: result.status };
    last = result;
  }
  return { ok: false, error: last.error, status: last.status };
}
