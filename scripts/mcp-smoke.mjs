/**
 * MCP against the local database: initialize, tools/list, save, read, highlight.
 *   node --env-file-if-exists=.env.local --import tsx scripts/mcp-smoke.mjs
 */
import assert from "node:assert/strict";
import { makeToken } from "../lib/agent.ts";
import { closeDb, createToken, db } from "../lib/db.ts";
import { handle } from "../lib/mcp.ts";

const user = "mcp-smoke";

async function rpc(token, method, params, id = 1) {
  const res = await handle(
    new Request("http://gloss.local/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    })
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function toolText(body) {
  return body?.result?.content?.[0]?.text ?? "";
}

async function cleanup() {
  await db().query("delete from glosses where user_id = $1", [user]);
  await db().query("delete from highlights where user_id = $1", [user]);
  await db().query("delete from articles where user_id = $1", [user]);
  await db().query("delete from agent_tokens where user_id = $1", [user]);
}

let failed = false;
try {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set.");
  await cleanup();

  const read = makeToken();
  const write = makeToken();
  await createToken(user, read.id, read.hash, "Smoke read", ["read"]);
  await createToken(user, write.id, write.hash, "Smoke write", ["read", "write"]);

  const anon = await rpc(undefined, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
  assert.equal(anon.status, 401);

  const init = await rpc(write.token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
  assert.equal(init.status, 200);
  assert.equal(init.body.result.protocolVersion, "2025-06-18");

  const listed = await rpc(write.token, "tools/list", {});
  const names = listed.body.result.tools.map((tool) => tool.name);
  for (const name of ["list_items", "search_items", "get_item", "get_highlights", "get_notes", "get_brief", "add_highlight", "add_note"]) {
    assert.ok(names.includes(name), name);
  }

  const denied = await rpc(read.token, "tools/call", { name: "save_text", arguments: { text: "nope", title: "Nope" } });
  assert.equal(denied.body.result.isError, true);

  const saved = await rpc(write.token, "tools/call", {
    name: "save_text",
    arguments: { text: "The zebrafish genome is a distinctive phrase for the search index.\n\nA second paragraph follows.", title: "Smoke essay", author: "Smoke" },
  });
  assert.equal(saved.body.result.isError, undefined);
  assert.match(toolText(saved.body), /Saved: Smoke essay/);

  const items = await rpc(write.token, "tools/call", { name: "list_items", arguments: { limit: 10 } });
  const found = items.body.result.structuredContent.items.find((item) => item.title === "Smoke essay");
  assert.ok(found, toolText(items.body));

  const item = await rpc(write.token, "tools/call", { name: "get_item", arguments: { id: found.id, format: "markdown", max_chars: 500 } });
  assert.match(item.body.result.structuredContent.text, /zebrafish/);

  const hits = await rpc(write.token, "tools/call", { name: "search_items", arguments: { query: "zebrafish" } });
  assert.ok(hits.body.result.structuredContent.items.some((row) => row.id === found.id));

  const marked = await rpc(write.token, "tools/call", { name: "add_highlight", arguments: { id: found.id, quote: "zebrafish genome", color: "green" } });
  assert.equal(marked.body.result.isError, undefined);

  const highlights = await rpc(write.token, "tools/call", { name: "get_highlights", arguments: { id: found.id } });
  assert.ok(highlights.body.result.structuredContent.highlights.some((mark) => mark.quote === "zebrafish genome"));

  const noted = await rpc(write.token, "tools/call", { name: "add_note", arguments: { id: found.id, question: "Why zebrafish?" } });
  assert.equal(noted.body.result.isError, undefined);
  const notes = await rpc(write.token, "tools/call", { name: "get_notes", arguments: { id: found.id } });
  assert.ok(notes.body.result.structuredContent.notes.some((note) => note.question === "Why zebrafish?"));

  const brief = await rpc(write.token, "tools/call", { name: "get_brief", arguments: { id: found.id } });
  assert.equal(brief.body.result.structuredContent.brief, null);

  console.log("mcp smoke ok");
} catch (err) {
  console.error(err);
  failed = true;
} finally {
  try {
    await cleanup();
  } catch (err) {
    console.error(err);
    failed = true;
  }
  // postgres-js can leave the pool open after the last query, which keeps node alive.
  await Promise.race([closeDb(), new Promise((resolve) => setTimeout(resolve, 2000))]);
  process.exit(failed ? 1 : 0);
}
