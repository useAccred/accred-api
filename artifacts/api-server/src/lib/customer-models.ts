import { isCustomerGatewayConfigured } from "./customer-gateway";

export type CustomerProvider = "openai" | "anthropic" | "gemini" | "openrouter" | "jev";

export type CustomerModel = {
  provider: CustomerProvider;
  id: string;
  name: string;
  inputCostUsdPerMillion: string | null;
  outputCostUsdPerMillion: string | null;
  cachedInputCostUsdPerMillion: string | null;
  cacheWrite5mCostUsdPerMillion: string | null;
  cacheWrite1hCostUsdPerMillion: string | null;
  cacheReadCostUsdPerMillion: string | null;
  capabilities: string[];
  available: boolean;
  unavailableReason: string | null;
  maxInputTokens: number;
  maxOutputTokens: number;
  pricingSource: string | null;
  pricingVerifiedAt: Date | null;
  pricingExpiresAt: Date | null;
  pricingType: "token-breakdown" | "reported-cost" | "unavailable";
};

export type Rational = { numerator: bigint; denominator: bigint };
type PriceConfig = {
  inputUsdPerMillion: unknown;
  outputUsdPerMillion: unknown;
  cachedInputUsdPerMillion?: unknown;
  cacheWrite5mUsdPerMillion?: unknown;
  cacheWrite1hUsdPerMillion?: unknown;
  cacheReadUsdPerMillion?: unknown;
  sourceUrl?: unknown;
  verifiedAt?: unknown;
};
export type ProviderTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheReadInputTokens?: number;
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
  thoughtsTokens?: number;
  reportedCostUsd?: string;
};

type RegistryEntry = {
  provider: CustomerProvider;
  id: string;
  name: string;
  capabilities: string[];
  handler: boolean;
};

// Upper bound on serialized message bytes per request (also a worst-case
// input-token bound). Reservations are sized per request from the actual
// serialized size, so this cap does not inflate holds for small requests.
const MAX_INPUT_TOKENS = 400_000;
const MAX_OUTPUT_TOKENS = 8192;

// This allowlist is based on the current Replit AI Integration skills, not on
// model names supplied by callers or environment configuration.
const REPLIT_MODELS: readonly RegistryEntry[] = [
  ...[
    "gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna",
    "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4",
    "gpt-5.2", "gpt-5.1", "gpt-5", "gpt-5.4-mini", "gpt-5-mini",
    "gpt-5-nano", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano",
    "gpt-4o", "gpt-4o-mini", "o4-mini", "o3", "o3-mini",
  ].map((id) => ({ provider: "openai" as const, id, name: id, capabilities: ["text-generation"], handler: true })),
  ...[
    "gpt-5.3-codex",
    "gpt-5.2-codex",
  ].map((id) => ({ provider: "openai" as const, id, name: id, capabilities: ["text-generation"], handler: true })),
  ...[
    ["gpt-image-1", "image-generation"],
    ["gpt-image-2", "image-generation"],
    ["gpt-audio", "audio-generation"],
    ["gpt-audio-mini", "audio-generation"],
    ["gpt-4o-mini-transcribe", "audio-transcription"],
    ["gpt-4o-transcribe", "audio-transcription"],
  ].map(([id, capability]) => ({ provider: "openai" as const, id, name: id, capabilities: [capability], handler: false })),
  ...[
    "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6",
    "claude-opus-4-5", "claude-opus-4-1", "claude-sonnet-5", "claude-sonnet-4-6",
    "claude-sonnet-4-5", "claude-haiku-4-5",
  ].map((id) => ({ provider: "anthropic" as const, id, name: id, capabilities: ["text-generation"], handler: true })),
  ...[
    "gemini-3.1-pro-preview", "gemini-3-pro-preview", "gemini-3-flash-preview", "gemini-2.5-pro", "gemini-2.5-flash",
  ].map((id) => ({ provider: "gemini" as const, id, name: id, capabilities: ["text-generation"], handler: true })),
  ...[
    "gemini-3-pro-image",
    "gemini-3-pro-image-preview",
    "gemini-2.5-flash-image",
  ].map((id) => ({ provider: "gemini" as const, id, name: id, capabilities: ["image-generation"], handler: false })),
  { provider: "jev", id: "jev-latest", name: "Jev latest", capabilities: ["typed-decisions"], handler: false },
];

