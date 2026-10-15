import assert from "node:assert/strict";
import test from "node:test";
import type { Block } from "../lib/article";
import { articleMarkdown, blocksPage, decodeCursor, encodeCursor, findQuote, pageOf } from "../lib/library-read";

const blocks: Block[] = [
  { id: "h", type: "h2", runs: [{ text: "Heading" }] },
  { id: "p", type: "p", runs: [{ text: "Hello zebrafish." }] },
  { id: "q", type: "quote", runs: [{ text: "A quoted line" }] },
  { id: "t", type: "table", runs: [], head: true, rows: [["A", "B"], ["1", "2"]] },
];

test("markdown keeps headings, quotes, and tables", () => {
  assert.equal(articleMarkdown(blocks), "## Heading\n\nHello zebrafish.\n\n> A quoted line\n\n| A | B |\n| --- | --- |\n| 1 | 2 |");
});

test("a quote is found inside one block, with the block's own offsets", () => {
  const found = findQuote(blocks, "zebrafish");
  assert.equal(found?.start.b, "p");
  assert.equal(found?.start.o, "Hello ".length);
  assert.equal(found?.quote, "zebrafish");
  assert.equal(findQuote(blocks, "not in the text"), null);
  assert.equal(findQuote(blocks, "Hello zebrafish. A quoted"), null);
});

test("long text is paged, and the next offset continues it", () => {
  const text = articleMarkdown(blocks);
  const first = pageOf(text, 0, 16);
  assert.equal(first.text, text.slice(0, 16));
  assert.equal(first.nextOffset, 16);
  const rest = pageOf(text, first.nextOffset, 10_000);
  assert.equal(first.text + rest.text, text);
  assert.equal(rest.nextOffset, null);
  const paged = blocksPage(blocks, 0, 10);
  assert.ok(paged.blocks.length >= 1);
  assert.ok(paged.nextOffset);
});

test("cursors round-trip", () => {
  const at = new Date("2026-10-15T12:00:00.000Z");
  const cursor = encodeCursor(at, "abc");
  assert.deepEqual(decodeCursor(cursor), { at, id: "abc" });
  assert.equal(decodeCursor("nope"), null);
});
