import { logger } from "./logger";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { keccak256, toUtf8Bytes } from "ethers";
import { db, creditUsageLedger, platformApiKeys, verifiedWalletOwnerships } from "@workspace/db";
import type { CustomerChatMessage, ProviderCompletion } from "./customer-provider";
import { CUSTOMER_PROVIDER_TIMEOUT_MS, CustomerProviderError, createProviderCompletion } from "./customer-provider";
import {
  microcreditsForUsd,
  microcreditsToDecimal,
  parseDecimal,
  providerCostUsdForUsage,
  reserveMicrocredits,
  reserveInputRate,
  resolveCustomerModel,
  type CustomerModel,
} from "./customer-models";
import {
  CustomerGatewayError,
  inspectOnchainReservation,
  releaseOnchain,
  reserveOnchain,
  settleOnchain,
  vaultUnitsToCreditsDecimal,
} from "./customer-gateway";
import {
  CUSTOMER_LEDGER_WORKFLOW,
  mayDispatchCustomerProvider,
  mayClaimUndispatchedRelease,
  providerLifecycleLeaseActive,
  requiresOwnerAbsorbedRelease,
} from "./customer-recovery-policy";

export type CustomerChatInput = {
  model: string;
  messages: CustomerChatMessage[];
  maxOutputTokens?: number;
};

export type CustomerChatOutput = {
  id: string;
  model: string;
  content: string;
  usage: { inputTokens: number; outputTokens: number };
  creditsCharged: number;
  creditsChargedExact: string;
  providerCostUsdExact: string;
  creditUnit: "service_credit";
  cashbackUsdExact: null;
  remainingCredits: number | null;
  remainingCreditsExact: string | null;
};

export type CustomerBillingResult =
  | { statusCode: 200; response: CustomerChatOutput }
  | { statusCode: 400 | 401 | 402 | 403 | 409 | 429 | 503; error: string };

const MICROcredits_PER_CREDIT = 1_000_000n;
const CHAIN_ID = "4663";
const PROVIDER_DISPATCH_LEASE_MS = CUSTOMER_PROVIDER_TIMEOUT_MS + 60_000;
const LEDGER_LIFECYCLE_LEASE_MS = 8 * 60_000;
const LEGACY_PROVIDER_DISPATCH_LEASE_MS = LEDGER_LIFECYCLE_LEASE_MS;

function leaseAfter(milliseconds: number) {
  return sql<Date>`now() + (${milliseconds} * interval '1 millisecond')`;
}

async function databaseNow(): Promise<Date> {
  const result = await db.execute(sql`SELECT now() AS now`);
  const value = (result.rows[0] as { now?: Date | string } | undefined)?.now;
  if (!value) throw new Error("database_clock_unavailable");
  return value instanceof Date ? value : new Date(value);
}

function safetyPolicy(): { userRpm: number; keyRpm: number; dailyBudgetMicrocredits: bigint } | undefined {
  const userRpm = Number(process.env.CUSTOMER_USER_RPM);
  const keyRpm = Number(process.env.CUSTOMER_KEY_RPM);
  const budget = process.env.CUSTOMER_DAILY_BUDGET_CREDITS;
  const parsedBudget = budget ? parseDecimal(budget) : undefined;
  if (!Number.isSafeInteger(userRpm) || userRpm < 1 || userRpm > 1000 ||
      !Number.isSafeInteger(keyRpm) || keyRpm < 1 || keyRpm > 1000 || !parsedBudget) return undefined;
  const dailyBudgetMicrocredits = parsedBudget.numerator * MICROcredits_PER_CREDIT / parsedBudget.denominator;
  if (dailyBudgetMicrocredits <= 0n) return undefined;
  return { userRpm, keyRpm, dailyBudgetMicrocredits };
}

