/**
 * The ChatGPT credential row. Tokens are encrypted before they touch Postgres.
 * A refresh takes a transaction advisory lock, re-reads, and writes the rotated
 * refresh token before releasing the lock, so two requests cannot both spend it.
 */

import type { TxQuery } from "./db";
import { db, withTransaction } from "./db";
import {
  ChatgptAuthError,
  ISSUER,
  UnusableRefresh,
  createMutex,
  newHostId,
  publicAuthError,
  refreshWithLock,
  requestRefresh,
  toPublicStatus,
  type PublicChatgptStatus,
  type StoredSession,
} from "./openai-oauth";
import { decryptSecret, encryptSecret, encryptionKeyFromEnv } from "./token-crypto";

export { publicAuthError, toPublicStatus };
export type { PublicChatgptStatus, StoredSession };

export const REFRESH_LOCK_SQL = "select pg_advisory_xact_lock(hashtextextended($1, 0::bigint))";
export const REFRESH_ROW_SQL = `select user_id, client_id, host_id, issuer, subject, email,
  access_token_enc, refresh_token_enc, id_token_enc, scopes, expires_at, earliest_refresh_at, refreshed_at
  from openai_auth where user_id = $1 for update`;

const UPSERT_SQL = `insert into openai_auth (
  user_id, client_id, host_id, issuer, subject, email,
  access_token_enc, refresh_token_enc, id_token_enc, scopes,
  expires_at, earliest_refresh_at, refreshed_at, updated_at
) values (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text[], $11, $12, $13, now()
) on conflict (user_id) do update set
  client_id = excluded.client_id,
  host_id = excluded.host_id,
  issuer = excluded.issuer,
  subject = excluded.subject,
  email = excluded.email,
  access_token_enc = excluded.access_token_enc,
  refresh_token_enc = excluded.refresh_token_enc,
  id_token_enc = excluded.id_token_enc,
  scopes = excluded.scopes,
  expires_at = excluded.expires_at,
  earliest_refresh_at = excluded.earliest_refresh_at,
  refreshed_at = excluded.refreshed_at,
  updated_at = now()`;

const UPDATE_TOKENS_SQL = `update openai_auth set
  access_token_enc = $2,
  refresh_token_enc = $3,
  id_token_enc = $4,
  scopes = $5::text[],
  expires_at = $6,
  earliest_refresh_at = $7,
  refreshed_at = $8,
  updated_at = now()
where user_id = $1`;

const CLEAR_SQL = `update openai_auth set
  access_token_enc = null,
  refresh_token_enc = null,
  id_token_enc = null,
  updated_at = now()
where user_id = $1`;

type Key = Buffer;

function scopesOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((s): s is string => typeof s === "string");
  return [];
}

