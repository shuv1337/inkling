import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { streamChatgpt } from "../lib/chatgpt";
import { hasLlmConfig, visionSettings } from "../lib/llm";
import { CHATGPT_DEFAULT_MODEL } from "../lib/models";
import {
  REFRESH_LOCK_SQL,
  REFRESH_ROW_SQL,
  refreshLocked,
  type StoredSession,
} from "../lib/openai-auth";
import {
  AUTHORIZE_URL,
  ChatgptAuthError,
  DYNAMIC_CLIENT,
  ISSUER,
  PLAN_SCOPE,
  RESOURCE,
  TOKEN_URL,
  UnusableRefresh,
  applyTokenResponse,
  authorizeUrl,
  codeExchangeForm,
  createMutex,
  loopbackRedirect,
  needsRefresh,
  pkcePair,
  planGranted,
  refreshForm,
  refreshWithLock,
  requestRefresh,
  sessionFromCredential,
  toPublicStatus,
  validateIdToken,
  type SigningKey,
} from "../lib/openai-oauth";
import { coverSettings } from "../lib/paint";
import {
  FORBIDDEN_FIELDS,
  RESPONSES_URL,
  ResponsesStream,
  SseBuffer,
  TOOL_NAMESPACE,
  USAGE_LIMIT_MESSAGE,
  buildResponsesRequest,
  jsonFromText,
  responsesHttpError,
  textFromEvents,
} from "../lib/responses";
import { WEB_TOOL } from "../lib/search";
import { decryptSecret, encryptSecret, parseEncryptionKey } from "../lib/token-crypto";

const KEY = Buffer.alloc(32, 7);

function session(over: Partial<StoredSession> = {}): StoredSession {
  return {
    clientId: "oaiapp_test",
    hostId: "urn:uuid:00000000-0000-4000-8000-000000000001",
    issuer: ISSUER,
    subject: "user_1",
    email: "reader@example.com",
    accessToken: "old-access",
    refreshToken: "old-refresh",
    idToken: null,
    scopes: [PLAN_SCOPE, "openid", "offline_access"],
    expiresAt: Date.now() + 3_600_000,
    earliestRefreshAt: null,
    refreshedAt: null,
    ...over,
  };
}

function play(raw: string) {
  const buffer = new SseBuffer();
  const stream = new ResponsesStream();
  const events = buffer.push(raw).flatMap((message) => stream.push(message));
  events.push(...buffer.flush().flatMap((message) => stream.push(message)));
  events.push(...stream.finish());
  return events;
}

test("AES-GCM round trip hides the token and rejects a missing, short, or wrong key", () => {
  const plain = "refresh-token-do-not-log";
  const key = parseEncryptionKey(KEY.toString("base64"));
  const hex = parseEncryptionKey(KEY.toString("hex"));
  assert.equal(hex.equals(KEY), true);
  const encoded = encryptSecret(plain, key);
  assert.equal(encoded.includes(plain), false);
  assert.equal(decryptSecret(encoded, key), plain);
  assert.notEqual(encryptSecret(plain, key), encoded);
  assert.throws(() => parseEncryptionKey(undefined), /AUTH_ENCRYPTION_KEY is not set/);
  assert.throws(() => parseEncryptionKey("too-short"), /must be 32 bytes/);
  assert.throws(() => decryptSecret(encoded, Buffer.alloc(32, 9)), /does not match/);
  const tampered = `${encoded.slice(0, -2)}${encoded.endsWith("a") ? "b" : "a"}`;
  assert.throws(() => decryptSecret(tampered, key), /does not match|not an Inkling ciphertext/);
});

