/**
 * ChatGPT plan usage speaks only to POST /v1/responses, with store false and
 * stream true. Temperature, max_output_tokens, and role:system are refused by
 * that route. Function tools go in a namespace. Text comes back as
 * response.output_text.delta, a tool call as function_call events, and a
 * usage limit can arrive as response.failed after text has already streamed.
 *
 * https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
 * https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
 */

import { APP_UA } from "./llm";
import type { StreamEvent, Usage } from "./models";

export const RESPONSES_URL = "https://api.openai.com/v1/responses";
export const TOOL_NAMESPACE = "gloss";

/** Fields the ChatGPT plan route rejects. They are never copied onto a request. */
export const FORBIDDEN_FIELDS = [
  "temperature",
  "max_output_tokens",
  "max_tokens",
  "top_p",
  "top_logprobs",
  "previous_response_id",
  "metadata",
  "user",
  "truncation",
  "background",
  "conversation",
  "max_tool_calls",
  "moderation",
  "multi_agent",
  "prompt",
  "prompt_cache_retention",
  "safety_identifier",
] as const;

export const USAGE_LIMIT_MESSAGE =
  "ChatGPT's usage limit for Inkling was reached. This can happen in the middle of an answer. Open ChatGPT, then Settings, then Usage, and check this app's weekly limit. The plan can still have room when the app cap is used up.";

const USAGE_UNAVAILABLE_MESSAGE = "ChatGPT could not check usage just now. Wait a moment and try again.";

export type ResponsePart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } | string };

export type ResponseTurn =
  | { role: "system" | "user"; content: string | ResponsePart[] }
  | { role: "assistant"; content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }
  | { role: "tool"; content: string; tool_call_id: string };

export type ResponsesRequest = {
  model: string;
  messages: readonly ResponseTurn[];
  tools?: readonly unknown[];
  toolChoice?: "auto" | "none";
  json?: boolean;
  thinking?: boolean;
  /** Accepted and ignored. The plan route rejects both. */
  temperature?: number;
  maxTokens?: number;
};

type FunctionTool = { type: "function"; name: string; description?: string; parameters?: unknown };

function asFunctionTool(tool: unknown): FunctionTool | null {
  if (!tool || typeof tool !== "object") return null;
  const record = tool as { type?: string; name?: string; description?: string; parameters?: unknown; function?: { name?: string; description?: string; parameters?: unknown } };
  if (record.type === "function" && record.function && typeof record.function.name === "string") {
    return { type: "function", name: record.function.name, description: record.function.description, parameters: record.function.parameters };
  }
  if (record.type === "function" && typeof record.name === "string") {
    return { type: "function", name: record.name, description: record.description, parameters: record.parameters };
  }
  return null;
}

function contentParts(content: string | ResponsePart[]): string | { type: string; text?: string; image_url?: string }[] {
  if (typeof content === "string") return content;
  return content.map((part) => {
    if (part.type === "text") return { type: "input_text", text: part.text };
    const url = typeof part.image_url === "string" ? part.image_url : part.image_url.url;
    return { type: "input_image", image_url: url };
  });
}

export function buildResponsesRequest(req: ResponsesRequest): { url: string; body: Record<string, unknown> } {
  const instructions: string[] = [];
  const input: Record<string, unknown>[] = [];
  for (const message of req.messages) {
    if (message.role === "system") {
      instructions.push(typeof message.content === "string" ? message.content : "");
      continue;
    }
    if (message.role === "tool") {
      input.push({ type: "function_call_output", call_id: message.tool_call_id, output: message.content });
      continue;
    }
    if (message.role === "assistant" && message.tool_calls?.length) {
      if (message.content) input.push({ role: "assistant", content: message.content });
      for (const call of message.tool_calls) {
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.function.name,
          namespace: TOOL_NAMESPACE,
          arguments: call.function.arguments,
        });
      }
      continue;
    }
    input.push({ role: message.role, content: contentParts(message.content ?? "") });
  }

  // JSON mode checks input messages, not the separate instructions field.
  // Shelving keeps its schema in system instructions, so explicitly request
  // JSON in the input as well. Preserve the original text and image parts.
  if (req.json) input.unshift({ role: "user", content: "Return a JSON object in the format requested by the instructions." });

  const body: Record<string, unknown> = {
    model: req.model,
    input,
    store: false,
    stream: true,
  };
  const guidance = instructions.filter(Boolean).join("\n\n");
  if (guidance) body.instructions = guidance;
  if (req.thinking) body.reasoning = { effort: "medium" };
  if (req.json) body.text = { format: { type: "json_object" } };

  const functions = (req.tools ?? []).map(asFunctionTool).filter((tool): tool is FunctionTool => tool !== null);
  if (functions.length) {
    body.tools = [
      {
        type: "namespace",
        name: TOOL_NAMESPACE,
        description: "Look outside the text the reader is studying.",
        tools: functions,
      },
    ];
    if (req.toolChoice === "none") body.tool_choice = "none";
  }

  for (const field of FORBIDDEN_FIELDS) {
    if (field in body) throw new Error(`Refusing to send ${field} on the ChatGPT plan.`);
  }
  return { url: RESPONSES_URL, body };
}