export function parseDecimal(value: string): Rational | undefined {
  const match = /^([+]?(?:\d+)(?:\.\d*)?|\.\d+)(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match) return undefined;
  const exponent = Number(match[2] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) return undefined;
  const unsigned = match[1].replace(/^\+/, "");
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const digits = `${whole || "0"}${fraction}`;
  let numerator: bigint;
  try {
    numerator = BigInt(digits);
  } catch {
    return undefined;
  }
  let scale = fraction.length - exponent;
  if (scale < 0) {
    numerator *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { numerator, denominator: 10n ** BigInt(scale) };
}

export function rationalToDecimal(value: Rational): string {
  if (value.denominator <= 0n || value.numerator < 0n) throw new Error("Invalid nonnegative rational.");
  let denominator = value.denominator;
  let twos = 0;
  let fives = 0;
  while (denominator % 2n === 0n) {
    denominator /= 2n;
    twos++;
  }
  while (denominator % 5n === 0n) {
    denominator /= 5n;
    fives++;
  }
  if (denominator !== 1n) throw new Error("Value cannot be represented as a finite decimal.");
  const places = Math.max(twos, fives);
  const scaled = value.numerator * (2n ** BigInt(places - twos)) * (5n ** BigInt(places - fives));
  if (places === 0) return scaled.toString();
  const digits = scaled.toString().padStart(places + 1, "0");
  const whole = digits.slice(0, -places);
  const fraction = digits.slice(-places).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

export function microcreditsForUsage(
  inputRate: Rational,
  outputRate: Rational,
  inputTokens: number,
  outputTokens: number,
): bigint {
  const input = BigInt(inputTokens);
  const output = BigInt(outputTokens);
  const numerator = inputRate.numerator * input * outputRate.denominator +
    outputRate.numerator * output * inputRate.denominator;
  const denominator = inputRate.denominator * outputRate.denominator;
  // 100 credits / USD and 10^6 microcredits / credit cancel the 10^6
  // tokens-per-million denominator.
  return (numerator * 100n + denominator - 1n) / denominator;
}

export function reserveMicrocredits(
  inputRate: Rational,
  outputRate: Rational,
  maxInputTokens: number,
  maxOutputTokens: number,
  reserveInputRate: Rational = inputRate,
): bigint {
  return microcreditsForUsage(reserveInputRate, outputRate, maxInputTokens, maxOutputTokens);
}

export function providerCostUsd(
  inputRate: Rational,
  outputRate: Rational,
  inputTokens: number,
  outputTokens: number,
): string {
  const numerator = inputRate.numerator * BigInt(inputTokens) * outputRate.denominator +
    outputRate.numerator * BigInt(outputTokens) * inputRate.denominator;
  const denominator = inputRate.denominator * outputRate.denominator * 1_000_000n;
  return rationalToDecimal({ numerator, denominator });
}

function rationalCostUsd(terms: Array<{ rate: Rational; tokens: number }>): string {
  let numerator = 0n;
  let denominator = 1n;
  for (const { rate, tokens } of terms) {
    if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error("Invalid provider token usage.");
    numerator = numerator * rate.denominator + rate.numerator * BigInt(tokens) * denominator;
    denominator *= rate.denominator;
  }
  return rationalToDecimal({ numerator, denominator: denominator * 1_000_000n });
}

export function providerCostUsdForUsage(
  model: CustomerModel,
  usage: ProviderTokenUsage,
): string | undefined {
  if (model.provider === "openrouter") {
    const reported = usage.reportedCostUsd ? parseDecimal(usage.reportedCostUsd) : undefined;
    return reported ? rationalToDecimal(reported) : undefined;
  }
  if (!Number.isSafeInteger(usage.inputTokens) || usage.inputTokens < 0 ||
      !Number.isSafeInteger(usage.outputTokens) || usage.outputTokens < 0) return undefined;
  if (model.provider === "openai" &&
      (!Number.isSafeInteger(usage.cachedInputTokens) || (usage.cachedInputTokens ?? -1) < 0 ||
       !Number.isSafeInteger(usage.thoughtsTokens) || (usage.thoughtsTokens ?? -1) < 0)) return undefined;
  if (model.provider === "anthropic" &&
      (!Number.isSafeInteger(usage.cacheReadInputTokens) || (usage.cacheReadInputTokens ?? -1) < 0 ||
       !Number.isSafeInteger(usage.cacheWrite5mTokens) || (usage.cacheWrite5mTokens ?? -1) < 0 ||
       !Number.isSafeInteger(usage.cacheWrite1hTokens) || (usage.cacheWrite1hTokens ?? -1) < 0)) return undefined;
  if (model.provider === "gemini" &&
      (!Number.isSafeInteger(usage.cachedInputTokens) || (usage.cachedInputTokens ?? -1) < 0 ||
       !Number.isSafeInteger(usage.thoughtsTokens) || (usage.thoughtsTokens ?? -1) < 0)) return undefined;
  const inputRate = model.inputCostUsdPerMillion ? parseDecimal(model.inputCostUsdPerMillion) : undefined;
  const outputRate = model.outputCostUsdPerMillion ? parseDecimal(model.outputCostUsdPerMillion) : undefined;
  if (!inputRate || !outputRate) return undefined;

  const cachedInputTokens = usage.cachedInputTokens ?? 0;
  const cacheReadInputTokens = usage.cacheReadInputTokens ?? 0;
  const cacheWrite5mTokens = usage.cacheWrite5mTokens ?? 0;
  const cacheWrite1hTokens = usage.cacheWrite1hTokens ?? 0;
  const specialInputTokens = cachedInputTokens + cacheReadInputTokens + cacheWrite5mTokens + cacheWrite1hTokens;
  if (!Number.isSafeInteger(specialInputTokens) || specialInputTokens > usage.inputTokens) return undefined;
  const terms: Array<{ rate: Rational; tokens: number }> = [
    { rate: inputRate, tokens: usage.inputTokens - specialInputTokens },
  ];
  const addRateTerm = (field: string | null, tokens: number): boolean => {
    if (tokens === 0) return true;
    const rate = field ? parseDecimal(field) : undefined;
    if (!rate) return false;
    terms.push({ rate, tokens });
    return true;
  };
  if (!addRateTerm(model.cachedInputCostUsdPerMillion, cachedInputTokens) ||
      !addRateTerm(model.cacheReadCostUsdPerMillion, cacheReadInputTokens) ||
      !addRateTerm(model.cacheWrite5mCostUsdPerMillion, cacheWrite5mTokens) ||
      !addRateTerm(model.cacheWrite1hCostUsdPerMillion, cacheWrite1hTokens)) return undefined;
  terms.push({ rate: outputRate, tokens: usage.outputTokens });
  return rationalCostUsd(terms);
}

export function microcreditsForUsd(providerCostUsdExact: string): bigint | undefined {
  const usd = parseDecimal(providerCostUsdExact);
  if (!usd) return undefined;
  return (usd.numerator * 100_000_000n + usd.denominator - 1n) / usd.denominator;
}

export function reserveInputRate(model: CustomerModel): Rational | undefined {
  const input = model.inputCostUsdPerMillion ? parseDecimal(model.inputCostUsdPerMillion) : undefined;
  if (!input) return undefined;
  if (model.provider === "anthropic") {
    const longWrite = model.cacheWrite1hCostUsdPerMillion
      ? parseDecimal(model.cacheWrite1hCostUsdPerMillion)
      : undefined;
    return longWrite ?? input;
  }
  return input;
}

export function microcreditsToDecimal(microcredits: bigint): string {
  if (microcredits < 0n) throw new Error("Credit amount must be nonnegative.");
  return rationalToDecimal({ numerator: microcredits, denominator: 1_000_000n });
}

type PricingSnapshot = {
  input: Rational;
  output: Rational;
  cachedInput?: Rational;
  cacheWrite5m?: Rational;
  cacheWrite1h?: Rational;
  cacheRead?: Rational;
  source: string;
  verifiedAt: Date;
  expiresAt: Date;
};

const BUILTIN_PRICING_VERIFIED_AT = new Date("2026-10-01T00:00:00.000Z");
const BUILTIN_PRICING_EXPIRES_AT = new Date("2026-10-31T00:00:00.000Z");
const OPENAI_PRICING_SOURCE = "https://developers.openai.com/api/docs/pricing";
const ANTHROPIC_PRICING_SOURCE = "https://platform.claude.com/docs/en/about-claude/pricing";
const GEMINI_PRICING_SOURCE = "https://ai.google.dev/gemini-api/docs/pricing";

function multiplyRate(value: Rational, numerator: bigint, denominator = 1n): Rational {
  return { numerator: value.numerator * numerator, denominator: value.denominator * denominator };
}

function makeSnapshot(
  inputUsdPerMillion: string,
  outputUsdPerMillion: string,
  source: string,
  options: {
    cachedInputUsdPerMillion?: string;
    cacheWrite5mUsdPerMillion?: string;
    cacheWrite1hUsdPerMillion?: string;
    cacheReadUsdPerMillion?: string;
  } = {},
): PricingSnapshot {
  const input = parseDecimal(inputUsdPerMillion);
  const output = parseDecimal(outputUsdPerMillion);
  if (!input || !output) throw new Error("Invalid built-in customer pricing snapshot.");
  return {
    input,
    output,
    ...(options.cachedInputUsdPerMillion ? { cachedInput: parseDecimal(options.cachedInputUsdPerMillion)! } : {}),
    ...(options.cacheWrite5mUsdPerMillion ? { cacheWrite5m: parseDecimal(options.cacheWrite5mUsdPerMillion)! } : {}),
    ...(options.cacheWrite1hUsdPerMillion ? { cacheWrite1h: parseDecimal(options.cacheWrite1hUsdPerMillion)! } : {}),
    ...(options.cacheReadUsdPerMillion ? { cacheRead: parseDecimal(options.cacheReadUsdPerMillion)! } : {}),
    source,
    verifiedAt: BUILTIN_PRICING_VERIFIED_AT,
    expiresAt: BUILTIN_PRICING_EXPIRES_AT,
  };
}

const BUILTIN_PRICING: ReadonlyMap<string, PricingSnapshot> = new Map([
  ["openai/gpt-6-astra", makeSnapshot("10", "50", OPENAI_PRICING_SOURCE, { cachedInputUsdPerMillion: "1" })],
  ["openai/gpt-6.1-sol", makeSnapshot("2", "10", OPENAI_PRICING_SOURCE, { cachedInputUsdPerMillion: "0.10" })],
  ["openai/gpt-6-luna", makeSnapshot("0.10", "0.50", OPENAI_PRICING_SOURCE, { cachedInputUsdPerMillion: "0.01" })],
  ["openai/gpt-5.6-sol", makeSnapshot("4", "20", OPENAI_PRICING_SOURCE, { cachedInputUsdPerMillion: "0.40" })],
  ["openai/gpt-5.3-codex", makeSnapshot("1.75", "14", OPENAI_PRICING_SOURCE, { cachedInputUsdPerMillion: "0.175" })],
  ...[
    ["claude-opus-5", "5", "25"],
    ["claude-opus-4-8", "5", "25"],
    ["claude-opus-4-7", "5", "25"],
    ["claude-opus-4-6", "5", "25"],
    ["claude-opus-4-5", "5", "25"],
    ["claude-opus-4-1", "15", "75"],
    ["claude-sonnet-5", "2", "10"],
    ["claude-sonnet-4-6", "3", "15"],
    ["claude-sonnet-4-5", "3", "15"],
    ["claude-haiku-4-5", "1", "5"],
  ].map(([id, inputPrice, outputPrice]) => {
    const input = parseDecimal(inputPrice)!;
    return [
      `anthropic/${id}`,
      makeSnapshot(inputPrice, outputPrice, ANTHROPIC_PRICING_SOURCE, {
        cacheWrite5mUsdPerMillion: rationalToDecimal(multiplyRate(input, 5n, 4n)),
        cacheWrite1hUsdPerMillion: rationalToDecimal(multiplyRate(input, 2n)),
        cacheReadUsdPerMillion: rationalToDecimal(multiplyRate(input, 1n, 10n)),
      }),
    ] as const;
  }),
  ["gemini/gemini-3.1-pro-preview", makeSnapshot("2", "12", GEMINI_PRICING_SOURCE, { cachedInputUsdPerMillion: "0.20" })],
]);

function validConfiguredRate(
  raw: unknown,
): PricingSnapshot | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const config = raw as Partial<PriceConfig>;
  if (typeof config.inputUsdPerMillion !== "string" || typeof config.outputUsdPerMillion !== "string") return undefined;
  if (typeof config.sourceUrl !== "string" || typeof config.verifiedAt !== "string") return undefined;
  const input = parseDecimal(config.inputUsdPerMillion);
  const output = parseDecimal(config.outputUsdPerMillion);
  const verifiedAt = new Date(config.verifiedAt);
  let source: URL;
  try {
    source = new URL(config.sourceUrl);
  } catch {
    return undefined;
  }
  if (!input || !output || (input.numerator === 0n && output.numerator === 0n) ||
      source.protocol !== "https:" || !Number.isFinite(verifiedAt.getTime()) ||
      verifiedAt.toISOString() !== config.verifiedAt) return undefined;
  const optionalRate = (value: unknown): Rational | undefined => {
    if (value === undefined) return undefined;
    return typeof value === "string" ? parseDecimal(value) : undefined;
  };
  const cachedInput = optionalRate(config.cachedInputUsdPerMillion);
  const cacheWrite5m = optionalRate(config.cacheWrite5mUsdPerMillion);
  const cacheWrite1h = optionalRate(config.cacheWrite1hUsdPerMillion);
  const cacheRead = optionalRate(config.cacheReadUsdPerMillion);
  if ((config.cachedInputUsdPerMillion !== undefined && !cachedInput) ||
      (config.cacheWrite5mUsdPerMillion !== undefined && !cacheWrite5m) ||
      (config.cacheWrite1hUsdPerMillion !== undefined && !cacheWrite1h) ||
      (config.cacheReadUsdPerMillion !== undefined && !cacheRead)) return undefined;
  return {
    input,
    output,
    cachedInput,
    cacheWrite5m,
    cacheWrite1h,
    cacheRead,
    source: source.toString(),
    verifiedAt,
    expiresAt: new Date(verifiedAt.getTime() + 30 * 24 * 60 * 60 * 1000),
  };
}

function readConfiguredPrices(): Map<string, PricingSnapshot | undefined> {
  const result = new Map<string, PricingSnapshot | undefined>();
  const raw = process.env.CUSTOMER_MODEL_COSTS_JSON;
  if (!raw) return result;
  try {
    const entries = JSON.parse(raw) as Record<string, unknown>;
    for (const [key, value] of Object.entries(entries)) {
      const slash = key.indexOf("/");
      if (slash < 1) continue;
      const provider = key.slice(0, slash) as CustomerProvider;
      if (provider !== "openai" && provider !== "anthropic" && provider !== "gemini") continue;
      result.set(key, validConfiguredRate(value));
    }
  } catch {
    return result;
  }
  return result;
}

function providerConfigured(provider: CustomerProvider): boolean {
  switch (provider) {
    case "openai":
      return Boolean(process.env.AI_INTEGRATIONS_OPENAI_BASE_URL && process.env.AI_INTEGRATIONS_OPENAI_API_KEY);
    case "anthropic":
      return Boolean(process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL && process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY);
    case "gemini":
      return Boolean(process.env.AI_INTEGRATIONS_GEMINI_BASE_URL && process.env.AI_INTEGRATIONS_GEMINI_API_KEY);
    case "openrouter":
      return Boolean(process.env.AI_INTEGRATIONS_OPENROUTER_BASE_URL && process.env.AI_INTEGRATIONS_OPENROUTER_API_KEY);
    case "jev":
      return Boolean(process.env.AI_INTEGRATIONS_OPENROUTER_BASE_URL && process.env.AI_INTEGRATIONS_OPENROUTER_API_KEY);
  }
}

type OpenRouterModel = {
  id?: unknown;
  name?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown };
  architecture?: { output_modalities?: unknown };
};
let openRouterCache: { expiresAt: number; entries: OpenRouterModel[] } | undefined;