test("a refresh rotates the refresh token, and two callers share one exchange", async () => {
  const now = 1_700_000_000_000;
  let current = session({ expiresAt: now - 1000, refreshToken: "old-refresh", accessToken: "old-access" });
  let calls = 0;
  const lock = createMutex();
  const run = () =>
    refreshWithLock({
      load: async () => current,
      save: async (next) => {
        current = next;
      },
      clear: async () => {
        current = { ...current, accessToken: "", refreshToken: "" };
      },
      lock,
      now: () => now,
      exchange: async (seen) => {
        calls += 1;
        assert.equal(seen.refreshToken, "old-refresh");
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { ...seen, accessToken: "new-access", refreshToken: "new-refresh", expiresAt: now + 3_600_000, refreshedAt: now };
      },
    });
  const [first, second] = await Promise.all([run(), run()]);
  assert.equal(calls, 1);
  assert.equal(first, "new-access");
  assert.equal(second, "new-access");
  assert.equal(current.refreshToken, "new-refresh");
  assert.equal(current.accessToken, "new-access");
});

test("refresh waits out earliest_refresh_at and otherwise refreshes inside five minutes", () => {
  const now = 5_000_000;
  assert.equal(needsRefresh(session({ expiresAt: now + 10 * 60_000 }), now), false);
  assert.equal(needsRefresh(session({ expiresAt: now + 60_000, earliestRefreshAt: now + 30_000 }), now), false);
  assert.equal(needsRefresh(session({ expiresAt: now + 60_000, earliestRefreshAt: now - 1 }), now), true);
  assert.equal(needsRefresh(session({ expiresAt: now - 1, earliestRefreshAt: now + 10_000 }), now), true);
});

test("the refresh request uses the issued client, the resource, and no secret or scope", async () => {
  const seen: { url: string; body: string }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), body: String(init?.body ?? "") });
    return new Response(
      JSON.stringify({
        access_token: "next-access",
        refresh_token: "next-refresh",
        expires_in: 3600,
        scope: "openid offline_access chatgpt.tokens.use.direct",
        earliest_refresh_at: 1_700_000_100,
      }),
      { status: 200 }
    );
  }) as typeof fetch;
  const now = 1_700_000_000_000;
  const next = await requestRefresh(session({ expiresAt: now - 1 }), fetchImpl, now);
  assert.equal(seen[0]?.url, TOKEN_URL);
  const form = new URLSearchParams(seen[0]?.body);
  assert.equal(form.get("grant_type"), "refresh_token");
  assert.equal(form.get("client_id"), "oaiapp_test");
  assert.equal(form.get("refresh_token"), "old-refresh");
  assert.equal(form.get("resource"), RESOURCE);
  assert.equal(form.get("scope"), null);
  assert.equal(form.get("client_secret"), null);
  assert.equal(next.accessToken, "next-access");
  assert.equal(next.refreshToken, "next-refresh");
  assert.equal(next.expiresAt, now + 3_600_000);
  assert.equal(next.earliestRefreshAt, 1_700_000_100_000);
});

