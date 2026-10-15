import assert from "node:assert/strict";
import test from "node:test";
import { TOGETHER_API_BASE } from "../lib/llm";
import { buildSpeechRequest, requestSpeech } from "../lib/tts";
import { passageChunks, TTS_MAX_CHARS } from "../lib/voice";

const base = {
  TTS_PROVIDER: undefined,
  TTS_BASE_URL: undefined,
  TTS_API_KEY: undefined,
  TTS_MODEL: undefined,
  TTS_VOICE: undefined,
  TTS_VOICES: undefined,
};

test("together is the default and still asks for a key", () => {
  const missing = buildSpeechRequest({ text: "Hello." }, base);
  assert.equal(missing.ok, false);
  if (missing.ok) return;
  assert.equal(missing.code, "need_key");

  const built = buildSpeechRequest({ text: "Hello.", apiKey: "user-key" }, base);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.url, `${TOGETHER_API_BASE}/audio/speech`);
  assert.equal(built.headers.Authorization, "Bearer user-key");
  assert.equal(built.body.model, "cartesia/sonic-3");
  assert.equal(built.body.response_format, "mp3");
  assert.equal(built.body.input, "Hello.");
});

test("openai-compatible posts to TTS_BASE_URL and does not require a key", async () => {
  const env = {
    ...base,
    TTS_PROVIDER: "openai-compatible",
    TTS_BASE_URL: "http://tts.test/v1/",
    TTS_MODEL: "kokoro",
    TTS_VOICE: "af_heart",
    TTS_VOICES: "af_heart:Heart,af_bella:Bella",
  };
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(new Uint8Array([0xff, 0xfb, 0x10]), { status: 200, headers: { "content-type": "audio/mpeg" } });
  }) as typeof fetch;

  const result = await requestSpeech({ text: "Read this aloud.", voice: "af_bella" }, { env, fetch: fetchImpl });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "http://tts.test/v1/audio/speech");
  assert.equal(new Headers(calls[0]?.init.headers).has("authorization"), false);
  const body = JSON.parse(String(calls[0]?.init.body)) as { model: string; voice: string; input: string; response_format: string };
  assert.deepEqual(body, { model: "kokoro", voice: "af_bella", input: "Read this aloud.", response_format: "mp3" });
  assert.equal(result.response.headers.get("content-type"), "audio/mpeg");
  const bytes = new Uint8Array(await result.response.arrayBuffer());
  assert.equal(bytes[0], 0xff);
});

test("TTS_API_KEY is sent when set, and an unknown voice falls back", () => {
  const built = buildSpeechRequest(
    { text: "Hello.", voice: "nope" },
    { ...base, TTS_PROVIDER: "openai-compatible", TTS_BASE_URL: "http://tts.test/v1", TTS_API_KEY: "local-secret", TTS_VOICES: "af_heart:Heart" }
  );
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.headers.Authorization, "Bearer local-secret");
  assert.equal(built.body.voice, "af_heart");
});

test("TTS_PROVIDER=off never calls the endpoint", async () => {
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return new Response(null, { status: 500 });
  }) as typeof fetch;
  const result = await requestSpeech({ text: "Hello." }, { env: { ...base, TTS_PROVIDER: "off" }, fetch: fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(called, false);
});

test("long passages are chunked the same way, under the request limit", () => {
  const text = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is long enough to matter.`).join(" ");
  const chunks = passageChunks(text, true);
  assert.ok(chunks.length > 1);
  assert.ok(chunks[0]!.length <= 220);
  for (const chunk of chunks) assert.ok(chunk.length <= TTS_MAX_CHARS);
  assert.equal(chunks.join(" ").replace(/\s+/g, " "), text.replace(/\s+/g, " "));
});
