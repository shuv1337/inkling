/**
 * Sign in with ChatGPT, the open-source direct flow.
 * https://developers.openai.com/siwc/token-sharing-open-source
 *
 * Authorization code + PKCE, dynamic client registration, no client secret
 * and no API key. The redirect is a loopback on 127.0.0.1. Refresh tokens
 * rotate: every successful refresh returns a replacement that has to be stored
 * before the previous one is used again.
 */

import { createHash, createPublicKey, createVerify, randomBytes, randomUUID } from "node:crypto";

export const ISSUER = "https://auth.openai.com";
export const AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize";
export const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
export const RESOURCE = "https://api.openai.com/v1";
export const DYNAMIC_CLIENT = "dynamic_agent_client";
export const AGENT_NAME = "Inkling";
export const PLAN_SCOPE = "chatgpt.tokens.use.direct";
export const REQUESTED_SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

/** Refresh once the access token has this little life left, and not before earliest_refresh_at while it is still valid. */
export const REFRESH_WINDOW_MS = 5 * 60 * 1000;

const UNUSABLE_REFRESH = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

export class ChatgptAuthError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message);
    this.name = "ChatgptAuthError";
  }
}

/** The refresh token cannot be used again. The caller clears the stored tokens and asks for a new sign-in. */
export class UnusableRefresh extends ChatgptAuthError {
  constructor(code: string) {
    super("ChatGPT sign-in expired. Run npm run chatgpt:login again.", code);
    this.name = "UnusableRefresh";
  }
}

export type StoredSession = {
  clientId: string;
  hostId: string;
  issuer: string;
  subject: string;
  email: string | null;
  accessToken: string;
  refreshToken: string;
  idToken: string | null;
  scopes: string[];
  /** Unix milliseconds. */
  expiresAt: number;
  earliestRefreshAt: number | null;
  refreshedAt: number | null;
};

export type PublicChatgptStatus = {
  linked: boolean;
  email: string | null;
  expiresAt: string | null;
  planUsage: boolean;
};

export function newHostId(): string {
  return `urn:uuid:${randomUUID()}`;
}

export function isHostId(value: string): boolean {
  return value.startsWith("urn:uuid:") || value.startsWith("urn:ietf:params:oauth:jwk-thumbprint:") || value.startsWith("did:key:");
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function randomSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** The only redirect this flow accepts. The port may change; the scheme, host, and path may not. */
export function loopbackRedirect(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ChatgptAuthError("The login port must be an integer from 1 to 65535.");
  }
  return `http://127.0.0.1:${port}/auth/callback`;
}