test("an unusable refresh token is cleared and not retried", async () => {
  let current = session({ expiresAt: 0 });
  let cleared = false;
  const fetchImpl = (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as typeof fetch;
  await assert.rejects(
    () =>
      refreshWithLock({
        load: async () => current,
        save: async (next) => {
          current = next;
        },
        clear: async () => {
          cleared = true;
          current = { ...current, accessToken: "", refreshToken: "" };
        },
        lock: (fn) => fn(),
        now: () => Date.now(),
        exchange: (seen) => requestRefresh(seen, fetchImpl, Date.now()),
      }),
    (error: unknown) => error instanceof UnusableRefresh
  );
  assert.equal(cleared, true);
  assert.equal(current.refreshToken, "");
});

test("the database refresh takes an advisory lock and stores the new ciphertext", async () => {
  const now = 1_800_000_000_000;
  const sql: string[] = [];
  const updates: unknown[][] = [];
  const query = async (text: string, params: readonly unknown[] = []) => {
    sql.push(text);
    if (text.includes("for update")) {
      return [
        {
          client_id: "oaiapp_test",
          host_id: "urn:uuid:00000000-0000-4000-8000-000000000001",
          issuer: ISSUER,
          subject: "user_1",
          email: "reader@example.com",
          access_token_enc: encryptSecret("old-access", KEY),
          refresh_token_enc: encryptSecret("old-refresh", KEY),
          id_token_enc: null,
          scopes: [PLAN_SCOPE],
          expires_at: new Date(now - 5_000),
          earliest_refresh_at: null,
          refreshed_at: null,
        },
      ];
    }
    if (text.startsWith("update")) updates.push([...params]);
    return [];
  };
  const token = await refreshLocked(query, "owner", {
    key: KEY,
    now: () => now,
    exchange: async (seen) => ({ ...seen, accessToken: "new-access", refreshToken: "rotated-refresh", expiresAt: now + 3_600_000, refreshedAt: now }),
  });
  assert.equal(token, "new-access");
  assert.match(REFRESH_LOCK_SQL, /pg_advisory_xact_lock/);
  assert.match(REFRESH_ROW_SQL, /for update/);
  assert.equal(sql[0], REFRESH_LOCK_SQL);
  assert.equal(sql.some((line) => line.includes("for update")), true);
  assert.equal(decryptSecret(String(updates[0]?.[2]), KEY), "rotated-refresh");
  assert.equal(String(updates[0]?.[2]).includes("rotated-refresh"), false);
});

test("the authorize URL is loopback PKCE registration with no client secret", () => {
  const { verifier, challenge } = pkcePair();
  assert.equal(challenge, createHash("sha256").update(verifier).digest("base64url"));
  assert.equal(challenge.includes("="), false);
  const url = new URL(
    authorizeUrl({
      redirectUri: loopbackRedirect(1455),
      state: "state-1",
      nonce: "nonce-1",
      challenge,
      hostId: "urn:uuid:00000000-0000-4000-8000-000000000002",
    })
  );
  assert.equal(url.origin + url.pathname, AUTHORIZE_URL);
  assert.equal(url.searchParams.get("client_id"), DYNAMIC_CLIENT);
  assert.equal(url.searchParams.get("agent_name_hint"), "Inkling");
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:1455/auth/callback");
  assert.equal(url.searchParams.get("redirect_uri")?.includes("localhost"), false);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge"), challenge);
  assert.equal(url.searchParams.get("resource"), RESOURCE);
  assert.equal(url.searchParams.get("scope")?.includes(PLAN_SCOPE), true);
  assert.equal(url.searchParams.get("client_secret"), null);
  assert.throws(() => authorizeUrl({ redirectUri: "http://localhost:1455/auth/callback", state: "s", nonce: "n", challenge, hostId: "urn:uuid:x" }), /127\.0\.0\.1/);
});

test("a returning sign-in reuses the issued client and omits the name hint", () => {
  const url = new URL(
    authorizeUrl({
      redirectUri: "http://127.0.0.1:1455/auth/callback",
      state: "s",
      nonce: "n",
      challenge: "c",
      hostId: "urn:uuid:00000000-0000-4000-8000-000000000002",
      clientId: "oaiapp_saved",
      idTokenHint: "hint",
      loginHint: "reader@example.com",
    })
  );
  assert.equal(url.searchParams.get("client_id"), "oaiapp_saved");
  assert.equal(url.searchParams.get("agent_name_hint"), null);
  assert.equal(url.searchParams.get("id_token_hint"), "hint");
  const form = codeExchangeForm({ clientId: "oaiapp_saved", code: "code", verifier: "verifier", redirectUri: "http://127.0.0.1:1455/auth/callback" });
  assert.equal(form.get("client_secret"), null);
  assert.equal(form.get("client_id"), "oaiapp_saved");
  assert.throws(() => codeExchangeForm({ clientId: DYNAMIC_CLIENT, code: "c", verifier: "v", redirectUri: "http://127.0.0.1:1/auth/callback" }), ChatgptAuthError);
});

test("an ID token is checked for signature, issuer, audience, expiry, and nonce", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as SigningKey;
  jwk.kid = "test-key";
  jwk.alg = "RS256";
  const now = 1_700_000_000;
  const mint = (claims: Record<string, unknown>, kid = "test-key") => {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const data = `${header}.${body}`;
    const signature = sign("RSA-SHA256", Buffer.from(data), privateKey).toString("base64url");
    return `${data}.${signature}`;
  };
  const claims = { iss: ISSUER, aud: "oaiapp_test", exp: now + 600, nonce: "nonce-1", sub: "user_1", email: "reader@example.com" };
  const good = validateIdToken(mint(claims), { jwks: { keys: [jwk] }, issuer: ISSUER, audience: "oaiapp_test", nonce: "nonce-1", now: now * 1000 });
  assert.equal(good.sub, "user_1");
  assert.equal(good.email, "reader@example.com");
  assert.throws(() => validateIdToken(mint(claims), { jwks: { keys: [jwk] }, issuer: ISSUER, audience: "oaiapp_test", nonce: "other", now: now * 1000 }), /did not match/);
  assert.throws(() => validateIdToken(mint(claims), { jwks: { keys: [jwk] }, issuer: ISSUER, audience: "oaiapp_other", nonce: "nonce-1", now: now * 1000 }), /different app/);
  assert.throws(() => validateIdToken(mint({ ...claims, exp: now - 120 }), { jwks: { keys: [jwk] }, issuer: ISSUER, audience: "oaiapp_test", nonce: "nonce-1", now: now * 1000 }), /expired/);
  assert.throws(() => validateIdToken(mint(claims, "other-kid"), { jwks: { keys: [jwk] }, issuer: ISSUER, audience: "oaiapp_test", nonce: "nonce-1", now: now * 1000 }), /signature/);
});

