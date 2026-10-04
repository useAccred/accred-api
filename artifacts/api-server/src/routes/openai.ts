import { randomUUID } from "node:crypto";
import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import { extractPlatformKey, findPlatformApiKey, isPlausiblePlatformKey } from "../lib/platform-api-key";
import { runCustomerCompletion, type CustomerChatInput, type CustomerChatOutput } from "../lib/customer-billing";
import { listCustomerModels } from "../lib/customer-models";
import type { CustomerChatMessage } from "../lib/customer-provider";

// OpenAI-compatible surface over the metered customer completion flow.
// Base URL for OpenAI SDKs / tools: https://<host>/api/openai/v1

const router: IRouter = Router();

const DEFAULT_MAX_OUTPUT_TOKENS = 1024;
const MAX_MESSAGES = 4096;
const SSE_KEEPALIVE_MS = 10_000;
const SSE_CHUNK_CHARS = 96;

type OpenAIErrorType = "invalid_request_error" | "authentication_error" | "insufficient_quota" | "rate_limit_error" | "api_error";

function errorBody(message: string, type: OpenAIErrorType, code: string | null = null) {
  return { error: { message, type, param: null, code } };
}

function errorTypeFor(statusCode: number): { type: OpenAIErrorType; code: string | null } {
  switch (statusCode) {
    case 400: return { type: "invalid_request_error", code: null };
    case 401: return { type: "authentication_error", code: "invalid_api_key" };
    case 402: return { type: "insufficient_quota", code: "insufficient_quota" };
    case 403: return { type: "invalid_request_error", code: "permission_denied" };
    case 409: return { type: "invalid_request_error", code: "conflict" };
    case 429: return { type: "rate_limit_error", code: "rate_limit_exceeded" };
    default: return { type: "api_error", code: null };
  }
}

function sendError(res: Response, statusCode: number, message: string): void {
  const { type, code } = errorTypeFor(statusCode);
  res.status(statusCode).json(errorBody(message, type, code));
}

async function requireBearerPlatformKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  const secret = extractPlatformKey(req);
  if (!isPlausiblePlatformKey(secret)) {
    sendError(res, 401, "A platform API key is required. Use: Authorization: Bearer <platform API key>.");
    return;
  }
  try {
    const key = await findPlatformApiKey(secret);
    if (!key) {
      sendError(res, 401, "The platform API key is invalid or revoked.");
      return;
    }
    req.platformApiKey = key;
    next();
  } catch (error) {
    req.log.error({ error }, "Platform API key lookup failed");
    sendError(res, 503, "The platform API key service is unavailable.");
  }
}

/** Flattens OpenAI message content (string or text parts) into plain text. */
function contentToText(content: unknown): string | { error: string } {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return { error: "Message content must be a string or an array of content parts." };
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") return { error: "Invalid content part." };
    const { type, text } = part as { type?: unknown; text?: unknown };
    if (type !== "text" || typeof text !== "string") {
      return { error: `Content part type "${String(type)}" is not supported; only text parts are accepted.` };
    }
    parts.push(text);
  }
  return parts.join("\n");
}

type ParsedRequest = { input: CustomerChatInput; stream: boolean; includeUsage: boolean };

function parseRequest(body: unknown): ParsedRequest | { error: string } {
  if (!body || typeof body !== "object") return { error: "Request body must be a JSON object." };
  const b = body as Record<string, unknown>;

  if (typeof b.model !== "string" || !b.model.trim() || b.model.length > 200) {
    return { error: "`model` is required and must be a model ID string." };
  }
  if (!Array.isArray(b.messages) || b.messages.length === 0) {
    return { error: "`messages` must be a non-empty array." };
  }
  if (b.messages.length > MAX_MESSAGES) return { error: `\`messages\` may contain at most ${MAX_MESSAGES} items.` };

  const messages: CustomerChatMessage[] = [];
  for (const [index, raw] of b.messages.entries()) {
    if (!raw || typeof raw !== "object") return { error: `messages[${index}] must be an object.` };
    const { role, content } = raw as { role?: unknown; content?: unknown };
    let mappedRole: CustomerChatMessage["role"];
    if (role === "system" || role === "developer") mappedRole = "system";
    else if (role === "user" || role === "assistant") mappedRole = role;
    else return { error: `messages[${index}].role "${String(role)}" is not supported (use system, developer, user, or assistant).` };
    const text = contentToText(content);
    if (typeof text !== "string") return { error: `messages[${index}]: ${text.error}` };
    // Assistant turns that only carried tool calls have no text to forward.
    if (!text) continue;
    messages.push({ role: mappedRole, content: text });
  }
  if (!messages.length) return { error: "`messages` contains no text content." };

  if (Array.isArray(b.tools) && b.tools.length > 0) {
    return { error: "Tool calling is not supported by this gateway yet; remove `tools`." };
  }

  const rawMax = b.max_completion_tokens ?? b.max_tokens;
  let maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS;
  if (rawMax !== undefined && rawMax !== null) {
    if (typeof rawMax !== "number" || !Number.isSafeInteger(rawMax) || rawMax < 1) {
      return { error: "`max_tokens` must be a positive integer." };
    }
    maxOutputTokens = rawMax;
  }

  if (b.stream !== undefined && b.stream !== null && typeof b.stream !== "boolean") {
    return { error: "`stream` must be a boolean." };
  }
  const streamOptions = b.stream_options as { include_usage?: unknown } | undefined;

  return {
    input: { model: b.model.trim(), messages, maxOutputTokens },
    stream: b.stream === true,
    includeUsage: streamOptions?.include_usage === true,
  };
}

