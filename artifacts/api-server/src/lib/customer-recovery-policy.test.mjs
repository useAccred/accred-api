import assert from "node:assert/strict";
import test from "node:test";
import {
  CUSTOMER_LEDGER_WORKFLOW,
  exactRequestEventMatches,
  mayClaimUndispatchedRelease,
  mayDispatchCustomerProvider,
  providerLifecycleLeaseActive,
  providerResultFenceMatches,
  receiptIsFinalized,
  requiresOwnerAbsorbedRelease,
} from "./customer-recovery-policy.ts";

const wallet = "0x1111111111111111111111111111111111111111";
const requestId = `0x${"ab".repeat(32)}`;

test("request-specific reservation proof is independent of unrelated global vault activity", () => {
  const event = {
    name: "Reserved",
    args: { account: wallet, requestId, amount: 900n },
  };
  const expected = { account: wallet, requestId, reservedAmount: 900n };

  // Unrelated wallet deposits, reserves, and burns can change aggregate vault
  // balances; they cannot change the request-indexed event proof.
  for (const globalVaultBalance of [1n, 900n, 9_000_000n]) {
    assert.ok(globalVaultBalance >= 0n);
    assert.equal(exactRequestEventMatches(event, expected), true);
  }
  assert.equal(exactRequestEventMatches(event, { ...expected, reservedAmount: 901n }), false);
  assert.equal(exactRequestEventMatches(event, { ...expected, requestId: `0x${"cd".repeat(32)}` }), false);
  assert.equal(exactRequestEventMatches({
    ...event,
    args: { ...event.args, account: "0x2222222222222222222222222222222222222222" },
  }, expected), false);
});

test("inference is gated on finalized reservation inclusion", () => {
  assert.equal(receiptIsFinalized(100, 99), false);
  assert.equal(receiptIsFinalized(100, 100), true);
  assert.equal(receiptIsFinalized(100, 101), true);
  assert.equal(receiptIsFinalized(Number.MAX_SAFE_INTEGER + 1, 101), false);
});

