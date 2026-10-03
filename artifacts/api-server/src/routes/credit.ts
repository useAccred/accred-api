import { logger } from "../lib/logger";
import { randomUUID } from "node:crypto";
import { keccak256, toUtf8Bytes } from "ethers";
import { and, desc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  creditEconomyActivity,
  creditEconomyCashbacks,
  creditEconomyQuotes,
  creditEconomyReserves,
  db,
  verifiedWalletOwnerships,
  solanaDepositSessions,
  creditUsageLedger,
} from "@workspace/db";
import {
  cashbackAmountForQuote,
  chooseCashbackBps,
} from "../lib/cashback-policy";
import {
  getFinalizedErc20Balance,
  getFinalizedNativeBalance,
  getFinalizedSolanaAssetBalance,
  getFinalizedRedeemerState,
  getFinalizedQuoteSigner,
  isFinalizedPurchaseInputEligible,
  getRobinhoodCreditAccount,
  verifyFinalizedErc20Transfer,
  verifyFinalizedTransaction,
  type PreparedSolanaMessage,
} from "../lib/credit-chain";
import { creditConfiguration, isEvmAddress, isSolanaAddress, publicRpcUrl } from "../lib/credit-config";
import { assetRegistry, findCreditAsset, isDirectBuyAsset } from "../lib/credit-assets";
import {
  formatUnits,
  isTxHash,
  parseDecimalAmount,
  type CreditChain,
  type CreditMode,
} from "../lib/credit-policy";
import {
  requestExecutableQuote,
  type AtomicRedemptionExpectation,
  type AtomicPurchaseExpectation,
  type ExecutableCreditQuote,
  type ExpectedTransfer,
} from "../lib/credit-router";
import {
  payoutReservedCashback,
  settleCreditPurchase,
  payoutRedemption,
} from "../lib/credit-settlement";
import { assetAvailability, treasuryAvailable, walletTokenBalance, assetUsdValueMicros, rpcProvider } from "../lib/internal-router";
import { burnProjectTokenDeposit } from "../lib/internal-settlement";
import { credStats } from "../lib/cred-stats";
import { requirePrivySession } from "../lib/privy-auth";
import { PROJECT_TOKEN_BONUS_BPS, PROJECT_TOKEN_BURN_ADDRESS, ROBINHOOD_WETH, dexQuote, geckoToken, isProjectToken, projectToken } from "../lib/dex-tokens";

const router: IRouter = Router();
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const USD_MICROS_TO_18_DECIMAL_UNITS = 10n ** 12n;
const RH_CHAIN_IDS = ["4663", "robinhood-mainnet"];
const SOLANA_CHAIN_IDS = ["solana-mainnet", "mainnet-beta", "101"];

type Wallet = typeof verifiedWalletOwnerships.$inferSelect;
type QuoteRow = typeof creditEconomyQuotes.$inferSelect;
type CashbackRow = typeof creditEconomyCashbacks.$inferSelect;

const reasonOf = (error: unknown) => {
  const value = error instanceof Error ? error.message : "financial_operation_unavailable";
  return /^[a-zA-Z0-9_:-]{1,100}$/.test(value) ? value : "financial_operation_unavailable";
};
const sameTxHash = (chain: CreditChain, first: string, second: string) =>
  chain === "robinhood" ? first.toLowerCase() === second.toLowerCase() : first === second;
const capability = (config: ReturnType<typeof creditConfiguration>, name: string) =>
  config.capabilities[name as keyof typeof config.capabilities];

async function fundedRedeemCapability(config: ReturnType<typeof creditConfiguration>) {
  const configured = config.capabilities.redeem;
  if (!configured.enabled || !config.addresses.treasuryAddress || !config.addresses.usdgAddress) {
    return { enabled: false, reason: configured.reason ?? "Redemption is not configured.", reserveUsdg: null };
  }
  return { enabled: true, reason: null, reserveUsdg: null };
}

export async function findVerifiedWallet(ownerUserId: string, chain: CreditChain): Promise<Wallet | undefined> {
  const chainIds = chain === "robinhood" ? RH_CHAIN_IDS : SOLANA_CHAIN_IDS;
  for (const chainId of chainIds) {
    const ownership = await db.query.verifiedWalletOwnerships.findFirst({
      where: and(
        eq(verifiedWalletOwnerships.ownerUserId, ownerUserId),
        eq(verifiedWalletOwnerships.chainId, chainId),
        isNull(verifiedWalletOwnerships.revokedAt),
      ),
    });
    if (ownership) return ownership;
  }
  return undefined;
}

async function loadWalletPair(ownerUserId: string, chain: CreditChain): Promise<{ recipient: Wallet; source: Wallet } | null> {
  const recipient = await findVerifiedWallet(ownerUserId, "robinhood");
  const source = chain === "robinhood" ? recipient : await findVerifiedWallet(ownerUserId, chain);
  return recipient && source ? { recipient, source } : null;
}

function jsonTransfers(value: unknown): ExpectedTransfer[] {
  return Array.isArray(value) ? value as ExpectedTransfer[] : [];
}

function outputCashback(row: CashbackRow | undefined) {
  if (!row) return { status: "not_eligible" as const, percentBps: null, amountUsdg: null, recipientAddress: null };
  return {
    status: row.status as "reserved" | "pending" | "paid" | "expired",
    percentBps: row.percentBps,
    amountUsdg: row.amountUsdg,
    recipientAddress: row.recipientAddress,
  };
}

async function reserveQuoteCashback(args: {
  quote: QuoteRow;
  recipientAddress: string;
  netUsdMicros: bigint;
  config: ReturnType<typeof creditConfiguration>;
}): Promise<CashbackRow | undefined> {
  const { quote, config } = args;
  const usdg = findCreditAsset(config, "robinhood", "USDG");
  const cashbackAddress = config.addresses.cashbackAddress;
  if (!capability(config, "cashback").enabled || !usdg || usdg.decimals < 6 || !cashbackAddress || !config.addresses.usdgAddress) return undefined;
  // Flat 10% on every swap. For the platform's own token it is measured on the value before its 10% bonus credit.
  const own = projectToken();
  const isOwn = !!own && quote.inputToken.toLowerCase() === own.address.toLowerCase();
  const percentBps = chooseCashbackBps();
  const baseUsdMicros = isOwn ? (args.netUsdMicros * 10_000n) / (10_000n + PROJECT_TOKEN_BONUS_BPS) : args.netUsdMicros;
  const amountMicros = cashbackAmountForQuote(baseUsdMicros, percentBps);
  if (!amountMicros) return undefined;
  const amountUnits = amountMicros * 10n ** BigInt(usdg.decimals - 6);
  let fundedBalance: bigint;
  try {
    fundedBalance = await getFinalizedErc20Balance(config, config.addresses.usdgAddress, cashbackAddress);
  } catch {
    return undefined;
  }
  const amountUsdg = formatUnits(amountUnits, usdg.decimals);
  return db.transaction(async (tx) => {
    const fundingKey = `usdg:${config.addresses.usdgAddress!.toLowerCase()}:${cashbackAddress.toLowerCase()}`;
    await tx.insert(creditEconomyReserves).values({ fundingKey, reservedAmount: "0" }).onConflictDoNothing();
    await tx.select().from(creditEconomyReserves).where(eq(creditEconomyReserves.fundingKey, fundingKey)).for("update");
    const existing = await tx.select({
      id: creditEconomyCashbacks.id,
      quoteId: creditEconomyCashbacks.quoteId,
      amountUsdg: creditEconomyCashbacks.amountUsdg,
      status: creditEconomyCashbacks.status,
      expiresAt: creditEconomyQuotes.expiresAt,
      quoteStatus: creditEconomyQuotes.status,
      quoteTxHash: creditEconomyQuotes.txHash,
    }).from(creditEconomyCashbacks).innerJoin(
      creditEconomyQuotes,
      eq(creditEconomyCashbacks.quoteId, creditEconomyQuotes.id),
    ).where(inArray(creditEconomyCashbacks.status, ["reserved", "pending"]));
    let reservedUnits = 0n;
    const now = new Date();
    for (const entry of existing) {
      const expired = entry.status === "reserved" && entry.expiresAt.getTime() <= now.getTime() &&
        !entry.quoteTxHash && (entry.quoteStatus === "quoted" || entry.quoteStatus === "expired");
      const parsed = parseDecimalAmount(entry.amountUsdg, usdg.decimals);
      if (expired) {
        await tx.update(creditEconomyCashbacks).set({ status: "expired", updatedAt: now })
          .where(eq(creditEconomyCashbacks.id, entry.id));
        await tx.update(creditEconomyActivity).set({
          status: "expired", updatedAt: now,
          detail: "Quote expired before a finalized mainnet payment was confirmed.",
        }).where(and(
          eq(creditEconomyActivity.quoteId, entry.quoteId),
          eq(creditEconomyActivity.kind, "cashback"),
        ));
      } else if (parsed) {
        reservedUnits += parsed.units;
      }
    }
    if (fundedBalance < reservedUnits + amountUnits) {
      await tx.update(creditEconomyReserves).set({ reservedAmount: reservedUnits.toString(), updatedAt: now })
        .where(eq(creditEconomyReserves.fundingKey, fundingKey));
      return undefined;
    }
    const [cashback] = await tx.insert(creditEconomyCashbacks).values({
      id: randomUUID(),
      quoteId: quote.id,
      ownerUserId: quote.ownerUserId,
      recipientAddress: args.recipientAddress,
      amountUsdg,
      percentBps,
      status: "reserved",
    }).returning();
    await tx.update(creditEconomyReserves).set({
      reservedAmount: (reservedUnits + amountUnits).toString(),
      updatedAt: now,
    }).where(eq(creditEconomyReserves.fundingKey, fundingKey));
    await tx.insert(creditEconomyActivity).values({
      id: randomUUID(), ownerUserId: quote.ownerUserId, quoteId: quote.id,
      kind: "cashback", chain: quote.chain, asset: "USDG", amount: amountUsdg,
      status: "reserved", detail: `${(percentBps / 100).toFixed(2).replace(/\.?0+$/, "")}% cashback on your swap, paid in USDG`,
    });
    return cashback;
  });
}

