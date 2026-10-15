import { getUserId } from "@/lib/auth";
import { chatgptStatus } from "@/lib/openai-auth";
import { isChatgptProvider } from "@/lib/llm";

export const runtime = "nodejs";

/**
 * Whether ChatGPT is linked, and when the access token expires.
 * The access token, refresh token, and client id are not included.
 */
export async function GET() {
  if (!isChatgptProvider()) {
    return Response.json({ provider: "compat", linked: false, email: null, expiresAt: null, planUsage: false });
  }
  const userId = await getUserId();
  if (!userId) return Response.json({ provider: "chatgpt", linked: false, email: null, expiresAt: null, planUsage: false }, { status: 401 });
  const status = await chatgptStatus(userId);
  return Response.json({ provider: "chatgpt", ...status });
}
