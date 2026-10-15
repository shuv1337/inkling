/**
 * Chat completions. OpenAI-compatible SSE. The provider comes from env
 * (lib/llm.ts); Together is the default.
 *
 * Things learned the hard way, kept on purpose:
 * 1. A named User-Agent. Together's WAF has 403'd the default undici agent.
 * 2. stream_options.include_usage, so the cost receipt is real, not a guess.
 * 3. Errors come back as JSON: surface error.message, not the raw body.
 * 4. enable_thinking:false keeps Together reasoners from spending the budget thinking.
 *    Verified per model on 2026-10-08 with the full sample article (11k tokens).
 *    Other providers do not get that field unless LLM_EXTRA_BODY asks for it.
 */

import { APP_UA, buildChatRequest, providerError } from "./llm";
import { costOf, type ModelKey, type StreamEvent, type Usage } from "./models";

export { APP_UA };
export { MODELS, DEFAULT_MODEL, isModelKey, costFor } from "./models";
export type { ModelKey, StreamEvent, Usage } from "./models";

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string };

type Chunk = {
  choices?: { delta?: { content?: string; reasoning_content?: string; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
};

function errorMessage(provider: string, status: number, body: string): string {
  return providerError(provider, status, body);
}

export async function* streamChat(req: {
  messages: ChatMessage[];
  model: ModelKey;
  apiKey?: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** Tools the model may call; a call ends the stream with a "tool" event instead of an answer. */
  tools?: readonly unknown[];
  /** "none" sends the tools (a conversation that already used one needs them) but asks for an answer. */
  toolChoice?: "auto" | "none";
}): AsyncGenerator<StreamEvent> {
  const built = buildChatRequest({
    model: req.model,
    messages: req.messages,
    apiKey: req.apiKey,
    maxTokens: req.maxTokens ?? 900,
    temperature: req.temperature ?? 0.4,
    stream: true,
    tools: req.tools,
    toolChoice: req.toolChoice,
    thinking: false,
  });
  if (!built.ok) {
    yield { type: "error", text: built.error };
    return;
  }
  const model = built.entry;

  yield { type: "meta", model: model.label };

  let res: Response;
  try {
    res = await fetch(built.url, {
      method: "POST",
      signal: req.signal,
      headers: built.headers,
      body: JSON.stringify(built.body),
    });
  } catch (e) {
    if (req.signal?.aborted) return;
    yield { type: "error", text: `Could not reach ${built.provider === "Together" ? "Together" : "the model provider"}: ${String(e)}` };
    return;
  }

  if (!res.ok || !res.body) {
    yield { type: "error", text: errorMessage(built.provider, res.status, await res.text().catch(() => "")) };
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawContent = false;
  let sawReasoning = false;
  // A tool call arrives in pieces, by index: its id and name once, its arguments in fragments.
  const calls: { id: string; name: string; args: string }[] = [];

  const finish = (): StreamEvent => {
    if (calls[0]?.name) return { type: "tool", id: calls[0].id || "call_0", name: calls[0].name, args: calls[0].args };
    return !sawContent && sawReasoning ? { type: "error", text: `${model.label} answered only in its reasoning. Try again.` } : { type: "done" };
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      const line = frame.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") {
        yield finish();
        return;
      }
      let chunk: Chunk;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.reasoning_content) sawReasoning = true;
      for (const tc of delta?.tool_calls ?? []) {
        const c = (calls[tc.index] ??= { id: "", name: "", args: "" });
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.name += tc.function.name;
        if (tc.function?.arguments) c.args += tc.function.arguments;
      }
      if (delta?.content) {
        sawContent = true;
        yield { type: "content", text: delta.content };
      }
      if (chunk.usage && typeof chunk.usage.completion_tokens === "number") {
        const pt = chunk.usage.prompt_tokens ?? 0;
        const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
        const ct = chunk.usage.completion_tokens ?? 0;
        yield {
          type: "usage",
          usage: { promptTokens: pt, cachedTokens: cached, completionTokens: ct, costUsd: costOf(model, pt, cached, ct) },
        };
      }
    }
  }
  yield finish();
}

/** Non-streaming JSON completion, for structured output like the brief. */
export async function completeJSON<T>(req: {
  messages: ChatMessage[];
  model: ModelKey;
  apiKey?: string;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Let the model reason before it answers, for checking a text against itself. Its thinking spends from maxTokens. */
  thinking?: boolean;
}): Promise<{ ok: true; data: T; usage: Usage } | { ok: false; error: string }> {
  const built = buildChatRequest({
    model: req.model,
    messages: req.messages,
    apiKey: req.apiKey,
    maxTokens: req.maxTokens ?? 1400,
    temperature: 0.3,
    thinking: Boolean(req.thinking),
    responseFormat: { type: "json_object" },
  });
  if (!built.ok) return { ok: false, error: built.error };
  const model = built.entry;

  let res: Response;
  try {
    res = await fetch(built.url, {
      method: "POST",
      signal: req.signal,
      headers: built.headers,
      body: JSON.stringify(built.body),
    });
  } catch (e) {
    return { ok: false, error: `Could not reach ${built.provider === "Together" ? "Together" : "the model provider"}: ${String(e)}` };
  }
  const body = await res.text();
  if (!res.ok) return { ok: false, error: errorMessage(built.provider, res.status, body) };

  try {
    const j = JSON.parse(body) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
    };
    const raw = j.choices?.[0]?.message?.content ?? "";
    const jsonText = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
    const data = JSON.parse(jsonText) as T;
    const pt = j.usage?.prompt_tokens ?? 0;
    const cached = j.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const ct = j.usage?.completion_tokens ?? 0;
    return { ok: true, data, usage: { promptTokens: pt, cachedTokens: cached, completionTokens: ct, costUsd: costOf(model, pt, cached, ct) } };
  } catch {
    return { ok: false, error: "The model returned something that was not valid JSON. Try again." };
  }
}
