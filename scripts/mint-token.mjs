/**
 * Agent tokens for single-user mode. The token is printed once.
 *
 *   node --env-file-if-exists=.env.local --import tsx scripts/mint-token.mjs --label "Grok" --scope read,write
 *   node --env-file-if-exists=.env.local --import tsx scripts/mint-token.mjs list
 *   node --env-file-if-exists=.env.local --import tsx scripts/mint-token.mjs revoke <id>
 */
import { makeToken, normalizeScopes } from "../lib/agent.ts";
import { singleUserId } from "../lib/auth.ts";
import { closeDb, createToken, listTokens, revokeToken } from "../lib/db.ts";

const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith("-") ? args.shift() : "mint";

function flag(name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  return args[i + 1];
}

function help() {
  console.log(`Usage:
  scripts/mint-token.mjs --label <name> [--scope read,write] [--user <id>]
  scripts/mint-token.mjs list [--user <id>]
  scripts/mint-token.mjs revoke <id> [--user <id>]`);
}

try {
  if (command === "help" || args.includes("--help")) {
    help();
  } else if (command === "list") {
    const tokens = await listTokens(flag("--user") || singleUserId());
    if (!tokens.length) console.log("No tokens.");
    for (const token of tokens) {
      console.log(`${token.id}\t${token.scopes.join(",")}\t${token.label}\tlast used ${token.lastUsedAt ?? "never"}\tcreated ${token.createdAt}`);
    }
  } else if (command === "revoke") {
    const id = args.find((a) => !a.startsWith("-"));
    if (!id) {
      help();
      process.exit(1);
    }
    const ok = await revokeToken(flag("--user") || singleUserId(), id);
    if (!ok) {
      console.error("No active token with that id.");
      process.exit(1);
    }
    console.log(`Revoked ${id}`);
  } else if (command === "mint") {
    const label = flag("--label");
    if (!label) {
      help();
      process.exit(1);
    }
    const scopes = normalizeScopes(flag("--scope"));
    const made = makeToken();
    const userId = flag("--user") || singleUserId();
    await createToken(userId, made.id, made.hash, label.slice(0, 40), scopes);
    console.log(`id: ${made.id}`);
    console.log(`label: ${label.slice(0, 40)}`);
    console.log(`scopes: ${scopes.join(",")}`);
    console.log(`user: ${userId}`);
    console.log(`token: ${made.token}`);
  } else {
    help();
    process.exit(1);
  }
} finally {
  await closeDb();
}
