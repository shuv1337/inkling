/**
 * Postgres, through postgres-js. Server-side only. One pool per process.
 * Queries use the same `$1` placeholders the Neon driver did, so the SQL
 * stays as it is. A transaction runs those statements on one connection.
 */

import postgres, { type Sql } from "postgres";
import type { TokenScope } from "./agent";

export type { TokenScope };

export type Row = postgres.Row;

/** A query that runs when awaited, or inside `transaction`, but not both. */
export type PendingQuery = PromiseLike<Row[]> & { text: string; params: unknown[] };

let client: Sql | null = null;

function clientOf(): Sql {
  if (!client) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set.");
    client = postgres(url, { max: 10 });
  }
  return client;
}

function query(text: string, params: readonly unknown[] = []): PendingQuery {
  const values = [...params];
  let pending: Promise<Row[]> | null = null;
  const run = () => (pending ??= clientOf().unsafe(text, values as never[]));
  return {
    text,
    params: values,
    then(onFulfilled, onRejected) {
      return run().then(onFulfilled, onRejected);
    },
  };
}

export type TxQuery = (text: string, params?: readonly unknown[]) => Promise<Row[]>;

export function db() {
  return {
    query,
    transaction(queries: readonly PendingQuery[]): Promise<Row[][]> {
      return clientOf().begin(async (tx) => {
        const out: Row[][] = [];
        for (const q of queries) out.push(await tx.unsafe(q.text, q.params as never[]));
        return out;
      });
    },
  };
}

/**
 * One transaction, with room for work between statements. The ChatGPT refresh
 * holds its lock across the token request, which a list of queries cannot do.
 */
export async function withTransaction<T>(fn: (query: TxQuery) => Promise<T>): Promise<T> {
  const result = await clientOf().begin(async (tx) => {
    const query: TxQuery = (text, params = []) => tx.unsafe(text, [...params] as never[]);
    return fn(query);
  });
  return result as T;
}

/** Close the pool. Scripts call this so the process can exit. */
export async function closeDb(): Promise<void> {
  if (!client) return;
  const current = client;
  client = null;
  await current.end({ timeout: 5 });
}

/** The tables the sync route reads and writes. Names are only ever taken from this list. */
export const COLLECTIONS = ["articles", "highlights", "glosses", "briefs", "progress"] as const;
export type Collection = (typeof COLLECTIONS)[number];
export const isCollection = (v: unknown): v is Collection => typeof v === "string" && (COLLECTIONS as readonly string[]).includes(v);

export type PushRow = { id: string; article_id: string; data: unknown; deleted: boolean; doc?: unknown };
export type PullRow = { id: string; articleId: string; data: unknown; deleted: boolean };

/** Rows changed since `since` in every collection, tombstones included, plus the server clock to pull from next time. */
export async function pullRows(userId: string, since: string): Promise<{ now: string; changes: Record<Collection, PullRow[]> }> {
  const sql = db();
  const [clock, ...results] = await sql.transaction([
    sql.query("select now() as now"),
    ...COLLECTIONS.map((t) =>
      sql.query(`select id, article_id, data, deleted from ${t} where user_id = $1 and updated_at > $2 order by updated_at`, [userId, since])
    ),
  ]);
  const changes = Object.fromEntries(
    COLLECTIONS.map((t, i) => [
      t,
      (results[i] as Record<string, unknown>[]).map((r) => ({ id: String(r.id), articleId: String(r.article_id), data: r.deleted ? null : r.data, deleted: Boolean(r.deleted) })),
    ])
  ) as Record<Collection, PullRow[]>;
  return { now: new Date(clock[0].now as string | Date).toISOString(), changes };
}

/** Upsert every collection's rows in one transaction. The server stamps the time, so the latest write wins. */
export async function pushRows(userId: string, changes: Partial<Record<Collection, PushRow[]>>): Promise<void> {
  const sql = db();
  const queries = Object.entries(changes)
    .filter(([t, rows]) => isCollection(t) && rows?.length)
    .map(([t, rows]) => sql.query(upsert(t as Collection), [userId, rows]));
  // A text taken off the shelf takes its painted cover with it.
  const gone = (changes.articles ?? []).filter((r) => r.deleted).map((r) => r.id);
  if (gone.length) queries.push(sql.query("delete from covers where user_id = $1 and id = any($2::text[])", [userId, gone]));
  if (queries.length) await sql.transaction(queries);
}

/** One article's full text. */
export async function articleDoc(userId: string, id: string): Promise<unknown | null> {
  const rows = await db().query("select doc from articles where user_id = $1 and id = $2 and not deleted and doc is not null", [userId, id]);
  return rows.length ? rows[0].doc : null;
}

