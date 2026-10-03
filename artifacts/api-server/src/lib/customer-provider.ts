import OpenAI from "openai";
import type { CustomerModel } from "./customer-models";
import type { ProviderTokenUsage } from "./customer-models";

export const CUSTOMER_PROVIDER_TIMEOUT_MS = 120_000;

export type CustomerChatMessage = { role: "system" | "user" | "assistant"; content: string };
export type ProviderCompletion = ProviderTokenUsage & {
  id: string;
  content: string;
};

export class CustomerProviderError extends Error {
  constructor(readonly code: "integration_unavailable" | "unknown_outcome") {
    super(code);
  }
}

function safeTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function optionalTokenCount(value: unknown): number | undefined {
  if (value === undefined || value === null) return 0;
  return safeTokenCount(value);
}

function requiredTokenCount(value: unknown): number {
  const count = safeTokenCount(value);
  if (count === undefined) throw new CustomerProviderError("unknown_outcome");
  return count;
}

function requiredUsage(input: unknown, output: unknown): Pick<ProviderTokenUsage, "inputTokens" | "outputTokens"> {
  const inputTokens = safeTokenCount(input);
  const outputTokens = safeTokenCount(output);
  if (inputTokens === undefined || outputTokens === undefined) throw new CustomerProviderError("unknown_outcome");
  return { inputTokens, outputTokens };
}

async function readJson(response: Response): Promise<Record<string, any>> {
  if (!response.ok) throw new CustomerProviderError("unknown_outcome");
  try {
    const json = await response.json();
    if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error();
    return json as Record<string, any>;
  } catch {
    throw new CustomerProviderError("unknown_outcome");
  }
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(CUSTOMER_PROVIDER_TIMEOUT_MS) });
  } catch {
    throw new CustomerProviderError("unknown_outcome");
  }
}