async function activeRedemptionReservationUnits(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  config: ReturnType<typeof creditConfiguration>,
  asset: { address: string; decimals: number },
  now: Date,
): Promise<bigint> {
  const creditToken = config.addresses.creditTokenAddress;
  if (!config.addresses.treasuryAddress || !creditToken) return 0n;
  const rows = await tx.select({
    id: creditEconomyQuotes.id,
    status: creditEconomyQuotes.status,
    txHash: creditEconomyQuotes.txHash,
    expiresAt: creditEconomyQuotes.expiresAt,
    expectedTo: creditEconomyQuotes.expectedTo,
    outputToken: creditEconomyQuotes.outputToken,
    outputAmount: creditEconomyQuotes.outputAmount,
  }).from(creditEconomyQuotes).where(and(
    eq(creditEconomyQuotes.mode, "redeem"),
    eq(creditEconomyQuotes.chain, "robinhood"),
    inArray(creditEconomyQuotes.status, ["quoted", "confirming", "reconciling"]),
  ));
  let reserved = 0n;
  for (const row of rows) {
    if (row.expectedTo.toLowerCase() !== creditToken.toLowerCase()) continue;
    if (row.status === "quoted" && !row.txHash && row.expiresAt.getTime() <= now.getTime()) {
      await tx.update(creditEconomyQuotes).set({ status: "expired", updatedAt: now })
        .where(eq(creditEconomyQuotes.id, row.id));
      await tx.update(creditEconomyActivity).set({
        status: "expired", detail: "Redemption quote expired before a mainnet transaction was submitted.", updatedAt: now,
      }).where(and(
        eq(creditEconomyActivity.quoteId, row.id),
        eq(creditEconomyActivity.kind, "quote"),
      ));
      continue;
    }
    if (row.outputToken.toLowerCase() !== asset.address.toLowerCase()) continue;
    reserved += parseDecimalAmount(row.outputAmount, asset.decimals)?.units ?? 0n;
  }
  return reserved;
}

const redeemFundingKey = (config: ReturnType<typeof creditConfiguration>, asset: { address: string }) =>
  `redeem:${asset.address.toLowerCase()}:${config.addresses.treasuryAddress?.toLowerCase()}`;

async function reserveRedemptionLiquidity(
  quote: QuoteRow,
  config: ReturnType<typeof creditConfiguration>,
): Promise<boolean> {
  const treasury = config.addresses.treasuryAddress;
  const asset = assetRegistry(config).find((a) => a.chain === "robinhood" && a.address.toLowerCase() === quote.outputToken.toLowerCase());
  if (!treasury || !asset) throw new Error("redemption_reserve_not_configured");
  const fundedBalance = await treasuryAvailable(asset);
  const fundingKey = redeemFundingKey(config, asset);
  return db.transaction(async (tx) => {
    await tx.insert(creditEconomyReserves).values({ fundingKey, reservedAmount: "0" }).onConflictDoNothing();
    await tx.select().from(creditEconomyReserves)
      .where(eq(creditEconomyReserves.fundingKey, fundingKey)).for("update");
    // A new quote replaces this user's earlier unsubmitted redeem quotes, so re-quoting
    // while typing does not stack commitments against the same liquidity.
    const superseded = await tx.update(creditEconomyQuotes).set({ status: "cancelled", updatedAt: new Date() })
      .where(and(
        eq(creditEconomyQuotes.ownerUserId, quote.ownerUserId),
        eq(creditEconomyQuotes.mode, "redeem"),
        eq(creditEconomyQuotes.status, "quoted"),
        isNull(creditEconomyQuotes.txHash),
        ne(creditEconomyQuotes.id, quote.id),
      )).returning({ id: creditEconomyQuotes.id });
    if (superseded.length) {
      await tx.update(creditEconomyActivity).set({
        status: "cancelled", detail: "Replaced by a newer quote.", updatedAt: new Date(),
      }).where(and(
        inArray(creditEconomyActivity.quoteId, superseded.map((r) => r.id)),
        eq(creditEconomyActivity.kind, "quote"),
      ));
    }
    const reserved = await activeRedemptionReservationUnits(tx, config, asset, new Date());
    if (fundedBalance < reserved) {
      await tx.update(creditEconomyQuotes).set({ status: "cancelled", updatedAt: new Date() })
        .where(eq(creditEconomyQuotes.id, quote.id));
      await tx.update(creditEconomyActivity).set({
        status: "cancelled",
        detail: "Liquidity cannot cover this redemption quote and all live quote commitments.",
        updatedAt: new Date(),
      }).where(and(
        eq(creditEconomyActivity.quoteId, quote.id),
        eq(creditEconomyActivity.kind, "quote"),
      ));
      const remaining = await activeRedemptionReservationUnits(tx, config, asset, new Date());
      await tx.update(creditEconomyReserves).set({
        reservedAmount: remaining.toString(),
        updatedAt: new Date(),
      }).where(eq(creditEconomyReserves.fundingKey, fundingKey));
      return false;
    }
    await tx.update(creditEconomyReserves).set({
      reservedAmount: reserved.toString(),
      updatedAt: new Date(),
    }).where(eq(creditEconomyReserves.fundingKey, fundingKey));
    return true;
  });
}

async function syncRedemptionLiquidityReserve(config: ReturnType<typeof creditConfiguration>, outputToken: string): Promise<void> {
  const asset = assetRegistry(config).find((a) => a.chain === "robinhood" && a.address.toLowerCase() === outputToken.toLowerCase());
  if (!config.addresses.treasuryAddress || !asset) return;
  const fundingKey = redeemFundingKey(config, asset);
  await db.transaction(async (tx) => {
    await tx.insert(creditEconomyReserves).values({ fundingKey, reservedAmount: "0" }).onConflictDoNothing();
    await tx.select().from(creditEconomyReserves)
      .where(eq(creditEconomyReserves.fundingKey, fundingKey)).for("update");
    const reserved = await activeRedemptionReservationUnits(tx, config, asset, new Date());
    await tx.update(creditEconomyReserves).set({
      reservedAmount: reserved.toString(),
      updatedAt: new Date(),
    }).where(eq(creditEconomyReserves.fundingKey, fundingKey));
  });
}

async function getQuoteCashback(quoteId: string): Promise<CashbackRow | undefined> {
  return db.query.creditEconomyCashbacks.findFirst({
    where: eq(creditEconomyCashbacks.quoteId, quoteId),
  });
}

async function releaseCashbackReserve(
  row: CashbackRow,
  config: ReturnType<typeof creditConfiguration>,
  payoutTxHash: string,
): Promise<void> {
  const usdg = findCreditAsset(config, "robinhood", "USDG");
  const token = config.addresses.usdgAddress;
  if (!usdg || !token) return;
  const amount = parseDecimalAmount(row.amountUsdg, usdg.decimals)?.units;
  if (!amount) return;
  const fundingKey = `usdg:${token.toLowerCase()}:${config.addresses.cashbackAddress?.toLowerCase()}`;
  await db.transaction(async (tx) => {
    await tx.insert(creditEconomyReserves).values({ fundingKey, reservedAmount: "0" }).onConflictDoNothing();
    await tx.select().from(creditEconomyReserves).where(eq(creditEconomyReserves.fundingKey, fundingKey)).for("update");
    const [currentCashback] = await tx.select().from(creditEconomyCashbacks)
      .where(eq(creditEconomyCashbacks.id, row.id)).for("update");
    if (!currentCashback || currentCashback.status === "paid" ||
        (currentCashback.status !== "reserved" && currentCashback.status !== "pending")) return;
    const [bucket] = await tx.select().from(creditEconomyReserves).where(eq(creditEconomyReserves.fundingKey, fundingKey));
    const current = BigInt(bucket?.reservedAmount ?? "0");
    await tx.update(creditEconomyReserves).set({
      reservedAmount: (current >= amount ? current - amount : 0n).toString(),
      updatedAt: new Date(),
    }).where(eq(creditEconomyReserves.fundingKey, fundingKey));
    await tx.update(creditEconomyCashbacks).set({
      status: "paid",
      payoutTxHash,
      attemptCount: currentCashback.attemptCount + 1,
      lastErrorCode: null,
      updatedAt: new Date(),
    }).where(eq(creditEconomyCashbacks.id, row.id));
    await tx.update(creditEconomyActivity).set({
      status: "paid",
      updatedAt: new Date(),
    }).where(and(
      eq(creditEconomyActivity.quoteId, row.quoteId),
      eq(creditEconomyActivity.kind, "cashback"),
    ));
  });
}

