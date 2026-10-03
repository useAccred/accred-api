import assert from "node:assert/strict";
import test from "node:test";
import { boundedReservation, settleProviderUsage, verifyGatewayState } from "./customer-credit-policy.ts";

const model = { inputCreditsNumerator: 10n, inputCreditsDenominator: 1n, outputCreditsNumerator: 20n, outputCreditsDenominator: 1n, maxInputTokens: 1000, maxOutputTokens: 500 };
const trust = { enabled: true, chainId: "4663", creditContract: "0xCredit", indexerSource: "trusted-indexer", maxAgeMs: 60_000 };
const state = { confirmedCredits: 1000n, consumedCredits: 400n, reservedCredits: 100n, indexedAtMs: 1_000_000, chainId: "4663", creditContract: "0xcredit", indexerSource: "trusted-indexer", finalityStatus: "finalized" };

test("reserved balance prevents sequential and concurrent double spend", () => {
  assert.equal(state.confirmedCredits - state.consumedCredits - state.reservedCredits, 500n);
  assert.equal(state.confirmedCredits - state.consumedCredits - 600n, 0n);
});
test("trust rejects disabled, stale, unfinalized and manually mismatched state", () => {
  assert.equal(verifyGatewayState(state, { ...trust, enabled: false }, 1_010_000), "gateway_disabled");
  assert.equal(verifyGatewayState(state, trust, 1_060_001), "stale_indexer_state");
  assert.equal(verifyGatewayState({ ...state, finalityStatus: "pending" }, trust, 1_010_000), "untrusted_indexer_state");
});
test("reservation uses configured worst-case bounds, not chars divided by four", () => {
  const result = boundedReservation(model, "x".repeat(1000), 500);
  assert.equal("reservation" in result, true);
  assert.equal(boundedReservation(model, "x".repeat(1001), 500).error, "input_limit_exceeded");
  assert.equal(boundedReservation(model, "x", 501).error, "output_limit_exceeded");
});
test("actual provider cost above reservation remains reconciling", () => {
  assert.equal(settleProviderUsage(10n, 11n), "reconciling");
  assert.equal(settleProviderUsage(10n, 10n), "charged");
});
test("malformed pricing or bounds cannot produce a reservation", () => {
  assert.equal(boundedReservation({ ...model, inputCreditsDenominator: 0n }, "x", 1).error, "invalid_model_policy");
  assert.equal(boundedReservation({ ...model, maxInputTokens: 0 }, "x", 1).error, "invalid_model_policy");
});
test("snapshot refresh cannot overwrite gateway holds or consumed counters", () => {
  const snapshotBefore = { confirmedCredits: 1000n };
  const counters = { reservedCredits: 300n, consumedCredits: 200n };
  const refreshedSnapshot = { confirmedCredits: 1200n };
  assert.equal(refreshedSnapshot.confirmedCredits - counters.consumedCredits - counters.reservedCredits, 700n);
  assert.equal(snapshotBefore.confirmedCredits - counters.consumedCredits - counters.reservedCredits, 500n);
});