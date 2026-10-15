import assert from "node:assert/strict";
import test from "node:test";
import { normalizeScopes } from "../lib/agent";
import { authMode, getUserId, singleUserId, tailscaleAllowed } from "../lib/auth";

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