async function getOpenRouterModels(nowMs: number): Promise<{ entries: OpenRouterModel[]; error?: string }> {
  if (openRouterCache && openRouterCache.expiresAt > nowMs) return { entries: openRouterCache.entries };
  try {
    const response = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return { entries: [], error: "OpenRouter live model pricing is unavailable." };
    const body = await response.json() as { data?: unknown };
    if (!Array.isArray(body.data)) return { entries: [], error: "OpenRouter live model catalog returned an invalid response." };
    const entries = body.data as OpenRouterModel[];
    openRouterCache = { entries, expiresAt: nowMs + 5 * 60 * 1000 };
    return { entries };
  } catch {
    return { entries: [], error: "OpenRouter live model pricing is unavailable." };
  }
}

function openRouterRate(value: unknown): Rational | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  return parseDecimal(String(value));
}

function getUnavailableReason(input: {
  handler: boolean;
  rateAvailable: boolean;
  pricingFresh: boolean;
  usageCostAdapterAvailable: boolean;
  providerAvailable: boolean;
  gatewayAvailable: boolean;
}): string | null {
  if (!input.handler) return "This model capability is not implemented by the metered customer gateway.";
  if (!input.usageCostAdapterAvailable) return "Exact cached/reasoning token cost data is not supported by this model's billing adapter.";
  if (!input.rateAvailable) return "No current, source-verified cost configuration is available for this model.";
  if (!input.pricingFresh) return "The verified provider pricing snapshot has expired and requires review.";
  if (!input.providerAvailable) return "The model provider integration is not configured.";
  if (!input.gatewayAvailable) return "On-chain customer gateway configuration is incomplete or disabled.";
  return null;
}

