export type GatewayModel = {
  inputCreditsNumerator: bigint;
  inputCreditsDenominator: bigint;
  outputCreditsNumerator: bigint;
  outputCreditsDenominator: bigint;
  maxInputTokens: number;
  maxOutputTokens: number;
};

export type IndexedCreditState = {
  confirmedCredits: bigint;
  consumedCredits: bigint;
  reservedCredits: bigint;
  indexedAtMs: number;
  chainId: string;
  creditContract: string;
  indexerSource: string;
  finalityStatus: string;
};

export type GatewayTrust = {
  enabled: boolean;
  chainId: string;
  creditContract: string;
  indexerSource: string;
  maxAgeMs: number;
};

export function verifyGatewayState(
  state: IndexedCreditState,
  trust: GatewayTrust,
  nowMs: number,
): string | undefined {
  if (!trust.enabled) return "gateway_disabled";
  if (state.chainId !== trust.chainId || state.creditContract.toLowerCase() !== trust.creditContract.toLowerCase()) return "wrong_credit_network";
  if (state.indexerSource !== trust.indexerSource || state.finalityStatus !== "finalized") return "untrusted_indexer_state";
  if (!Number.isSafeInteger(state.indexedAtMs) || state.indexedAtMs > nowMs || nowMs - state.indexedAtMs > trust.maxAgeMs) return "stale_indexer_state";
  if (state.confirmedCredits < 0n || state.consumedCredits < 0n || state.reservedCredits < 0n || state.consumedCredits + state.reservedCredits > state.confirmedCredits) return "invalid_credit_accounting";
  return undefined;
}

export function boundedReservation(
  model: GatewayModel,
  messages: string,
  requestedOutputTokens: number,
): { reservation: bigint } | { error: string } {
  if (model.inputCreditsNumerator <= 0n || model.inputCreditsDenominator <= 0n ||
      model.outputCreditsNumerator <= 0n || model.outputCreditsDenominator <= 0n ||
      !Number.isSafeInteger(model.maxInputTokens) || !Number.isSafeInteger(model.maxOutputTokens) ||
      model.maxInputTokens <= 0 || model.maxOutputTokens <= 0) return { error: "invalid_model_policy" };
  if (requestedOutputTokens > model.maxOutputTokens) return { error: "output_limit_exceeded" };
  // UTF-8 bytes are a deliberately conservative upper bound for token count:
  // a tokenizer may encode every byte separately, so chars/4 is not safe.
  if (Buffer.byteLength(messages, "utf8") > model.maxInputTokens) return { error: "input_limit_exceeded" };
  const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
  const input = ceil(BigInt(model.maxInputTokens) * model.inputCreditsNumerator, model.inputCreditsDenominator * 1000n);
  const output = ceil(BigInt(model.maxOutputTokens) * model.outputCreditsNumerator, model.outputCreditsDenominator * 1000n);
  return { reservation: input + output };
}

export function settleProviderUsage(reserved: bigint, actual: bigint): "charged" | "reconciling" {
  return actual <= reserved ? "charged" : "reconciling";
}