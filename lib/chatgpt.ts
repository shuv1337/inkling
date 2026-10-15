/**
 * Ask, brief, shelve, and scanned-page reading on a ChatGPT plan.
 * The access token is the subscription token from Sign in with ChatGPT.
 * Nothing here sends temperature, a system role, or an image-generation call.
 */

import { getUserId } from "./auth";
import { getAccessToken } from "./openai-auth";
import { publicAuthError } from "./openai-oauth";
import { costOf, resolveModel, type ModelEntry, type StreamEvent, type Usage } from "./models";
import {
  buildResponsesRequest,
  chatgptErrorStatus,
  jsonFromText,
  RESPONSES_URL,
  responsesHeaders,
  responsesHttpError,
  ResponsesStream,
  SseBuffer,
  type ResponseTurn,
} from "./responses";

type Env = Record<string, string | undefined>;

export type ChatgptCall = {
  messages: readonly ResponseTurn[];
  model: unknown;
  /** Wire id, when it is not a catalog key. Vision sets this from VISION_MODEL. */
  modelId?: string;
  signal?: AbortSignal;
  tools?: readonly unknown[];
  toolChoice?: "auto" | "none";
  thinking?: boolean;
  json?: boolean;
  /** Tests pass a token and skip Postgres. */
  accessToken?: string;
  env?: Env;
  fetchImpl?: typeof fetch;
};

function priced(entry: ModelEntry, usage: Usage): Usage {
  return { ...usage, costUsd: costOf(entry, usage.promptTokens, usage.cachedTokens, usage.completionTokens) };
}

function mapUsage(entry: ModelEntry, events: StreamEvent[]): StreamEvent[] {
  return events.map((event) => (event.type === "usage" ? { type: "usage", usage: priced(entry, event.usage) } : event));
}

async function tokenFor(req: ChatgptCall): Promise<string> {
  if (req.accessToken) return req.accessToken;
  const userId = await getUserId();
  if (!userId) throw new Error("ChatGPT is not linked. Run npm run chatgpt:login.");
  return getAccessToken(userId);
}

export async function* streamChatgpt(req: ChatgptCall): AsyncGenerator<StreamEvent> {
  const env = req.env ?? process.env;
  const resolved = resolveModel(req.model, env);
  const id = req.modelId?.trim() || resolved.entry.id;
  const entry: ModelEntry = { ...resolved.entry, id, label: req.modelId?.trim() || resolved.entry.label };
  yield { type: "meta", model: entry.label };

  let accessToken: string;
  try {
    accessToken = await tokenFor(req);
  } catch (error) {
    const message = error instanceof Error && error.message.startsWith("ChatGPT is not linked") ? error.message : publicAuthError(error);
    yield { type: "error", text: message };
    return;
  }

  const built = buildResponsesRequest({
    model: entry.id,
    messages: req.messages,
    tools: req.tools,
    toolChoice: req.toolChoice,
    json: req.json,
    thinking: req.thinking,
  });
  if (built.url !== RESPONSES_URL) {
    yield { type: "error", text: "ChatGPT requests must go to the Responses API." };
    return;
  }

  const fetchImpl = req.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(built.url, {
      method: "POST",
      signal: req.signal,
      headers: responsesHeaders(accessToken),
      body: JSON.stringify(built.body),
    });
  } catch {
    if (req.signal?.aborted) return;
    yield { type: "error", text: "Could not reach ChatGPT." };
    return;
  }
  if (!res.ok || !res.body) {
    yield { type: "error", text: responsesHttpError(res.status, await res.text().catch(() => "")) };
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const sse = new SseBuffer();
  const stream = new ResponsesStream();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const message of sse.push(decoder.decode(value, { stream: true }))) {
      for (const event of mapUsage(entry, stream.push(message))) yield event;
    }
  }
  for (const message of sse.flush()) {
    for (const event of mapUsage(entry, stream.push(message))) yield event;
  }
  for (const event of mapUsage(entry, stream.finish())) yield event;
}

const EMPTY_USAGE: Usage = { promptTokens: 0, cachedTokens: 0, completionTokens: 0, costUsd: 0 };

export async function completeChatgptJSON<T>(req: ChatgptCall): Promise<{ ok: true; data: T; usage: Usage } | { ok: false; error: string }> {
  let text = "";
  let usage = EMPTY_USAGE;
  for await (const event of streamChatgpt({ ...req, json: true })) {
    if (event.type === "content") text += event.text;
    else if (event.type === "usage") usage = event.usage;
    else if (event.type === "error") return { ok: false, error: event.text };
  }
  try {
    return { ok: true, data: jsonFromText<T>(text), usage };
  } catch {
    return { ok: false, error: "The model returned something that was not valid JSON. Try again." };
  }
}

export async function readChatgptPage(req: {
  model: string;
  image: string;
  prompt: string;
  signal?: AbortSignal;
}): Promise<{ ok: true; text: string } | { ok: false; error: string; status: number }> {
  let text = "";
  for await (const event of streamChatgpt({
    model: "flash",
    modelId: req.model,
    signal: req.signal,
    messages: [{ role: "user", content: [{ type: "image_url", image_url: req.image }, { type: "text", text: req.prompt }] }],
  })) {
    if (event.type === "content") text += event.text;
    else if (event.type === "error") return { ok: false, error: event.text, status: chatgptErrorStatus(event.text) };
  }
  return { ok: true, text };
}
