/**
 * The fork's naming contract (FORK.md): Inkling is the product name, and the
 * old Gloss names that hold stored data or connected clients stay exactly as
 * they are. An upstream merge that blurs either side fails here.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "..");
const read = (f: string) => readFileSync(join(root, f), "utf8");

function files(dir: string, exts = /\.(tsx?|mjs|css|html)$/): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(root, dir))) {
    const rel = join(dir, name);
    if (statSync(join(root, rel)).isDirectory()) {
      // Upstream's evaluation reports keep the name they were run under.
      if (!/(^|\/)(pdf-eval|image-eval|fixtures)$/.test(rel)) out.push(...files(rel, exts));
    } else if (exts.test(name)) out.push(rel);
  }
  return out;
}

const SURFACES = ["app", "components", "lib", "scripts"].flatMap((d) => files(d)).concat("proxy.ts", ".env.example", "deploy/docker-compose.yml", "db/schema.sql");

// "A gloss" is one answer in the margin; these are the type and the verb, not the product.
const GLOSS_THE_WORD = /type Gloss\b|[:(<|,]\s*Gloss\b|\bGloss\[\]|=>\s*Gloss\b|\bGloss this text\b/g;

test("the product is called Inkling", () => {
  assert.equal(JSON.parse(read("package.json")).name, "inkling");
  assert.match(read("lib/brand.ts"), /name: "Inkling"/);
  assert.match(read("app/layout.tsx"), /title: \{ default: "Inkling"/);
  assert.match(read("app/layout.tsx"), /applicationName: "Inkling"/);
  assert.match(read("lib/llm.ts"), /APP_UA = "Inkling\/0\.1"/);
  assert.match(read("lib/openai-oauth.ts"), /AGENT_NAME = "Inkling"/);
  assert.match(read("components/brand/Inkling.tsx"), /export function InklingWordmark/);
  assert.match(read("scripts/og/card.html"), /<span>Inkling<\/span>/);
  assert.match(read("README.md"), /<h1 align="center">Inkling<\/h1>/);
});

test("product surfaces do not use the old name or upstream's site", () => {
  const hits: string[] = [];
  for (const f of SURFACES) {
    read(f).split("\n").forEach((line, i) => {
      const where = `${relative(root, join(root, f))}:${i + 1}`;
      if (/\bGloss\b/.test(line.replace(GLOSS_THE_WORD, ""))) hits.push(`${where} Gloss`);
      if (/usegloss\.io/i.test(line)) hits.push(`${where} usegloss`);
      if (/TogetherMark|TogetherWordmark|TogetherLink|Powered by Together|served by Together/i.test(line)) hits.push(`${where} Together branding`);
    });
  }
  assert.deepEqual(hits, []);
  assert.equal(existsSync(join(root, "components/brand/Together.tsx")), false);
  assert.equal(existsSync(join(root, "components/brand/Gloss.tsx")), false);
});

test("stored and protocol names keep the Gloss spelling", () => {
  const kept: [string, RegExp][] = [
    ["lib/store.ts", /const KEY = "gloss:v1";/],
    ["lib/store.ts", /const DOC_PREFIX = "gloss:doc:";/],
    ["lib/store.ts", /const DB_NAME = "gloss";/],
    ["lib/settings.ts", /SETTINGS_KEY = "gloss:settings"/],
    ["lib/library-prefs.ts", /const KEY = "gloss:library";/],
    ["lib/tts-client.ts", /TTS_VOICE_KEY = "gloss:tts-voice"/],
    ["lib/sync.ts", /`gloss:sync:\$\{userId\}`/],
    ["lib/quota.ts", /`gloss:\$\{clientId\(req\)\}`/],
    ["app/api/pdf-careful/route.ts", /`gloss:\$\{s\}`/],
    ["lib/agent.ts", /const PREFIX = "gls_";/],
    ["lib/responses.ts", /TOOL_NAMESPACE = "gloss";/],
    ["lib/mcp.ts", /serverInfo: \{ name: "gloss",/],
    ["scripts/chatgpt-login.ts", /join\(homedir\(\), "\.config", "gloss"\)/],
    ["scripts/chatgpt-import.ts", /join\(homedir\(\), "\.config", "gloss"\)/],
    ["deploy/docker-compose.yml", /^name: gloss$/m],
    ["deploy/docker-compose.yml", /^ {4}name: gloss-pg$/m],
  ];
  for (const [f, re] of kept) assert.match(read(f), re, `${f} must keep ${re}`);
});

test("upstream is credited", () => {
  for (const f of ["README.md", "FORK.md"]) assert.match(read(f), /\[Gloss\]\(https:\/\/github\.com\/Nutlope\/gloss\)/, f);
  assert.match(read("FORK.md"), /## License/);
});

test("a production build, when there is one, says Inkling", { skip: !existsSync(join(root, ".next/server/app/index.html")) }, () => {
  const html = read(".next/server/app/index.html");
  // Plain checks, so a failure does not print the whole page.
  assert.ok(html.includes("<title>Inkling</title>"), "the built home page is titled Inkling");
  assert.ok(!/usegloss\.io|together\.ai/i.test(html), "the built home page has no upstream site or Together links");
});
