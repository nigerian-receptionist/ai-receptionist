import { Agent } from "undici";

import type { ChatMessage, LlmClient, LlmEvent, TokenUsage } from "../types";
import { SseParser } from "./sse";

/**
 * LLM adapter speaking the OpenAI chat-completions protocol over fetch, so the
 * provider stays swappable (ADR 0007). Streaming responses are parsed as SSE;
 * the caller's AbortSignal cancels the request mid-stream.
 *
 * All requests on this instance share one keep-alive agent, so the
 * notice-time warmup and turn 1 reuse a connection instead of paying TLS
 * again. Idle sockets survive 30s (past the ~7.5s notice plus the caller's
 * first utterance); the 10-minute cap is undici's default.
 */
export class OpenAiCompatibleLlm implements LlmClient {
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly reasoningEffort: string;
  private readonly defaultMaxTokens: number;
  private readonly requestTimeoutMs: number;
  private readonly onSkippedPayload: ((count: number) => void) | null;
  private readonly dispatcher: Agent;

  constructor(opts: {
    baseUrl: string;
    apiKey: string;
    model: string;
    reasoningEffort: string;
    maxCompletionTokens: number;
    /** Overall timeout per request, including a slow stream. */
    requestTimeoutMs?: number;
    /** Called once per stream when malformed SSE payloads were skipped. */
    onSkippedPayload?: (count: number) => void;
  }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.reasoningEffort = opts.reasoningEffort;
    this.defaultMaxTokens = opts.maxCompletionTokens;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 60_000;
    this.onSkippedPayload = opts.onSkippedPayload ?? null;
    this.dispatcher = new Agent({ keepAliveTimeout: 30_000, keepAliveMaxTimeout: 600_000 });
  }

  async *streamChat(
    messages: ChatMessage[],
    opts: { signal?: AbortSignal; maxTokens?: number } = {},
  ): AsyncIterable<LlmEvent> {
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          max_completion_tokens: opts.maxTokens ?? this.defaultMaxTokens,
          reasoning_effort: this.reasoningEffort,
        }),
        signal,
        dispatcher: this.dispatcher,
      });
    } catch (error) {
      throw llmError("request failed", error);
    }
    if (!response.ok || !response.body) {
      const detail = await safeErrorText(response);
      throw new Error(`llm http ${response.status}: ${detail}`);
    }
    const parser = new SseParser();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let skipped = 0;
    const emit = function* (payloads: string[]): Generator<LlmEvent> {
      for (const payload of payloads) {
        const event = parseChunk(payload);
        if (event) yield event;
        else skipped += 1;
      }
    };
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        yield* emit(parser.push(decoder.decode(value, { stream: true })));
        if (parser.isDone) break;
      }
      yield* emit(parser.flush());
      if (skipped > 0) this.onSkippedPayload?.(skipped);
    } catch (error) {
      if (signal.aborted) throw abortError(opts.signal);
      throw llmError("stream failed", error);
    } finally {
      reader.releaseLock();
      await response.body.cancel().catch(() => undefined);
    }
  }
}

function parseChunk(payload: string): LlmEvent | null {
  let json: {
    choices?: { delta?: { content?: unknown }; finish_reason?: unknown }[];
    usage?: {
      prompt_tokens?: unknown;
      completion_tokens?: unknown;
      completion_tokens_details?: { reasoning_tokens?: unknown };
    };
  };
  try {
    json = JSON.parse(payload) as typeof json;
  } catch {
    return null;
  }
  if (json.usage) {
    const usage: TokenUsage = {
      in: toIntOrNull(json.usage.prompt_tokens),
      out: toIntOrNull(json.usage.completion_tokens),
      reasoning: toIntOrNull(json.usage.completion_tokens_details?.reasoning_tokens),
    };
    return { kind: "usage", usage };
  }
  const delta = json.choices?.[0]?.delta?.content;
  if (typeof delta === "string" && delta !== "") return { kind: "delta", text: delta };
  return null;
}

function toIntOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

async function safeErrorText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return "<unreadable>";
  }
}

function abortError(callerSignal?: AbortSignal): Error {
  const error = new Error(callerSignal?.aborted ? "llm cancelled" : "llm timed out");
  error.name = "AbortError";
  return error;
}

function llmError(what: string, cause: unknown): Error {
  if (cause instanceof Error && cause.name === "AbortError") return cause;
  return new Error(`llm ${what}: ${cause instanceof Error ? cause.message : String(cause)}`);
}