/** One statement per table: unpack the JSON array of rows and upsert them all. An article pushed without its text keeps the stored one. */
function upsert(table: Collection): string {
  const isArticles = table === "articles";
  return `insert into ${table} (user_id, id, article_id, data, deleted, updated_at${isArticles ? ", doc" : ""})
    select $1, r.id, r.article_id, r.data, r.deleted, now()${isArticles ? ", r.doc" : ""}
    from jsonb_to_recordset($2::jsonb) as r(id text, article_id text, data jsonb, deleted boolean${isArticles ? ", doc jsonb" : ""})
    on conflict (user_id, id) do update set
      article_id = excluded.article_id, data = excluded.data, deleted = excluded.deleted, updated_at = now()${
        isArticles ? ", doc = case when excluded.deleted then null else coalesce(excluded.doc, articles.doc) end" : ""
      }`;
}

/* ---------- painted covers ---------- */

export async function saveCover(userId: string, id: string, jpeg: Uint8Array): Promise<void> {
  await db().query(
    `insert into covers (user_id, id, jpeg) values ($1, $2, $3)
     on conflict (user_id, id) do update set jpeg = excluded.jpeg, created_at = now()`,
    [userId, id, Buffer.from(jpeg).toString("base64")]
  );
}

export async function loadCover(userId: string, id: string): Promise<Uint8Array | null> {
  const rows = await db().query("select jpeg from covers where user_id = $1 and id = $2", [userId, id]);
  return rows.length ? Uint8Array.from(Buffer.from(String(rows[0].jpeg), "base64")) : null;
}

/* ---------- agent tokens ---------- */

export type AgentToken = { id: string; label: string; scopes: TokenScope[]; createdAt: string; lastUsedAt: string | null };

function scopesOf(value: unknown): TokenScope[] {
  const list = Array.isArray(value) ? value : [];
  const scopes = list.filter((s): s is TokenScope => s === "read" || s === "write");
  return scopes.length ? scopes : ["read", "write"];
}

export async function createToken(userId: string, id: string, hash: string, label: string, scopes: TokenScope[] = ["read", "write"]): Promise<void> {
  await db().query("insert into agent_tokens (id, user_id, hash, label, scopes) values ($1, $2, $3, $4, $5::text[])", [id, userId, hash, label, scopes]);
}

export async function listTokens(userId: string): Promise<AgentToken[]> {
  const rows = await db().query("select id, label, scopes, created_at, last_used_at from agent_tokens where user_id = $1 and not revoked order by created_at desc", [userId]);
  return rows.map((r) => ({
    id: String(r.id),
    label: String(r.label),
    scopes: scopesOf(r.scopes),
    createdAt: new Date(r.created_at as string | Date).toISOString(),
    lastUsedAt: r.last_used_at ? new Date(r.last_used_at as string | Date).toISOString() : null,
  }));
}

export async function revokeToken(userId: string, id: string): Promise<boolean> {
  const rows = await db().query("update agent_tokens set revoked = true where user_id = $1 and id = $2 and not revoked returning id", [userId, id]);
  return rows.length > 0;
}

/** The reader a token belongs to, noting that it was used. Null for an unknown or revoked token. */
export async function tokenUser(hash: string): Promise<{ userId: string; label: string; scopes: TokenScope[] } | null> {
  const rows = await db().query("update agent_tokens set last_used_at = now() where hash = $1 and not revoked returning user_id, label, scopes", [hash]);
  return rows.length ? { userId: String(rows[0].user_id), label: String(rows[0].label ?? ""), scopes: scopesOf(rows[0].scopes) } : null;
}

/* ---------- the library, for an agent ---------- */

export type ShelfRow = { id: string; data: Record<string, unknown>; pct: number };

/** Every text on a reader's shelf, with how far they've read. */
export async function shelfOf(userId: string): Promise<ShelfRow[]> {
  const rows = await db().query(
    `select a.id, a.data, p.data as progress from articles a
     left join progress p on p.user_id = a.user_id and p.id = a.id and not p.deleted
     where a.user_id = $1 and not a.deleted order by a.updated_at desc`,
    [userId]
  );
  return rows.map((r) => ({ id: String(r.id), data: (r.data ?? {}) as Record<string, unknown>, pct: Number((r.progress as { pct?: number } | null)?.pct ?? 0) }));
}

/** Put one imported text on a reader's shelf, as their browser would: the next sync brings it down. */
export async function shelveForUser(userId: string, item: { id: string }, doc: unknown): Promise<void> {
  await db().query(
    `insert into articles (user_id, id, article_id, data, doc, deleted, updated_at) values ($1, $2, $2, $3, $4, false, now())
     on conflict (user_id, id) do update set data = excluded.data, doc = excluded.doc, deleted = false, updated_at = now()`,
    [userId, item.id, item, doc]
  );
}
