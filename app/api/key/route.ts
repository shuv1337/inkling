import { APP_UA, hasLlmConfig, modelsUrl, skipKeyCheck } from "@/lib/llm";
import { peekFree } from "@/lib/quota";

export const runtime = "nodejs";

/** Validates a pasted key with a zero-cost model listing. The key is never stored or logged. */
export async function POST(req: Request) {
  let body: { apiKey?: string } = {};
  try {
    body = await req.json();
  } catch {}
  const key = body.apiKey?.trim();
  if (!key) return Response.json({ ok: false });
  if (skipKeyCheck()) return Response.json({ ok: true });
  try {
    const res = await fetch(modelsUrl(), {
      headers: { Authorization: `Bearer ${key}`, "User-Agent": APP_UA },
      signal: AbortSignal.timeout(10_000),
    });
    // A provider with no model listing (some local servers) does not mean the key is bad.
    return Response.json({ ok: res.ok || res.status === 404 });
  } catch {
    return Response.json({ ok: false });
  }
}

/** Whether there is a shared key, and how much of today's free allowance is left on it. */
export async function GET(req: Request) {
  const house = hasLlmConfig();
  return Response.json({ house, free: house ? await peekFree(req) : null });
}