export function responsesHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "User-Agent": APP_UA,
  };
}

export function subscriptionMessage(code: string | undefined, param?: string): string | null {
  switch (code) {
    case "subscription_sharing_usage_limit_exceeded":
      return USAGE_LIMIT_MESSAGE;
    case "subscription_sharing_usage_unavailable":
    case "subscription_sharing_user_unavailable":
      return USAGE_UNAVAILABLE_MESSAGE;
    case "subscription_sharing_user_not_eligible":
      return "This ChatGPT account cannot use its plan here.";
    case "subscription_sharing_unsupported_capability":
      return param ? `ChatGPT refused this request (${param}).` : "ChatGPT refused part of this request.";
    case "subscription_sharing_invalid_user":
      return "ChatGPT did not accept this sign-in. Run npm run chatgpt:login again.";
    case "subscription_sharing_route_not_supported":
      return "ChatGPT refused the request path.";
    default:
      return null;
  }
}

function safeDetail(value: string | undefined): string {
  if (!value) return "";
  const cleaned = value
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return cleaned;
}

type ParsedError = { code?: string; message?: string; param?: string };

function parsedError(raw: string): ParsedError {
  try {
    const body = JSON.parse(raw) as { error?: { code?: string; message?: string; param?: string } | string; detail?: string; message?: string; code?: string };
    if (typeof body.error === "string") return { message: body.error, code: body.code };
    if (body.error && typeof body.error === "object") return { code: body.error.code, message: body.error.message, param: body.error.param };
    if (typeof body.detail === "string") return { message: body.detail, code: body.code };
    if (typeof body.message === "string") return { message: body.message, code: body.code };
  } catch {
    /* not JSON */
  }
  return {};
}

export function responsesHttpError(status: number, raw: string): string {
  const parsed = parsedError(raw);
  const known = subscriptionMessage(parsed.code, parsed.param);
  if (known) return known;
  if (status === 429) return USAGE_LIMIT_MESSAGE;
  if (status === 401) return "ChatGPT did not accept this sign-in. Run npm run chatgpt:login again.";
  if (status === 403) return "ChatGPT refused this request. Check that plan usage was allowed for Inkling.";
  if (status === 503) return USAGE_UNAVAILABLE_MESSAGE;
  const detail = safeDetail(parsed.message);
  return detail ? `ChatGPT request failed (${status}). ${detail}` : `ChatGPT request failed (${status}).`;
}

export function chatgptErrorStatus(text: string): number {
  if (text === USAGE_LIMIT_MESSAGE) return 429;
  if (text === USAGE_UNAVAILABLE_MESSAGE) return 503;
  return 502;
}

export function jsonFromText<T>(raw: string): T {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("no json");
  return JSON.parse(raw.slice(start, end + 1)) as T;
}

export type SseMessage = { event: string; data: string };

function parseFrame(frame: string): SseMessage | null {
  let event = "";
  const data: string[] = [];
  for (const line of frame.split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(":")) continue;
    if (trimmed.startsWith("event:")) event = trimmed.slice(6).trim();
    else if (trimmed.startsWith("data:")) data.push(trimmed.slice(5).trim());
  }
  if (!data.length) return null;
  return { event, data: data.join("\n") };
}

/** Incremental SSE. A frame is complete at a blank line; flush() takes a tail with no trailing blank line. */
export class SseBuffer {
  private pending = "";

  push(chunk: string): SseMessage[] {
    this.pending += chunk;
    const parts = this.pending.split(/\n\n/);
    this.pending = parts.pop() ?? "";
    return parts.map(parseFrame).filter((message): message is SseMessage => message !== null);
  }

  flush(): SseMessage[] {
    if (!this.pending.trim()) {
      this.pending = "";
      return [];
    }
    const tail = this.pending;
    this.pending = "";
    const message = parseFrame(tail);
    return message ? [message] : [];
  }
}

type ToolCall = { itemId: string; callId: string; name: string; args: string };

type ResponsePayload = {
  type?: string;
  delta?: string;
  text?: string;
  item_id?: string;
  arguments?: string;
  code?: string;
  message?: string;
  param?: string;
  error?: { code?: string; message?: string; param?: string };
  item?: OutputItem;
  response?: { error?: { code?: string; message?: string; param?: string }; usage?: UsagePayload; output?: OutputItem[] };
};