async function attemptCashbackPayout(
  quote: QuoteRow,
  config: ReturnType<typeof creditConfiguration>,
  cashbackRow: CashbackRow | undefined,
): Promise<CashbackRow | undefined> {
  if (!cashbackRow || (cashbackRow.status !== "reserved" && cashbackRow.status !== "pending")) return cashbackRow;
  const usdg = findCreditAsset(config, "robinhood", "USDG");
  const usdgAddress = config.addresses.usdgAddress;
  const cashbackAddress = config.addresses.cashbackAddress;
  const signerAddress = config.settlementSignerAddress;
  if (!usdg || !usdgAddress || !cashbackAddress || !signerAddress || !config.settlementEnabled) return cashbackRow;
  const amountUnits = parseDecimalAmount(cashbackRow.amountUsdg, usdg.decimals)?.units;
  if (!amountUnits) return cashbackRow;
  try {
    const fundingKey = `usdg:${usdgAddress.toLowerCase()}:${cashbackAddress.toLowerCase()}`;
    const bucket = await db.query.creditEconomyReserves.findFirst({
      where: eq(creditEconomyReserves.fundingKey, fundingKey),
    });
    const reserved = BigInt(bucket?.reservedAmount ?? "0");
    const actual = await getFinalizedErc20Balance(config, usdgAddress, cashbackAddress);
    if (actual < reserved) throw new Error("cashback_reserve_unfunded");
    const payment = await payoutReservedCashback(config, {
      quoteId: quote.id,
      recipientAddress: cashbackRow.recipientAddress,
      cashbackAddress,
      usdgAddress,
      amountBaseUnits: amountUnits.toString(),
    });
    if (!payment.txHash) throw new Error("cashback_payout_pending");
    const verified = await verifyFinalizedErc20Transfer({
      config,
      txHash: payment.txHash,
      tokenAddress: usdgAddress,
      from: cashbackAddress,
      to: cashbackRow.recipientAddress,
      amount: amountUnits.toString(),
      transactionSender: cashbackAddress,
    });
    if (!verified.finalized) throw new Error("cashback_payout_not_finalized");
    await releaseCashbackReserve(cashbackRow, config, payment.txHash);
    return db.query.creditEconomyCashbacks.findFirst({ where: eq(creditEconomyCashbacks.id, cashbackRow.id) });
  } catch (error) {
    await db.transaction(async (tx) => {
      const [current] = await tx.select().from(creditEconomyCashbacks)
        .where(eq(creditEconomyCashbacks.id, cashbackRow.id)).for("update");
      if (current && current.status !== "paid") {
        await tx.update(creditEconomyCashbacks).set({
          status: "pending",
          attemptCount: current.attemptCount + 1,
          lastErrorCode: reasonOf(error),
          updatedAt: new Date(),
        }).where(eq(creditEconomyCashbacks.id, cashbackRow.id));
      }
    });
    await db.update(creditEconomyActivity).set({
      status: "pending",
      detail: "Payout awaits independently verified USDG funding and finalized receipt.",
      updatedAt: new Date(),
    }).where(and(eq(creditEconomyActivity.quoteId, quote.id), eq(creditEconomyActivity.kind, "cashback")));
    return db.query.creditEconomyCashbacks.findFirst({ where: eq(creditEconomyCashbacks.id, cashbackRow.id) });
  }
}

/**
 * After a $CRED swap has issued its credit (and cashback was attempted), the treasury burns the exact $CRED received.
 * Returns the burn transaction once it is mined and its Transfer to the dead address is verified.
 */
async function burnCredDeposit(quote: QuoteRow, config: ReturnType<typeof creditConfiguration>): Promise<string | null> {
  const treasury = config.addresses.treasuryAddress;
  if (quote.mode !== "swap" || quote.chain !== "robinhood" || quote.status !== "completed" || !treasury || !isProjectToken(quote.inputToken)) return null;
  const done = await db.query.creditEconomyActivity.findFirst({
    where: and(eq(creditEconomyActivity.quoteId, quote.id), eq(creditEconomyActivity.kind, "burn")),
  });
  if (done?.status === "completed" && done.txHash) return done.txHash;
  const deposit = (quote.expectedTransfers as Array<{ tokenAddress: string; to: string; amount: string }>).find((t) =>
    t.tokenAddress.toLowerCase() === quote.inputToken.toLowerCase() && t.to.toLowerCase() === treasury.toLowerCase());
  if (!deposit) return null;
  const record = async (status: string, txHash: string | null, detail: string) => {
    await db.insert(creditEconomyActivity).values({
      id: randomUUID(), ownerUserId: quote.ownerUserId, quoteId: quote.id, kind: "burn",
      chain: "robinhood", asset: quote.asset, amount: quote.inputAmount, status, txHash, detail,
    }).onConflictDoNothing();
    await db.update(creditEconomyActivity).set({ status, txHash, detail, updatedAt: new Date() })
      .where(and(eq(creditEconomyActivity.quoteId, quote.id), eq(creditEconomyActivity.kind, "burn")));
  };
  try {
    const sent = await burnProjectTokenDeposit(quote.id, quote.inputToken, BigInt(deposit.amount));
    if (!sent.txHash) throw new Error(`burn_${sent.state}`);
    await rpcProvider().waitForTransaction(sent.txHash, 1, 30_000).catch(() => null);
    const verified = await verifyFinalizedErc20Transfer({
      config, txHash: sent.txHash, tokenAddress: quote.inputToken, from: treasury, to: PROJECT_TOKEN_BURN_ADDRESS,
      amount: deposit.amount, transactionSender: treasury,
    });
    if (!verified.finalized) {
      await record("pending", sent.txHash, "Burn transaction sent; waiting for it to be mined.");
      return null;
    }
    await record("completed", sent.txHash, `${quote.inputAmount} ${quote.asset} you paid was burned onchain`);
    return sent.txHash;
  } catch (error) {
    logger.warn({ reason: reasonOf(error), quoteId: quote.id }, "CRED burn pending");
    if (done?.status !== "completed") await record("pending", done?.txHash ?? null, "Burn is queued.");
    return null;
  }
}

function prepareQuoteResponse(quote: QuoteRow, cashback: CashbackRow | undefined) {
  const transaction = quote.transaction as {
    chainId: number | string; to: string; data: string | null; value: string; serialized: string | null;
  };
  const approvals = quote.approvals as Array<{ transaction: { to: string; data: string; value: string } }>;
  return {
    quoteId: quote.id,
    reference: quote.id,
    mode: quote.mode,
    chain: quote.chain,
    asset: quote.asset,
    amount: quote.amount,
    inputToken: quote.inputToken,
    outputToken: quote.outputToken,
    inputAmount: quote.inputAmount,
    outputAmount: quote.outputAmount,
    netUsdMicros: quote.netUsdMicros,
    credits: quote.mode === "redeem" ? null : formatUnits(BigInt(quote.netUsdMicros) * 100n * USD_MICROS_TO_18_DECIMAL_UNITS, 18),
    cashback: cashback ? outputCashback(cashback) : {
      status: quote.mode === "swap" ? "not_eligible" : "not_eligible",
      percentBps: null, amountUsdg: null, recipientAddress: null,
      reason: quote.mode === "redeem"
        ? "redemptions_are_not_cashback_eligible"
        : "cashback_reserve_unavailable_or_below_minimum",
    },
    chainId: quote.chain === "robinhood" ? 4663 : "solana-mainnet",
    payer: quote.sourceWalletAddress,
    recipientWalletAddress: quote.walletAddress,
    transactions: [
      ...approvals.map((approval) => ({
        kind: "approval" as const,
        to: approval.transaction.to,
        data: approval.transaction.data,
        value: approval.transaction.value,
      })),
      {
        kind: "purchase" as const,
        to: transaction.to,
        data: transaction.serialized ?? transaction.data ?? "0x",
        value: transaction.value,
      },
    ],
    transaction,
    approvals,
    route: quote.route,
    expected: {
      to: quote.expectedTo,
      value: quote.expectedValue,
      calldata: quote.expectedCalldata,
      transfers: jsonTransfers(quote.expectedTransfers),
    },
    expiresAt: quote.expiresAt.toISOString(),
  };
}

async function setQuoteStatus(quoteId: string, status: string, txHash?: string | null): Promise<void> {
  await db.update(creditEconomyQuotes).set({
    status,
    ...(txHash !== undefined ? { txHash } : {}),
    updatedAt: new Date(),
  }).where(eq(creditEconomyQuotes.id, quoteId));
  await db.update(creditEconomyActivity).set({ status, updatedAt: new Date() }).where(and(
    eq(creditEconomyActivity.quoteId, quoteId),
    eq(creditEconomyActivity.kind, "quote"),
  ));
}

async function updatePurchaseActivity(quote: QuoteRow, status: string, detail: string | null, txHash = quote.txHash): Promise<void> {
  await db.insert(creditEconomyActivity).values({
    id: randomUUID(), ownerUserId: quote.ownerUserId, quoteId: quote.id,
    kind: quote.mode, chain: quote.chain, asset: quote.asset, amount: quote.amount,
    status, txHash, detail,
  }).onConflictDoNothing();
  await db.update(creditEconomyActivity).set({
    status, txHash, detail, updatedAt: new Date(),
  }).where(and(eq(creditEconomyActivity.quoteId, quote.id), eq(creditEconomyActivity.kind, quote.mode)));
}

async function loadActiveQuoteOwnership(quote: QuoteRow): Promise<boolean> {
  const [recipient, source] = await Promise.all([
    db.query.verifiedWalletOwnerships.findFirst({
      where: and(eq(verifiedWalletOwnerships.id, quote.walletOwnershipId),
        eq(verifiedWalletOwnerships.ownerUserId, quote.ownerUserId),
        isNull(verifiedWalletOwnerships.revokedAt)),
    }),
    db.query.verifiedWalletOwnerships.findFirst({
      where: and(eq(verifiedWalletOwnerships.id, quote.sourceWalletOwnershipId),
        eq(verifiedWalletOwnerships.ownerUserId, quote.ownerUserId),
        isNull(verifiedWalletOwnerships.revokedAt)),
    }),
  ]);
  return Boolean(recipient && source &&
    recipient.walletAddress.toLowerCase() === quote.walletAddress.toLowerCase() &&
    (quote.chain === "solana"
      ? source.walletAddress === quote.sourceWalletAddress
      : source.walletAddress.toLowerCase() === quote.sourceWalletAddress.toLowerCase()));
}