function requestFingerprint(request: CustomerChatInput): string {
  const canonical = JSON.stringify({
    model: request.model,
    messages: request.messages.map(({ role, content }) => ({ role, content })),
    maxOutputTokens: request.maxOutputTokens ?? 1024,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function wholeCreditCompatibility(microcredits: bigint): bigint {
  return (microcredits + MICROcredits_PER_CREDIT - 1n) / MICROcredits_PER_CREDIT;
}

function makeResponse(input: {
  id: string;
  model: string;
  content: string;
  inputTokens: number;
  outputTokens: number;
  chargedMicrocredits: bigint;
  providerCostUsdExact: string;
  remainingCreditsExact: string | null;
}): CustomerChatOutput {
  const exact = microcreditsToDecimal(input.chargedMicrocredits);
  return {
    id: input.id,
    model: input.model,
    content: input.content,
    usage: { inputTokens: input.inputTokens, outputTokens: input.outputTokens },
    creditsCharged: Number(exact),
    creditsChargedExact: exact,
    providerCostUsdExact: input.providerCostUsdExact,
    creditUnit: "service_credit",
    cashbackUsdExact: null,
    remainingCredits: input.remainingCreditsExact === null ? null : Number(input.remainingCreditsExact),
    remainingCreditsExact: input.remainingCreditsExact,
  };
}

function replayResponse(row: typeof creditUsageLedger.$inferSelect): CustomerChatOutput | undefined {
  const settled = row.status === "charged" && row.chargedMicrocredits > 0n;
  const zeroCostReleased = row.status === "released" && row.chargedMicrocredits === 0n &&
    row.providerRequestId !== null && row.responseContent !== null &&
    row.providerCostUsd !== null && microcreditsForUsd(row.providerCostUsd) === 0n;
  if ((!settled && !zeroCostReleased) || !row.responseContent || !row.providerRequestId ||
      row.providerCostUsd === null) return undefined;
  return makeResponse({
    id: row.providerRequestId,
    model: row.model,
    content: row.responseContent,
    inputTokens: Number(row.inputTokens ?? 0n),
    outputTokens: Number(row.outputTokens ?? 0n),
    chargedMicrocredits: row.chargedMicrocredits,
    providerCostUsdExact: row.providerCostUsd,
    remainingCreditsExact: row.availableCreditsAfter,
  });
}

async function setLedgerState(
  ledgerId: string,
  status: string,
  errorCode: string,
  completed = false,
  reservationClaimToken?: string,
): Promise<void> {
  const [updated] = await db.update(creditUsageLedger).set({
    status,
    errorCode,
    providerDispatchState: status === "released" ? "finished" : "reservation_abandoned",
    providerDispatchToken: randomUUID(),
    providerDispatchLeaseUntil: null,
    ...(completed ? { completedAt: new Date() } : {}),
  }).where(reservationClaimToken
    ? and(
      eq(creditUsageLedger.id, ledgerId),
      eq(creditUsageLedger.providerDispatchState, "reservation_claimed"),
      eq(creditUsageLedger.providerDispatchToken, reservationClaimToken),
    )
    : eq(creditUsageLedger.id, ledgerId)).returning({ id: creditUsageLedger.id });
  if (!updated) throw new Error("ledger_write_failed");
}

async function findVerifiedWallet(ownerUserId: string): Promise<string | undefined> {
  const [ownership] = await db.select({ walletAddress: verifiedWalletOwnerships.walletAddress })
    .from(verifiedWalletOwnerships)
    .where(and(
      eq(verifiedWalletOwnerships.ownerUserId, ownerUserId),
      eq(verifiedWalletOwnerships.chainId, CHAIN_ID),
      isNull(verifiedWalletOwnerships.revokedAt),
    )).limit(1);
  return ownership?.walletAddress;
}

function receiptAmounts(model: CustomerModel): {
  inputRate: NonNullable<ReturnType<typeof parseDecimal>>;
  outputRate: NonNullable<ReturnType<typeof parseDecimal>>;
} | undefined {
  if (!model.inputCostUsdPerMillion || !model.outputCostUsdPerMillion) return undefined;
  const inputRate = parseDecimal(model.inputCostUsdPerMillion);
  const outputRate = parseDecimal(model.outputCostUsdPerMillion);
  return inputRate && outputRate ? { inputRate, outputRate } : undefined;
}

function usageLedgerFields(usage: ProviderCompletion) {
  return {
    cachedInputTokens: BigInt(usage.cachedInputTokens ?? 0),
    cacheReadInputTokens: BigInt(usage.cacheReadInputTokens ?? 0),
    cacheWrite5mTokens: BigInt(usage.cacheWrite5mTokens ?? 0),
    cacheWrite1hTokens: BigInt(usage.cacheWrite1hTokens ?? 0),
    thoughtsTokens: BigInt(usage.thoughtsTokens ?? 0),
  };
}

type CustomerLedgerRow = typeof creditUsageLedger.$inferSelect;
const VAULT_UNITS_PER_MICROCREDIT = 1_000_000_000_000n;

async function loadLedger(ledgerId: string, ownerUserId?: string): Promise<CustomerLedgerRow | undefined> {
  const [row] = await db.select().from(creditUsageLedger).where(ownerUserId
    ? and(eq(creditUsageLedger.id, ledgerId), eq(creditUsageLedger.ownerUserId, ownerUserId))
    : eq(creditUsageLedger.id, ledgerId)).limit(1);
  return row;
}

function providerResultStored(row: CustomerLedgerRow): boolean {
  return row.providerRequestId !== null || row.providerCostUsd !== null;
}

function nullableEq(column: any, value: string | Date | null) {
  if (value === null) return isNull(column);
  // Postgres keeps microseconds but JS Dates only milliseconds, so compare at millisecond precision.
  if (value instanceof Date) return sql`date_trunc('milliseconds', ${column}) = ${value.toISOString()}::timestamptz`;
  return eq(column, value);
}

async function refreshLifecycleLease(
  ownerUserId: string,
  initial: CustomerLedgerRow,
): Promise<{ row: CustomerLedgerRow; pending: boolean }> {
  let row = initial;
  for (let attempt = 0; attempt < 2; attempt++) {
    const now = await databaseNow();
    const state = row.providerDispatchState;
    const activeLifecycle = state === "reservation_claimed" ||
      state === "dispatching" || state === "release_claimed" || state === "recovery_claimed";

    if (activeLifecycle && (!row.providerDispatchLeaseUntil ||
        providerLifecycleLeaseActive(state, row.providerDispatchLeaseUntil, now))) {
      return { row, pending: true };
    }

    const legacyDispatchInFlight = state === null &&
      row.providerDispatchStartedAt !== null &&
      !providerResultStored(row);
    if (legacyDispatchInFlight) {
      const legacyLeaseUntil = new Date(row.providerDispatchStartedAt!.getTime() + LEGACY_PROVIDER_DISPATCH_LEASE_MS);
      if (legacyLeaseUntil.getTime() > now.getTime()) return { row, pending: true };
    }

    if (!activeLifecycle && !legacyDispatchInFlight) return { row, pending: false };

    const recoveryState = state === "release_claimed"
      ? "release_pending"
      : providerResultStored(row)
        ? "completed"
        : row.providerDispatchStartedAt
          ? "abandoned"
          : "reservation_abandoned";
    const token = randomUUID();
    const priorLease = row.providerDispatchLeaseUntil;
    const [updated] = await db.update(creditUsageLedger).set({
      providerDispatchState: recoveryState,
      providerDispatchToken: token,
      providerDispatchLeaseUntil: null,
      errorCode: recoveryState === "abandoned"
        ? "provider_outcome_unknown_owner_absorbed"
        : row.errorCode,
    }).where(and(
      eq(creditUsageLedger.id, row.id),
      eq(creditUsageLedger.status, row.status),
      nullableEq(creditUsageLedger.providerDispatchState, state),
      nullableEq(creditUsageLedger.providerDispatchToken, row.providerDispatchToken),
      nullableEq(creditUsageLedger.providerDispatchLeaseUntil, priorLease),
      ...(legacyDispatchInFlight
        ? [nullableEq(creditUsageLedger.providerDispatchStartedAt, row.providerDispatchStartedAt),
          isNull(creditUsageLedger.providerRequestId), isNull(creditUsageLedger.providerCostUsd)]
        : []),
    )).returning({ id: creditUsageLedger.id });
    if (updated) {
      const latest = await loadLedger(row.id, ownerUserId);
      if (latest) row = latest;
      return { row, pending: false };
    }
    const latest = await loadLedger(row.id, ownerUserId);
    if (!latest) return { row, pending: true };
    row = latest;
  }
  return { row, pending: providerLifecycleLeaseActive(
    row.providerDispatchState,
    row.providerDispatchLeaseUntil,
    await databaseNow(),
  ) };
}

async function claimLifecycleRecovery(
  row: CustomerLedgerRow,
  claimedState: "recovery_claimed" | "release_claimed" = "recovery_claimed",
): Promise<string | undefined> {
  if (claimedState === "release_claimed" && !mayClaimUndispatchedRelease(row)) return undefined;
  const token = randomUUID();
  const [claimed] = await db.update(creditUsageLedger).set({
    providerDispatchState: claimedState,
    providerDispatchToken: token,
    providerDispatchLeaseUntil: leaseAfter(LEDGER_LIFECYCLE_LEASE_MS),
  }).where(and(
    eq(creditUsageLedger.id, row.id),
    eq(creditUsageLedger.status, row.status),
    nullableEq(creditUsageLedger.providerDispatchState, row.providerDispatchState),
    nullableEq(creditUsageLedger.providerDispatchToken, row.providerDispatchToken),
    nullableEq(creditUsageLedger.providerDispatchLeaseUntil, row.providerDispatchLeaseUntil),
    nullableEq(creditUsageLedger.providerDispatchStartedAt, row.providerDispatchStartedAt),
  )).returning({ id: creditUsageLedger.id });
  return claimed ? token : undefined;
}

async function leaveLifecycleRecovery(
  ledgerId: string,
  recoveryToken: string,
  nextState: "completed" | "abandoned" | "reservation_abandoned" | "release_pending" | "failed",
  errorCode: string,
  claimState: "recovery_claimed" | "release_claimed" | "reservation_claimed" = "recovery_claimed",
): Promise<boolean> {
  const [updated] = await db.update(creditUsageLedger).set({
    providerDispatchState: nextState,
    providerDispatchToken: randomUUID(),
    providerDispatchLeaseUntil: null,
    status: "reconciling",
    errorCode,
  }).where(and(
    eq(creditUsageLedger.id, ledgerId),
    eq(creditUsageLedger.providerDispatchState, claimState),
    eq(creditUsageLedger.providerDispatchToken, recoveryToken),
  )).returning({ id: creditUsageLedger.id });
  return Boolean(updated);
}

async function persistSubmittedTransaction(
  ledgerId: string,
  kind: "reserve" | "settle" | "release",
  transactionHash: string,
): Promise<void> {
  const values = kind === "reserve"
    ? { reserveTxHash: transactionHash, errorCode: "reserve_submitted" }
    : kind === "settle"
      ? { settleTxHash: transactionHash, errorCode: "settlement_submitted" }
      : { releaseTxHash: transactionHash, errorCode: "release_submitted" };
  const [updated] = await db.update(creditUsageLedger).set(values)
    .where(eq(creditUsageLedger.id, ledgerId)).returning({ id: creditUsageLedger.id });
  if (!updated) throw new Error("ledger_write_failed");
}

async function finalizeReleasedLedger(
  row: CustomerLedgerRow,
  available: bigint | undefined,
  errorCode: string,
  releaseTxHash?: string,
  recoveryToken?: string,
  claimState: "recovery_claimed" | "release_claimed" | "reservation_claimed" = "recovery_claimed",
): Promise<boolean> {
  const [updated] = await db.update(creditUsageLedger).set({
    status: "released",
    chargedMicrocredits: 0n,
    refundedMicrocredits: row.reservedMicrocredits,
    chargedCredits: 0n,
    refundedCredits: wholeCreditCompatibility(row.reservedMicrocredits),
    ...(available === undefined ? {} : { availableCreditsAfter: vaultUnitsToCreditsDecimal(available) }),
    ...(releaseTxHash ? { releaseTxHash } : {}),
    errorCode,
    completedAt: new Date(),
    providerDispatchState: "finished",
    providerDispatchLeaseUntil: null,
  }).where(recoveryToken
    ? and(
      eq(creditUsageLedger.id, row.id),
      eq(creditUsageLedger.providerDispatchState, claimState),
      eq(creditUsageLedger.providerDispatchToken, recoveryToken),
    )
    : eq(creditUsageLedger.id, row.id)).returning({ id: creditUsageLedger.id });
  return Boolean(updated);
}

function microcreditsFromVaultUnits(amount: bigint): bigint | undefined {
  if (amount < 0n || amount % VAULT_UNITS_PER_MICROCREDIT !== 0n) return undefined;
  return amount / VAULT_UNITS_PER_MICROCREDIT;
}

async function finalizeChargedLedger(
  row: CustomerLedgerRow,
  actualMicrocredits: bigint,
  available: bigint | undefined,
  settleTxHash?: string,
  recoveryToken?: string,
): Promise<boolean> {
  if (actualMicrocredits <= 0n || actualMicrocredits > row.reservedMicrocredits) return false;
  const computed = row.providerCostUsd === null ? undefined : microcreditsForUsd(row.providerCostUsd);
  if ((computed !== undefined && computed !== actualMicrocredits) ||
      (row.chargedMicrocredits > 0n && row.chargedMicrocredits !== actualMicrocredits)) return false;
  const [updated] = await db.update(creditUsageLedger).set({
    status: "charged",
    chargedMicrocredits: actualMicrocredits,
    refundedMicrocredits: row.reservedMicrocredits - actualMicrocredits,
    chargedCredits: wholeCreditCompatibility(actualMicrocredits),
    refundedCredits: wholeCreditCompatibility(row.reservedMicrocredits) - wholeCreditCompatibility(actualMicrocredits),
    ...(available === undefined ? {} : { availableCreditsAfter: vaultUnitsToCreditsDecimal(available) }),
    ...(settleTxHash ? { settleTxHash } : {}),
    errorCode: row.providerCostUsd === null ? "chain_charge_recovered_receipt_missing" : null,
    completedAt: new Date(),
    providerDispatchState: "finished",
    providerDispatchLeaseUntil: null,
  }).where(recoveryToken
    ? and(
      eq(creditUsageLedger.id, row.id),
      eq(creditUsageLedger.providerDispatchState, "recovery_claimed"),
      eq(creditUsageLedger.providerDispatchToken, recoveryToken),
    )
    : eq(creditUsageLedger.id, row.id)).returning({ id: creditUsageLedger.id });
  return Boolean(updated);
}

function reserveSubmittedHook(ledgerId: string) {
  return (hash: string) => persistSubmittedTransaction(ledgerId, "reserve", hash);
}

function settleSubmittedHook(ledgerId: string) {
  return (hash: string) => persistSubmittedTransaction(ledgerId, "settle", hash);
}

function releaseSubmittedHook(ledgerId: string) {
  return (hash: string) => persistSubmittedTransaction(ledgerId, "release", hash);
}

export async function reconcileCustomerLedger(
  ownerUserId: string,
  ledgerId: string,
  options: { releaseUndispatchedReservation?: boolean } = {},
): Promise<{ status: string; errorCode: string | null }> {
  let row = await loadLedger(ledgerId, ownerUserId);
  if (!row) return { status: "not_found", errorCode: null };
  if (row.status === "charged" || row.status === "released") {
    return { status: row.status, errorCode: row.errorCode };
  }
  const refreshed = await refreshLifecycleLease(ownerUserId, row);
  row = refreshed.row;
  if (row.status === "charged" || row.status === "released") {
    return { status: row.status, errorCode: row.errorCode };
  }
  if (refreshed.pending) {
    return { status: row.status, errorCode: row.errorCode ?? "provider_or_recovery_lease_active" };
  }
  if (!row.walletAddress || !row.vaultRequestId) {
    return { status: row.status, errorCode: row.errorCode ?? "ledger_identity_missing" };
  }
  const walletAddress = row.walletAddress;
  const vaultRequestId = row.vaultRequestId;

  let evidence;
  try {
    evidence = await inspectOnchainReservation(walletAddress, vaultRequestId, {
      reserve: row.reserveTxHash,
      settle: row.settleTxHash,
      release: row.releaseTxHash,
    });
  } catch {
    return { status: row.status, errorCode: row.errorCode ?? "chain_state_unavailable" };
  }
  if (evidence.transactionPending) {
    return { status: row.status, errorCode: "vault_transaction_pending" };
  }

  const expectedAmount = row.reservedMicrocredits * VAULT_UNITS_PER_MICROCREDIT;
  if (evidence.amount > 0n && evidence.amount !== expectedAmount) {
    return { status: row.status, errorCode: "reservation_amount_mismatch" };
  }

  if (evidence.status === "none") {
    if (row.providerDispatchStartedAt) {
      const recoveryToken = await claimLifecycleRecovery(row);
      if (!recoveryToken) return { status: row.status, errorCode: "reconciliation_claimed" };
      const errorCode = "provider_outcome_unknown_no_confirmed_reservation";
      const finalized = await finalizeReleasedLedger(row, undefined, errorCode, undefined, recoveryToken);
      return finalized
        ? { status: "released", errorCode }
        : { status: row.status, errorCode: "reconciliation_claim_lost" };
    }
    if (options.releaseUndispatchedReservation) {
      const recoveryToken = await claimLifecycleRecovery(row);
      if (!recoveryToken) return { status: row.status, errorCode: "reconciliation_claimed" };
      const errorCode = "reservation_released_before_provider_dispatch";
      const finalized = await finalizeReleasedLedger(row, undefined, errorCode, undefined, recoveryToken);
      return finalized
        ? { status: "released", errorCode }
        : { status: row.status, errorCode: "reconciliation_claim_lost" };
    }
    if (row.providerDispatchState === "release_pending") {
      return { status: row.status, errorCode: "undispatched_reservation_release_pending" };
    }
    // The request id is idempotent in the vault. Re-submitting reserve can
    // never create a second hold; only one Reserved event/status can exist.
    if (!row.providerDispatchStartedAt &&
        (row.status === "reserving" || row.workflowVersion === CUSTOMER_LEDGER_WORKFLOW)) {
      const recoveryToken = await claimLifecycleRecovery(row);
      if (!recoveryToken) return { status: row.status, errorCode: "reservation_reconciliation_claimed" };
      try {
        evidence = await reserveOnchain(
          walletAddress,
          vaultRequestId,
          row.reservedMicrocredits,
          reserveSubmittedHook(row.id),
        );
        const [updated] = await db.update(creditUsageLedger).set({
          status: "reserved",
          reserveTxHash: evidence.transactionHash ?? row.reserveTxHash,
          errorCode: null,
          providerDispatchState: null,
          providerDispatchToken: null,
          providerDispatchLeaseUntil: null,
        }).where(and(
          eq(creditUsageLedger.id, row.id),
          eq(creditUsageLedger.providerDispatchState, "recovery_claimed"),
          eq(creditUsageLedger.providerDispatchToken, recoveryToken),
        )).returning({ id: creditUsageLedger.id });
        if (!updated) return { status: row.status, errorCode: "reservation_reconciliation_claim_lost" };
        row = (await loadLedger(row.id, ownerUserId))!;
      } catch (error) {
        if (error instanceof CustomerGatewayError && error.code === "insufficient") {
          const errorCode = "insufficient_onchain_available_balance";
          const finalized = await finalizeReleasedLedger(row, undefined, errorCode, undefined, recoveryToken);
          return finalized
            ? { status: "released", errorCode }
            : { status: row.status, errorCode: "reservation_reconciliation_claim_lost" };
        }
        await leaveLifecycleRecovery(
          row.id,
          recoveryToken,
          "reservation_abandoned",
          "reserve_outcome_unknown",
        ).catch(() => false);
        return { status: row.status, errorCode: "reserve_outcome_unknown" };
      }
    } else {
      return { status: row.status, errorCode: row.errorCode ?? "reservation_outcome_unknown" };
    }
  }

  if (evidence.status === "reserved") {
    if (evidence.amount !== expectedAmount) return { status: row.status, errorCode: "reservation_amount_mismatch" };
    if (!row.providerRequestId || row.providerCostUsd === null) {
      const ownerAbsorbs = requiresOwnerAbsorbedRelease(row) ||
        (row.providerDispatchState === "completed" &&
          (!row.providerRequestId || row.providerCostUsd === null));
      if (!ownerAbsorbs) {
        if (row.providerDispatchState === "release_pending" && !options.releaseUndispatchedReservation) {
          return { status: row.status, errorCode: "undispatched_reservation_release_pending" };
        }
        if (options.releaseUndispatchedReservation) {
          const recoveryToken = await claimLifecycleRecovery(row, "release_claimed");
          if (!recoveryToken) return { status: row.status, errorCode: "undispatched_release_claimed" };
          try {
            const released = await releaseOnchain(
              walletAddress,
              vaultRequestId,
              row.reservedMicrocredits,
              releaseSubmittedHook(row.id),
            );
            const finalized = await finalizeReleasedLedger(
              row,
              released.snapshot?.available,
              "reservation_released_before_provider_dispatch",
              released.transactionHash,
              recoveryToken,
              "release_claimed",
            );
            return finalized
              ? { status: "released", errorCode: "reservation_released_before_provider_dispatch" }
              : { status: row.status, errorCode: "undispatched_release_claim_lost" };
          } catch {
            await leaveLifecycleRecovery(
              row.id,
              recoveryToken,
              "release_pending",
              "undispatched_reservation_release_pending",
              "release_claimed",
            ).catch(() => false);
            return { status: "reconciling", errorCode: "undispatched_reservation_release_pending" };
          }
        }
        if (row.providerDispatchState === "reservation_abandoned") {
          const [updated] = await db.update(creditUsageLedger).set({
            status: "reserved",
            reserveTxHash: evidence.transactionHash ?? row.reserveTxHash,
            errorCode: null,
            providerDispatchState: null,
            providerDispatchToken: null,
            providerDispatchLeaseUntil: null,
          }).where(and(
            eq(creditUsageLedger.id, row.id),
            eq(creditUsageLedger.status, row.status),
            eq(creditUsageLedger.providerDispatchState, "reservation_abandoned"),
            eq(creditUsageLedger.providerDispatchToken, row.providerDispatchToken!),
            isNull(creditUsageLedger.providerDispatchStartedAt),
          )).returning({ id: creditUsageLedger.id });
          if (!updated) return { status: row.status, errorCode: "reservation_reconciliation_claimed" };
        } else {
          await db.update(creditUsageLedger).set({
            status: "reserved",
            reserveTxHash: evidence.transactionHash ?? row.reserveTxHash,
            errorCode: null,
          }).where(and(
            eq(creditUsageLedger.id, row.id),
            eq(creditUsageLedger.status, row.status),
            isNull(creditUsageLedger.providerDispatchStartedAt),
            isNull(creditUsageLedger.providerDispatchState),
          ));
        }
        return { status: "reserved", errorCode: null };
      }
      const recoveryToken = await claimLifecycleRecovery(row);
      if (!recoveryToken) return { status: row.status, errorCode: "provider_outcome_recovery_claimed" };
      try {
        const released = await releaseOnchain(
          walletAddress,
          vaultRequestId,
          row.reservedMicrocredits,
          releaseSubmittedHook(row.id),
        );
        const finalized = await finalizeReleasedLedger(
          row,
          released.snapshot?.available,
          "provider_outcome_unknown_owner_absorbed",
          released.transactionHash,
          recoveryToken,
        );
        return finalized
          ? { status: "released", errorCode: "provider_outcome_unknown_owner_absorbed" }
          : { status: row.status, errorCode: "provider_outcome_recovery_claim_lost" };
      } catch {
        await leaveLifecycleRecovery(
          row.id,
          recoveryToken,
          row.providerDispatchStartedAt ? "abandoned" : "reservation_abandoned",
          "provider_outcome_unknown_release_pending",
        ).catch(() => false);
        return { status: "reconciling", errorCode: "provider_outcome_unknown_release_pending" };
      }
    }

    const actualMicrocredits = microcreditsForUsd(row.providerCostUsd);
    if (actualMicrocredits === undefined || actualMicrocredits === 0n ||
        actualMicrocredits > row.reservedMicrocredits ||
        row.chargedMicrocredits !== actualMicrocredits) {
      const ownerAbsorbs = actualMicrocredits === undefined || actualMicrocredits > row.reservedMicrocredits;
      const recoveryToken = await claimLifecycleRecovery(row);
      if (!recoveryToken) return { status: row.status, errorCode: "provider_cost_recovery_claimed" };
      try {
        const released = await releaseOnchain(
        walletAddress,
        vaultRequestId,
          row.reservedMicrocredits,
          releaseSubmittedHook(row.id),
        );
        const finalized = await finalizeReleasedLedger(
          row,
          released.snapshot?.available,
          actualMicrocredits === 0n
            ? "zero_cost_released"
            : ownerAbsorbs ? "provider_cost_owner_absorbed" : "provider_receipt_mismatch_owner_absorbed",
          released.transactionHash,
          recoveryToken,
        );
        return finalized
          ? { status: "released", errorCode: actualMicrocredits === 0n ? "zero_cost_released" : "provider_cost_owner_absorbed" }
          : { status: row.status, errorCode: "provider_cost_recovery_claim_lost" };
      } catch {
        await leaveLifecycleRecovery(row.id, recoveryToken, "completed", "release_pending").catch(() => false);
        return { status: "reconciling", errorCode: "release_pending" };
      }
    }

    const recoveryToken = await claimLifecycleRecovery(row);
    if (!recoveryToken) return { status: row.status, errorCode: "settlement_recovery_claimed" };
    try {
      const settled = await settleOnchain(
        walletAddress,
        vaultRequestId,
        row.reservedMicrocredits,
        actualMicrocredits,
        settleSubmittedHook(row.id),
      );
      const finalized = await finalizeChargedLedger(
        row,
        actualMicrocredits,
        settled.snapshot?.available,
        settled.transactionHash,
        recoveryToken,
      );
      return finalized
        ? { status: "charged", errorCode: null }
        : (await leaveLifecycleRecovery(
            row.id,
            recoveryToken,
            "completed",
            "settlement_receipt_mismatch",
          ), { status: "reconciling", errorCode: "settlement_receipt_mismatch" });
    } catch {
      await leaveLifecycleRecovery(row.id, recoveryToken, "completed", "settlement_pending").catch(() => false);
      return { status: "reconciling", errorCode: "settlement_pending" };
    }
  }

  if (evidence.status === "settled") {
    const recoveryToken = await claimLifecycleRecovery(row);
    if (!recoveryToken) return { status: row.status, errorCode: "settlement_recovery_claimed" };
    const actualMicrocredits = microcreditsFromVaultUnits(evidence.actualAmount ?? -1n);
    if (actualMicrocredits === undefined) {
      await leaveLifecycleRecovery(row.id, recoveryToken, "completed", "settlement_amount_not_microcredit_exact");
      return { status: row.status, errorCode: "settlement_amount_not_microcredit_exact" };
    }
    if (actualMicrocredits === 0n) {
      const finalized = await finalizeReleasedLedger(
        row,
        evidence.snapshot?.available,
        "zero_cost_released",
        evidence.transactionHash,
        recoveryToken,
      );
      return finalized
        ? { status: "released", errorCode: "zero_cost_released" }
        : { status: row.status, errorCode: "reconciliation_claim_lost" };
    }
    const finalized = await finalizeChargedLedger(
      row,
      actualMicrocredits,
      evidence.snapshot?.available,
      evidence.transactionHash,
      recoveryToken,
    );
    if (!finalized) {
      await leaveLifecycleRecovery(row.id, recoveryToken, "completed", "settlement_receipt_mismatch");
      return { status: row.status, errorCode: "settlement_receipt_mismatch" };
    }
    return { status: "charged", errorCode: null };
  }

  if (evidence.status === "released") {
    const recoveryToken = await claimLifecycleRecovery(row);
    if (!recoveryToken) return { status: row.status, errorCode: "release_recovery_claimed" };
    const finalized = await finalizeReleasedLedger(
      row,
      evidence.snapshot?.available,
      row.providerRequestId && row.providerCostUsd !== null &&
        microcreditsForUsd(row.providerCostUsd) === 0n
        ? "zero_cost_released"
        : "provider_cost_owner_absorbed",
      evidence.transactionHash,
      recoveryToken,
    );
    if (!finalized) return { status: row.status, errorCode: "reconciliation_claim_lost" };
    const latest = await loadLedger(row.id, ownerUserId);
    return { status: latest?.status ?? "released", errorCode: latest?.errorCode ?? "provider_cost_owner_absorbed" };
  }

  return { status: row.status, errorCode: row.errorCode };
}

async function dispatchReservedCompletion(input: {
  ownerUserId: string;
  ledger: CustomerLedgerRow;
  model: CustomerModel;
  request: CustomerChatInput;
  maxOutputTokens: number;
}): Promise<CustomerBillingResult> {
  const { ledger, model, request, maxOutputTokens } = input;
  if (!mayDispatchCustomerProvider(ledger)) {
    return { statusCode: 409, error: "This request has already been dispatched or requires reconciliation; it will not be sent upstream again." };
  }
  const dispatchToken = randomUUID();
  const [claimed] = await db.update(creditUsageLedger).set({
    providerDispatchStartedAt: sql<Date>`now()`,
    providerDispatchState: "dispatching",
    providerDispatchToken: dispatchToken,
    providerDispatchLeaseUntil: leaseAfter(PROVIDER_DISPATCH_LEASE_MS),
    errorCode: "provider_dispatch_started",
  }).where(and(
    eq(creditUsageLedger.id, ledger.id),
    eq(creditUsageLedger.status, "reserved"),
    isNull(creditUsageLedger.providerDispatchStartedAt),
    isNull(creditUsageLedger.providerDispatchState),
    isNull(creditUsageLedger.providerDispatchToken),
    isNull(creditUsageLedger.providerDispatchLeaseUntil),
  )).returning({ id: creditUsageLedger.id });
  if (!claimed) {
    return { statusCode: 409, error: "This request is already dispatched or being reconciled." };
  }

  let completion: ProviderCompletion;
  try {
    completion = await createProviderCompletion({
      model,
      messages: request.messages,
      maxOutputTokens,
    });
  } catch (error) {
    const code = error instanceof CustomerProviderError && error.code === "integration_unavailable"
      ? "provider_integration_unavailable"
      : "provider_outcome_unknown_waiting_bounded_lease";
    if (code !== "provider_integration_unavailable") {
      const [stillOwned] = await db.update(creditUsageLedger).set({
        status: "reconciling",
        errorCode: code,
      }).where(and(
        eq(creditUsageLedger.id, ledger.id),
        eq(creditUsageLedger.providerDispatchState, "dispatching"),
        eq(creditUsageLedger.providerDispatchToken, dispatchToken),
        gt(creditUsageLedger.providerDispatchLeaseUntil, sql<Date>`now()`),
      )).returning({ id: creditUsageLedger.id });
      if (!stillOwned) {
        return { statusCode: 503, error: "Provider request ownership expired; this worker cannot change its outcome." };
      }
      return {
        statusCode: 503,
        error: "Provider outcome is unknown; reconciliation will wait for the bounded dispatch lease before releasing the hold.",
      };
    }
    const [failed] = await db.update(creditUsageLedger).set({
      status: "reconciling",
      providerDispatchState: "failed",
      providerDispatchLeaseUntil: null,
      errorCode: code,
    }).where(and(
      eq(creditUsageLedger.id, ledger.id),
      eq(creditUsageLedger.providerDispatchState, "dispatching"),
      eq(creditUsageLedger.providerDispatchToken, dispatchToken),
      gt(creditUsageLedger.providerDispatchLeaseUntil, sql<Date>`now()`),
    )).returning({ id: creditUsageLedger.id });
    if (!failed) {
      return { statusCode: 503, error: "Provider request ownership expired; this worker cannot change its outcome." };
    }
    const reconciliation = await reconcileCustomerLedger(input.ownerUserId, ledger.id).catch(() => undefined);
    if (reconciliation?.status === "released") {
      return {
        statusCode: 503,
        error: code === "provider_integration_unavailable"
          ? "The provider integration was unavailable; the confirmed reservation was released."
          : "Provider outcome was uncertain; the confirmed reservation was released without customer charge.",
      };
    }
    return {
      statusCode: 503,
      error: "Provider outcome requires reconciliation; the provider will not be called again for this request.",
    };
  }

  const actualProviderCost = providerCostUsdForUsage(model, completion);
  const chargedMicrocredits = actualProviderCost === undefined ? undefined : microcreditsForUsd(actualProviderCost);
  const errorCode = actualProviderCost === undefined || chargedMicrocredits === undefined
    ? "provider_cost_breakdown_unavailable"
    : chargedMicrocredits > ledger.reservedMicrocredits
      ? "provider_cost_owner_absorbed"
      : chargedMicrocredits === 0n ? "zero_cost_ready_to_release" : "provider_receipt_persisted";
  try {
    const [persisted] = await db.update(creditUsageLedger).set({
      status: "reconciling",
      providerDispatchState: "completed",
      providerDispatchLeaseUntil: null,
      errorCode,
      providerRequestId: completion.id,
      responseContent: completion.content,
      inputTokens: BigInt(completion.inputTokens),
      outputTokens: BigInt(completion.outputTokens),
      ...usageLedgerFields(completion),
      providerCostUsd: actualProviderCost ?? null,
      chargedMicrocredits: chargedMicrocredits ?? 0n,
    }).where(and(
      eq(creditUsageLedger.id, ledger.id),
      eq(creditUsageLedger.providerDispatchState, "dispatching"),
      eq(creditUsageLedger.providerDispatchToken, dispatchToken),
      gt(creditUsageLedger.providerDispatchLeaseUntil, sql<Date>`now()`),
    )).returning({ id: creditUsageLedger.id });
    if (!persisted) throw new Error("ledger_write_failed");
  } catch {
    // A result that could not be durably written remains fenced to this
    // dispatch. Recovery may absorb it only after its bounded lease expires.
    await db.update(creditUsageLedger).set({
      status: "reconciling",
      providerDispatchState: "failed",
      providerDispatchLeaseUntil: null,
      errorCode: "provider_receipt_persist_failed_owner_absorbed",
    }).where(and(
      eq(creditUsageLedger.id, ledger.id),
      eq(creditUsageLedger.providerDispatchState, "dispatching"),
      eq(creditUsageLedger.providerDispatchToken, dispatchToken),
      gt(creditUsageLedger.providerDispatchLeaseUntil, sql<Date>`now()`),
    )).catch(() => undefined);
    await reconcileCustomerLedger(input.ownerUserId, ledger.id).catch(() => undefined);
    return { statusCode: 503, error: "Provider usage receipt persistence failed; the provider will not be called again." };
  }

  const reconciliation = await reconcileCustomerLedger(input.ownerUserId, ledger.id);
  const latest = await loadLedger(ledger.id, input.ownerUserId);
  const replay = latest && replayResponse(latest);
  if (replay) return { statusCode: 200, response: replay };
  return {
    statusCode: 503,
    error: reconciliation.status === "released"
      ? "Provider completion was reconciled without a customer charge."
      : "Provider usage is durably recorded and chain settlement is pending reconciliation.",
  };
}

export async function runCustomerCompletion(input: {
  ownerUserId: string;
  apiKeyId: string;
  idempotencyKey: string;
  request: CustomerChatInput;
}): Promise<CustomerBillingResult> {
  const fingerprint = requestFingerprint(input.request);
  let model: CustomerModel | undefined;
  try {
    model = await resolveCustomerModel(input.request.model);
  } catch {
    return { statusCode: 503, error: "The live model catalog is temporarily unavailable." };
  }
  if (!model) return { statusCode: 400, error: "The requested model ID is not in the supported model catalog." };
  if (!model.capabilities.includes("text-generation")) {
    return { statusCode: 400, error: "The requested model capability is not implemented by the metered chat route." };
  }
  if (!model.available) {
    return { statusCode: 503, error: model.unavailableReason ?? "The requested model is currently unavailable." };
  }
  const rates = receiptAmounts(model);
  if (!rates) return { statusCode: 503, error: "No current exact provider cost is configured for this model." };
  const reservationInputRate = reserveInputRate(model);
  if (!reservationInputRate) return { statusCode: 503, error: "No exact worst-case input cost is configured for this model." };
  const maxOutputTokens = input.request.maxOutputTokens ?? 1024;
  const serializedMessages = JSON.stringify(input.request.messages);
  const serializedInputBytes = Buffer.byteLength(serializedMessages, "utf8");
  if (serializedInputBytes > model.maxInputTokens ||
      maxOutputTokens > model.maxOutputTokens || maxOutputTokens < 1) {
    return { statusCode: 400, error: "The request exceeds this model's input or output token safety bound." };
  }
  // Every text token covers at least one UTF-8 byte, and the JSON envelope
  // per message outweighs provider chat-template tokens, so the serialized
  // byte count is a worst-case input-token bound for this request. Reserving
  // against it (instead of the global cap) keeps small requests' holds small.
  const reservationMicrocredits = reserveMicrocredits(
    rates.inputRate, rates.outputRate, serializedInputBytes, maxOutputTokens, reservationInputRate,
  );
  if (reservationMicrocredits <= 0n) {
    return { statusCode: 503, error: "The configured rates do not produce a positive on-chain reservation." };
  }

  let walletAddress: string | undefined;
  try {
    walletAddress = await findVerifiedWallet(input.ownerUserId);
  } catch {
    return { statusCode: 503, error: "Verified wallet ownership could not be checked." };
  }
  if (!walletAddress) {
    return { statusCode: 403, error: "A verified wallet on chain 4663 is required for metered inference." };
  }
  const playgroundKey = `playground:${input.ownerUserId}`;
  if (input.apiKeyId !== playgroundKey) {
    try {
      const [apiKey] = await db.select({ walletAddress: platformApiKeys.walletAddress })
        .from(platformApiKeys).where(and(
          eq(platformApiKeys.id, input.apiKeyId),
          eq(platformApiKeys.ownerUserId, input.ownerUserId),
          isNull(platformApiKeys.revokedAt),
        )).limit(1);
      if (!apiKey) return { statusCode: 401, error: "The platform API key is invalid or revoked." };
      if (!apiKey.walletAddress) {
        return { statusCode: 403, error: "This API key has no verified-wallet snapshot; create a new key after verifying a wallet." };
      }
      if (apiKey.walletAddress.toLowerCase() !== walletAddress.toLowerCase()) {
        return { statusCode: 403, error: "This API key is bound to a different wallet; create a new key for the current verified wallet." };
      }
    } catch {
      return { statusCode: 503, error: "The API key's wallet binding could not be checked." };
    }
  }

  const policy = safetyPolicy();
  if (!policy) return { statusCode: 503, error: "Explicit per-user, per-key, and daily spending safety limits are required." };
  const ledgerId = randomUUID();
  const vaultRequestId = keccak256(toUtf8Bytes(`llm-credit-customer-request:${ledgerId}`));
  const reservationClaimToken = randomUUID();
  let inserted: { id: string }[] = [];
  let limitExceeded = false;
  try {
    await db.transaction(async (tx) => {
      const minuteStart = new Date(Date.now() - 60_000);
      const utcDayStart = new Date();
      utcDayStart.setUTCHours(0, 0, 0, 0);
      inserted = await tx.insert(creditUsageLedger).values({
        id: ledgerId,
        ownerUserId: input.ownerUserId,
        apiKeyId: input.apiKeyId,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: fingerprint,
        vaultRequestId,
        walletAddress,
        workflowVersion: CUSTOMER_LEDGER_WORKFLOW,
        providerDispatchState: "reservation_claimed",
        providerDispatchToken: reservationClaimToken,
        providerDispatchLeaseUntil: leaseAfter(LEDGER_LIFECYCLE_LEASE_MS),
        status: "reserving",
        model: model.id,
        provider: model.provider,
        inputUsdPerMillion: model.inputCostUsdPerMillion,
        outputUsdPerMillion: model.outputCostUsdPerMillion,
        cachedInputUsdPerMillion: model.cachedInputCostUsdPerMillion,
        cacheWrite5mUsdPerMillion: model.cacheWrite5mCostUsdPerMillion,
        cacheWrite1hUsdPerMillion: model.cacheWrite1hCostUsdPerMillion,
        cacheReadUsdPerMillion: model.cacheReadCostUsdPerMillion,
        providerCostUsd: null,
        pricingSource: model.pricingSource,
        pricingVerifiedAt: model.pricingVerifiedAt,
        pricingExpiresAt: model.pricingExpiresAt,
        reservedMicrocredits: reservationMicrocredits,
        reservedCredits: wholeCreditCompatibility(reservationMicrocredits),
        chargedCredits: 0n,
        refundedCredits: 0n,
      }).onConflictDoNothing({
        target: [creditUsageLedger.ownerUserId, creditUsageLedger.idempotencyKey],
      }).returning({ id: creditUsageLedger.id });
      if (!inserted.length) return;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.ownerUserId}, 4153))`);
      const limits = await tx.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE created_at >= ${minuteStart}) AS user_requests,
          COUNT(*) FILTER (WHERE api_key_id = ${input.apiKeyId} AND created_at >= ${minuteStart}) AS key_requests,
          COALESCE(SUM(
            CASE
              WHEN status = 'charged' THEN charged_microcredits
              WHEN status <> 'released' THEN reserved_microcredits
              ELSE 0
            END
          ) FILTER (WHERE created_at >= ${utcDayStart}), 0) AS daily_microcredits
        FROM credit_usage_ledger
        WHERE owner_user_id = ${input.ownerUserId}
      `);
      const row = limits.rows[0] as {
        user_requests?: string | bigint;
        key_requests?: string | bigint;
        daily_microcredits?: string | bigint;
      } | undefined;
      const userRequests = BigInt(row?.user_requests ?? 0);
      const keyRequests = BigInt(row?.key_requests ?? 0);
      const dailyMicrocredits = BigInt(row?.daily_microcredits ?? 0);
      limitExceeded = userRequests > BigInt(policy.userRpm) ||
        keyRequests > BigInt(policy.keyRpm) ||
        dailyMicrocredits > policy.dailyBudgetMicrocredits;
      if (limitExceeded) {
        await tx.update(creditUsageLedger).set({
          status: "released",
          refundedMicrocredits: reservationMicrocredits,
          refundedCredits: wholeCreditCompatibility(reservationMicrocredits),
          errorCode: dailyMicrocredits > policy.dailyBudgetMicrocredits ? "daily_budget_exceeded" : "rate_limit_exceeded",
          completedAt: new Date(),
          providerDispatchState: "finished",
          providerDispatchLeaseUntil: null,
        }).where(eq(creditUsageLedger.id, ledgerId));
      }
    });
  } catch {
    return { statusCode: 503, error: "The durable idempotency ledger is unavailable." };
  }

  if (limitExceeded) return { statusCode: 429, error: "Per-user/per-key rate limit or daily service-credit budget exceeded." };
  if (!inserted.length) {
    try {
      let existing = await loadLedgerByIdempotency(input.ownerUserId, input.idempotencyKey);
      if (!existing) return { statusCode: 503, error: "The idempotency record could not be read." };
      if (existing.requestFingerprint !== fingerprint) {
        return { statusCode: 409, error: "This Idempotency-Key is already bound to a different request." };
      }
      await reconcileCustomerLedger(input.ownerUserId, existing.id);
      existing = await loadLedger(existing.id, input.ownerUserId);
      if (!existing) return { statusCode: 503, error: "The idempotency record could not be read." };
      const replay = replayResponse(existing);
      if (replay) return { statusCode: 200, response: replay };
      if (mayDispatchCustomerProvider(existing)) {
        return dispatchReservedCompletion({
          ownerUserId: input.ownerUserId,
          ledger: existing,
          model,
          request: input.request,
          maxOutputTokens,
        });
      }
      return { statusCode: existing.status === "reconciling" ? 503 : 409,
        error: existing.status === "reconciling"
          ? "This request is being reconciled and will not be sent upstream again."
          : "This idempotency key is already complete or was released without a replayable provider response." };
    } catch {
      return { statusCode: 503, error: "The idempotency record could not be reconciled." };
    }
  }

  try {
    const reservedEvidence = await reserveOnchain(
      walletAddress,
      vaultRequestId,
      reservationMicrocredits,
      reserveSubmittedHook(ledgerId),
    );
    if (reservedEvidence.status !== "reserved" ||
        reservedEvidence.amount !== reservationMicrocredits * VAULT_UNITS_PER_MICROCREDIT ||
        !reservedEvidence.transactionHash) {
      throw new CustomerGatewayError("unknown");
    }
    const [reservedRow] = await db.update(creditUsageLedger).set({
      status: "reserved",
      reserveTxHash: reservedEvidence.transactionHash,
      errorCode: null,
      providerDispatchState: null,
      providerDispatchToken: null,
      providerDispatchLeaseUntil: null,
    }).where(and(
      eq(creditUsageLedger.id, ledgerId),
      eq(creditUsageLedger.status, "reserving"),
      eq(creditUsageLedger.providerDispatchState, "reservation_claimed"),
      eq(creditUsageLedger.providerDispatchToken, reservationClaimToken),
    )).returning();
    if (!reservedRow) {
      const current = await loadLedger(ledgerId, input.ownerUserId);
      if (!current || current.status !== "reserved") {
        await reconcileCustomerLedger(input.ownerUserId, ledgerId);
        return { statusCode: 503, error: "Confirmed reservation requires ledger reconciliation; inference was not dispatched." };
      }
      return dispatchReservedCompletion({
        ownerUserId: input.ownerUserId,
        ledger: current,
        model,
        request: input.request,
        maxOutputTokens,
      });
    }
    return dispatchReservedCompletion({
      ownerUserId: input.ownerUserId,
      ledger: reservedRow,
      model,
      request: input.request,
      maxOutputTokens,
    });
  } catch (error) {
    const gatewayError = error instanceof CustomerGatewayError ? error.code : "unknown";
    if (gatewayError !== "insufficient") logger.error({ err: error, gatewayError }, "customer reservation failed");
    if (gatewayError === "insufficient") {
      const current = await loadLedger(ledgerId, input.ownerUserId);
      if (current) {
        await finalizeReleasedLedger(
          current,
          undefined,
          "insufficient_onchain_available_balance",
          undefined,
          reservationClaimToken,
          "reservation_claimed",
        ).catch(() => false);
      }
      return { statusCode: 402, error: "The verified wallet has insufficient on-chain available credits." };
    }
    if (gatewayError === "unconfigured") {
      const current = await loadLedger(ledgerId, input.ownerUserId);
      if (current) {
        await finalizeReleasedLedger(
          current,
          undefined,
          "gateway_unconfigured",
          undefined,
          reservationClaimToken,
          "reservation_claimed",
        ).catch(() => false);
      }
      return { statusCode: 503, error: "The on-chain gateway is not configured for chain 4663." };
    }
    await setLedgerState(
      ledgerId,
      "reconciling",
      "reserve_outcome_unknown",
      false,
      reservationClaimToken,
    ).catch(() => undefined);
    return { statusCode: 503, error: "On-chain reservation outcome is unknown; inference was not dispatched." };
  }
}

async function loadLedgerByIdempotency(
  ownerUserId: string,
  idempotencyKey: string,
): Promise<CustomerLedgerRow | undefined> {
  const [row] = await db.select().from(creditUsageLedger).where(and(
    eq(creditUsageLedger.ownerUserId, ownerUserId),
    eq(creditUsageLedger.idempotencyKey, idempotencyKey),
  )).limit(1);
  return row;
}