/**
 * Revoke the ChatGPT refresh token, then clear the local tokens.
 * The client id and host id stay, so the next login is a reauthorization.
 * Disconnecting in ChatGPT settings is still required for a transferred session:
 * host-specific revocation is not available yet.
 */
import { singleUserId } from "../lib/auth";
import { closeDb } from "../lib/db";
import { clearStoredTokens, loadSession } from "../lib/openai-auth";
import { ChatgptAuthError, fetchRevocationEndpoint, revokeForm } from "../lib/openai-oauth";

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  const userId = singleUserId();
  const session = await loadSession(userId);
  if (!session?.refreshToken) {
    console.log("ChatGPT is not linked.");
    return;
  }
  let confirmed = false;
  try {
    const endpoint = await fetchRevocationEndpoint();
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: revokeForm(session),
    });
    confirmed = res.ok;
  } catch {
    confirmed = false;
  }
  await clearStoredTokens(userId);
  if (confirmed) {
    console.log("Revoked the ChatGPT session and cleared the local tokens.");
  } else {
    console.log("Cleared the local tokens. Remote revocation was not confirmed.");
  }
  console.log("In ChatGPT, open Settings, then Security and login, then Login connections, and disconnect Gloss if it is still listed.");
  console.log("Plan limits live under Settings, then Usage.");
}

main()
  .catch((error: unknown) => {
    if (error instanceof ChatgptAuthError) console.error(error.message);
    else if (error instanceof Error && error.message.includes("AUTH_ENCRYPTION_KEY")) console.error(error.message);
    else if (error instanceof Error && error.message.includes("openai_auth") && error.message.includes("does not exist")) console.error("The openai_auth table is missing. Run npm run db:migrate.");
    else console.error("Logout failed.");
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb().catch(() => undefined);
  });
