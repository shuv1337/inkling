import assert from "node:assert/strict";
import test from "node:test";
import { backoffDelay, HttpStatusError, isRetryableError, withRetry, withTimeout } from "../lib/retry";

const noSleep = async () => {};

test("isRetryableError: timeouts, network errors and transient statuses only", () => {
  assert.equal(isRetryableError(new DOMException("t", "TimeoutError")), true);
  assert.equal(isRetryableError(new TypeError("fetch failed")), true);
  for (const s of [408, 425, 500, 502, 503, 504]) assert.equal(isRetryableError(new HttpStatusError(s)), true, String(s));
  for (const s of [400, 401, 403, 404, 422, 429, 501]) assert.equal(isRetryableError(new HttpStatusError(s)), false, String(s));
  assert.equal(isRetryableError(new DOMException("a", "AbortError")), false);
  assert.equal(isRetryableError(new Error("boom")), false);
});

test("backoffDelay grows, caps and jitters within the ceiling", () => {
  assert.equal(backoffDelay(0, 100, 1000, () => 0.999), 99);
  assert.equal(backoffDelay(3, 100, 1000, () => 0.999), 799);
  assert.equal(backoffDelay(10, 100, 1000, () => 0.999), 999);
  assert.equal(backoffDelay(5, 100, 1000, () => 0), 0);
});

test("withRetry retries retryable errors up to the bound, then rethrows", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls++;
      throw new HttpStatusError(503);
    }, { attempts: 3, sleep: noSleep }),
    (e: unknown) => e instanceof HttpStatusError && e.status === 503,
  );
  assert.equal(calls, 3);
});

test("withRetry recovers after a transient failure and skips non-retryable ones", async () => {
  let calls = 0;
  const value = await withRetry(async () => {
    calls++;
    if (calls === 1) throw new TypeError("fetch failed");
    return "ok";
  }, { sleep: noSleep });
  assert.equal(value, "ok");
  assert.equal(calls, 2);

  let hard = 0;
  await assert.rejects(withRetry(async () => {
    hard++;
    throw new HttpStatusError(400);
  }, { attempts: 5, sleep: noSleep }));
  assert.equal(hard, 1);
});

test("withTimeout aborts a hung attempt at its deadline", async () => {
  const hang = (signal: AbortSignal) =>
    new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  // AbortSignal.timeout's timer is unref'd in Node; hold the event loop open while it runs.
  const keepAlive = setTimeout(() => {}, 5_000);
  try {
    await assert.rejects(withTimeout(hang, 20), (e: unknown) => e instanceof Error && e.name === "TimeoutError");
  } finally {
    clearTimeout(keepAlive);
  }
});

test("withRetry stops once the caller aborts", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls++;
      controller.abort(new Error("caller gave up"));
      throw new TypeError("fetch failed");
    }, { attempts: 5, signal: controller.signal, sleep: noSleep }),
    /caller gave up/,
  );
  assert.equal(calls, 1);
});
