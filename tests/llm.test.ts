import assert from "node:assert/strict";
import test from "node:test";
import { buildChatRequest, TOGETHER_API_BASE } from "../lib/llm";
import { streamChat } from "../lib/together";

const empty = {
  LLM_BASE_URL: undefined,
  LLM_API_KEY: undefined,
  LLM_MODEL: undefined,
  LLM_MODELS: undefined,
  LLM_EXTRA_BODY: undefined,
  LLM_PRICE_IN: undefined,
  LLM_PRICE_OUT: undefined,
  TOGETHER_API_KEY: "tg-test",
};

test("default provider is Together, with thinking disabled", () => {
  const built = buildChatRequest({ model: "flash", messages: [{ role: "user", content: "Hi" }], stream: true }, empty);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.url, `${TOGETHER_API_BASE}/chat/completions`);
  assert.equal(built.headers.Authorization, "Bearer tg-test");
  assert.equal(built.headers["User-Agent"], "Gloss/0.1");
  assert.equal(built.body.model, "deepseek-ai/DeepSeek-V4.1-Flash");
  assert.deepEqual(built.body.chat_template_kwargs, { enable_thinking: false });
  assert.equal(built.body.stream, true);
});

test("a custom base URL omits Together-only fields and uses LLM_API_KEY and LLM_MODEL", () => {
  const built = buildChatRequest(
    { model: "flash", messages: [{ role: "user", content: "Hi" }], temperature: 0.2, maxTokens: 40 },
    {
      ...empty,
      TOGETHER_API_KEY: undefined,
      LLM_BASE_URL: "http://llm.internal/v1/",
      LLM_API_KEY: "sk-local",
      LLM_MODEL: "local-model",
    }
  );
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.url, "http://llm.internal/v1/chat/completions");
  assert.equal(built.headers.Authorization, "Bearer sk-local");
  assert.equal(built.body.model, "local-model");
  assert.equal("chat_template_kwargs" in built.body, false);
  assert.equal(built.body.temperature, 0.2);
  assert.equal(built.body.max_tokens, 40);
  assert.equal(built.entry.inPerM, 0);
});

test("LLM_EXTRA_BODY replaces the default extras, including on Together", () => {
  const built = buildChatRequest(
    { model: "flash", messages: [], thinking: true },
    { ...empty, LLM_EXTRA_BODY: JSON.stringify({ reasoning_effort: "low" }) }
  );
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.deepEqual(built.body.reasoning_effort, "low");
  assert.equal("chat_template_kwargs" in built.body, false);
});

test("thinking is forwarded only for the Together default", () => {
  const built = buildChatRequest({ model: "flash", messages: [], thinking: true }, empty);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.deepEqual(built.body.chat_template_kwargs, { enable_thinking: true });
});

test("LLM_MODELS builds the allow-list as key:id:label", () => {
  const built = buildChatRequest(
    { model: "writer", messages: [] },
    {
      ...empty,
      LLM_BASE_URL: "https://example.test/v1",
      LLM_API_KEY: "sk",
      LLM_MODELS: "writer:org/writer-a:Writer,fast:org/small:Small",
      LLM_PRICE_IN: "1.5",
      LLM_PRICE_OUT: "3",
    }
  );
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.body.model, "org/writer-a");
  assert.equal(built.entry.label, "Writer");
  assert.equal(built.entry.inPerM, 1.5);
  assert.equal(built.entry.outPerM, 3);
});

test("a missing key is an error and does not call the network", () => {
  const built = buildChatRequest({ model: "flash", messages: [] }, { ...empty, TOGETHER_API_KEY: undefined });
  assert.equal(built.ok, false);
});

test("streamChat posts the built request", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'));
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;

  const prev = { ...process.env };
  process.env.LLM_BASE_URL = "http://llm.internal/v1";
  process.env.LLM_API_KEY = "sk-stream";
  process.env.LLM_MODEL = "stream-model";
  delete process.env.LLM_EXTRA_BODY;
  delete process.env.TOGETHER_API_KEY;
  delete process.env.LLM_MODELS;

  try {
    const events = [];
    for await (const event of streamChat({ model: "flash", messages: [{ role: "user", content: "Hi" }] })) events.push(event);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "http://llm.internal/v1/chat/completions");
    assert.equal(new Headers(calls[0]?.init.headers).get("authorization"), "Bearer sk-stream");
    const body = JSON.parse(String(calls[0]?.init.body)) as { model?: string; chat_template_kwargs?: unknown };
    assert.equal(body.model, "stream-model");
    assert.equal(body.chat_template_kwargs, undefined);
    assert.equal(events.some((e) => e.type === "content" && e.text === "Hi"), true);
  } finally {
    globalThis.fetch = original;
    process.env = prev;
  }
});