test("status shows the link and the expiry and not the token", () => {
  const now = Date.parse("2026-10-15T20:00:00.000Z");
  const current = session({ accessToken: "secret-access", refreshToken: "secret-refresh", expiresAt: now });
  const pub = toPublicStatus(current);
  assert.equal(pub.linked, true);
  assert.equal(pub.email, "reader@example.com");
  assert.equal(pub.expiresAt, "2026-10-15T20:00:00.000Z");
  assert.equal(pub.planUsage, true);
  assert.equal("accessToken" in pub, false);
  assert.equal("refreshToken" in pub, false);
  assert.equal(JSON.stringify(pub).includes("secret-access"), false);
  assert.deepEqual(toPublicStatus(null), { linked: false, email: null, expiresAt: null, planUsage: false });
});

test("import keeps the machine host id and refuses the registration entrypoint", () => {
  const imported = sessionFromCredential(
    {
      email: "reader@example.com",
      issuer: ISSUER,
      subject: "user_1",
      client_id: "oaiapp_test",
      ext_agent_host_id: "urn:uuid:99999999-9999-4999-8999-999999999999",
      access_token: "access",
      refresh_token: "refresh",
      scopes: [PLAN_SCOPE],
      expires_in: 3600,
      saved_at: "2026-10-15T20:00:00.000Z",
    },
    "urn:uuid:00000000-0000-4000-8000-00000000000a",
    Date.parse("2026-10-15T20:00:00.000Z")
  );
  assert.equal(imported.hostId, "urn:uuid:00000000-0000-4000-8000-00000000000a");
  assert.equal(imported.hostId.includes("99999999"), false);
  assert.throws(() => sessionFromCredential({ client_id: DYNAMIC_CLIENT, access_token: "a", refresh_token: "r", subject: "s", scopes: [PLAN_SCOPE] }, imported.hostId, Date.now()), /issued client id/);
});

