import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { isAgentRoute, tailscaleAllowed } from "@/lib/auth";

// Single-user mode does not load Clerk. Set AUTH_MODE=clerk to keep accounts.
export default async function proxy(req: NextRequest, event: NextFetchEvent) {
  if (process.env.AUTH_MODE === "clerk") {
    const { clerkMiddleware } = await import("@clerk/nextjs/server");
    return clerkMiddleware()(req, event);
  }
  // Tagged agent hosts have no user-login header. The MCP handler validates the
  // token and scopes; this exception never includes account-management APIs.
  if (!isAgentRoute(req.nextUrl.pathname) && !tailscaleAllowed(req.headers.get("tailscale-user-login"))) {
    return new NextResponse("This Inkling is only for its owner.", { status: 403 });
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    // Skip Next internals and static files, unless found in search params.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|mjs|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