function idempotencyKeyFor(req: Request): string {
  const supplied = req.get("idempotency-key");
  if (supplied && supplied.length >= 8 && supplied.length <= 128) return supplied;
  return `oai-${randomUUID()}`;
}

function finishReason(result: CustomerChatOutput, maxOutputTokens: number): "stop" | "length" {
  return result.usage.outputTokens >= maxOutputTokens ? "length" : "stop";
}

function usageBlock(result: CustomerChatOutput) {
  return {
    prompt_tokens: result.usage.inputTokens,
    completion_tokens: result.usage.outputTokens,
    total_tokens: result.usage.inputTokens + result.usage.outputTokens,
  };
}

function accredBlock(result: CustomerChatOutput) {
  return {
    credits_charged: result.creditsChargedExact,
    provider_cost_usd: result.providerCostUsdExact,
    remaining_credits: result.remainingCreditsExact,
  };
}

router.get(["/openai/v1/models", "/customer/v1/models"], requireBearerPlatformKey, async (_req, res): Promise<void> => {
  try {
    const models = (await listCustomerModels()).filter((m) => m.available && m.capabilities.includes("text-generation"));
    const idCounts = new Map<string, number>();
    for (const m of models) idCounts.set(m.id, (idCounts.get(m.id) ?? 0) + 1);
    res.json({
      object: "list",
      data: models.map((m) => ({
        id: idCounts.get(m.id) === 1 ? m.id : `${m.provider}/${m.id}`,
        object: "model",
        created: 0,
        owned_by: m.provider,
      })),
    });
  } catch {
    sendError(res, 503, "The live model catalogue is temporarily unavailable.");
  }
});

/**
 * On the shared /customer/v1 path, any request that carries X-Platform-API-Key is a native
 * client and falls through to the original route unchanged (its response shape never depends
 * on which optional body fields are present). Only requests without that header (Bearer or
 * x-api-key clients such as Cursor) get the OpenAI shape.
 */
function isOpenAIStyle(req: Request): boolean {
  return !req.get("x-platform-api-key");
}

router.post("/customer/v1/chat/completions", (req, res, next) => {
  if (!isOpenAIStyle(req)) return void next("route");
  next();
}, requireBearerPlatformKey, chatCompletions);

router.post("/openai/v1/chat/completions", requireBearerPlatformKey, chatCompletions);

