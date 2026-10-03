/**
 * Pure eligibility calculation. This never transfers USDG or authenticates an event.
 * A trusted chain indexer must classify flows; a DB transaction must lock the
 * account and funded reserve, deduplicate economicActionId, persist the award,
 * and only then authorize any on-chain payment. Never expose this to public input.
 */
import { randomInt } from "node:crypto";

export type CashbackEventKind =
  | "deposit"
  | "swap"
  | "buy"
  | "stake"
  | "eligible_transaction";

export type EconomicFlow =
  | "net_new"
  | "self_transfer"
  | "round_trip"
  | "repeated_deposit_withdraw"
  | "unclassified";

export type VerifiedCashbackEvent = {
  economicActionId: string;
  kind: CashbackEventKind;
  flow: EconomicFlow;
  confirmed: boolean;
  usdAmountMicros: bigint;
  occurredAtMs: number;
};

export type RecordedAward = {
  economicActionId: string;
  authorizedAtMs: number;
  usdgAmountMicros: bigint;
};

type CashbackContext = {
  event: VerifiedCashbackEvent;
  priorAwards: readonly RecordedAward[];
  nowMs: number;
  cooldownUntilMs: number;
  fundedAvailableUsdgMicros: bigint;
};

export type CashbackDecision =
  | { eligible: false; reason: string }
  | {
      eligible: true;
      amountUsdgMicros: bigint;
      economicActionId: string;
      nextCooldownUntilMs: number;
    };

const HOUR_MS = 60 * 60 * 1000;
const HOURLY_CAP_USDG_MICROS = 10_000_000n;

/** Flat cashback on every swap (basis points): 10%. */
export const FLAT_CASHBACK_BPS = 1000;
/** Largest single cashback payout (USDG six-decimal units), matching the payout wallet's per-transfer limit. */
export const MAX_CASHBACK_USDG_MICROS = 10_000_000n;

export function chooseCashbackBps(): number {
  return FLAT_CASHBACK_BPS;
}

/** USD value and USDG are both represented as integer six-decimal units. Capped at one payout. */
export function cashbackAmountForQuote(netUsdMicros: bigint, percentBps: number): bigint | undefined {
  if (netUsdMicros <= 0n || percentBps !== FLAT_CASHBACK_BPS) return undefined;
  const amount = netUsdMicros * BigInt(percentBps) / 10_000n;
  if (amount <= 0n) return undefined;
  return amount > MAX_CASHBACK_USDG_MICROS ? MAX_CASHBACK_USDG_MICROS : amount;
}

export function decideCashback({
  event,
  priorAwards,
  nowMs,
  cooldownUntilMs,
  fundedAvailableUsdgMicros,
}: CashbackContext): CashbackDecision {
  if (
    !Number.isSafeInteger(nowMs) ||
    !Number.isSafeInteger(cooldownUntilMs) ||
    !Number.isSafeInteger(event.occurredAtMs) ||
    !event.economicActionId.trim() ||
    event.usdAmountMicros <= 0n ||
    fundedAvailableUsdgMicros < 0n
  ) {
    return { eligible: false, reason: "invalid_event_or_account_state" };
  }
  if (!event.confirmed || event.occurredAtMs > nowMs) {
    return { eligible: false, reason: "not_confirmed" };
  }
  if (event.flow !== "net_new") {
    return { eligible: false, reason: "recycled_or_unclassified_funds" };
  }
  if (priorAwards.some((award) => award.economicActionId === event.economicActionId)) {
    return { eligible: false, reason: "economic_action_already_rewarded" };
  }
  if (cooldownUntilMs > nowMs) {
    return { eligible: false, reason: "cooldown_active" };
  }
  // The cap is based on when the reward was authorized, not the chain event's
  // time. Delayed indexing must not let historical transactions evade the cap.
  const activeAwards = priorAwards.filter((award) =>
    award.authorizedAtMs > nowMs - HOUR_MS && award.authorizedAtMs <= nowMs
  );
  if (activeAwards.some((award) =>
    award.usdgAmountMicros < 0n || !Number.isSafeInteger(award.authorizedAtMs)
  )) {
    return { eligible: false, reason: "invalid_account_history" };
  }
  const paidThisHour = activeAwards.reduce((total, award) => total + award.usdgAmountMicros, 0n);
  const remaining = HOURLY_CAP_USDG_MICROS - paidThisHour;
  if (remaining <= 0n) {
    return { eligible: false, reason: "hourly_cap_reached" };
  }
  // USDG micro-units and input USD micro-units are both six decimal places.
  const requested = event.usdAmountMicros / 20n;
  const amount = requested < remaining ? requested : remaining;
  if (amount <= 0n) {
    return { eligible: false, reason: "below_smallest_usdg_unit" };
  }
  if (fundedAvailableUsdgMicros < amount) {
    return { eligible: false, reason: "reward_pool_unfunded" };
  }
  return {
    eligible: true,
    amountUsdgMicros: amount,
    economicActionId: event.economicActionId,
    nextCooldownUntilMs: amount === remaining ? nowMs + HOUR_MS : cooldownUntilMs,
  };
}