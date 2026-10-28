/**
 * Import a credential file from `npm run chatgpt:login -- --export`.
 * The file's host id is the laptop's. This machine keeps, or creates, its own.
 */
import { readFileSync } from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { singleUserId } from "../lib/auth";
import { closeDb } from "../lib/db";
import { loadHostId, saveSession } from "../lib/openai-auth";
import { ChatgptAuthError, isHostId, newHostId, sessionFromCredential } from "../lib/openai-oauth";
import { encryptionKeyFromEnv } from "../lib/token-crypto";

function writeHost(id: string) {
  const dir = join(homedir(), ".config", "gloss");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "host-id"), `${id}\n`, { mode: 0o600 });
}

async function main() {
  const file = process.argv.slice(2).find((arg) => !arg.startsWith("-"));
  if (!file) {
    console.error("Usage: npm run chatgpt:import -- <credential-file>");
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  encryptionKeyFromEnv();

  const record = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const userId = singleUserId();
  const existing = await loadHostId(userId).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("does not exist")) throw new ChatgptAuthError("The openai_auth table is missing. Run npm run db:migrate.");
    throw error;
  });
  const fromEnv = process.env.OPENAI_HOST_ID?.trim();
  const hostId = existing || (fromEnv && isHostId(fromEnv) ? fromEnv : newHostId());
  const session = sessionFromCredential(record, hostId, Date.now());
  await saveSession(userId, session);
  writeHost(hostId);
  console.log(`Imported ChatGPT for ${session.email ?? "the account"}.`);
  console.log(existing ? "Kept this machine's host id." : "Created a host id for this machine. The host id in the file was not copied.");
  console.log(`The access token expires ${new Date(session.expiresAt).toISOString()}.`);
  console.log("Delete the credential file on this machine and on the laptop. It contains tokens.");
}

main()
  .catch((error: unknown) => {
    if (error instanceof ChatgptAuthError) console.error(error.message);
    else if (error instanceof Error && (error.message.includes("AUTH_ENCRYPTION_KEY") || error.message.includes("openai_auth"))) console.error(error.message);
    else console.error("Import failed.");
    process.exitCode = 1;
  })
  .finally(() => {
    // Fire-and-forget: the pending close keeps the process alive until it settles.
    void closeDb().catch(() => undefined);
  });