async function verifyQuotePayment(quote: QuoteRow, txHash: string, config: ReturnType<typeof creditConfiguration>) {
  const route = quote.route as Record<string, unknown>;
  const solanaPayment = route.solanaPayment as PreparedSolanaMessage | undefined;
  let atomicPurchase: AtomicPurchaseExpectation | undefined;
  if (quote.mode === "buy" && quote.chain === "robinhood") {
    const prepared = route.atomicPurchase as AtomicPurchaseExpectation | undefined;
    const inputAsset = findCreditAsset(config, "robinhood", "USDG");
    if (!prepared || !config.addresses.purchaseAddress || !config.addresses.creditTokenAddress ||
        !inputAsset ||
        prepared.purchaseAddress.toLowerCase() !== config.addresses.purchaseAddress.toLowerCase() ||
        prepared.user.toLowerCase() !== quote.walletAddress.toLowerCase() ||
        prepared.inputToken.toLowerCase() !== quote.inputToken.toLowerCase() ||
        prepared.inputAmount !== parseDecimalAmount(quote.inputAmount, inputAsset.decimals)?.units.toString() ||
        prepared.creditToken.toLowerCase() !== config.addresses.creditTokenAddress.toLowerCase() ||
        prepared.creditAmount !== parseDecimalAmount(quote.outputAmount, 18)?.units.toString() ||
        !/^\d+$/.test(prepared.nonce)) {
      throw new Error("atomic_purchase_quote_expectation_missing_or_invalid");
    }
    atomicPurchase = prepared;
  }
  return verifyFinalizedTransaction(config, quote.chain as CreditChain, {
    txHash,
    sender: quote.sourceWalletAddress,
    expectedTo: quote.expectedTo,
    expectedValue: quote.expectedValue,
    expectedCalldata: quote.expectedCalldata,
    expectedToken: quote.expectedToken,
    expectedRecipient: quote.expectedRecipient,
    expectedTokenAmount: quote.expectedTokenAmount,
    expectedTransfers: jsonTransfers(quote.expectedTransfers),
    ...(quote.chain === "solana" ? { preparedMessage: solanaPayment } : {}),
    ...(atomicPurchase ? { atomicPurchase } : {}),
  });
}

async function settleConfirmedPurchase(
  quote: QuoteRow,
  txHash: string,
  paymentBlock: string,
  config: ReturnType<typeof creditConfiguration>,
): Promise<{ completed: boolean; settlementTxHash: string | null }> {
  const creditToken = config.addresses.creditTokenAddress;
  const signerAddress = config.settlementSignerAddress;
  const credits = parseDecimalAmount(
    formatUnits(BigInt(quote.netUsdMicros) * 100n * USD_MICROS_TO_18_DECIMAL_UNITS, 18),
    18,
  )?.units;
  if (!creditToken || !signerAddress || !credits) throw new Error("credit_settlement_not_configured");
  let mintTxHash: string | null = null;
  const existingRoute = quote.route as Record<string, unknown>;
  const prior = typeof existingRoute.settlementTxHash === "string" && isTxHash(existingRoute.settlementTxHash, "robinhood")
    ? existingRoute.settlementTxHash : null;
  if (prior) mintTxHash = prior;
  if (!mintTxHash) {
    const submission = await settleCreditPurchase(config, {
      quoteId: quote.id,
      ownerUserId: quote.ownerUserId,
      recipientAddress: quote.walletAddress,
      creditTokenAddress: creditToken,
      creditsBaseUnits: credits.toString(),
      paymentChain: quote.chain as CreditChain,
      paymentTxHash: txHash,
      paymentBlock,
      netUsdMicros: quote.netUsdMicros,
      quoteRouteId: String(existingRoute.id ?? quote.id),
    });
    mintTxHash = submission.txHash;
  }
  if (!mintTxHash) return { completed: false, settlementTxHash: null };
  const verification = await verifyFinalizedErc20Transfer({
    config,
    txHash: mintTxHash,
    tokenAddress: creditToken,
    from: ZERO_ADDRESS,
    to: quote.walletAddress,
    amount: credits.toString(),
    transactionSender: signerAddress,
  });
  if (!verification.finalized) return { completed: false, settlementTxHash: mintTxHash };
  return { completed: true, settlementTxHash: mintTxHash };
}

async function confirmWithTx(
  quote: QuoteRow,
  txHash: string,
  config: ReturnType<typeof creditConfiguration>,
) {
  if (!await loadActiveQuoteOwnership(quote)) throw new Error("verified_wallet_ownership_revoked");
  const result = await verifyQuotePayment(quote, txHash, config);
  if (!result.finalized) {
    await setQuoteStatus(quote.id, "reconciling", txHash);
    await updatePurchaseActivity(quote, "reconciling", "Payment transaction has not reached mainnet finality.", txHash);
    return { pending: true as const, response: confirmationResponse(quote.id, txHash, "reconciling", false, null, "payment_not_finalized", undefined, null) };
  }
  if (result.confirmedAtMs === null || result.confirmedAtMs > quote.expiresAt.getTime()) {
    await setQuoteStatus(quote.id, "expired", null);
    throw new Error("quote_expired_before_finalized_payment");
  }
  const proofBlock = result.blockNumber ?? result.slot;
  if (!proofBlock) throw new Error("finalized_payment_proof_missing");
  await db.update(creditEconomyQuotes).set({
    status: "payment_confirmed",
    txHash,
    confirmedAt: new Date(result.confirmedAtMs),
    updatedAt: new Date(),
  }).where(eq(creditEconomyQuotes.id, quote.id));
  await updatePurchaseActivity(quote, "payment_confirmed", `Finalized source payment at block/slot ${proofBlock}.`, txHash);

  if (quote.mode === "redeem") {
    if (quote.chain !== "robinhood") throw new Error("redemption_chain_mismatch");
    const routeData = quote.route as Record<string, unknown>;
    const payout = routeData.redeemPayout as { minOut: string } | undefined;
    const creditToken = config.addresses.creditTokenAddress;
    if (!payout || !creditToken) throw new Error("redemption_payout_plan_missing");
    let payoutTx: string | null = null;
    try {
      const prior = typeof routeData.payoutTxHash === "string" ? routeData.payoutTxHash : null;
      payoutTx = prior ?? (await payoutRedemption(config, {
        quoteId: quote.id,
        recipientAddress: quote.sourceWalletAddress,
        creditTokenAddress: creditToken,
        creditTransferTxHash: txHash,
        creditAmountBaseUnits: parseDecimalAmount(quote.amount, 18)!.units.toString(),
        outputTokenAddress: quote.outputToken,
        minOutBaseUnits: payout.minOut,
      })).txHash;
    } catch (error) {
      logger.warn({ reason: reasonOf(error) }, "Redemption payout not completed");
    }
    if (!payoutTx) {
      await setQuoteStatus(quote.id, "reconciling", txHash);
      await updatePurchaseActivity(quote, "reconciling", "CREDIT received by the treasury; payout is pending.", txHash);
      return { pending: true as const, response: confirmationResponse(quote.id, txHash, "reconciling", false, null, "redemption_payout_pending", undefined, null) };
    }
    const route = { ...routeData, payoutTxHash: payoutTx };
    await db.update(creditEconomyQuotes).set({ status: "completed", route, txHash, updatedAt: new Date() })
      .where(eq(creditEconomyQuotes.id, quote.id));
    await syncRedemptionLiquidityReserve(config, quote.outputToken);
    await updatePurchaseActivity(quote, "completed", `Redemption paid out in ${payoutTx}.`, payoutTx);
    return { pending: false as const, response: confirmationResponse(quote.id, txHash, "completed", false, payoutTx, null, undefined, null) };
  }

  if (quote.mode === "buy" && quote.chain === "robinhood") {
    await setQuoteStatus(quote.id, "completed", txHash);
    await updatePurchaseActivity(quote, "completed", "Treasury payment, exact purchase quote nonce, and credit mint finalized atomically in the purchase contract.", txHash);
    const cashback = await attemptCashbackPayout(quote, config, await getQuoteCashback(quote.id));
    return { pending: false as const, response: confirmationResponse(
      quote.id, txHash, "completed", true, txHash, null, cashback,
      formatUnits(BigInt(quote.netUsdMicros) * 100n * USD_MICROS_TO_18_DECIMAL_UNITS, 18),
    ) };
  }

  let settlement: { completed: boolean; settlementTxHash: string | null };
  try {
    settlement = await settleConfirmedPurchase(quote, txHash, proofBlock, config);
  } catch {
    await db.update(creditEconomyQuotes).set({ status: "reconciling", txHash, updatedAt: new Date() })
      .where(eq(creditEconomyQuotes.id, quote.id));
    await updatePurchaseActivity(quote, "reconciling", "Payment finalized; secure signer settlement is awaiting retry.", txHash);
    return { pending: true as const, response: confirmationResponse(quote.id, txHash, "reconciling", false, null, "settlement_service_pending", await getQuoteCashback(quote.id), null) };
  }
  if (!settlement.completed) {
    const route = { ...(quote.route as Record<string, unknown>), settlementTxHash: settlement.settlementTxHash };
    await db.update(creditEconomyQuotes).set({ status: "reconciling", route, txHash, updatedAt: new Date() })
      .where(eq(creditEconomyQuotes.id, quote.id));
    await updatePurchaseActivity(quote, "reconciling", "Payment is finalized; credit mint is awaiting a verified final receipt.", txHash);
    return { pending: true as const, response: confirmationResponse(quote.id, txHash, "reconciling", false, null, "credit_mint_not_finalized", await getQuoteCashback(quote.id), null) };
  }
  const route = { ...(quote.route as Record<string, unknown>), settlementTxHash: settlement.settlementTxHash };
  await db.update(creditEconomyQuotes).set({ status: "completed", route, txHash, updatedAt: new Date() })
    .where(eq(creditEconomyQuotes.id, quote.id));
  await updatePurchaseActivity(quote, "completed", `Credit mint finalized in ${settlement.settlementTxHash}.`, txHash);
  const cashback = await attemptCashbackPayout(quote, config, await getQuoteCashback(quote.id));
  const burnTxHash = await burnCredDeposit({ ...quote, status: "completed", route }, config);
  return { pending: false as const, response: { ...confirmationResponse(
    quote.id, txHash, "completed", true, settlement.settlementTxHash, null, cashback,
    formatUnits(BigInt(quote.netUsdMicros) * 100n * USD_MICROS_TO_18_DECIMAL_UNITS, 18),
  ), burnTxHash } };
}

