export const CUSTOMER_LEDGER_WORKFLOW = "customer-metering-v2";

export type ProviderLifecycleState =
  | "reservation_claimed"
  | "dispatching"
  | "completed"
  | "failed"
  | "abandoned"
  | "release_claimed"
  | "release_pending"
  | "recovery_claimed";

export function providerLifecycleLeaseActive(
  state: string | null,
  leaseUntil: Date | null,
  now: Date,
): boolean {
  return (state === "reservation_claimed" || state === "dispatching" ||
      state === "release_claimed" || state === "recovery_claimed") &&
    leaseUntil !== null && leaseUntil.getTime() > now.getTime();
}

export function providerResultFenceMatches(
  currentState: string | null,
  currentToken: string | null,
  expectedToken: string,
): boolean {
  return currentState === "dispatching" && currentToken === expectedToken;
}

export function mayClaimUndispatchedRelease(input: {
  status: string;
  providerDispatchStartedAt: Date | null;
  providerDispatchState: string | null;
  providerRequestId: string | null;
  providerCostUsd: string | null;
}): boolean {
  return input.status === "reserved" &&
    input.providerDispatchStartedAt === null &&
    input.providerRequestId === null &&
    input.providerCostUsd === null &&
    (input.providerDispatchState === null ||
      input.providerDispatchState === "reservation_abandoned" ||
      input.providerDispatchState === "release_pending");
}

export function receiptIsFinalized(receiptBlock: number, finalizedBlock: number): boolean {
  return Number.isSafeInteger(receiptBlock) &&
    Number.isSafeInteger(finalizedBlock) &&
    receiptBlock >= 0 &&
    finalizedBlock >= receiptBlock;
}

export function exactRequestEventMatches(
  event: {
    name: string;
    args: {
      account: string;
      requestId: string;
      amount?: bigint;
      actualAmount?: bigint;
      releasedAmount?: bigint;
    };
  },
  expected: { account: string; requestId: string; reservedAmount: bigint },
): boolean {
  if (event.args.account.toLowerCase() !== expected.account.toLowerCase() ||
      event.args.requestId.toLowerCase() !== expected.requestId.toLowerCase()) return false;
  if (event.name === "Reserved" || event.name === "Released") {
    return event.args.amount === expected.reservedAmount;
  }
  if (event.name === "Settled") {
    return event.args.actualAmount !== undefined &&
      event.args.releasedAmount !== undefined &&
      event.args.actualAmount >= 0n &&
      event.args.actualAmount <= expected.reservedAmount &&
      event.args.releasedAmount === expected.reservedAmount - event.args.actualAmount;
  }
  return false;
}

export function mayDispatchCustomerProvider(input: {
  status: string;
  workflowVersion: string | null;
  providerDispatchStartedAt: Date | null;
  providerDispatchState: string | null;
  reserveTxHash: string | null;
}): boolean {
  return input.status === "reserved" &&
    input.workflowVersion === CUSTOMER_LEDGER_WORKFLOW &&
    input.providerDispatchStartedAt === null &&
    input.providerDispatchState === null &&
    Boolean(input.reserveTxHash);
}

export function requiresOwnerAbsorbedRelease(input: {
  workflowVersion: string | null;
  providerDispatchStartedAt: Date | null;
  providerDispatchState: string | null;
}): boolean {
  if (input.workflowVersion !== CUSTOMER_LEDGER_WORKFLOW) return true;
  return input.providerDispatchState === "failed" ||
    (input.providerDispatchState === "abandoned" && input.providerDispatchStartedAt !== null) ||
    (input.providerDispatchStartedAt !== null &&
      input.providerDispatchState === null);
}