type OutputItem = {
  type?: string;
  id?: string;
  call_id?: string;
  name?: string;
  namespace?: string;
  arguments?: string;
  content?: { type?: string; text?: string }[];
};

type UsagePayload = {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
};

function outputText(output: OutputItem[] | undefined): string {
  if (!output) return "";
  let text = "";
  for (const item of output) {
    if (item.type !== "message" || !item.content) continue;
    for (const part of item.content) if (part.type === "output_text" && part.text) text += part.text;
  }
  return text;
}

function usageOf(payload: UsagePayload | undefined): Usage | null {
  if (!payload || typeof payload.output_tokens !== "number") return null;
  return {
    promptTokens: payload.input_tokens ?? 0,
    cachedTokens: payload.input_tokens_details?.cached_tokens ?? 0,
    completionTokens: payload.output_tokens,
    costUsd: 0,
  };
}

function errorCode(payload: ResponsePayload): { code?: string; param?: string } {
  return {
    code: payload.response?.error?.code ?? payload.error?.code ?? payload.code,
    param: payload.response?.error?.param ?? payload.error?.param ?? payload.param,
  };
}

/**
 * Turns Responses SSE events into the stream Inkling already uses.
 * A tool call is held until response.completed so its arguments are whole.
 * response.failed, including a usage limit after text has started, is an error
 * and not a finished answer.
 */
export class ResponsesStream {
  private calls = new Map<string, ToolCall>();
  private sawText = false;
  private completed = false;
  private failed = false;
  private usage: Usage | null = null;

  push(message: SseMessage): StreamEvent[] {
    let payload: ResponsePayload;
    try {
      payload = JSON.parse(message.data) as ResponsePayload;
    } catch {
      return [];
    }
    const type = payload.type || message.event;
    switch (type) {
      case "response.output_text.delta":
        if (!payload.delta) return [];
        this.sawText = true;
        return [{ type: "content", text: payload.delta }];
      case "response.output_text.done":
        if (this.sawText || !payload.text) return [];
        this.sawText = true;
        return [{ type: "content", text: payload.text }];
      case "response.output_item.added":
      case "response.output_item.done":
        this.rememberCall(payload.item);
        return [];
      case "response.function_call_arguments.delta":
        this.appendArgs(payload.item_id, payload.delta);
        return [];
      case "response.function_call_arguments.done":
        this.appendArgs(payload.item_id, undefined, payload.arguments);
        return [];
      case "response.completed": {
        this.completed = true;
        for (const item of payload.response?.output ?? []) this.rememberCall(item);
        this.usage = usageOf(payload.response?.usage);
        if (this.sawText) return [];
        const text = outputText(payload.response?.output);
        if (!text) return [];
        this.sawText = true;
        return [{ type: "content", text }];
      }
      case "response.failed":
      case "error": {
        this.failed = true;
        const { code, param } = errorCode(payload);
        return [{ type: "error", text: subscriptionMessage(code, param) ?? "ChatGPT stopped this answer." }];
      }
      case "response.incomplete":
        this.failed = true;
        return [{ type: "error", text: "ChatGPT stopped before the answer finished." }];
      default:
        return [];
    }
  }

  finish(): StreamEvent[] {
    if (this.failed) return [];
    if (!this.completed) return [{ type: "error", text: "ChatGPT stopped before the answer finished." }];
    const events: StreamEvent[] = [];
    if (this.usage) events.push({ type: "usage", usage: this.usage });
    const call = [...this.calls.values()].find((item) => item.name);
    if (call) events.push({ type: "tool", id: call.callId || call.itemId, name: call.name, args: call.args });
    events.push({ type: "done" });
    return events;
  }

  private rememberCall(item: OutputItem | undefined) {
    if (!item || item.type !== "function_call") return;
    const itemId = item.id || item.call_id || "call_0";
    const current = this.calls.get(itemId) ?? { itemId, callId: item.call_id || itemId, name: "", args: "" };
    if (item.call_id) current.callId = item.call_id;
    if (item.name) current.name = item.name;
    if (item.arguments) current.args = item.arguments;
    this.calls.set(itemId, current);
  }

  private appendArgs(itemId: string | undefined, delta: string | undefined, full?: string) {
    const key = itemId && this.calls.has(itemId) ? itemId : [...this.calls.keys()].at(-1);
    if (!key) {
      if (!itemId) return;
      this.calls.set(itemId, { itemId, callId: itemId, name: "", args: full ?? delta ?? "" });
      return;
    }
    const call = this.calls.get(key);
    if (!call) return;
    if (full != null) call.args = full;
    else if (delta) call.args += delta;
  }
}

/** Text collected from a finished stream, for JSON answers. Content events only. */
export function textFromEvents(events: readonly StreamEvent[]): string {
  return events.filter((event): event is Extract<StreamEvent, { type: "content" }> => event.type === "content").map((event) => event.text).join("");
}
