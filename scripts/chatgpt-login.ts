/**
 * One-time Sign in with ChatGPT.
 *
 * On the machine that has the database: `npm run chatgpt:login`
 * stores the tokens, encrypted, in Postgres.
 *
 * On a laptop, or when you would rather carry a file:
 * `npm run chatgpt:login -- --export` writes a 0600 credential file.
 * Import it on the server with `npm run chatgpt:import`.
 *
 * The browser must be able to open the callback on 127.0.0.1. From a laptop
 * that is the local listener. From the server, forward it:
 * `ssh -L 1455:127.0.0.1:1455 shuvdev` and open the printed address on the laptop.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { singleUserId } from "../lib/auth";
import { closeDb } from "../lib/db";
import { loadRegistration, saveSession } from "../lib/openai-auth";
import {
  ChatgptAuthError,
  DYNAMIC_CLIENT,
  ISSUER,
  TOKEN_URL,
  applyTokenResponse,
  authorizeUrl,
  codeExchangeForm,
  credentialRecord,
  fetchJwks,
  isHostId,
  loopbackRedirect,
  newHostId,
  pkcePair,
  planGranted,
  randomSecret,
  validateIdToken,
  type StoredSession,
} from "../lib/openai-oauth";
import { encryptionKeyFromEnv } from "../lib/token-crypto";

function flagValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const next = process.argv[index + 1];
  if (!next || next.startsWith("-")) return "";
  return next;
}

function configDir(): string {
  return join(homedir(), ".config", "gloss");
}

function hostPath(): string {
  return join(configDir(), "host-id");
}

function readHostFile(): string | null {
  try {
    const value = readFileSync(hostPath(), "utf8").trim();
    return isHostId(value) ? value : null;
  } catch {
    return null;
  }
}

function writePrivate(path: string, contents: string) {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(path, contents, { mode: 0o600 });
}

function openBrowser(url: string) {
  const child = spawn("xdg-open", [url], { stdio: "ignore", detached: true });
  child.on("error", () => undefined);
  child.unref();
}

function waitForCallback(port: number): Promise<URL> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      const ok = url.pathname === "/auth/callback";
      res.writeHead(ok ? 200 : 404, { "Content-Type": "text/html; charset=utf-8" });
      res.end(ok ? "<!doctype html><meta charset=utf-8><title>Inkling</title><p>ChatGPT sign-in finished. You can close this tab.</p>" : "Not found");
      if (!ok) return;
      server.close();
      resolve(url);
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new ChatgptAuthError("Sign-in timed out after 5 minutes."));
    }, 5 * 60 * 1000);
    timer.unref();
    server.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    server.listen(port, "127.0.0.1");
  });
}

async function main() {
  const wantsExport = process.argv.includes("--export");
  const noBrowser = process.argv.includes("--no-browser");
  const fresh = process.argv.includes("--fresh");
  const port = Number(flagValue("--port") || process.env.OPENAI_REDIRECT_PORT || 1455);
  const redirectUri = loopbackRedirect(port);
  const exportPath = flagValue("--export") || join(configDir(), "chatgpt-auth.json");

  if (!wantsExport) {
    if (!process.env.DATABASE_URL) {
      console.error("DATABASE_URL is not set. Re-run with --export to write a credential file, then npm run chatgpt:import on the server.");
      process.exit(1);
    }
    encryptionKeyFromEnv();
  }

  const userId = singleUserId();
  const registration = !wantsExport && !fresh && process.env.DATABASE_URL ? await loadRegistration(userId).catch(() => null) : null;
  const hostFromEnv = process.env.OPENAI_HOST_ID?.trim();
  const hostId = (registration?.hostId && isHostId(registration.hostId) ? registration.hostId : null) || (hostFromEnv && isHostId(hostFromEnv) ? hostFromEnv : null) || readHostFile() || newHostId();
  writePrivate(hostPath(), `${hostId}\n`);

  const { verifier, challenge } = pkcePair();
  const state = randomSecret();
  const nonce = randomSecret();
  const clientId = fresh ? null : registration?.clientId || null;
  const url = authorizeUrl({
    redirectUri,
    state,
    nonce,
    challenge,
    hostId,
    clientId,
    idTokenHint: clientId ? registration?.idToken : null,
    loginHint: clientId ? registration?.email : null,
  });

  console.log(`Waiting for the callback on ${redirectUri}`);
  console.log("Open this address in the browser that can reach that port.");
  if (url.includes("id_token_hint=")) console.log("The address contains a sign-in hint. Do not paste it into chat.");
  console.log(url);
  if (!noBrowser) openBrowser(url);

  const callback = await waitForCallback(port);
  if (callback.searchParams.get("state") !== state) throw new ChatgptAuthError("The callback state did not match. Nothing was saved.");
  const oauthError = callback.searchParams.get("error");
  if (oauthError) {
    throw new ChatgptAuthError(oauthError === "access_denied" ? "ChatGPT sign-in was declined. Nothing was saved." : "ChatGPT sign-in did not finish. Nothing was saved.");
  }

  const issued = callback.searchParams.get("client_id");
  let usedClient = clientId ?? "";
  if (!clientId) {
    if (!issued || issued === DYNAMIC_CLIENT) throw new ChatgptAuthError("Registration did not return a client id. Nothing was saved.");
    usedClient = issued;
  } else if (issued && issued !== clientId) {
    throw new ChatgptAuthError("The callback returned a different client id. Nothing was saved.");
  }

  const code = callback.searchParams.get("code");
  if (!code) throw new ChatgptAuthError("The callback had no authorization code. Nothing was saved.");

  const tokenRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: codeExchangeForm({ clientId: usedClient, code, verifier, redirectUri }),
  });
  const raw = await tokenRes.text();
  if (!tokenRes.ok) throw new ChatgptAuthError("ChatGPT rejected the sign-in. Start again.");
  let token: { access_token?: string; refresh_token?: string; id_token?: string; expires_in?: number; scope?: string; earliest_refresh_at?: number | string };
  try {
    token = JSON.parse(raw) as typeof token;
  } catch {
    throw new ChatgptAuthError("ChatGPT returned a sign-in response that was not JSON.");
  }
  if (!token.id_token) throw new ChatgptAuthError("ChatGPT did not return an ID token. Nothing was saved.");
  const jwks = await fetchJwks();
  const identity = validateIdToken(token.id_token, { jwks, issuer: jwks.issuer || ISSUER, audience: usedClient, nonce });
  if (registration?.subject && identity.sub !== registration.subject && !fresh) {
    throw new ChatgptAuthError("This sign-in was for a different ChatGPT account. Nothing was replaced.");
  }

  const scope = token.scope || callback.searchParams.get("scope")?.replace(/\+/g, " ") || "";
  const blank: StoredSession = {
    clientId: usedClient,
    hostId,
    issuer: ISSUER,
    subject: identity.sub,
    email: identity.email,
    accessToken: "",
    refreshToken: "",
    idToken: null,
    scopes: [],
    expiresAt: 0,
    earliestRefreshAt: null,
    refreshedAt: null,
  };
  const session = applyTokenResponse(blank, { ...token, scope }, Date.now());
  if (!planGranted(session.scopes)) {
    throw new ChatgptAuthError("ChatGPT did not grant plan usage (chatgpt.tokens.use.direct). Sign in again and allow Inkling to use the plan. Nothing was saved.");
  }

  if (wantsExport) {
    const savedAt = new Date().toISOString();
    writePrivate(exportPath, `${JSON.stringify(credentialRecord(session, savedAt), null, 2)}\n`);
    console.log(`Wrote ${exportPath}`);
    console.log("This file contains tokens. Copy it over SSH, run npm run chatgpt:import on the server, then delete the file in both places.");
  } else {
    await saveSession(userId, session);
    console.log("Stored the ChatGPT sign-in in Postgres.");
  }
  console.log(`Linked ${session.email ?? "the ChatGPT account"}.`);
  console.log(`The access token expires ${new Date(session.expiresAt).toISOString()}. Inkling refreshes it on its own.`);
}

main()
  .catch((error: unknown) => {
    if (error instanceof ChatgptAuthError) console.error(error.message);
    else if (error instanceof Error && error.message.includes("AUTH_ENCRYPTION_KEY")) console.error(error.message);
    else if (error instanceof Error && "code" in error && error.code === "EADDRINUSE") console.error("That port is in use. Re-run with --port and the same port in the SSH tunnel.");
    else console.error("Sign-in failed.");
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb().catch(() => undefined);
  });
