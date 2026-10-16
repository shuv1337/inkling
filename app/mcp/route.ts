import { handle, notAllowed, options } from "@/lib/mcp";

export const runtime = "nodejs";
export const maxDuration = 120;

/** The Inkling MCP server. The token comes in the Authorization header. */
export const POST = (req: Request) => handle(req);
export const GET = notAllowed;
export const DELETE = notAllowed;
export const OPTIONS = options;
