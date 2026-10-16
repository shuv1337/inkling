/**
 * AES-256-GCM for ChatGPT tokens at rest. The key is AUTH_ENCRYPTION_KEY:
 * 32 bytes, as standard base64 or as 64 hex characters. A missing or short
 * key throws before anything is written or read. Ciphertext is not a token,
 * and these functions never log the plaintext.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const AAD = Buffer.from("gloss.openai_auth.v1");

export class TokenCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenCryptoError";
  }
}

/** 32-byte key, or a TokenCryptoError that names AUTH_ENCRYPTION_KEY and nothing else. */
export function parseEncryptionKey(raw: string | undefined): Buffer {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) {
    throw new TokenCryptoError(
      "AUTH_ENCRYPTION_KEY is not set. ChatGPT tokens are encrypted at rest, so set a 32-byte key (base64, or 64 hex characters) in the environment."
    );
  }
  const key = /^[0-9a-fA-F]{64}$/.test(trimmed) ? Buffer.from(trimmed, "hex") : Buffer.from(trimmed, "base64");
  if (key.length !== 32) {
    throw new TokenCryptoError("AUTH_ENCRYPTION_KEY must be 32 bytes, encoded as base64 or as 64 hex characters.");
  }
  return key;
}

export function encryptionKeyFromEnv(env: Record<string, string | undefined> = process.env): Buffer {
  return parseEncryptionKey(env.AUTH_ENCRYPTION_KEY);
}

/** `v1.<iv>.<tag>.<ciphertext>`, each piece base64url. The plaintext is not recoverable from a log of this string. */
export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptSecret(encoded: string, key: Buffer): string {
  const parts = encoded.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") throw new TokenCryptoError("Could not decrypt the ChatGPT token. The stored value is not an Inkling ciphertext.");
  try {
    const iv = Buffer.from(parts[1], "base64url");
    const tag = Buffer.from(parts[2], "base64url");
    const ciphertext = Buffer.from(parts[3], "base64url");
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch (e) {
    if (e instanceof TokenCryptoError) throw e;
    throw new TokenCryptoError("Could not decrypt the ChatGPT token. AUTH_ENCRYPTION_KEY does not match the key that stored it.");
  }
}