function confirmationResponse(
  quoteId: string,
  txHash: string,
  status: "reconciling" | "completed",
  creditsIssued: boolean,
  settlementTxHash: string | null,
  reason: string | null,
  cashback: CashbackRow | undefined,
  credits: string | null,
) {
  return {
    quoteId,
    status,
    txHash,
    settlementTxHash,
    confirmedAt: new Date().toISOString(),
    creditsIssued,
    credits,
    reason,
    cashback: cashback ? {
      status: cashback.status,
      amountUsdg: cashback.amountUsdg,
      recipientAddress: cashback.recipientAddress,
      payoutTxHash: cashback.payoutTxHash,
    } : { status: "not_eligible", amountUsdg: null, recipientAddress: null, payoutTxHash: null },
  };
}

router.get("/credit/cred-stats", async (req, res) => {
  try {
    const stats = await credStats();
    if (!stats) { res.status(404).json({ error: "token_not_configured" }); return; }
    res.json(stats);
  } catch (error) {
    req.log.warn({ reason: reasonOf(error) }, "CRED stats unavailable");
    res.status(503).json({ error: "stats_unavailable" });
  }
});

router.get("/credit/config", async (_req, res) => {
  const config = creditConfiguration();
  const redeem = await fundedRedeemCapability(config);
  let buy = config.capabilities.buy;
  if (buy.enabled && config.addresses.purchaseAddress) {
    try {
      await getFinalizedQuoteSigner(config, config.addresses.purchaseAddress);
      if (!config.addresses.usdgAddress ||
          !await isFinalizedPurchaseInputEligible(config, config.addresses.purchaseAddress, config.addresses.usdgAddress)) {
        buy = { enabled: false, reason: "The deployed atomic purchase contract does not authorize the configured USDG input." };
      }
    } catch {
      buy = { enabled: false, reason: "The deployed purchase contract or its finalized quote signer is unavailable on Robinhood mainnet." };
    }
  }
  res.json({
    network: config.network,
    chainId: config.chainId,
    rpcUrl: publicRpcUrl(config.robinhoodRpcUrl, config.rpcUrl),
    explorerUrl: config.explorerUrl,
    creditTokenAddress: config.creditTokenAddress,
    vaultAddress: config.vaultAddress,
    purchaseAddress: config.purchaseAddress,
    redeemAddress: config.redeemAddress,
    treasuryAddress: config.treasuryAddress,
    cashbackAddress: config.cashbackAddress,
    usdgAddress: config.usdgAddress,
    stakingAddress: config.stakingAddress,
    solanaTreasuryAddress: config.solanaTreasuryAddress,
    creditsPerUsd: config.creditsPerUsd,
    solanaExecutorPrograms: config.solanaExecutorPrograms,
    redeemReserveUsdg: redeem.reserveUsdg,
    projectToken: (() => { const own = projectToken(); return own ? { ...own, burnAddress: PROJECT_TOKEN_BURN_ADDRESS } : null; })(),
    robinhoodAssets: assetRegistry(config).filter((a) => a.chain === "robinhood")
      .map((a) => ({ symbol: a.symbol, address: a.address, decimals: a.decimals, category: a.dex || a.symbol === "ETH" ? "crypto" : a.symbol === "USDG" ? "stable" : "stock" })),
    capabilities: { ...config.capabilities, buy, redeem },
    missing: config.missing,
  });
});

let logoCache: { at: number; data: Record<string, string> } | null = null;

