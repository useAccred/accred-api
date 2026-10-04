import type { CustomerChatOutput } from "./customer-billing";
import type { CustomerChatMessage } from "./customer-provider";

// Pure translation between the OpenAI / Anthropic wire formats and the native
// metered chat request. Nothing here touches billing, the ledger, or providers.

export type CompatFlavor = "openai" | "anthropic";
export type CompatRequest = {
  model: string;
  messages: CustomerChatMessage[];
  requestedMaxOutputTokens: number | undefined;
  stream: boolean;
  includeStreamUsage: boolean;
};
export type CompatParseResult = { request: CompatRequest } | { error: string };

export const COMPAT_DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const STREAM_CHUNK_CHARS = 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/**
 * Flattens OpenAI content parts and Anthropic content blocks to plain text.
 * The metered engine is text-only, so tool calls and tool results are kept as
 * readable text and non-text media is replaced by a placeholder.
 */
export function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (!isRecord(part)) continue;
    if ((part.type === "text" || part.type === "input_text" || part.type === "output_text") &&
        typeof part.text === "string") {
      parts.push(part.text);
    } else if (part.type === "tool_use") {
      parts.push(`[tool call ${stringify(part.name)}: ${stringify(part.input)}]`);
    } else if (part.type === "tool_result") {
      parts.push(`[tool result]\n${flattenContent(part.content)}`);
    } else if (part.type === "image" || part.type === "image_url" || part.type === "document") {
      parts.push(`[${part.type} omitted]`);
    }
  }
  return parts.join("\n");
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function finish(model: unknown, messages: CustomerChatMessage[], rest: Omit<CompatRequest, "model" | "messages">): CompatParseResult {
  if (typeof model !== "string" || !model || model.length > 200) return { error: "A model ID is required." };
  const nonEmpty = messages.filter((message) => message.content.trim().length > 0);
  if (!nonEmpty.some((message) => message.role !== "system")) {
    return { error: "At least one non-empty user or assistant message is required." };
  }
  return { request: { model, messages: nonEmpty, ...rest } };
}

export function parseOpenAiRequest(body: unknown): CompatParseResult {
  if (!isRecord(body) || !Array.isArray(body.messages)) return { error: "A messages array is required." };
  const messages: CustomerChatMessage[] = [];
  for (const raw of body.messages) {
    if (!isRecord(raw)) return { error: "Each message must be an object." };
    const text = flattenContent(raw.content);
    if (raw.role === "system" || raw.role === "developer") {
      messages.push({ role: "system", content: text });
    } else if (raw.role === "user") {
      messages.push({ role: "user", content: text });
    } else if (raw.role === "assistant") {
      const calls = Array.isArray(raw.tool_calls)
        ? raw.tool_calls.filter(isRecord).map((call) => {
          const fn = isRecord(call.function) ? call.function : {};
          return `[tool call ${stringify(fn.name)}: ${stringify(fn.arguments)}]`;
        })
        : [];
      messages.push({ role: "assistant", content: [text, ...calls].filter(Boolean).join("\n") });
    } else if (raw.role === "tool" || raw.role === "function") {
      messages.push({ role: "user", content: `[tool result]\n${text}` });
    } else {
      return { error: "Unsupported message role." };
    }
  }
  const streamOptions = isRecord(body.stream_options) ? body.stream_options : {};
  return finish(body.model, messages, {
    requestedMaxOutputTokens: positiveInteger(body.max_completion_tokens) ?? positiveInteger(body.max_tokens),
    stream: body.stream === true,
    includeStreamUsage: streamOptions.include_usage === true,
  });
}

export function parseAnthropicRequest(body: unknown): CompatParseResult {
  if (!isRecord(body) || !Array.isArray(body.messages)) return { error: "A messages array is required." };
  const messages: CustomerChatMessage[] = [];
  const system = flattenContent(body.system);
  if (system) messages.push({ role: "system", content: system });
  for (const raw of body.messages) {
    if (!isRecord(raw) || (raw.role !== "user" && raw.role !== "assistant")) {
      return { error: "Each message must have the user or assistant role." };
    }
    messages.push({ role: raw.role, content: flattenContent(raw.content) });
  }
  return finish(body.model, messages, {
    requestedMaxOutputTokens: positiveInteger(body.max_tokens),
    stream: body.stream === true,
    includeStreamUsage: true,
  });
}