test("a Responses request is streamed, stored off, and drops plan-rejected fields", () => {
  const built = buildResponsesRequest({
    model: "gpt-6.1-sol",
    temperature: 0.2,
    maxTokens: 16000,
    thinking: true,
    json: true,
    toolChoice: "none",
    tools: [WEB_TOOL],
    messages: [
      { role: "system", content: "Be brief" },
      { role: "user", content: "Hello" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", function: { name: "web_search", arguments: "{\"query\":\"Ada\"}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "a result" },
    ],
  });
  assert.equal(built.url, RESPONSES_URL);
  assert.equal(built.body.store, false);
  assert.equal(built.body.stream, true);
  assert.equal(built.body.instructions, "Be brief");
  assert.equal(built.body.temperature, undefined);
  assert.equal(built.body.max_tokens, undefined);
  assert.equal(built.body.max_output_tokens, undefined);
  for (const field of FORBIDDEN_FIELDS) assert.equal(field in built.body, false);
  const input = built.body.input as { role?: string; type?: string; namespace?: string; call_id?: string }[];
  assert.equal(input.some((item) => item.role === "system"), false);
  assert.equal(input.some((item) => item.type === "function_call" && item.namespace === TOOL_NAMESPACE && item.call_id === "call_1"), true);
  assert.equal(input.some((item) => item.type === "function_call_output" && item.call_id === "call_1"), true);
  const tools = built.body.tools as { type: string; name: string; tools: { type: string; name: string }[] }[];
  assert.equal(tools[0]?.type, "namespace");
  assert.equal(tools[0]?.name, "gloss");
  assert.equal(tools[0]?.tools[0]?.name, "web_search");
  assert.deepEqual(built.body.reasoning, { effort: "medium" });
  assert.deepEqual(built.body.text, { format: { type: "json_object" } });
  assert.equal(built.body.tool_choice, "none");
});

test("image input is an input_image and the system text stays in instructions", () => {
  const built = buildResponsesRequest({
    model: "gpt-6.1-sol",
    messages: [
      { role: "system", content: "Transcribe" },
      { role: "user", content: [{ type: "image_url", image_url: "data:image/jpeg;base64,abc" }, { type: "text", text: "Read the page" }] },
    ],
  });
  assert.equal(built.body.instructions, "Transcribe");
  const input = built.body.input as { content: { type: string; image_url?: string; text?: string }[] }[];
  assert.deepEqual(input[0]?.content, [
    { type: "input_image", image_url: "data:image/jpeg;base64,abc" },
    { type: "input_text", text: "Read the page" },
  ]);
});

test("a stream yields text, then a usage limit that arrives after the text", () => {
  const events = play(
    [
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"Hel"}',
      "",
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","delta":"lo"}',
      "",
      "event: response.failed",
      'data: {"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_limit_exceeded","message":"limit Bearer secret-token"}}}',
      "",
    ].join("\n")
  );
  assert.equal(textFromEvents(events), "Hello");
  const error = events.find((event) => event.type === "error");
  assert.equal(error && error.type === "error" ? error.text : "", USAGE_LIMIT_MESSAGE);
  assert.equal(JSON.stringify(events).includes("secret-token"), false);
  assert.equal(events.some((event) => event.type === "done"), false);
});

test("a stream assembles a tool call and a JSON object", () => {
  const tool = play(
    [
      "event: response.output_item.added",
      'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"web_search","namespace":"gloss","arguments":""}}',
      "",
      "event: response.function_call_arguments.delta",
      'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\\"query\\":"}',
      "",
      "event: response.function_call_arguments.delta",
      'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"\\"Ada\\"}"}',
      "",
      "event: response.output_item.done",
      'data: {"type":"response.output_item.done","item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"web_search","namespace":"gloss","arguments":"{\\"query\\":\\"Ada\\"}"}}',
      "",
      "event: response.completed",
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":8,"output_tokens":3,"input_tokens_details":{"cached_tokens":1}}}}',
      "",
    ].join("\n")
  );
  const call = tool.find((event) => event.type === "tool");
  assert.deepEqual(call, { type: "tool", id: "call_1", name: "web_search", args: '{"query":"Ada"}' });
  const usage = tool.find((event) => event.type === "usage");
  assert.equal(usage && usage.type === "usage" ? usage.usage.promptTokens : 0, 8);
  assert.equal(usage && usage.type === "usage" ? usage.usage.cachedTokens : 0, 1);

  const json = play(
    [
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","delta":"{\\"topic\\":"}',
      "",
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","delta":"\\"books\\"}"}',
      "",
      "event: response.completed",
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":4,"output_tokens":2,"input_tokens_details":{"cached_tokens":0}}}}',
      "",
    ].join("\n")
  );
  assert.deepEqual(jsonFromText(textFromEvents(json)), { topic: "books" });
});

test("an SSE frame split across chunks still parses", () => {
  const buffer = new SseBuffer();
  const stream = new ResponsesStream();
  const first = buffer.push('event: response.output_text.delta\ndata: {"type":"response.output_text.del');
  assert.equal(first.length, 0);
  const second = buffer.push('ta","delta":"Hi"}\n\n');
  const events = second.flatMap((message) => stream.push(message));
  assert.equal(events[0] && events[0].type === "content" ? events[0].text : "", "Hi");
});

test("a 429 body does not leak a token into the message", () => {
  const message = responsesHttpError(429, JSON.stringify({ error: { code: "subscription_sharing_usage_limit_exceeded", message: "Bearer sess-secret" } }));
  assert.equal(message, USAGE_LIMIT_MESSAGE);
  assert.equal(message.includes("sess-secret"), false);
  const jwt = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.eyJhbGciOiJub25lIn0";
  const other = responsesHttpError(500, JSON.stringify({ error: { message: `bad ${jwt}` } }));
  assert.equal(other.includes(jwt), false);
});

test("streamChatgpt posts the subscription token to the Responses API", async () => {
  const original = globalThis.fetch;
  let auth = "";
  let body: Record<string, unknown> = {};
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    assert.equal(String(url), RESPONSES_URL);
    auth = new Headers(init?.headers).get("authorization") ?? "";
    body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const sse = ['event: response.output_text.delta', 'data: {"type":"response.output_text.delta","delta":"Hi"}', "", "event: response.completed", 'data: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":1,"input_tokens_details":{"cached_tokens":0}}}}', ""].join("\n");
    return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }) as typeof fetch;
  try {
    const events = [];
    for await (const event of streamChatgpt({
      accessToken: "access-token-value",
      model: "flash",
      env: { LLM_PROVIDER: "chatgpt", LLM_MODEL: "gpt-test" },
      messages: [
        { role: "system", content: "Be brief" },
        { role: "user", content: "Hi" },
      ],
    })) events.push(event);
    assert.equal(auth, "Bearer access-token-value");
    assert.equal(body.model, "gpt-test");
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    assert.equal(body.instructions, "Be brief");
    assert.equal(JSON.stringify(body).includes("access-token-value"), false);
    assert.equal(events.some((event) => event.type === "content" && event.text === "Hi"), true);
    assert.equal(events.some((event) => event.type === "done"), true);
  } finally {
    globalThis.fetch = original;
  }
});

test("ChatGPT needs no Together key, and covers stay off", () => {
  assert.equal(hasLlmConfig({ LLM_PROVIDER: "chatgpt" }), true);
  assert.equal(hasLlmConfig({}), false);
  const vision = visionSettings({ LLM_PROVIDER: "chatgpt", FEATURE_VISION: "1" });
  assert.equal(vision.enabled, true);
  if (vision.enabled) {
    assert.equal(vision.provider, "ChatGPT");
    assert.equal(vision.apiKey, "");
    assert.equal(vision.model, CHATGPT_DEFAULT_MODEL);
  }
  const covers = coverSettings({ LLM_PROVIDER: "chatgpt" });
  assert.equal(covers.enabled, false);
  if (!covers.enabled) assert.match(covers.reason, /FEATURE_COVERS=0/);
  assert.equal(applyTokenResponse(session({ scopes: [] }), { access_token: "a", refresh_token: "r", expires_in: 10 }, 0).refreshToken, "r");
  assert.equal(planGranted([PLAN_SCOPE]), true);
});