/** Official logos: Robinhood's asset catalogue for stock tokens, DexScreener/GeckoTerminal token images for crypto. */
router.get("/credit/asset-logos", async (_req, res): Promise<void> => {
  if (logoCache && Date.now() - logoCache.at < 3_600_000) { res.json({ logos: logoCache.data }); return; }
  const logos: Record<string, string> = {};
  try {
    const r = await fetch("https://api.robinhood.com/rhj/assets", { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8_000) });
    if (r.ok) for (const a of ((await r.json()) as { assets?: Array<{ tokenSymbol: string; logoUrl?: string }> }).assets ?? []) {
      if (a.logoUrl && /^https:\/\//.test(a.logoUrl)) logos[a.tokenSymbol.toUpperCase()] = a.logoUrl;
    }
  } catch { /* stock logos fall back to initials */ }
  const config = creditConfiguration();
  await Promise.all(assetRegistry(config).filter((a) => a.chain === "robinhood" && (a.dex || a.symbol === "ETH" || a.symbol === "USDG")).map(async (a) => {
    const address = a.symbol === "ETH" ? ROBINHOOD_WETH : a.address;
    const url = (await dexQuote(address))?.imageUrl ?? (await geckoToken(address))?.imageUrl;
    if (url && /^https:\/\//.test(url)) logos[a.symbol] = url;
  }));
  const SOLANA_LOGOS = "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet";
  logos.SOL ??= `${SOLANA_LOGOS}/So11111111111111111111111111111111111111112/logo.png`;
  logos.USDC ??= `${SOLANA_LOGOS}/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png`;
  logos.USDT ??= "https://coin-images.coingecko.com/coins/images/325/large/Tether.png";
  if (Object.keys(logos).length) logoCache = { at: Date.now(), data: logos };
  res.json({ logos });
});

let availabilityCache: { at: number; data: Array<{ symbol: string; swap: boolean; redeem: boolean }> } | null = null;
let availabilityPending: Promise<Array<{ symbol: string; swap: boolean; redeem: boolean }>> | null = null;

/** Which assets can be swapped in or redeemed out right now. Booleans only; no balances or liquidity details. */
router.get("/credit/availability", async (_req, res): Promise<void> => {
  if (availabilityCache && Date.now() - availabilityCache.at < 60_000) { res.json({ assets: availabilityCache.data }); return; }
  try {
    availabilityPending ??= (async () => {
      const config = creditConfiguration();
      const assets = assetRegistry(config).filter((a) => a.chain === "robinhood");
      const out: Array<{ symbol: string; swap: boolean; redeem: boolean }> = [];
      for (let i = 0; i < assets.length; i += 8) {
        const chunk = await Promise.all(assets.slice(i, i + 8).map(async (asset) => {
          try { return { symbol: asset.symbol, ...(await assetAvailability(asset)) }; } catch { return { symbol: asset.symbol, swap: false, redeem: false }; }
        }));
        out.push(...chunk);
      }
      availabilityCache = { at: Date.now(), data: out };
      return out;
    })().finally(() => { availabilityPending = null; });
    res.json({ assets: await availabilityPending });
  } catch {
    res.status(503).json({ error: "Availability is temporarily unavailable." });
  }
});

type PlatformStats = { swapVolumeUsd: number; directBuyVolumeUsd: number; cashbackPaidUsd: number; creditsUsed: number; swaps: number; directBuys: number };
let statsCache: { at: number; data: PlatformStats } | null = null;

/** Public, aggregate-only platform totals for the landing page. No per-user or treasury data. */
router.get("/credit/stats", async (_req, res): Promise<void> => {
  if (statsCache && Date.now() - statsCache.at < 5_000) { res.json(statsCache.data); return; }
  try {
    const num = (v: unknown) => Number(v ?? 0) || 0;
    const [quotes] = (await db.execute(sql`
      select
        coalesce(sum(net_usd_micros::numeric) filter (where mode = 'swap'), 0) as swap_micros,
        count(*) filter (where mode = 'swap') as swaps,
        coalesce(sum(net_usd_micros::numeric) filter (where mode = 'buy'), 0) as buy_micros,
        count(*) filter (where mode = 'buy') as buys
      from credit_economy_quotes where status = 'completed' and mode in ('swap', 'buy')`)).rows;
    const [sol] = (await db.execute(sql`
      select coalesce(sum(net_usd_micros::numeric), 0) as micros, count(*) as n from solana_deposit_sessions where status = 'completed'`)).rows;
    const [cb] = (await db.execute(sql`
      select coalesce(sum(amount_usdg::numeric), 0) as usdg from credit_economy_cashbacks where status = 'paid'`)).rows;
    const [used] = (await db.execute(sql`
      select coalesce(sum(charged_microcredits), 0) as micro from credit_usage_ledger where status = 'charged'`)).rows;
    const data: PlatformStats = {
      swapVolumeUsd: num(quotes?.swap_micros) / 1e6,
      directBuyVolumeUsd: (num(quotes?.buy_micros) + num(sol?.micros)) / 1e6,
      cashbackPaidUsd: num(cb?.usdg),
      creditsUsed: num(used?.micro) / 1e6,
      swaps: num(quotes?.swaps),
      directBuys: num(quotes?.buys) + num(sol?.n),
    };
    statsCache = { at: Date.now(), data };
    res.json(data);
  } catch {
    res.status(503).json({ error: "Platform stats are temporarily unavailable." });
  }
});

/** Total cashback paid to the signed-in user. */
router.get("/credit/cashback-total", requirePrivySession, async (req, res): Promise<void> => {
  if (!req.privySession) { res.status(401).json({ error: "A verified Privy session is required." }); return; }
  try {
    const [row] = (await db.execute(sql`
      select coalesce(sum(amount_usdg::numeric), 0) as usdg, count(*) as n
      from credit_economy_cashbacks where owner_user_id = ${req.privySession.userId} and status = 'paid'`)).rows;
    res.json({ totalUsdg: String(row?.usdg ?? "0"), payouts: Number(row?.n ?? 0) });
  } catch {
    res.status(503).json({ error: "Cashback total is temporarily unavailable." });
  }
});

router.get("/credit/account", requirePrivySession, async (req, res): Promise<void> => {
  if (!req.privySession) { res.status(401).json({ error: "A verified Privy session is required." }); return; }
  try {
    const wallet = await findVerifiedWallet(req.privySession.userId, "robinhood");
    if (!wallet) {
      res.status(409).json({ error: "Verify a Robinhood Chain mainnet wallet before viewing a credit account." });
      return;
    }
    const config = creditConfiguration();
    const enabled = capability(config, "account");
    if (!enabled.enabled) {
      res.json({
        walletAddress: wallet.walletAddress, chainId: "4663", enabled: false, reason: enabled.reason,
        balanceCredits: null, depositedCredits: null, reservedCredits: null, availableCredits: null, blockNumber: null,
      });
      return;
    }
    const state = await getRobinhoodCreditAccount(config, wallet.walletAddress);
    res.json({
      walletAddress: wallet.walletAddress, chainId: "4663", enabled: true, reason: null, ...state,
    });
  } catch {
    req.log.warn({ reason: "robinhood_finalized_account_read_failed" }, "Credit account read unavailable");
    res.status(503).json({
      error: "Finalized Robinhood mainnet credit account data is temporarily unavailable.",
      reason: "robinhood_finalized_account_read_failed",
    });
  }
});

const holdingsCache = new Map<string, { at: number; data: Array<{ symbol: string; balance: string }> }>();
router.get("/credit/holdings", requirePrivySession, async (req, res): Promise<void> => {
  if (!req.privySession) { res.status(401).json({ error: "A verified Privy session is required." }); return; }
  try {
    const wallet = await findVerifiedWallet(req.privySession.userId, "robinhood");
    if (!wallet) { res.status(409).json({ error: "Verify a Robinhood Chain mainnet wallet first." }); return; }
    const key = wallet.walletAddress.toLowerCase();
    const hit = holdingsCache.get(key);
    if (hit && Date.now() - hit.at < 20_000) { res.json({ holdings: hit.data }); return; }
    const config = creditConfiguration();
    const assets = assetRegistry(config).filter((a) => a.chain === "robinhood");
    const found: Array<{ symbol: string; balance: string; usd: string | null }> = [];
    for (let i = 0; i < assets.length; i += 10) {
      const part = await Promise.all(assets.slice(i, i + 10).map(async (a) => {
        try {
          const raw = await walletTokenBalance(a, wallet.walletAddress);
          if (raw <= 0n) return null;
          let usd: string | null = null;
          try { usd = formatUnits(await assetUsdValueMicros(a, raw), 6); } catch { usd = null; }
          return { symbol: a.symbol, balance: formatUnits(raw, a.decimals), usd };
        } catch { return null; }
      }));
      for (const x of part) if (x) found.push(x);
    }
    holdingsCache.set(key, { at: Date.now(), data: found });
    res.json({ holdings: found });
  } catch {
    res.status(503).json({ error: "Wallet balances are temporarily unavailable." });
  }
});

router.get("/credit/activity", requirePrivySession, async (req, res): Promise<void> => {
  if (!req.privySession) { res.status(401).json({ error: "A verified Privy session is required." }); return; }
  try {
    const wallet = await findVerifiedWallet(req.privySession.userId, "robinhood");
    if (!wallet) {
      res.status(409).json({ error: "Verify a Robinhood Chain mainnet wallet before viewing credit activity." });
      return;
    }
    const rows = await db.query.creditEconomyActivity.findMany({
      where: eq(creditEconomyActivity.ownerUserId, req.privySession.userId),
      orderBy: [desc(creditEconomyActivity.createdAt)],
      limit: 300,
    });
    // Only real on-chain actions: quotes are never shown, cashback only once paid.
    const real = rows.filter((row) => row.kind !== "quote" && !(row.kind === "cashback" && row.status !== "paid") && !(row.kind === "burn" && row.status !== "completed")).slice(0, 100);
    const doneIds = real.filter((r) => ["buy", "swap", "redeem"].includes(r.kind) && r.status === "completed" && r.quoteId).map((r) => r.quoteId!);
    const doneQuotes = doneIds.length ? await db.query.creditEconomyQuotes.findMany({ where: inArray(creditEconomyQuotes.id, doneIds) }) : [];
    const quoteById = new Map(doneQuotes.map((q) => [q.id, q]));
    const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 4 });
    /** Signed credit change for a completed action: + when credit is received, − when credit is spent. */
    const creditsFor = (row: (typeof real)[number]): number | null => {
      if (row.status !== "completed" || !row.quoteId) return null;
      const q = quoteById.get(row.quoteId);
      if (!q) return null;
      if (row.kind === "redeem") return -Number(row.amount);
      if (row.kind === "buy" || row.kind === "swap") return (Number(q.netUsdMicros) / 1_000_000) * 100;
      return null;
    };
    const describe = (row: (typeof real)[number]) => {
      if (row.status === "reconciling" && row.txHash) return "Confirmed on-chain. Final settlement is in progress.";
      const credits = creditsFor(row);
      const q = row.quoteId ? quoteById.get(row.quoteId) : undefined;
      if (credits !== null && credits !== undefined) {
        if (row.kind === "buy") return `${fmt(credits)} LLM credits bought for ${row.amount} ${row.asset} via ${row.chain === "solana" ? "Solana deposit" : "direct buy"}`;
        if (row.kind === "swap") return `${fmt(credits)} LLM credits swapped from ${row.amount} ${row.asset}`;
        if (row.kind === "redeem") return `${fmt(-credits)} LLM credits redeemed for ${q?.outputAmount ? `${q.outputAmount} ` : ""}${row.asset}`;
      }
      if (row.kind === "cashback") {
        const m = row.detail?.match(/^(\d+) basis points/);
        if (m) return `${(Number(m[1]) / 100).toFixed(2).replace(/\.?0+$/, "")}% cashback on your swap, paid in USDG`;
      }
      return row.detail;
    };
    // Direct Solana purchases live in their own table; show completed ones as buys (link goes to the credit transaction).
    const solanaBuys = (await db.select().from(solanaDepositSessions).where(and(
      eq(solanaDepositSessions.ownerUserId, req.privySession.userId), eq(solanaDepositSessions.status, "completed"),
    ))).map((d) => {
      const credits = (Number(d.netUsdMicros) / 1_000_000) * 100;
      const paid = Number(d.expectedUnits) / 10 ** d.decimals;
      return {
        id: d.id, quoteId: d.id, kind: "buy", chain: "robinhood", asset: d.asset, amount: String(paid),
        status: "completed", txHash: d.settlementTxHash || null,
        detail: `${fmt(credits)} LLM credits bought for ${paid} ${d.asset} via Solana deposit`,
        credits, createdAt: d.createdAt.toISOString(),
      };
    });
    const items = [
      ...real.map((row) => ({
        id: row.id, quoteId: row.quoteId, kind: row.kind, chain: row.chain,
        asset: row.asset, amount: row.amount,
        status: row.status === "reconciling" && row.txHash ? "confirming" : row.status,
        txHash: row.txHash,
        detail: describe(row),
        credits: creditsFor(row), createdAt: row.createdAt.toISOString(),
      })),
      ...solanaBuys,
    ].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100);
    res.json({ activity: items });
  } catch {
    req.log.warn({ reason: "credit_activity_read_failed" }, "Credit activity read unavailable");
    res.status(503).json({ error: "Credit activity is temporarily unavailable.", reason: "credit_activity_read_failed" });
  }
});

async function sourceHasFunds(
  config: ReturnType<typeof creditConfiguration>, chain: CreditChain, tokenAddress: string, inputUnits: bigint, wallet: string,
): Promise<boolean> {
  const solanaFeeReserve = chain === "solana"
    ? 5_000n + (1_400_000n * BigInt(process.env.CREDIT_MAX_SOLANA_PRIORITY_FEE_MICROLAMPORTS ?? "100000") + 999_999n) / 1_000_000n
    : 0n;
  const inputBalance = chain === "robinhood"
    ? (tokenAddress === "native"
      ? await getFinalizedNativeBalance(config, wallet)
      : await getFinalizedErc20Balance(config, tokenAddress, wallet))
    : await getFinalizedSolanaAssetBalance({ config, tokenAddress, walletAddress: wallet });
  const nativeFeeBalance = chain === "solana" && tokenAddress !== "native"
    ? await getFinalizedSolanaAssetBalance({ config, tokenAddress: "native", walletAddress: wallet })
    : inputBalance;
  const required = inputUnits + (chain === "solana" && tokenAddress === "native" ? solanaFeeReserve : 0n);
  return inputBalance >= required && nativeFeeBalance >= solanaFeeReserve;
}