function usageCostAdapterAvailable(provider: CustomerProvider, rate?: PricingSnapshot): boolean {
  if (provider === "openrouter") return true;
  if (!rate) return false;
  if (provider === "openai" || provider === "gemini") return Boolean(rate.cachedInput);
  if (provider === "anthropic") {
    return Boolean(rate.cacheRead && rate.cacheWrite5m && rate.cacheWrite1h);
  }
  return false;
}

export async function listCustomerModels(): Promise<CustomerModel[]> {
  const nowMs = Date.now();
  const prices = readConfiguredPrices();
  const gatewayAvailable = isCustomerGatewayConfigured();
  const models: CustomerModel[] = [];

  for (const model of REPLIT_MODELS) {
    const key = `${model.provider}/${model.id}`;
    const hasConfiguredSnapshot = prices.has(key);
    const configured = prices.get(key);
    const builtIn = BUILTIN_PRICING.get(key);
    const rate = hasConfiguredSnapshot
      ? configured && configured.expiresAt.getTime() > nowMs ? configured : undefined
      : builtIn;
    const pricingFresh = Boolean(rate && rate.expiresAt.getTime() > nowMs);
    const adaptedRate = rate && pricingFresh ? rate : undefined;
    const zeroRates = Boolean(rate && rate.input.numerator === 0n && rate.output.numerator === 0n);
    const unavailableReason = getUnavailableReason({
      handler: model.handler,
      rateAvailable: Boolean(adaptedRate && !zeroRates),
      pricingFresh,
      usageCostAdapterAvailable: usageCostAdapterAvailable(model.provider, adaptedRate),
      providerAvailable: providerConfigured(model.provider),
      gatewayAvailable,
    });
    models.push({
      ...model,
      inputCostUsdPerMillion: rate ? rationalToDecimal(rate.input) : null,
      outputCostUsdPerMillion: rate ? rationalToDecimal(rate.output) : null,
      cachedInputCostUsdPerMillion: rate?.cachedInput ? rationalToDecimal(rate.cachedInput) : null,
      cacheWrite5mCostUsdPerMillion: rate?.cacheWrite5m ? rationalToDecimal(rate.cacheWrite5m) : null,
      cacheWrite1hCostUsdPerMillion: rate?.cacheWrite1h ? rationalToDecimal(rate.cacheWrite1h) : null,
      cacheReadCostUsdPerMillion: rate?.cacheRead ? rationalToDecimal(rate.cacheRead) : null,
      available: unavailableReason === null,
      unavailableReason,
      maxInputTokens: MAX_INPUT_TOKENS,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      pricingSource: rate?.source ?? null,
      pricingVerifiedAt: rate?.verifiedAt ?? null,
      pricingExpiresAt: rate?.expiresAt ?? null,
      pricingType: adaptedRate ? "token-breakdown" : "unavailable",
    });
  }

  const openRouter = await getOpenRouterModels(nowMs);
  if (openRouter.error) throw new Error(openRouter.error);
  for (const model of openRouter.entries) {
    if (typeof model.id !== "string" || !model.id || model.id.length > 200) continue;
    const outputModalities = Array.isArray(model.architecture?.output_modalities)
      ? model.architecture.output_modalities
      : [];
    const chatHandler = outputModalities.includes("text");
    const input = openRouterRate(model.pricing?.prompt);
    const output = openRouterRate(model.pricing?.completion);
    const rateAvailable = Boolean(input && output && (input.numerator > 0n || output.numerator > 0n));
    const freeModel = Boolean(input && output && input.numerator === 0n && output.numerator === 0n);
    const unavailableReason = freeModel
      ? "Free OpenRouter models are unavailable for metered inference."
      : getUnavailableReason({
        handler: chatHandler,
        rateAvailable,
        pricingFresh: true,
        usageCostAdapterAvailable: true,
        providerAvailable: providerConfigured("openrouter"),
        gatewayAvailable,
      });
    models.push({
      provider: "openrouter",
      id: model.id,
      name: typeof model.name === "string" ? model.name : model.id,
      inputCostUsdPerMillion: input ? rationalToDecimal({ numerator: input.numerator * 1_000_000n, denominator: input.denominator }) : null,
      outputCostUsdPerMillion: output ? rationalToDecimal({ numerator: output.numerator * 1_000_000n, denominator: output.denominator }) : null,
      cachedInputCostUsdPerMillion: null,
      cacheWrite5mCostUsdPerMillion: null,
      cacheWrite1hCostUsdPerMillion: null,
      cacheReadCostUsdPerMillion: null,
      capabilities: chatHandler ? ["text-generation"] : [],
      available: !unavailableReason,
      unavailableReason: unavailableReason ?? null,
      maxInputTokens: MAX_INPUT_TOKENS,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      pricingSource: "https://openrouter.ai/api/v1/models",
      pricingVerifiedAt: new Date(nowMs),
      pricingExpiresAt: new Date(nowMs + 5 * 60 * 1000),
      pricingType: input && output ? "reported-cost" : "unavailable",
    });
  }

  return models;
}

export async function findCustomerModel(provider: CustomerProvider, id: string): Promise<CustomerModel | undefined> {
  return (await listCustomerModels()).find((model) => model.provider === provider && model.id === id);
}

export async function resolveCustomerModel(requestedId: string): Promise<CustomerModel | undefined> {
  const models = await listCustomerModels();
  const qualified = models.find((model) => `${model.provider}/${model.id}` === requestedId);
  if (qualified) return qualified;
  const matches = models.filter((model) => model.id === requestedId);
  return matches.length === 1 ? matches[0] : undefined;
}