/**
 * Agent tokens: how a reader's agent (Grok Bot, Claude, ChatGPT) is let into
 * their library. A token is shown once; only its hash is stored. Server-side.
 */

import { createHash, randomBytes } from "node:crypto";

const PREFIX = "gls_";

export const hashToken = (token: string) => createHash("sha256").update(`gloss-agent:${token}`).digest("hex");

export function makeToken(): { id: string; token: string; hash: string } {
  const token = PREFIX + randomBytes(24).toString("base64url");
  return { id: randomBytes(8).toString("hex"), token, hash: hashToken(token) };
}

export const looksLikeToken = (s: string | null | undefined): s is string => typeof s === "string" && s.startsWith(PREFIX) && s.length > 20 && s.length < 80;

export type TokenScope = "read" | "write";

/** `read`, `write`, or both. Anything else is dropped. Empty means both, the historical default. */
export function normalizeScopes(value: unknown): TokenScope[] {
  const parts = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,\s]+/) : [];
  const scopes = [...new Set(parts.map((part) => String(part).trim()).filter((part): part is TokenScope => part === "read" || part === "write"))];
  return scopes.length ? scopes : ["read", "write"];
}