router.post("/credit/quote/:quoteId/funds", requirePrivySession, async (req, res): Promise<void> => {
  if (!req.privySession) { res.status(401).json({ error: "A verified Privy session is required." }); return; }
  try {
    const quote = await db.query.creditEconomyQuotes.findFirst({
      where: and(eq(creditEconomyQuotes.id, String(req.params.quoteId)), eq(creditEconomyQuotes.ownerUserId, req.privySession.userId)),
    });
    if (!quote) { res.status(404).json({ error: "Quote not found." }); return; }
    const config = creditConfiguration();
    const asset = quote.mode === "redeem" ? undefined : findCreditAsset(config, quote.chain as CreditChain, quote.asset);
    if (!asset) { res.json({ fundsOk: true }); return; }
    const units = parseDecimalAmount(quote.inputAmount, asset.decimals)?.units;
    if (!units) { res.status(400).json({ error: "Quote amount is invalid." }); return; }
    res.json({ fundsOk: await sourceHasFunds(config, quote.chain as CreditChain, quote.inputToken, units, quote.sourceWalletAddress) });
  } catch {
    res.status(503).json({ error: "Could not check your balance right now. Please try again." });
  }
});

router.post("/credit/quote", requirePrivySession, async (req, res): Promise<void> => {
  if (!req.privySession) { res.status(401).json({ error: "A verified Privy session is required." }); return; }
  const body = req.body as Record<string, unknown> | undefined;
  const mode = body?.mode;
  const chain = body?.chain;
  const asset = body?.asset;
  const amount = body?.amount;
  if ((mode !== "buy" && mode !== "swap" && mode !== "redeem") ||
      (chain !== "robinhood" && chain !== "solana") ||
      typeof asset !== "string" || !asset.trim() || asset.length > 32 ||
      typeof amount !== "string") {
    res.status(400).json({ error: "mode, chain, asset and a decimal-string amount are required." });
    return;
  }
  const creditMode = mode as CreditMode;
  const creditChain = chain as CreditChain;
  const config = creditConfiguration();
  const routeCapability = creditChain === "solana" && creditMode === "buy"
    ? capability(config, "solanaBuy")
    : creditChain === "solana" && creditMode === "swap"
      ? capability(config, "solanaSwaps")
      : capability(config, creditMode);
  if (!routeCapability.enabled) {
    res.status(503).json({ error: "This financial capability is unavailable.", reason: routeCapability.reason });
    return;
  }
  if (creditChain === "solana" && !capability(config, "solana").enabled) {
    res.status(503).json({ error: "Solana mainnet purchases are unavailable.", reason: capability(config, "solana").reason });
    return;
  }
  if (creditMode === "redeem" && creditChain !== "robinhood") {
    res.status(400).json({ error: "Atomic credit redemption is only available on Robinhood Chain mainnet." });
    return;
  }
  let purchaseQuoteSigner: string | undefined;
  if (creditMode === "buy" && creditChain === "robinhood") {
    const purchase = config.addresses.purchaseAddress;
    try { purchaseQuoteSigner = purchase ? await getFinalizedQuoteSigner(config, purchase) : undefined; } catch { purchaseQuoteSigner = undefined; }
    let eligible = false;
    try {
      eligible = Boolean(purchase && config.addresses.usdgAddress &&
        await isFinalizedPurchaseInputEligible(config, purchase, config.addresses.usdgAddress));
    } catch { eligible = false; }
    if (!purchaseQuoteSigner) {
      res.status(503).json({ error: "The configured atomic purchase contract or its onchain quote signer is unavailable on Robinhood Chain mainnet.", reason: "credit_purchase_contract_not_deployed" });
      return;
    }
    if (!eligible) {
      res.status(503).json({ error: "The deployed atomic purchase contract does not authorize the configured USDG input token.", reason: "credit_purchase_input_not_eligible" });
      return;
    }
  }
  if (creditMode === "buy" && !isDirectBuyAsset(creditChain, asset)) {
    res.status(400).json({ error: "This asset requires swap mode and an executable mainnet route." });
    return;
  }
  if (creditMode === "swap" && isDirectBuyAsset(creditChain, asset)) {
    res.status(400).json({ error: "Use direct buy mode for USDG on Robinhood or SOL, USDC, and USDT on Solana mainnet." });
    return;
  }
  const pair = await loadWalletPair(req.privySession.userId, creditChain);
  if (!pair) {
    res.status(409).json({
      error: creditChain === "solana"
        ? "Verify both a Robinhood Chain recipient wallet and Solana mainnet source wallet before quoting."
        : "Verify a Robinhood Chain mainnet wallet before quoting.",
    });
    return;
  }
  const configuredAsset = creditMode === "redeem"
    ? findCreditAsset(config, "robinhood", asset)
    : findCreditAsset(config, creditChain, asset);
  if (!configuredAsset) {
    res.status(503).json({ error: "This asset is not in the verified mainnet token registry.", reason: "asset_not_registered_for_mainnet" });
    return;
  }
  const parsedAmount = parseDecimalAmount(amount, creditMode === "redeem" ? 18 : configuredAsset.decimals);
  if (!parsedAmount) {
    res.status(400).json({ error: "amount must be a positive decimal string with supported token precision." });
    return;
  }
  try {
    const quoteId = randomUUID();
    if (creditMode === "redeem") {
      const creditToken = config.addresses.creditTokenAddress;
      if (!creditToken) throw new Error("credit_token_not_configured");
      const walletBalance = await getFinalizedErc20Balance(config, creditToken, pair.source.walletAddress);
      if (parsedAmount.units > walletBalance) {
        res.status(409).json({
          error: "Redemption can spend only real CREDIT held in your connected wallet. Withdraw any unused vault credits to the wallet first.",
          walletBalanceCredits: formatUnits(walletBalance, 18),
        });
        return;
      }
    }
    const prepared = await requestExecutableQuote({
      config,
      mode: creditMode,
      chain: creditChain,
      asset: asset.trim().toUpperCase(),
      amount: parsedAmount.normalized,
      sender: pair.source.walletAddress,
      recipient: pair.recipient.walletAddress,
      reference: quoteId,
      ...(purchaseQuoteSigner ? { purchaseQuoteSigner } : {}),
    });
    const inputUnits = parseDecimalAmount(prepared.inputAmount, prepared.inputAsset.decimals)?.units;
    if (!inputUnits) throw new Error("router_input_amount_invalid");
    const fundsOk = await sourceHasFunds(config, creditChain, prepared.inputAsset.address, inputUnits, pair.source.walletAddress);
    const now = new Date();
    let routeData: Record<string, unknown> = {
      ...prepared.route,
      id: prepared.id,
      expiresAt: prepared.expiresAt.toISOString(),
    };
    if (creditMode === "redeem") {
      const creditToken = config.addresses.creditTokenAddress;
      const units = creditToken ? await getFinalizedErc20Balance(config, creditToken, pair.source.walletAddress) : 0n;
      if (units < parsedAmount.units) {
        res.status(409).json({ error: "Wallet-held CREDIT changed while quoting; refresh the account and withdraw any vault balance separately." });
        return;
      }
    }
    const [quote] = await db.insert(creditEconomyQuotes).values({
      id: quoteId,
      ownerUserId: req.privySession.userId,
      walletOwnershipId: pair.recipient.id,
      sourceWalletOwnershipId: pair.source.id,
      walletAddress: pair.recipient.walletAddress,
      sourceWalletAddress: pair.source.walletAddress,
      mode: creditMode,
      chain: creditChain,
      asset: asset.trim().toUpperCase(),
      amount: parsedAmount.normalized,
      inputToken: prepared.inputToken,
      outputToken: prepared.outputToken,
      inputAmount: prepared.inputAmount,
      outputAmount: prepared.outputAmount,
      netUsdMicros: prepared.netUsdMicros,
      expectedTo: prepared.expectedTo,
      expectedValue: prepared.expectedValue,
      expectedCalldata: prepared.expectedCalldata,
      expectedToken: prepared.expectedToken,
      expectedRecipient: prepared.expectedRecipient,
      expectedTokenAmount: prepared.expectedTokenAmount,
      expectedTransfers: prepared.expectedTransfers,
      transaction: prepared.transaction,
      approvals: prepared.approvals,
      route: routeData,
      status: "quoted",
      expiresAt: prepared.expiresAt,
      createdAt: now,
      updatedAt: now,
    }).returning();
    await db.insert(creditEconomyActivity).values({
      id: randomUUID(), ownerUserId: quote.ownerUserId, quoteId,
      kind: "quote", chain: creditChain, asset: quote.asset,
      amount: quote.amount, status: "quoted", detail: null,
    });
    if (creditMode === "redeem" && !await reserveRedemptionLiquidity(quote, config)) {
      res.status(503).json({
        error: "Liquidity is not available right now. Please try a lower amount or check back later.",
        reason: "redemption_liquidity_unavailable",
      });
      return;
    }
    const cashback = creditMode !== "redeem"
      ? await reserveQuoteCashback({ quote, recipientAddress: pair.recipient.walletAddress, netUsdMicros: BigInt(prepared.netUsdMicros), config })
      : undefined;
    res.status(201).json({ ...prepareQuoteResponse(quote, cashback), fundsOk });
  } catch (error) {
    const reason = reasonOf(error);
    req.log.warn({ reason }, "Mainnet credit quote unavailable");
    const status = reason === "amount_too_small" || reason === "amount_above_limit" ? 400
      : reason === "low_liquidity" ? 409 : reason === "invalid_amount" || reason === "asset_requires_direct_buy_or_swap" ||
      reason === "asset_not_registered_for_mainnet" ? 400 : 503;
    res.status(status).json({
      error: "No executable, sufficiently funded mainnet quote is available.",
      reason,
    });
  }
});