export function authorizeUrl(opts: {
  redirectUri: string;
  state: string;
  nonce: string;
  challenge: string;
  hostId: string;
  /** Issued client id from an earlier registration. Omit it to register. */
  clientId?: string | null;
  idTokenHint?: string | null;
  loginHint?: string | null;
}): string {
  if (!opts.redirectUri.startsWith("http://127.0.0.1:")) {
    throw new ChatgptAuthError("The ChatGPT redirect must be http://127.0.0.1, not localhost.");
  }
  const registering = !opts.clientId;
  const params = new URLSearchParams();
  params.set("client_id", opts.clientId || DYNAMIC_CLIENT);
  if (registering) params.set("agent_name_hint", AGENT_NAME);
  params.set("ext_agent_host_id", opts.hostId);
  params.set("response_type", "code");
  params.set("redirect_uri", opts.redirectUri);
  params.set("scope", REQUESTED_SCOPE);
  params.set("resource", RESOURCE);
  params.set("state", opts.state);
  params.set("nonce", opts.nonce);
  params.set("code_challenge_method", "S256");
  params.set("code_challenge", opts.challenge);
  if (!registering && opts.idTokenHint) params.set("id_token_hint", opts.idTokenHint);
  if (!registering && opts.loginHint) params.set("login_hint", opts.loginHint);
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export function codeExchangeForm(opts: { clientId: string; code: string; verifier: string; redirectUri: string }): URLSearchParams {
  if (opts.clientId === DYNAMIC_CLIENT) {
    throw new ChatgptAuthError("The registration did not return a client id. Start the sign-in again.");
  }
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("client_id", opts.clientId);
  body.set("code", opts.code);
  body.set("code_verifier", opts.verifier);
  body.set("redirect_uri", opts.redirectUri);
  body.set("resource", RESOURCE);
  return body;
}

export function refreshForm(session: Pick<StoredSession, "clientId" | "refreshToken">): URLSearchParams {
  if (!session.clientId || session.clientId === DYNAMIC_CLIENT) {
    throw new ChatgptAuthError("The saved ChatGPT client id is missing. Run npm run chatgpt:login again.");
  }
  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("client_id", session.clientId);
  body.set("refresh_token", session.refreshToken);
  body.set("resource", RESOURCE);
  return body;
}

export function revokeForm(session: Pick<StoredSession, "clientId" | "refreshToken">): URLSearchParams {
  const body = new URLSearchParams();
  body.set("token", session.refreshToken);
  body.set("token_type_hint", "refresh_token");
  body.set("client_id", session.clientId);
  return body;
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  scope?: string;
  earliest_refresh_at?: number | string;
  token_type?: string;
};

export function parseScopes(scope: string | undefined, previous: string[]): string[] {
  if (!scope?.trim()) return previous;
  return scope.split(/[\s+]+/).map((s) => s.trim()).filter(Boolean);
}

/** Unix milliseconds. Numbers below 1e12 are seconds. Numeric strings follow the same rule. */
export function epochMs(value: number | string | null | undefined): number | null {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) return epochMs(Number(trimmed));
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

export function applyTokenResponse(session: StoredSession, body: TokenResponse, now: number): StoredSession {
  if (!body.access_token || !body.refresh_token) {
    throw new ChatgptAuthError("ChatGPT did not return an access token and a refresh token.");
  }
  const expiresIn = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
  // A refresh that omits scope keeps the grant. Never drop a rotated refresh token
  // because the scope list was absent: the previous refresh token is already dead.
  const scopes = parseScopes(body.scope, session.scopes);
  return {
    ...session,
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    idToken: body.id_token || session.idToken,
    scopes,
    expiresAt: now + expiresIn * 1000,
    earliestRefreshAt: epochMs(body.earliest_refresh_at),
    refreshedAt: now,
  };
}

export function needsRefresh(session: StoredSession, now: number, windowMs = REFRESH_WINDOW_MS): boolean {
  const remaining = session.expiresAt - now;
  if (remaining > windowMs) return false;
  if (session.earliestRefreshAt != null && now < session.earliestRefreshAt && remaining > 0) return false;
  return true;
}

export function planGranted(scopes: readonly string[]): boolean {
  return scopes.includes(PLAN_SCOPE);
}

export function toPublicStatus(session: Pick<StoredSession, "email" | "expiresAt" | "scopes" | "refreshToken"> | null): PublicChatgptStatus {
  if (!session?.refreshToken) return { linked: false, email: null, expiresAt: null, planUsage: false };
  return {
    linked: true,
    email: session.email,
    expiresAt: new Date(session.expiresAt).toISOString(),
    planUsage: planGranted(session.scopes),
  };
}

type ErrorBody = { code?: string; message?: string; param?: string };

function errorBody(raw: string): ErrorBody {
  try {
    const parsed = JSON.parse(raw) as { error?: string | { code?: string; message?: string; param?: string }; error_description?: string; code?: string };
    if (typeof parsed.error === "string") return { code: parsed.error, message: parsed.error_description };
    if (parsed.error && typeof parsed.error === "object") return { code: parsed.error.code, message: parsed.error.message, param: parsed.error.param };
    if (parsed.code) return { code: parsed.code };
  } catch {
    /* not JSON */
  }
  return {};
}

export function isUnusableRefresh(code: string | undefined): boolean {
  return Boolean(code && UNUSABLE_REFRESH.has(code));
}

/** A message safe to show. The raw body is not included: it can echo a token. */
export function tokenEndpointError(status: number, raw: string): ChatgptAuthError {
  const { code } = errorBody(raw);
  if (isUnusableRefresh(code)) return new UnusableRefresh(code ?? "invalid_grant");
  if (code === "invalid_client") return new ChatgptAuthError("ChatGPT did not accept the saved client. Run npm run chatgpt:login again.", code);
  if (status === 401 || status === 400) return new ChatgptAuthError("ChatGPT rejected the sign-in refresh. Run npm run chatgpt:login again.", code);
  return new ChatgptAuthError("Could not refresh the ChatGPT sign-in. Try again in a moment.", code);
}

export async function requestRefresh(session: StoredSession, fetchImpl: typeof fetch, now: number): Promise<StoredSession> {
  let res: Response;
  try {
    res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: refreshForm(session),
    });
  } catch {
    throw new ChatgptAuthError("Could not reach ChatGPT to refresh sign-in. Try again in a moment.");
  }
  const raw = await res.text();
  if (!res.ok) throw tokenEndpointError(res.status, raw);
  let body: TokenResponse;
  try {
    body = JSON.parse(raw) as TokenResponse;
  } catch {
    throw new ChatgptAuthError("ChatGPT returned a sign-in response that was not JSON.");
  }
  return applyTokenResponse(session, body, now);
}

