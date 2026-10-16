import assert from "node:assert/strict";
import test from "node:test";
import { normalizeScopes } from "../lib/agent";
import { authMode, getUserId, singleUserId, tailscaleAllowed } from "../lib/auth";
import { NextRequest, type NextFetchEvent } from "next/server";
import proxy from "../proxy";

test("single-user mode is the default and does not need Clerk", async () => {
  const prev = process.env.AUTH_MODE;
  const prevId = process.env.SINGLE_USER_ID;
  delete process.env.AUTH_MODE;
  process.env.SINGLE_USER_ID = "kyle";
  try {
    assert.equal(authMode(), "single");
    assert.equal(singleUserId(), "kyle");
    assert.equal(await getUserId(), "kyle");
  } finally {
    if (prev === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = prev;
    if (prevId === undefined) delete process.env.SINGLE_USER_ID;
    else process.env.SINGLE_USER_ID = prevId;
  }
});

test("tailscale allow list", () => {
  const prev = process.env.ALLOWED_TS_USERS;
  delete process.env.ALLOWED_TS_USERS;
  assert.equal(tailscaleAllowed(null), true);
  process.env.ALLOWED_TS_USERS = "kyle, ada";
  assert.equal(tailscaleAllowed("kyle"), true);
  assert.equal(tailscaleAllowed("ada"), true);
  assert.equal(tailscaleAllowed("someone"), false);
  assert.equal(tailscaleAllowed(null), false);
  if (prev === undefined) delete process.env.ALLOWED_TS_USERS;
  else process.env.ALLOWED_TS_USERS = prev;
});

test("token scopes", () => {
  assert.deepEqual(normalizeScopes(undefined), ["read", "write"]);
  assert.deepEqual(normalizeScopes("read"), ["read"]);
  assert.deepEqual(normalizeScopes("write,read,write"), ["write", "read"]);
  assert.deepEqual(normalizeScopes(["nope", "read"]), ["read"]);
});

test("production requires an owner allowlist; only MCP delegates to token authentication", async () => {
  const before = { ...process.env };
  try {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    process.env.AUTH_MODE = "single";
    delete process.env.ALLOWED_TS_USERS;
    assert.equal(tailscaleAllowed(null), false);
    assert.equal(tailscaleAllowed("owner@example.invalid"), false);
    process.env.ALLOWED_TS_USERS = "owner@example.invalid";
    const check = async (path: string, login?: string, token?: string) => {
      const headers = new Headers();
      if (login) headers.set("Tailscale-User-Login", login);
      if (token) headers.set("Authorization", `Bearer ${token}`);
      const response = await proxy(new NextRequest(`http://localhost${path}`, { headers }), {} as NextFetchEvent);
      assert.ok(response);
      return response;
    };
    for (const path of ["/", "/api/sync", "/api/agent-tokens", "/api/chatgpt", "/mcpevil", "/mcp/token/extra"]) {
      assert.equal((await check(path)).status, 403, path);
      assert.equal((await check(path, "other@example.invalid", "gls_fake_agent_token_12345")).status, 403, path);
      assert.equal((await check(path, "owner@example.invalid")).status, 200, path);
    }
    for (const path of ["/mcp", "/mcp/", "/mcp/gls_example_token_12345"]) {
      assert.equal((await check(path)).headers.get("x-middleware-next"), "1", path);
    }
  } finally {
    for (const key of ["NODE_ENV", "AUTH_MODE", "ALLOWED_TS_USERS"]) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
});