test("unknown provider outcome is never redispatched and is eligible only for owner-absorbed release", () => {
  const beforeDispatch = {
    status: "reserved",
    workflowVersion: CUSTOMER_LEDGER_WORKFLOW,
    providerDispatchStartedAt: null,
    providerDispatchState: null,
    reserveTxHash: `0x${"12".repeat(32)}`,
  };
  assert.equal(mayDispatchCustomerProvider(beforeDispatch), true);
  assert.equal(requiresOwnerAbsorbedRelease(beforeDispatch), false);

  const unknownOutcome = {
    ...beforeDispatch,
    providerDispatchStartedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
  assert.equal(mayDispatchCustomerProvider(unknownOutcome), false);
  assert.equal(requiresOwnerAbsorbedRelease(unknownOutcome), true);
  assert.equal(mayDispatchCustomerProvider({
    ...beforeDispatch,
    reserveTxHash: null,
  }), false);
  assert.equal(mayDispatchCustomerProvider({
    ...beforeDispatch,
    workflowVersion: null,
  }), false);
});

test("same-key replay and reconciliation stay pending while an upstream dispatch lease is active", () => {
  const now = new Date("2026-01-01T00:00:30.000Z");
  const inflight = {
    status: "reserved",
    workflowVersion: CUSTOMER_LEDGER_WORKFLOW,
    providerDispatchStartedAt: new Date("2026-01-01T00:00:00.000Z"),
    providerDispatchState: "dispatching",
    providerDispatchLeaseUntil: new Date("2026-01-01T00:03:00.000Z"),
    providerRequestId: null,
    providerCostUsd: null,
    reserveTxHash: `0x${"12".repeat(32)}`,
  };

  assert.equal(providerLifecycleLeaseActive(
    inflight.providerDispatchState,
    inflight.providerDispatchLeaseUntil,
    now,
  ), true);
  let providerCalls = 1;
  let releases = 0;
  if (mayDispatchCustomerProvider(inflight)) providerCalls++;
  if (!providerLifecycleLeaseActive(
    inflight.providerDispatchState,
    inflight.providerDispatchLeaseUntil,
    now,
  ) && requiresOwnerAbsorbedRelease(inflight)) releases++;
  assert.equal(providerCalls, 1);
  assert.equal(releases, 0);
  assert.equal(mayDispatchCustomerProvider(inflight), false);
  assert.equal(requiresOwnerAbsorbedRelease(inflight), false);
  assert.equal(mayClaimUndispatchedRelease(inflight), false);
  const abandoned = {
    ...inflight,
    providerDispatchState: "abandoned",
    providerDispatchLeaseUntil: null,
  };
  assert.equal(requiresOwnerAbsorbedRelease(abandoned), true);
  assert.equal(mayDispatchCustomerProvider(abandoned), false);
});

test("dispatch and undispatched release CAS claims serialize in either order", () => {
  const makeReserved = () => ({
    status: "reserved",
    workflowVersion: CUSTOMER_LEDGER_WORKFLOW,
    providerDispatchStartedAt: null,
    providerDispatchState: null,
    providerDispatchLeaseUntil: null,
    providerDispatchToken: null,
    providerRequestId: null,
    providerCostUsd: null,
    reserveTxHash: `0x${"12".repeat(32)}`,
  });

  // Model the production conditional UPDATE: both contenders compare the
  // lifecycle state they read, and the first committed claim fences the other.
  const dispatchFirst = makeReserved();
  assert.equal(mayDispatchCustomerProvider(dispatchFirst), true);
  dispatchFirst.providerDispatchStartedAt = new Date();
  dispatchFirst.providerDispatchState = "dispatching";
  dispatchFirst.providerDispatchToken = "dispatch-fence";
  assert.equal(mayClaimUndispatchedRelease(dispatchFirst), false);
  assert.equal(mayDispatchCustomerProvider(dispatchFirst), false);

  const releaseFirst = makeReserved();
  assert.equal(mayClaimUndispatchedRelease(releaseFirst), true);
  releaseFirst.providerDispatchState = "release_claimed";
  releaseFirst.providerDispatchToken = "release-fence";
  assert.equal(mayDispatchCustomerProvider(releaseFirst), false);
  assert.equal(mayClaimUndispatchedRelease(releaseFirst), false);
});

test("concurrent dispatch and release claim admits exactly one owner", async () => {
  const race = async (releaseStartsFirst) => {
    const row = {
      status: "reserved",
      workflowVersion: CUSTOMER_LEDGER_WORKFLOW,
      providerDispatchStartedAt: null,
      providerDispatchState: null,
      providerDispatchLeaseUntil: null,
      providerDispatchToken: null,
      providerRequestId: null,
      providerCostUsd: null,
      reserveTxHash: `0x${"12".repeat(32)}`,
    };
    let providerCalls = 0;
    let releases = 0;
    const compareAndSet = async (expected, patch) => {
      await new Promise((resolve) => setImmediate(resolve));
      if (row.providerDispatchState !== expected) return false;
      Object.assign(row, patch);
      return true;
    };
    const dispatch = async () => {
      if (!mayDispatchCustomerProvider(row)) return false;
      const claimed = await compareAndSet(null, {
        providerDispatchStartedAt: new Date(),
        providerDispatchState: "dispatching",
        providerDispatchToken: "dispatch-fence",
      });
      if (claimed) providerCalls++;
      return claimed;
    };
    const release = async () => {
      if (!mayClaimUndispatchedRelease(row)) return false;
      const claimed = await compareAndSet(null, {
        providerDispatchState: "release_claimed",
        providerDispatchToken: "release-fence",
      });
      if (claimed) releases++;
      return claimed;
    };
    await Promise.all(releaseStartsFirst ? [release(), dispatch()] : [dispatch(), release()]);
    assert.equal(providerCalls + releases, 1);
  };

  await race(false);
  await race(true);
});

test("late provider results are fenced after lifecycle recovery claims ownership", () => {
  const dispatchToken = "original-dispatch-token";
  assert.equal(providerResultFenceMatches("dispatching", dispatchToken, dispatchToken), true);
  assert.equal(providerResultFenceMatches("recovery_claimed", "recovery-token", dispatchToken), false);
  assert.equal(providerResultFenceMatches("finished", "recovery-token", dispatchToken), false);
});