/** Editors routinely ask for more output than a model allows; clamp instead of rejecting. */
export function clampMaxOutputTokens(requested: number | undefined, modelMaxOutputTokens: number): number {
  return Math.max(1, Math.min(requested ?? COMPAT_DEFAULT_MAX_OUTPUT_TOKENS, modelMaxOutputTokens));
}

/** Conservative estimate for count_tokens; the metered engine bounds input by bytes. */
export function estimateInputTokens(messages: CustomerChatMessage[]): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(messages), "utf8") / 3);
}

function receipt(output: CustomerChatOutput) {
  return {
    creditsChargedExact: output.creditsChargedExact,
    providerCostUsdExact: output.providerCostUsdExact,
    creditUnit: output.creditUnit,
    cashbackUsdExact: output.cashbackUsdExact,
    remainingCreditsExact: output.remainingCreditsExact,
  };
}

function textChunks(content: string): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < content.length; index += STREAM_CHUNK_CHARS) {
    chunks.push(content.slice(index, index + STREAM_CHUNK_CHARS));
  }
  return chunks;
}

function openAiUsage(output: CustomerChatOutput) {
  return {
    prompt_tokens: output.usage.inputTokens,
    completion_tokens: output.usage.outputTokens,
    total_tokens: output.usage.inputTokens + output.usage.outputTokens,
  };
}

export function openAiCompletion(output: CustomerChatOutput, id: string, created: number, model: string) {
  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message: { role: "assistant", content: output.content }, finish_reason: "stop" }],
    usage: openAiUsage(output),
    accred: receipt(output),
  };
}

function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function sseEvent(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** The engine settles on a finished response, so the stream replays that response as chunks. */
export function openAiStreamFrames(
  output: CustomerChatOutput,
  id: string,
  created: number,
  model: string,
  includeUsage: boolean,
): string[] {
  const chunk = (delta: Record<string, unknown>, finishReason: string | null) => sseData({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
  const frames = [chunk({ role: "assistant", content: "" }, null)];
  for (const text of textChunks(output.content)) frames.push(chunk({ content: text }, null));
  frames.push(chunk({}, "stop"));
  if (includeUsage) {
    frames.push(sseData({ id, object: "chat.completion.chunk", created, model, choices: [], usage: openAiUsage(output) }));
  }
  frames.push("data: [DONE]\n\n");
  return frames;
}

export function anthropicMessage(output: CustomerChatOutput, id: string, model: string) {
  return {
    id,
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: output.content }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: output.usage.inputTokens, output_tokens: output.usage.outputTokens },
    accred: receipt(output),
  };
}

/** Sent before the metered engine runs so the client sees an open stream while it waits. */
export function anthropicStreamStart(id: string, model: string): string {
  return sseEvent("message_start", {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
}

export function anthropicStreamFrames(output: CustomerChatOutput): string[] {
  const frames = [sseEvent("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  })];
  for (const text of textChunks(output.content)) {
    frames.push(sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    }));
  }
  frames.push(sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }));
  frames.push(sseEvent("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { input_tokens: output.usage.inputTokens, output_tokens: output.usage.outputTokens },
  }));
  frames.push(sseEvent("message_stop", { type: "message_stop" }));
  return frames;
}

const OPENAI_ERROR_TYPES: Record<number, [type: string, code: string]> = {
  400: ["invalid_request_error", "invalid_request"],
  401: ["authentication_error", "invalid_api_key"],
  402: ["insufficient_quota", "insufficient_quota"],
  403: ["permission_error", "permission_denied"],
  409: ["invalid_request_error", "idempotency_conflict"],
  429: ["rate_limit_error", "rate_limit_exceeded"],
};

const ANTHROPIC_ERROR_TYPES: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  402: "billing_error",
  403: "permission_error",
  409: "invalid_request_error",
  429: "rate_limit_error",
};

export function compatErrorBody(flavor: CompatFlavor, statusCode: number, message: string) {
  if (flavor === "anthropic") {
    return { type: "error", error: { type: ANTHROPIC_ERROR_TYPES[statusCode] ?? "api_error", message } };
  }
  const [type, code] = OPENAI_ERROR_TYPES[statusCode] ?? ["api_error", "service_unavailable"];
  return { error: { message, type, code } };
}

export function compatStreamError(flavor: CompatFlavor, statusCode: number, message: string): string {
  const body = compatErrorBody(flavor, statusCode, message);
  return flavor === "anthropic" ? sseEvent("error", body) : sseData(body);
}

export function compatKeepalive(flavor: CompatFlavor): string {
  return flavor === "anthropic" ? sseEvent("ping", { type: "ping" }) : ": keepalive\n\n";
}