export type RefreshDeps = {
  load: () => Promise<StoredSession | null>;
  save: (session: StoredSession) => Promise<void>;
  clear: () => Promise<void>;
  lock: <T>(fn: () => Promise<T>) => Promise<T>;
  exchange: (session: StoredSession) => Promise<StoredSession>;
  now: () => number;
};

/**
 * One refresh at a time for a session. The second caller waits, re-reads, and
 * uses the rotated token instead of spending the refresh token twice.
 */
export async function refreshWithLock(deps: RefreshDeps): Promise<string> {
  return deps.lock(async () => {
    const session = await deps.load();
    if (!session?.refreshToken) throw new ChatgptAuthError("ChatGPT is not linked. Run npm run chatgpt:login.");
    if (!needsRefresh(session, deps.now())) return session.accessToken;
    try {
      const next = await deps.exchange(session);
      await deps.save(next);
      return next.accessToken;
    } catch (e) {
      if (e instanceof UnusableRefresh) await deps.clear();
      throw e;
    }
  });
}

/** Queues async work so two refreshes cannot overlap. */
export function createMutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve();
  return function lock<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };
}

export function credentialRecord(session: StoredSession, savedAt: string): Record<string, unknown> {
  return {
    email: session.email,
    issuer: session.issuer,
    subject: session.subject,
    client_id: session.clientId,
    ext_agent_host_id: session.hostId,
    id_token: session.idToken,
    access_token: session.accessToken,
    refresh_token: session.refreshToken,
    token_type: "Bearer",
    expires_in: Math.max(0, Math.round((session.expiresAt - Date.parse(savedAt)) / 1000)),
    earliest_refresh_at: session.earliestRefreshAt == null ? null : new Date(session.earliestRefreshAt).toISOString(),
    scopes: session.scopes,
    saved_at: savedAt,
  };
}

export function sessionFromCredential(record: Record<string, unknown>, hostId: string, now: number): StoredSession {
  const clientId = typeof record.client_id === "string" ? record.client_id : "";
  const accessToken = typeof record.access_token === "string" ? record.access_token : "";
  const refreshToken = typeof record.refresh_token === "string" ? record.refresh_token : "";
  const subject = typeof record.subject === "string" ? record.subject : "";
  if (!clientId || clientId === DYNAMIC_CLIENT) throw new ChatgptAuthError("The file has no issued client id. Sign in again.");
  if (!accessToken || !refreshToken) throw new ChatgptAuthError("The file is missing tokens. Sign in again.");
  if (!subject) throw new ChatgptAuthError("The file has no account id. Sign in again.");
  if (!isHostId(hostId)) throw new ChatgptAuthError("This machine has no host id yet.");
  const scopes = Array.isArray(record.scopes) ? record.scopes.filter((s): s is string => typeof s === "string") : parseScopes(typeof record.scope === "string" ? record.scope : undefined, []);
  if (!planGranted(scopes)) throw new ChatgptAuthError("The file does not include ChatGPT plan usage. Sign in again and allow it.");
  const savedAt = typeof record.saved_at === "string" ? Date.parse(record.saved_at) : now;
  const expiresIn = typeof record.expires_in === "number" && record.expires_in > 0 ? record.expires_in : 3600;
  const base = Number.isNaN(savedAt) ? now : savedAt;
  return {
    clientId,
    hostId,
    issuer: typeof record.issuer === "string" && record.issuer ? record.issuer : ISSUER,
    subject,
    email: typeof record.email === "string" ? record.email : null,
    accessToken,
    refreshToken,
    idToken: typeof record.id_token === "string" ? record.id_token : null,
    scopes,
    expiresAt: base + expiresIn * 1000,
    earliestRefreshAt: epochMs(record.earliest_refresh_at as number | string | null | undefined),
    refreshedAt: Number.isNaN(savedAt) ? null : savedAt,
  };
}

/** JWKS keys carry `kid`, which the DOM JsonWebKey type omits. */
export type SigningKey = JsonWebKey & { kid?: string };

type IdClaims = { iss?: string; aud?: string | string[]; exp?: number; nonce?: string; sub?: string; email?: string };

