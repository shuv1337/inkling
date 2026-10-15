import assert from "node:assert/strict";
import test from "node:test";
import { TOOLS, scopeOf } from "../lib/mcp";

test("every published tool has a scope, and writes are not readable", () => {
  for (const tool of TOOLS) assert.ok(scopeOf(tool.name), tool.name);
  assert.equal(scopeOf("save_articles"), "write");
  assert.equal(scopeOf("save_text"), "write");
  assert.equal(scopeOf("add_highlight"), "write");
  assert.equal(scopeOf("add_note"), "write");
  assert.equal(scopeOf("list_items"), "read");
  assert.equal(scopeOf("search_items"), "read");
  assert.equal(scopeOf("get_item"), "read");
  assert.equal(scopeOf("get_highlights"), "read");
  assert.equal(scopeOf("get_notes"), "read");
  assert.equal(scopeOf("get_brief"), "read");
  assert.equal(scopeOf("search_library"), "read");
  assert.equal(scopeOf("list_topics"), "read");
  assert.equal(scopeOf("drop_table"), null);
});