function ms(value: unknown): number | null {
  if (value == null) return null;
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

function sessionFromRow(row: Record<string, unknown>, key: Key): StoredSession | null {
  const refreshEnc = row.refresh_token_enc == null ? "" : String(row.refresh_token_enc);
  const accessEnc = row.access_token_enc == null ? "" : String(row.access_token_enc);
  if (!refreshEnc || !accessEnc) return null;
  const expiresAt = ms(row.expires_at);
  if (expiresAt == null) return null;
  return {
    clientId: String(row.client_id ?? ""),
    hostId: String(row.host_id ?? ""),
    issuer: String(row.issuer ?? ISSUER),
    subject: String(row.subject ?? ""),
    email: row.email == null ? null : String(row.email),
    accessToken: decryptSecret(accessEnc, key),
    refreshToken: decryptSecret(refreshEnc, key),
    idToken: row.id_token_enc == null ? null : decryptSecret(String(row.id_token_enc), key),
    scopes: scopesOf(row.scopes),
    expiresAt,
    earliestRefreshAt: ms(row.earliest_refresh_at),
    refreshedAt: ms(row.refreshed_at),
  };
}

function stamp(msValue: number | null): string | null {
  return msValue == null ? null : new Date(msValue).toISOString();
}

async function readSession(query: TxQuery, userId: string, key: Key): Promise<StoredSession | null> {
  const rows = await query(REFRESH_ROW_SQL, [userId]);
  return rows.length ? sessionFromRow(rows[0], key) : null;
}

async function writeTokens(query: TxQuery, userId: string, session: StoredSession, key: Key): Promise<void> {
  await query(UPDATE_TOKENS_SQL, [
    userId,
    encryptSecret(session.accessToken, key),
    encryptSecret(session.refreshToken, key),
    session.idToken ? encryptSecret(session.idToken, key) : null,
    session.scopes,
    new Date(session.expiresAt).toISOString(),
    stamp(session.earliestRefreshAt),
    stamp(session.refreshedAt),
  ]);
}

async function clearTokens(query: TxQuery, userId: string): Promise<void> {
  await query(CLEAR_SQL, [userId]);
}

export async function refreshLocked(
  query: TxQuery,
  userId: string,
  opts: { key: Key; now: () => number; exchange: (session: StoredSession) => Promise<StoredSession> }
): Promise<string> {
  await query(REFRESH_LOCK_SQL, [`openai_auth:${userId}`]);
  return refreshWithLock({
    lock: (fn) => fn(),
    load: () => readSession(query, userId, opts.key),
    save: (session) => writeTokens(query, userId, session, opts.key),
    clear: () => clearTokens(query, userId),
    exchange: opts.exchange,
    now: opts.now,
  });
}

const memoryLock = createMutex();
let override: { session: StoredSession | null } | null = null;

/** Tests park a session here so a request can run without Postgres. */
export function setSessionOverrideForTests(session: StoredSession | null): void {
  override = { session };
}

export function clearSessionOverrideForTests(): void {
  override = null;
}

const inflight = new Map<string, Promise<string>>();

function joinInflight(userId: string, fn: () => Promise<string>): Promise<string> {
  const existing = inflight.get(userId);
  if (existing) return existing;
  const pending = fn().finally(() => inflight.delete(userId));
  inflight.set(userId, pending);
  return pending;
}

export async function getAccessToken(userId: string, now = Date.now()): Promise<string> {
  if (override) {
    return joinInflight(userId, () =>
      refreshWithLock({
        lock: memoryLock,
        load: async () => override?.session ?? null,
        save: async (session) => {
          if (override) override.session = session;
        },
        clear: async () => {
          if (override?.session) override.session = { ...override.session, accessToken: "", refreshToken: "" };
        },
        exchange: (session) => requestRefresh(session, fetch, now),
        now: () => now,
      })
    );
  }
  const key = encryptionKeyFromEnv();
  return joinInflight(userId, async () => {
    let failed: UnusableRefresh | null = null;
    let token = "";
    try {
      token = await withTransaction(async (query) => {
        try {
          return await refreshLocked(query, userId, {
            key,
            now: () => Date.now(),
            exchange: (session) => requestRefresh(session, fetch, Date.now()),
          });
        } catch (error) {
          if (error instanceof UnusableRefresh) {
            failed = error;
            return "";
          }
          throw error;
        }
      });
    } catch (error) {
      throw new ChatgptAuthError(publicAuthError(error));
    }
    if (failed) throw failed;
    return token;
  });
}

export async function saveSession(userId: string, session: StoredSession): Promise<void> {
  const key = encryptionKeyFromEnv();
  await db().query(UPSERT_SQL, [
    userId,
    session.clientId,
    session.hostId,
    session.issuer || ISSUER,
    session.subject,
    session.email,
    encryptSecret(session.accessToken, key),
    encryptSecret(session.refreshToken, key),
    session.idToken ? encryptSecret(session.idToken, key) : null,
    session.scopes,
    new Date(session.expiresAt).toISOString(),
    stamp(session.earliestRefreshAt),
    stamp(session.refreshedAt ?? Date.now()),
  ]);
}

export type Registration = {
  clientId: string;
  hostId: string;
  email: string | null;
  idToken: string | null;
  subject: string;
};

/** Client id and host id, even after the tokens were cleared, so the next sign-in can reuse them. */
export async function loadRegistration(userId: string): Promise<Registration | null> {
  const rows = await db().query("select client_id, host_id, email, subject, id_token_enc from openai_auth where user_id = $1", [userId]);
  if (!rows.length) return null;
  const row = rows[0];
  let idToken: string | null = null;
  if (row.id_token_enc != null) idToken = decryptSecret(String(row.id_token_enc), encryptionKeyFromEnv());
  return {
    clientId: String(row.client_id ?? ""),
    hostId: String(row.host_id ?? ""),
    email: row.email == null ? null : String(row.email),
    subject: String(row.subject ?? ""),
    idToken,
  };
}

export async function loadHostId(userId: string): Promise<string | null> {
  const rows = await db().query("select host_id from openai_auth where user_id = $1", [userId]);
  const hostId = rows[0]?.host_id;
  return typeof hostId === "string" && hostId ? hostId : null;
}

export async function chatgptStatus(userId: string): Promise<PublicChatgptStatus> {
  if (override) return toPublicStatus(override.session);
  if (!process.env.DATABASE_URL) return toPublicStatus(null);
  try {
    const rows = await db().query(
      `select email, expires_at, scopes, refresh_token_enc is not null as linked
       from openai_auth where user_id = $1`,
      [userId]
    );
    if (!rows.length || !rows[0].linked) return toPublicStatus(null);
    const expiresAt = ms(rows[0].expires_at);
    return {
      linked: true,
      email: rows[0].email == null ? null : String(rows[0].email),
      expiresAt: expiresAt == null ? null : new Date(expiresAt).toISOString(),
      planUsage: scopesOf(rows[0].scopes).includes("chatgpt.tokens.use.direct"),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("does not exist")) return toPublicStatus(null);
    throw error;
  }
}

export async function chatgptLinked(userId: string): Promise<boolean> {
  return (await chatgptStatus(userId)).linked;
}

/** Drop the tokens. The client id and host id stay, for a later sign-in. */
export async function clearStoredTokens(userId: string): Promise<void> {
  await db().query(CLEAR_SQL, [userId]);
}

export async function loadSession(userId: string): Promise<StoredSession | null> {
  const key = encryptionKeyFromEnv();
  const rows = await db().query(
    `select user_id, client_id, host_id, issuer, subject, email,
      access_token_enc, refresh_token_enc, id_token_enc, scopes, expires_at, earliest_refresh_at, refreshed_at
     from openai_auth where user_id = $1`,
    [userId]
  );
  return rows.length ? sessionFromRow(rows[0], key) : null;
}

export function freshHostId(): string {
  return newHostId();
}