function decodePart(part: string): unknown {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

function verifySignature(alg: string, data: string, signature: Buffer, jwk: SigningKey): boolean {
  try {
    const key = createPublicKey({ key: jwk, format: "jwk" });
    if (alg === "RS256") {
      const verifier = createVerify("RSA-SHA256");
      verifier.update(data);
      return verifier.verify(key, signature);
    }
    if (alg === "ES256") {
      const verifier = createVerify("SHA256");
      verifier.update(data);
      return verifier.verify({ key, dsaEncoding: "ieee-p1363" }, signature);
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Signature against the published JWKS, then issuer, audience (the issued
 * client id), expiry, and the nonce from this attempt. Email is taken only
 * after that succeeds.
 */
export function validateIdToken(
  token: string,
  opts: { jwks: { keys?: SigningKey[] }; issuer: string; audience: string; nonce: string; now?: number }
): { sub: string; email: string | null } {
  const parts = token.split(".");
  if (parts.length !== 3) throw new ChatgptAuthError("The sign-in token was not a JWT.");
  let header: { alg?: string; kid?: string };
  let claims: IdClaims;
  try {
    header = decodePart(parts[0]) as { alg?: string; kid?: string };
    claims = decodePart(parts[1]) as IdClaims;
  } catch {
    throw new ChatgptAuthError("The sign-in token could not be read.");
  }
  if (header.alg !== "RS256" && header.alg !== "ES256") throw new ChatgptAuthError("The sign-in token uses an unexpected signature.");
  const keys = (opts.jwks.keys ?? []).filter((key) => !header.kid || key.kid === header.kid);
  const signature = Buffer.from(parts[2], "base64url");
  const data = `${parts[0]}.${parts[1]}`;
  const signed = keys.some((key) => verifySignature(header.alg ?? "", data, signature, key));
  if (!signed) throw new ChatgptAuthError("The sign-in token failed its signature check.");
  if (claims.iss !== opts.issuer) throw new ChatgptAuthError("The sign-in token came from an unexpected issuer.");
  const audiences = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
  if (!audiences.includes(opts.audience)) throw new ChatgptAuthError("The sign-in token was for a different app.");
  const now = opts.now ?? Date.now();
  if (typeof claims.exp !== "number" || claims.exp * 1000 + 60_000 < now) throw new ChatgptAuthError("The sign-in token expired. Start again.");
  if (claims.nonce !== opts.nonce) throw new ChatgptAuthError("The sign-in token did not match this attempt. Start again.");
  if (!claims.sub) throw new ChatgptAuthError("The sign-in token had no account id.");
  return { sub: claims.sub, email: typeof claims.email === "string" ? claims.email : null };
}

export async function fetchJwks(fetchImpl: typeof fetch = fetch): Promise<{ keys: SigningKey[]; issuer: string }> {
  let confRes: Response;
  try {
    confRes = await fetchImpl(`${ISSUER}/.well-known/openid-configuration`, { headers: { Accept: "application/json" } });
  } catch {
    throw new ChatgptAuthError("Could not load OpenAI's sign-in configuration.");
  }
  if (!confRes.ok) throw new ChatgptAuthError("Could not load OpenAI's sign-in configuration.");
  const conf = (await confRes.json()) as { issuer?: string; jwks_uri?: string; revocation_endpoint?: string };
  if (!conf.jwks_uri) throw new ChatgptAuthError("OpenAI's sign-in configuration has no signing keys.");
  const jwksRes = await fetchImpl(conf.jwks_uri, { headers: { Accept: "application/json" } });
  if (!jwksRes.ok) throw new ChatgptAuthError("Could not load OpenAI's signing keys.");
  const jwks = (await jwksRes.json()) as { keys?: SigningKey[] };
  return { keys: jwks.keys ?? [], issuer: conf.issuer || ISSUER };
}

export async function fetchRevocationEndpoint(fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(`${ISSUER}/.well-known/openid-configuration`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new ChatgptAuthError("Could not load OpenAI's sign-in configuration.");
  const conf = (await res.json()) as { revocation_endpoint?: string };
  if (!conf.revocation_endpoint) throw new ChatgptAuthError("OpenAI's sign-in configuration has no revocation endpoint.");
  return conf.revocation_endpoint;
}

/** What a failed network call may say out loud. Auth errors pass through. Anything else stays generic, so a token or a database URL cannot leak. */
export function publicAuthError(error: unknown): string {
  if (error instanceof ChatgptAuthError || error instanceof Error && error.name === "TokenCryptoError") return error.message;
  const message = error instanceof Error ? error.message : "";
  if (message.includes("AUTH_ENCRYPTION_KEY")) return message;
  if (message.includes("openai_auth") && message.includes("does not exist")) return "The openai_auth table is missing. Run npm run db:migrate.";
  return "Could not read the ChatGPT sign-in.";
}
