import assert from "node:assert/strict";
import test from "node:test";
import { decideCashback } from "./cashback-policy.ts";

const nowMs = 1_800_000_000_000;
const event = {
  economicActionId: "4663:0xreceipt:0",
  kind: "swap",
  flow: "net_new",
  confirmed: true,
  usdAmountMicros: 10_000_000n,
  occurredAtMs: nowMs,
};
const evaluate = (changes = {}) => decideCashback({
  event,
  priorAwards: [],
  nowMs,
  cooldownUntilMs: 0,
  fundedAvailableUsdgMicros: 20_000_000n,
  ...changes,
});

test("pays 5% for a confirmed eligible $10 action", () => {
  assert.deepEqual(evaluate(), {
    eligible: true,
    amountUsdgMicros: 500_000n,
    economicActionId: event.economicActionId,
    nextCooldownUntilMs: 0,
  });
});

test("limits payout to remaining $10 per rolling hour and starts cooldown at the cap", () => {
  const decision = evaluate({
    priorAwards: [{
      economicActionId: "other-action",
      authorizedAtMs: nowMs - 30_000,
      usdgAmountMicros: 9_750_000n,
    }],
  });
  assert.equal(decision.eligible, true);
  assert.equal(decision.amountUsdgMicros, 250_000n);
  assert.equal(decision.nextCooldownUntilMs, nowMs + 3_600_000);
  assert.equal(evaluate({ cooldownUntilMs: nowMs + 3_600_000 }).reason, "cooldown_active");
});

test("excludes self-transfers, round trips, repeat deposits and unknown flows", () => {
  for (const flow of ["self_transfer", "round_trip", "repeated_deposit_withdraw", "unclassified"]) {
    assert.equal(evaluate({ event: { ...event, flow } }).reason, "recycled_or_unclassified_funds");
  }
});

test("rejects duplicate economic action even under another event label", () => {
  assert.equal(evaluate({
    event: { ...event, kind: "eligible_transaction" },
    priorAwards: [{ economicActionId: event.economicActionId, authorizedAtMs: nowMs, usdgAmountMicros: 500_000n }],
  }).reason, "economic_action_already_rewarded");
});

test("does not promise unfunded, pending or negligible payouts", () => {
  assert.equal(evaluate({ fundedAvailableUsdgMicros: 499_999n }).reason, "reward_pool_unfunded");
  assert.equal(evaluate({ event: { ...event, confirmed: false } }).reason, "not_confirmed");
  assert.equal(evaluate({ event: { ...event, usdAmountMicros: 1n } }).reason, "below_smallest_usdg_unit");
});

test("awards older than an hour do not consume the rolling cap", () => {
  assert.equal(evaluate({
    priorAwards: [{ economicActionId: "old", authorizedAtMs: nowMs - 3_600_001, usdgAmountMicros: 10_000_000n }],
  }).amountUsdgMicros, 500_000n);
});

test("delayed chain events count against the current authorization hour", () => {
  assert.equal(evaluate({
    event: { ...event, occurredAtMs: nowMs - 30 * 24 * 3_600_000 },
    priorAwards: [{
      economicActionId: "delayed-earlier-action",
      authorizedAtMs: nowMs - 15_000,
      usdgAmountMicros: 9_750_000n,
    }],
  }).amountUsdgMicros, 250_000n);
});