async function chatCompletions(req: Request, res: Response): Promise<void> {
  const parsed = parseRequest(req.body);
  if ("error" in parsed) {
    sendError(res, 400, parsed.error);
    return;
  }
  const { input, stream, includeUsage } = parsed;
  const key = req.platformApiKey!;
  const run = () => runCustomerCompletion({
    ownerUserId: key.ownerUserId,
    apiKeyId: key.id,
    idempotencyKey: idempotencyKeyFor(req),
    request: input,
  });
  const created = Math.floor(Date.now() / 1000);

  if (!stream) {
    const result = await run();
    if (result.statusCode !== 200) {
      sendError(res, result.statusCode, result.error);
      return;
    }
    const r = result.response;
    res.json({
      id: `chatcmpl-${r.id}`,
      object: "chat.completion",
      created,
      model: r.model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: r.content, refusal: null },
        logprobs: null,
        finish_reason: finishReason(r, input.maxOutputTokens!),
      }],
      usage: usageBlock(r),
      accred: accredBlock(r),
    });
    return;
  }

  // Streaming: the metered flow (on-chain hold → provider → settlement) completes
  // before any text is known, so headers go out immediately with keep-alive
  // comments, and the settled reply is then emitted as OpenAI chunk events.
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  let closed = false;
  const keepAlive = setInterval(() => {
    if (!closed) res.write(": keep-alive\n\n");
  }, SSE_KEEPALIVE_MS);
  res.on("close", () => {
    closed = true;
    clearInterval(keepAlive);
  });
  const send = (payload: unknown) => {
    if (!closed) res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  let result: Awaited<ReturnType<typeof run>>;
  try {
    result = await run();
  } catch (error) {
    req.log.error({ error }, "OpenAI-compatible streaming completion failed");
    result = { statusCode: 503, error: "The completion could not be processed." };
  }
  clearInterval(keepAlive);
  if (closed) return;

  if (result.statusCode !== 200) {
    const { type, code } = errorTypeFor(result.statusCode);
    send(errorBody(result.error, type, code));
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  const r = result.response;
  const base = { id: `chatcmpl-${r.id}`, object: "chat.completion.chunk", created, model: r.model };
  const chunk = (delta: Record<string, unknown>, finish: string | null) => ({
    ...base,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
    ...(includeUsage ? { usage: null } : {}),
  });

  send(chunk({ role: "assistant", content: "" }, null));
  // Split by code point so no chunk ends in half of a surrogate pair.
  const chars = Array.from(r.content);
  for (let i = 0; i < chars.length; i += SSE_CHUNK_CHARS) {
    send(chunk({ content: chars.slice(i, i + SSE_CHUNK_CHARS).join("") }, null));
  }
  send(chunk({}, finishReason(r, input.maxOutputTokens!)));
  if (includeUsage) {
    send({ ...base, choices: [], usage: usageBlock(r), accred: accredBlock(r) });
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

// ---------------- Anthropic Messages API ----------------

type AnthropicErrorType = "invalid_request_error" | "authentication_error" | "permission_error" | "not_found_error" | "rate_limit_error" | "api_error" | "overloaded_error";

function anthropicErrorType(status: number): AnthropicErrorType {
  switch (status) {
    case 400: return "invalid_request_error";
    case 401: return "authentication_error";
    case 402: return "permission_error";
    case 403: return "permission_error";
    case 404: return "not_found_error";
    case 429: return "rate_limit_error";
    case 503: return "overloaded_error";
    default: return "api_error";
  }
}

function anthropicError(res: Response, status: number, message: string): void {
  res.status(status).json({ type: "error", error: { type: anthropicErrorType(status), message } });
}

async function requireAnthropicKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  const secret = extractPlatformKey(req);
  if (!isPlausiblePlatformKey(secret)) return anthropicError(res, 401, "A platform API key is required. Use the x-api-key header.");
  try {
    const key = await findPlatformApiKey(secret);
    if (!key) return anthropicError(res, 401, "The platform API key is invalid or revoked.");
    req.platformApiKey = key;
    next();
  } catch (error) {
    req.log.error({ error }, "Platform API key lookup failed");
    anthropicError(res, 503, "The platform API key service is unavailable.");
  }
}

function anthropicBlocksToText(content: unknown): string | { error: string } {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return { error: "content must be a string or an array of content blocks." };
  const parts: string[] = [];
  for (const block of content) {
    const type = (block as { type?: unknown } | null)?.type;
    if (type !== "text" || typeof (block as { text?: unknown }).text !== "string") {
      return { error: `Content block type "${String(type)}" is not supported; only text blocks are accepted.` };
    }
    parts.push((block as { text: string }).text);
  }
  return parts.join("\n");
}

function parseAnthropic(body: unknown): { input: CustomerChatInput; stream: boolean } | { error: string } {
  if (!body || typeof body !== "object") return { error: "Request body must be a JSON object." };
  const b = body as Record<string, unknown>;
  if (typeof b.model !== "string" || !b.model.trim()) return { error: "`model` is required." };
  if (!Array.isArray(b.messages) || b.messages.length === 0) return { error: "`messages` must be a non-empty array." };
  if (b.messages.length > MAX_MESSAGES) return { error: `\`messages\` may contain at most ${MAX_MESSAGES} items.` };
  if (Array.isArray(b.tools) && b.tools.length > 0) return { error: "Tool use is not supported by this gateway yet; remove `tools`." };
  if (typeof b.max_tokens !== "number" || !Number.isSafeInteger(b.max_tokens) || b.max_tokens < 1) {
    return { error: "`max_tokens` is required and must be a positive integer." };
  }
  const messages: CustomerChatMessage[] = [];
  if (b.system !== undefined && b.system !== null) {
    const sys = anthropicBlocksToText(b.system);
    if (typeof sys !== "string") return { error: `system: ${sys.error}` };
    if (sys) messages.push({ role: "system", content: sys });
  }
  for (const [index, raw] of b.messages.entries()) {
    const { role, content } = (raw ?? {}) as { role?: unknown; content?: unknown };
    if (role !== "user" && role !== "assistant") return { error: `messages[${index}].role must be "user" or "assistant".` };
    const text = anthropicBlocksToText(content);
    if (typeof text !== "string") return { error: `messages[${index}]: ${text.error}` };
    if (text) messages.push({ role, content: text });
  }
  if (!messages.some((m) => m.role !== "system")) return { error: "`messages` contains no text content." };
  return { input: { model: b.model.trim(), messages, maxOutputTokens: b.max_tokens }, stream: b.stream === true };
}

router.post("/customer/v1/messages", requireAnthropicKey, async (req, res): Promise<void> => {
  const parsed = parseAnthropic(req.body);
  if ("error" in parsed) return anthropicError(res, 400, parsed.error);
  const { input, stream } = parsed;
  const key = req.platformApiKey!;
  const run = () => runCustomerCompletion({
    ownerUserId: key.ownerUserId, apiKeyId: key.id, idempotencyKey: idempotencyKeyFor(req), request: input,
  });
  const stopReason = (r: CustomerChatOutput) => (r.usage.outputTokens >= input.maxOutputTokens! ? "max_tokens" : "end_turn");

  if (!stream) {
    const result = await run();
    if (result.statusCode !== 200) return anthropicError(res, result.statusCode, result.error);
    const r = result.response;
    res.json({
      id: `msg_${r.id}`, type: "message", role: "assistant", model: r.model,
      content: [{ type: "text", text: r.content }],
      stop_reason: stopReason(r), stop_sequence: null,
      usage: { input_tokens: r.usage.inputTokens, output_tokens: r.usage.outputTokens },
    });
    return;
  }

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  let closed = false;
  const event = (name: string, data: unknown) => {
    if (!closed) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const ping = setInterval(() => event("ping", { type: "ping" }), SSE_KEEPALIVE_MS);
  res.on("close", () => { closed = true; clearInterval(ping); });

  let result: Awaited<ReturnType<typeof run>>;
  try {
    result = await run();
  } catch (error) {
    req.log.error({ error }, "Anthropic-compatible streaming completion failed");
    result = { statusCode: 503, error: "The completion could not be processed." };
  }
  clearInterval(ping);
  if (closed) return;
  if (result.statusCode !== 200) {
    event("error", { type: "error", error: { type: anthropicErrorType(result.statusCode), message: result.error } });
    res.end();
    return;
  }
  const r = result.response;
  event("message_start", {
    type: "message_start",
    message: {
      id: `msg_${r.id}`, type: "message", role: "assistant", model: r.model, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: r.usage.inputTokens, output_tokens: 0 },
    },
  });
  event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  const chars = Array.from(r.content);
  for (let i = 0; i < chars.length; i += SSE_CHUNK_CHARS) {
    event("content_block_delta", {
      type: "content_block_delta", index: 0,
      delta: { type: "text_delta", text: chars.slice(i, i + SSE_CHUNK_CHARS).join("") },
    });
  }
  event("content_block_stop", { type: "content_block_stop", index: 0 });
  event("message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason(r), stop_sequence: null },
    usage: { output_tokens: r.usage.outputTokens },
  });
  event("message_stop", { type: "message_stop" });
  res.end();
});

router.post("/customer/v1/messages/count_tokens", requireAnthropicKey, (req, res): void => {
  const parsed = parseAnthropic({ max_tokens: 1, ...(req.body as object) });
  if ("error" in parsed) return anthropicError(res, 400, parsed.error);
  // Estimate: ~4 bytes per token plus a small per-message overhead.
  const bytes = parsed.input.messages.reduce((n, m) => n + Buffer.byteLength(m.content, "utf8"), 0);
  res.json({ input_tokens: Math.ceil(bytes / 4) + parsed.input.messages.length * 4 });
});

export default router;