router.post("/credit/confirm", requirePrivySession, async (req, res): Promise<void> => {
  if (!req.privySession) { res.status(401).json({ error: "A verified Privy session is required." }); return; }
  const body = req.body as Record<string, unknown> | undefined;
  const quoteId = body?.quoteId;
  const chain = body?.chain;
  const txHash = body?.txHash;
  if (typeof quoteId !== "string" || !quoteId || (chain !== "robinhood" && chain !== "solana") ||
      !isTxHash(txHash, chain)) {
    res.status(400).json({ error: "quoteId, chain and a mainnet transaction hash/signature are required." });
    return;
  }
  const normalizedTxHash = chain === "robinhood" ? txHash.toLowerCase() : txHash;
  try {
    const quote = await db.query.creditEconomyQuotes.findFirst({
      where: and(eq(creditEconomyQuotes.id, quoteId), eq(creditEconomyQuotes.ownerUserId, req.privySession.userId)),
    });
    if (!quote) { res.status(404).json({ error: "Credit quote was not found for this account." }); return; }
    if (quote.chain !== chain) { res.status(400).json({ error: "Confirmation chain does not match the server-issued quote." }); return; }
    if (!await loadActiveQuoteOwnership(quote)) {
      res.status(409).json({ error: "The verified wallet used by this quote has been revoked or changed." });
      return;
    }
    if (quote.txHash && !sameTxHash(chain, quote.txHash, normalizedTxHash)) {
      res.status(409).json({ error: "This quote is already bound to a different transaction; quote replay is rejected." });
      return;
    }
    if (quote.status === "expired") { res.status(409).json({ error: "This quote has expired." }); return; }
    if (!quote.txHash && quote.expiresAt.getTime() <= Date.now()) {
      await setQuoteStatus(quote.id, "expired", null);
      res.status(409).json({ error: "This quote expired before a transaction was confirmed." });
      return;
    }
    const claimed = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(creditEconomyQuotes)
        .where(eq(creditEconomyQuotes.id, quote.id)).for("update");
      if (!locked) return { reason: "quote_missing" as const };
      if (locked.txHash && !sameTxHash(chain, locked.txHash, normalizedTxHash)) {
        return { reason: "different_transaction" as const };
      }
      if (!locked.txHash && locked.expiresAt.getTime() <= Date.now()) {
        await tx.update(creditEconomyQuotes).set({ status: "expired", updatedAt: new Date() })
          .where(eq(creditEconomyQuotes.id, locked.id));
        return { reason: "quote_expired" as const };
      }
      const [duplicate] = await tx.select({ id: creditEconomyQuotes.id }).from(creditEconomyQuotes)
        .where(and(eq(creditEconomyQuotes.chain, locked.chain), eq(creditEconomyQuotes.txHash, normalizedTxHash)));
      if (duplicate && duplicate.id !== locked.id) return { reason: "transaction_already_used" as const };
      await tx.update(creditEconomyQuotes).set({
        status: locked.status === "completed" ? "completed" : "confirming",
        txHash: normalizedTxHash,
        updatedAt: new Date(),
      }).where(eq(creditEconomyQuotes.id, locked.id));
      return { quote: { ...locked, status: locked.status === "completed" ? "completed" : "confirming", txHash: normalizedTxHash } };
    });
    if ("reason" in claimed) {
      if (claimed.reason === "quote_expired") {
        res.status(409).json({ error: "This quote expired before a transaction was confirmed." });
      } else {
        res.status(409).json({ error: "This transaction is already associated with another quote or this quote changed." });
      }
      return;
    }
    if (!claimed.quote) {
      res.status(409).json({ error: "This finalized transaction is already associated with another quote." });
      return;
    }
    const config = creditConfiguration();
    const result = await confirmWithTx(claimed.quote, normalizedTxHash, config);
    res.status(result.pending ? 202 : 200).json(result.response);
  } catch (error) {
    const reason = reasonOf(error);
    req.log.warn({ reason }, "Credit transaction confirmation requires reconciliation");
    if (reason === "transaction_not_successfully_finalized" || reason === "transaction_failed" ||
        reason === "transaction_sender_recipient_or_value_mismatch" ||
        reason === "transaction_calldata_mismatch" ||
        reason === "expected_exact_token_transfer_not_found" ||
        reason === "expected_exact_native_transfer_not_found" ||
        reason === "transaction_sender_mismatch" ||
        reason === "quote_expired_before_finalized_payment") {
      const quoteId = typeof body?.quoteId === "string" ? body.quoteId : "";
      const quote = await db.query.creditEconomyQuotes.findFirst({
        where: and(eq(creditEconomyQuotes.id, quoteId), eq(creditEconomyQuotes.ownerUserId, req.privySession!.userId)),
      });
      if (quote && quote.status !== "payment_confirmed" && quote.status !== "completed") {
        await setQuoteStatus(quote.id, quote.expiresAt.getTime() <= Date.now() ? "expired" : "quoted", null);
      }
      res.status(400).json({ error: "Transaction does not match the exact quote or has failed on mainnet.", reason });
      return;
    }
    res.status(503).json({
      error: "Finalized transaction settlement is pending reconciliation.",
      reason,
      quoteId: typeof body?.quoteId === "string" ? body.quoteId : null,
      status: "reconciling",
    });
  }
});

router.post("/credit/reconcile", requirePrivySession, async (req, res): Promise<void> => {
  if (!req.privySession) { res.status(401).json({ error: "A verified Privy session is required." }); return; }
  const quoteId = (req.body as { quoteId?: unknown } | undefined)?.quoteId;
  if (typeof quoteId !== "string" || !quoteId) {
    res.status(400).json({ error: "quoteId is required." });
    return;
  }
  try {
    const quote = await db.query.creditEconomyQuotes.findFirst({
      where: and(eq(creditEconomyQuotes.id, quoteId), eq(creditEconomyQuotes.ownerUserId, req.privySession.userId)),
    });
    if (!quote) { res.status(404).json({ error: "Credit quote was not found for this account." }); return; }
    if (!quote.txHash || !["confirming", "reconciling", "payment_confirmed", "completed"].includes(quote.status)) {
      res.status(409).json({ error: "This quote has no confirmed transaction eligible for reconciliation." });
      return;
    }
    const result = await confirmWithTx(quote, quote.txHash, creditConfiguration());
    res.status(result.pending ? 202 : 200).json(result.response);
  } catch (error) {
    const reason = reasonOf(error);
    req.log.warn({ reason }, "Credit settlement reconciliation pending");
    res.status(503).json({
      error: "Credit settlement reconciliation is temporarily unavailable.",
      reason,
      quoteId,
      status: "reconciling",
    });
  }
});

/** Finish quotes whose payment was on-chain but not yet L1-finalized (finality can take a while). */
let reconcileRunning = false;
export async function reconcilePendingQuotes(): Promise<void> {
  if (reconcileRunning) return;
  reconcileRunning = true;
  try {
    const rows = await db.query.creditEconomyQuotes.findMany({
      where: and(eq(creditEconomyQuotes.status, "reconciling"), gt(creditEconomyQuotes.createdAt, new Date(Date.now() - 3 * 86_400_000))),
      orderBy: [desc(creditEconomyQuotes.createdAt)],
      limit: 20,
    });
    for (const row of rows) {
      if (!row.txHash) continue;
      try { await confirmWithTx(row, row.txHash, creditConfiguration()); }
      catch (error) { logger.warn({ reason: reasonOf(error), quoteId: row.id }, "Background reconcile pending"); }
    }
    // Cashbacks whose payout was sent (or failed) after the swap completed are retried until they are recorded as paid.
    const pendingCashbacks = await db.query.creditEconomyCashbacks.findMany({
      where: eq(creditEconomyCashbacks.status, "pending"), limit: 20,
    });
    for (const cb of pendingCashbacks) {
      try {
        const q = await db.query.creditEconomyQuotes.findFirst({ where: and(eq(creditEconomyQuotes.id, cb.quoteId), eq(creditEconomyQuotes.status, "completed")) });
        if (q) await attemptCashbackPayout(q, creditConfiguration(), cb);
      } catch (error) { logger.warn({ reason: reasonOf(error), quoteId: cb.quoteId }, "Cashback retry pending"); }
    }
    // $CRED received for completed swaps is burned; retry any burn that has not been verified yet.
    const own = projectToken();
    if (own) {
      const unburned = await db.query.creditEconomyQuotes.findMany({
        where: and(
          eq(creditEconomyQuotes.status, "completed"), eq(creditEconomyQuotes.mode, "swap"), eq(creditEconomyQuotes.chain, "robinhood"),
          sql`lower(${creditEconomyQuotes.inputToken}) = ${own.address.toLowerCase()}`,
          sql`not exists (select 1 from credit_economy_activity a where a.quote_id = ${creditEconomyQuotes.id} and a.kind = 'burn' and a.status = 'completed')`,
        ),
        limit: 20,
      });
      for (const q of unburned) await burnCredDeposit(q, creditConfiguration());
    }
  } finally { reconcileRunning = false; }
}

export default router;