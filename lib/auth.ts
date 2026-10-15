/**
 * Who is reading. AUTH_MODE=single (the default) is one person, meant to be
 * reached only through Tailscale. AUTH_MODE=clerk keeps Clerk.
 * Clerk is loaded only in that mode, so a server without Clerk keys still boots.
 */

export type AuthMode = "single" | "clerk";

export function authMode(): AuthMode {
  return process.env.AUTH_MODE === "clerk" ? "clerk" : "single";
}

export function singleUserId(): string {
  const id = process.env.SINGLE_USER_ID?.trim();
  return id || "owner";
}

export async function getUserId(): Promise<string | null> {
  if (authMode() === "single") return singleUserId();
  try {
    const { auth } = await import("@clerk/nextjs/server");
    return (await auth()).userId;
  } catch {
    return null;
  }
}

/**
 * Tailscale logins listed in ALLOWED_TS_USERS may pass.
 * Unset or empty lets anyone who can reach the server through, including everyone on the tailnet.
 */
export function tailscaleAllowed(login: string | null): boolean {
  const allow = (process.env.ALLOWED_TS_USERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!allow.length) return true;
  return Boolean(login && allow.includes(login));
}