export async function createProviderCompletion(input: {
  model: CustomerModel;
  messages: CustomerChatMessage[];
  maxOutputTokens: number;
}): Promise<ProviderCompletion> {
  const { model, messages, maxOutputTokens } = input;
  try {
    if (model.provider === "openai" || model.provider === "openrouter") {
      const isOpenRouter = model.provider === "openrouter";
      const baseURL = isOpenRouter
        ? process.env.AI_INTEGRATIONS_OPENROUTER_BASE_URL
        : process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
      const apiKey = isOpenRouter
        ? process.env.AI_INTEGRATIONS_OPENROUTER_API_KEY
        : process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
      if (!baseURL || !apiKey) throw new CustomerProviderError("integration_unavailable");
      const client = new OpenAI({
        apiKey,
        baseURL,
        timeout: CUSTOMER_PROVIDER_TIMEOUT_MS,
        maxRetries: 0,
      });
      if (!isOpenRouter && model.id.endsWith("-codex")) {
        const response = await client.responses.create({
          model: model.id,
          input: messages.map(({ role, content }) => ({ role, content })),
          max_output_tokens: maxOutputTokens,
        });
        const usage = requiredUsage(response.usage?.input_tokens, response.usage?.output_tokens);
        const cachedInputTokens = requiredTokenCount(response.usage?.input_tokens_details?.cached_tokens);
        const thoughtsTokens = requiredTokenCount(response.usage?.output_tokens_details?.reasoning_tokens);
        if (typeof response.output_text !== "string") throw new CustomerProviderError("unknown_outcome");
        return { id: response.id, content: response.output_text, ...usage, cachedInputTokens, thoughtsTokens };
      }
      const completion = await client.chat.completions.create((isOpenRouter ? {
        model: model.id,
        messages,
        max_tokens: maxOutputTokens,
        usage: { include: true },
      } : {
        model: model.id,
        messages,
        max_completion_tokens: maxOutputTokens,
      }) as any);
      const usage = requiredUsage(completion.usage?.prompt_tokens, completion.usage?.completion_tokens);
      const cachedInputTokens = requiredTokenCount(completion.usage?.prompt_tokens_details?.cached_tokens);
      const thoughtsTokens = requiredTokenCount(completion.usage?.completion_tokens_details?.reasoning_tokens);
      const content = completion.choices[0]?.message?.content;
      if (typeof content !== "string") throw new CustomerProviderError("unknown_outcome");
      const reportedCost = isOpenRouter ? (completion.usage as any)?.cost : undefined;
      if (isOpenRouter && (typeof reportedCost !== "string" && typeof reportedCost !== "number")) {
        throw new CustomerProviderError("unknown_outcome");
      }
      return {
        id: completion.id,
        content,
        ...usage,
        cachedInputTokens,
        thoughtsTokens,
        ...(isOpenRouter ? { reportedCostUsd: String(reportedCost) } : {}),
      };
    }

    if (model.provider === "anthropic") {
      const baseURL = process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL;
      const apiKey = process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY;
      if (!baseURL || !apiKey) throw new CustomerProviderError("integration_unavailable");
      const endpoint = `${baseURL.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1/messages`;
      const response = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: model.id,
          max_tokens: maxOutputTokens,
          messages: messages.filter((message) => message.role !== "system"),
          ...(messages.some((message) => message.role === "system")
            ? { system: messages.filter((message) => message.role === "system").map((message) => message.content).join("\n") }
            : {}),
        }),
      });
      const data = await readJson(response);
      const rawInputTokens = safeTokenCount(data.usage?.input_tokens);
      const outputTokens = safeTokenCount(data.usage?.output_tokens);
      const cacheReadInputTokens = safeTokenCount(data.usage?.cache_read_input_tokens);
      const cacheCreationInputTokens = safeTokenCount(data.usage?.cache_creation_input_tokens);
      const cacheWrite5mTokens = optionalTokenCount(data.usage?.cache_creation?.ephemeral_5m_input_tokens);
      const cacheWrite1hTokens = optionalTokenCount(data.usage?.cache_creation?.ephemeral_1h_input_tokens);
      if (rawInputTokens === undefined || outputTokens === undefined ||
          cacheReadInputTokens === undefined || cacheCreationInputTokens === undefined ||
          cacheWrite5mTokens === undefined || cacheWrite1hTokens === undefined ||
          cacheWrite5mTokens + cacheWrite1hTokens !== cacheCreationInputTokens) {
        throw new CustomerProviderError("unknown_outcome");
      }
      const usage = {
        inputTokens: rawInputTokens + cacheReadInputTokens + cacheCreationInputTokens,
        outputTokens,
        cacheReadInputTokens,
        cacheWrite5mTokens,
        cacheWrite1hTokens,
      };
      const content = Array.isArray(data.content)
        ? data.content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("")
        : undefined;
      if (typeof data.id !== "string" || typeof content !== "string") {
        throw new CustomerProviderError("unknown_outcome");
      }
      return { id: data.id, content, ...usage };
    }

    if (model.provider === "gemini") {
      const baseURL = process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
      const apiKey = process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
      if (!baseURL || !apiKey) throw new CustomerProviderError("integration_unavailable");
      const normalizedBase = baseURL.replace(/\/+$/, "");
      const apiBase = /\/v1beta$/.test(normalizedBase) ? normalizedBase : `${normalizedBase}/v1beta`;
      const endpoint = `${apiBase}/models/${encodeURIComponent(model.id)}:generateContent`;
      const contents = messages.filter((message) => message.role !== "system").map((message) => ({
        role: message.role === "assistant" ? "model" : "user",
        parts: [{ text: message.content }],
      }));
      const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
      const response = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents,
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
          generationConfig: { maxOutputTokens },
        }),
      });
      const data = await readJson(response);
      const rawInputTokens = safeTokenCount(data.usageMetadata?.promptTokenCount);
      const cachedInputTokens = optionalTokenCount(data.usageMetadata?.cachedContentTokenCount);
      const candidateTokens = safeTokenCount(data.usageMetadata?.candidatesTokenCount);
      const thoughtsTokens = safeTokenCount(data.usageMetadata?.thoughtsTokenCount);
      if (rawInputTokens === undefined || cachedInputTokens === undefined ||
          candidateTokens === undefined || thoughtsTokens === undefined || cachedInputTokens > rawInputTokens) {
        throw new CustomerProviderError("unknown_outcome");
      }
      const usage = {
        inputTokens: rawInputTokens,
        outputTokens: candidateTokens + thoughtsTokens,
        cachedInputTokens,
        thoughtsTokens,
      };
      const parts = data.candidates?.[0]?.content?.parts;
      const content = Array.isArray(parts)
        ? parts.filter((part: any) => typeof part?.text === "string").map((part: any) => part.text).join("")
        : undefined;
      if (typeof content !== "string") throw new CustomerProviderError("unknown_outcome");
      const id = typeof data.responseId === "string" ? data.responseId : `gemini-${Date.now()}`;
      return { id, content, ...usage };
    }
    throw new CustomerProviderError("integration_unavailable");
  } catch (error) {
    if (error instanceof CustomerProviderError) throw error;
    // SDK errors can contain provider headers, request bodies, or credentials;
    // never expose or log them.
    throw new CustomerProviderError("unknown_outcome");
  }
}