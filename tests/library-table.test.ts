import { test } from "node:test";
import assert from "node:assert/strict";
import type { Book } from "../lib/library";
import { bookSource, DEFAULT_TABLE_SORT, filterTableBooks, matchesLibraryBook, nextTableSort, readingStatus, sortTableBooks, TABLE_COLUMNS, validTableSort } from "../lib/library-table";

const book = (id: string, patch: Partial<Book> = {}): Book => ({ id, title: id, author: "A writer", topic: "ai", minutes: 8, tags: [], favorite: false, pct: 0, highlights: 0, added: 100, agent: false, sample: false, ...patch });
const ids = (books: Book[]) => books.map((b) => b.id);

test("default is newest added; sorts copies, leaving library order untouched", () => {
  const books = [book("old"), book("new", { added: 200 }), book("sample", { added: 0, sample: true })];
  assert.deepEqual(ids(sortTableBooks(books, DEFAULT_TABLE_SORT)), ["new", "old", "sample"]);
  assert.deepEqual(ids(books), ["old", "new", "sample"]);
});

test("every column sorts in both directions", () => {
  for (const column of TABLE_COLUMNS) {
    const low = book("a", { title: "Article 2", topic: "ai", added: 10, minutes: 2, pct: 0, lastRead: 10 });
    const high = book("b", { title: "article 10", topic: "writing", added: 20, minutes: 10, pct: 1, lastRead: 20 });
    assert.deepEqual(ids(sortTableBooks([high, low], { key: column.key, direction: "asc" })), ["a", "b"], column.key);
    assert.deepEqual(ids(sortTableBooks([low, high], { key: column.key, direction: "desc" })), ["b", "a"], column.key);
  }
});

test("missing dates remain last in either direction; ties are stable across input order", () => {
  for (const key of ["added", "lastRead"] as const) {
    for (const direction of ["asc", "desc"] as const) {
      assert.deepEqual(ids(sortTableBooks([book("missing", { added: 0 }), book("dated", { lastRead: 5 })], { key, direction })), ["dated", "missing"]);
    }
  }
  const a = book("a", { title: "Same" });
  const b = book("b", { title: "Same" });
  assert.deepEqual(ids(sortTableBooks([b, a], DEFAULT_TABLE_SORT)), ids(sortTableBooks([a, b], DEFAULT_TABLE_SORT)));
});

test("status respects durable completion, zero, partial and full progress", () => {
  assert.equal(readingStatus(book("unread")), "unread");
  assert.equal(readingStatus(book("reading", { pct: 0.01 })), "reading");
  assert.equal(readingStatus(book("almost", { pct: 0.999 })), "reading");
  assert.equal(readingStatus(book("done", { pct: 1 })), "finished");
  assert.equal(readingStatus(book("rereading", { pct: 0.2, finished: 50 })), "finished");
});

test("search, topic and status filters compose before sorting", () => {
  const books = [
    book("match", { title: "Small systems", source: "Example News", topic: "infra", pct: 0.4, tags: ["databases"] }),
    book("unread", { title: "Small systems", source: "Example News", topic: "infra" }),
    book("other-topic", { title: "Small systems", source: "Example News", pct: 0.4 }),
  ];
  const searched = books.filter((b) => matchesLibraryBook(b, " SYSTEMS example "));
  assert.deepEqual(ids(filterTableBooks(searched, "reading", "infra")), ["match"]);
  assert.equal(filterTableBooks(searched, "finished", "all").length, 0);
  assert.equal(filterTableBooks(searched, "all", "all").length, 3);
  assert.ok(matchesLibraryBook(books[0], "databases infrastructure"));
  assert.equal(matchesLibraryBook(books[0], "nonexistent"), false);
  assert.equal(matchesLibraryBook(books[0], "", "agent"), false);
  assert.equal(matchesLibraryBook(book("agent", { agent: true }), "", "agent"), true);
});

test("header taps reverse direction; new date columns start newest first", () => {
  assert.deepEqual(nextTableSort(DEFAULT_TABLE_SORT, "added"), { key: "added", direction: "asc" });
  assert.deepEqual(nextTableSort(DEFAULT_TABLE_SORT, "title"), { key: "title", direction: "asc" });
  assert.deepEqual(nextTableSort(DEFAULT_TABLE_SORT, "lastRead"), { key: "lastRead", direction: "desc" });
});

test("invalid or old preferences fall back without accepting arbitrary sort fields", () => {
  for (const saved of [null, "recent", {}, { key: "color", direction: "asc" }, { key: "title", direction: "sideways" }]) assert.deepEqual(validTableSort(saved), DEFAULT_TABLE_SORT);
  assert.deepEqual(validTableSort({ key: "minutes", direction: "asc" }), { key: "minutes", direction: "asc" });
});

test("source is the real hostname, file/source label or byline", () => {
  assert.equal(bookSource(book("url", { url: "https://www.example.com/essay" })), "example.com");
  assert.equal(bookSource(book("file", { url: "bad url", source: "notes.pdf" })), "notes.pdf");
  assert.equal(bookSource(book("paste")), "A writer");
});
