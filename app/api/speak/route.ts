import { requestSpeech, ttsPublic } from "@/lib/tts";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Which voice is available, for the picker. No secrets. */
export async function GET() {
  return Response.json(ttsPublic());
}

/**
 * One passage, spoken. The audio streams straight through as MP3, so playback
 * can begin before the whole clip exists. The browser splits long texts first.
 */
export async function POST(req: Request) {
  let body: { text?: string; apiKey?: string; voice?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const headerKey = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "").trim();
  const result = await requestSpeech(
    { text: body.text ?? "", apiKey: body.apiKey?.trim() || headerKey || undefined, voice: body.voice },
    { signal: req.signal }
  );
  if (!result.ok) return Response.json({ error: result.error, ...(result.code ? { code: result.code } : {}) }, { status: result.status });
  return new Response(result.response.body, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" } });
}
