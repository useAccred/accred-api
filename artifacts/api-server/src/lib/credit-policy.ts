export type CreditChain = "robinhood" | "solana";
export type CreditMode = "buy" | "swap" | "redeem";

export function parseDecimalAmount(value: string, maxDecimals = 18): { units: bigint; normalized: string } | undefined {
  if (typeof value !== "string" || value.length > 80 || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return undefined;
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > maxDecimals || (whole.length > 1 && whole.startsWith("0"))) return undefined;
  const units = BigInt(whole) * 10n ** BigInt(maxDecimals) + BigInt((fraction + "0".repeat(maxDecimals)).slice(0, maxDecimals) || "0");
  if (units <= 0n) return undefined;
  return { units, normalized: formatUnits(units, maxDecimals) };
}

export function formatUnits(units: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = units / base;
  const remainder = units % base;
  if (remainder === 0n) return whole.toString();
  return `${whole}.${remainder.toString().padStart(decimals, "0").replace(/0+$/, "")}`;
}

export function isTxHash(value: unknown, chain: CreditChain): value is string {
  return typeof value === "string" && (chain === "robinhood"
    ? /^0x[a-fA-F0-9]{64}$/.test(value)
    : /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value));
}

export function decimalToUnits(value: string, decimals: number): bigint | undefined {
  const parsed = parseDecimalAmount(value, decimals);
  return parsed?.units;
}

export function validateQuoteAmounts(inputAmount: unknown, outputAmount: unknown, netUsdMicros: unknown): boolean {
  if (typeof inputAmount !== "string" || typeof outputAmount !== "string" ||
      typeof netUsdMicros !== "string" || !/^\d+$/.test(netUsdMicros)) return false;
  return Boolean(parseDecimalAmount(inputAmount) && parseDecimalAmount(outputAmount) && BigInt(netUsdMicros) > 0n);
}