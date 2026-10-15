import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { blockText } from "../lib/article";
import { notAnArticle } from "../lib/fetch-article";
import { fetchXPost, xStatusId } from "../lib/x-post";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "x");
const fixture = (name: string) => JSON.parse(readFileSync(join(dir, name), "utf8")) as unknown;

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("a status id is read from x.com and twitter.com, and a profile is not one", () => {
  assert.equal(xStatusId("https://x.com/someone/status/2110385721391366263"), "2110385721391366263");
  assert.equal(xStatusId("https://twitter.com/someone/status/2110385721391366263?s=20"), "2110385721391366263");
  assert.equal(xStatusId("https://mobile.twitter.com/i/web/status/123456789012345"), "123456789012345");
  assert.equal(xStatusId("https://x.com/someone"), null);
  assert.equal(xStatusId("https://example.com/status/2110385721391366263"), null);
  assert.equal(notAnArticle("https://x.com/someone/status/2110385721391366263"), null);
  assert.equal(notAnArticle("https://twitter.com/someone"), "social");
  assert.equal(notAnArticle("https://bsky.app/profile/someone"), "social");
});

test("a single post keeps the author, the photo, and a stable id", async () => {
  const result = await fetchXPost("https://x.com/tester/status/1111111111111111111", {
    env: { X_FETCH: "fx" },
    fetch: (async () => respond(fixture("post.json"))) as typeof fetch,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.article.id, "x-1111111111111111111");
  assert.equal(result.article.source, "X");
  assert.equal(result.article.author, "Test Author (@tester)");
  assert.equal(result.article.sourceUrl, "https://x.com/tester/status/1111111111111111111");
  assert.equal(result.article.published?.slice(0, 4), "2025");
  assert.equal(blockText(result.article.blocks[0]), "Hello from a status.");
  assert.equal(result.article.blocks.find((block) => block.type === "figure")?.src, "https://pbs.twimg.com/media/pic.jpg");
});

test("a long note tweet is read in full", async () => {
  const result = await fetchXPost("https://x.com/grace/status/2222222222222222222", {
    env: { X_FETCH: "fx" },
    fetch: (async () => respond(fixture("note.json"))) as typeof fetch,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const text = result.article.blocks.map(blockText).join(" ");
  assert.match(text, /zebrafish-note/);
  assert.equal(text.includes("Short preview"), false);
});

test("an X Article becomes headings, a link, and its image", async () => {
  const result = await fetchXPost("https://x.com/ada/status/3333333333333333333", {
    env: { X_FETCH: "fx" },
    fetch: (async () => respond(fixture("article.json"))) as typeof fetch,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.article.title, "On the Notes");
  assert.equal(result.article.dek, "A short standfirst that is not the first paragraph.");
  const paragraph = result.article.blocks.find((block) => block.type === "p");
  assert.equal(paragraph?.runs.some((run) => run.text === "analytical" && run.href === "https://example.com/engine"), true);
  assert.equal(result.article.blocks.find((block) => block.type === "figure")?.src, "https://pbs.twimg.com/media/example.jpg");
});

test("a quote post keeps the quoted text", async () => {
  const result = await fetchXPost("https://x.com/alan/status/4444444444444444444", {
    env: { X_FETCH: "fx" },
    fetch: (async () => respond(fixture("quote.json"))) as typeof fetch,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const quote = result.article.blocks.find((block) => block.type === "quote");
  assert.match(blockText(quote!), /@dijkstra: The quoted sentence\./);
});

test("a deleted post is a clean error and does not try the next source", async () => {
  const calls: string[] = [];
  const result = await fetchXPost("https://x.com/tester/status/1111111111111111111", {
    env: { X_FETCH: "fx,api", X_BEARER_TOKEN: "secret" },
    fetch: (async (url: string | URL) => {
      calls.push(String(url));
      return respond(fixture("deleted.json"), 200);
    }) as typeof fetch,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /deleted/);
  assert.equal(result.status, 404);
  assert.equal(calls.length, 1);
});

test("a protected post is a clean error and does not try the next source", async () => {
  const calls: string[] = [];
  const result = await fetchXPost("https://x.com/tester/status/1111111111111111111", {
    env: { X_FETCH: "fx,api", X_BEARER_TOKEN: "secret" },
    fetch: (async (url: string | URL) => {
      calls.push(String(url));
      return respond(fixture("protected.json"), 401);
    }) as typeof fetch,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /protected/);
  assert.equal(calls.length, 1);
});

test("a 5xx from fxtwitter falls through to the X API", async () => {
  const calls: string[] = [];
  const result = await fetchXPost("https://x.com/apiuser/status/5555555555555555555", {
    env: { X_FETCH: "fx,api", X_BEARER_TOKEN: "secret" },
    fetch: (async (url: string | URL) => {
      const href = String(url);
      calls.push(href);
      if (href.includes("fxtwitter")) return new Response("down", { status: 502 });
      return respond(fixture("api-post.json"));
    }) as typeof fetch,
  });
  assert.equal(calls.length, 2);
  assert.match(calls[1] ?? "", /api\.x\.com/);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.article.author, "API Author (@apiuser)");
  assert.match(result.article.blocks.map(blockText).join(" "), /second sentence from the note/);
  assert.match(blockText(result.article.blocks.find((block) => block.type === "quote")!), /@quoted: The API quoted line\./);
});

test("an X API 404 does not fall through", async () => {
  const calls: string[] = [];
  const result = await fetchXPost("https://x.com/tester/status/1111111111111111111", {
    env: { X_FETCH: "api,fx", X_BEARER_TOKEN: "secret" },
    fetch: (async (url: string | URL) => {
      calls.push(String(url));
      return respond({ errors: [{ title: "Not Found Error", status: 404 }] }, 404);
    }) as typeof fetch,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 404);
  assert.equal(calls.length, 1);
});
