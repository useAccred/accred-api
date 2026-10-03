import { randomInt, randomUUID } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { formatUnits } from "ethers";
import { db, solanaDepositSessions } from "@workspace/db";
import { requirePrivySession } from "../lib/privy-auth";
import { creditConfiguration } from "../lib/credit-config";
import { SOLANA_MAINNET_ASSETS } from "../lib/credit-assets";
import { parseDecimalAmount } from "../lib/credit-policy";
import { settleCreditPurchase } from "../lib/credit-settlement";
import { verifyFinalizedErc20Transfer } from "../lib/credit-chain";
import { solanaRpc, solUsdMicros } from "../lib/internal-router";
import { findVerifiedWallet } from "./credit";

// Manual Solana payments: the user sends from any Solana wallet; each session has a unique
// exact amount so the transfer can be attributed. Credit goes to the verified Robinhood wallet.
const router: IRouter = Router();
const SESSION_MS = 5 * 60_000;
const LATE_GRACE_MS = 90_000; // time allowed for a payment sent before expiry to finalize
const MIN_USD_MICROS = 1_000_000n;
const MAX_USD_MICROS = 10_000_000_000n;
const USD_MICROS_TO_CREDIT_UNITS = 100n * 10n ** 12n;
const lastScan = new Map<string, number>();
const inFlight = new Set<string>();

type Session = typeof solanaDepositSessions.$inferSelect;

type SolanaTx = {
  slot: number; blockTime: number | null;
  meta: { err: unknown; preBalances: number[]; postBalances: number[];
    preTokenBalances: Array<{ owner?: string; mint: string; uiTokenAmount: { amount: string } }>;
    postTokenBalances: Array<{ owner?: string; mint: string; uiTokenAmount: { amount: string } }> } | null;
  transaction: { signatures: string[]; message: { accountKeys: Array<{ pubkey: string; signer: boolean }> } };
} | null;

function view(s: Session, treasury: string | null, creditToken: string | null) {
  const now = Date.now();
  return {
    id: s.id,
    status: s.status === "detected" ? "processing" : s.status,
    asset: s.asset,
    mint: s.mint === "native" ? null : s.mint,
    amount: formatUnits(BigInt(s.expectedUnits), s.decimals),
    treasuryAddress: treasury,
    recipientAddress: s.recipientAddress,
    credits: formatUnits(BigInt(s.netUsdMicros) * USD_MICROS_TO_CREDIT_UNITS, 18),
    priceUsd: s.priceUsdMicros ? formatUnits(BigInt(s.priceUsdMicros), 6) : null,
    expiresAt: s.expiresAt.toISOString(),
    timerElapsed: s.expiresAt.getTime() <= now,
    paymentSignature: s.paymentSignature,
    settlementTxHash: s.settlementTxHash,
    creditTokenAddress: creditToken,
    reason: s.error,
  };
}

async function setStatus(id: string, patch: Partial<Session>) {
  await db.update(solanaDepositSessions).set({ ...patch, updatedAt: new Date() }).where(eq(solanaDepositSessions.id, id));
}

async function findDeposit(s: Session, treasury: string): Promise<{ signature: string; slot: string } | null> {
  let targets: string[] = [treasury];
  if (s.mint !== "native") {
    const accounts = await solanaRpc<{ value: Array<{ pubkey: string }> }>(
      "getTokenAccountsByOwner", [treasury, { mint: s.mint }, { encoding: "jsonParsed", commitment: "finalized" }]);
    targets = accounts.value.map((a) => a.pubkey);
  }
  const from = s.createdAt.getTime() - 10_000;
  const expected = BigInt(s.expectedUnits);
  for (const target of targets) {
    const sigs = await solanaRpc<Array<{ signature: string; err: unknown; blockTime: number | null }>>(
      "getSignaturesForAddress", [target, { limit: 40, commitment: "finalized" }]);
    for (const sig of sigs) {
      if (sig.blockTime === null) continue;
      const ms = sig.blockTime * 1000;
      if (ms < from) break; // newest first
      if (sig.err !== null || ms > s.expiresAt.getTime()) continue;
      const tx = await solanaRpc<SolanaTx>("getTransaction", [sig.signature, { commitment: "finalized", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
      if (!tx?.meta || tx.meta.err !== null || tx.transaction.signatures[0] !== sig.signature) continue;
      let delta = 0n;
      if (s.mint === "native") {
        const i = tx.transaction.message.accountKeys.findIndex((k) => k.pubkey === treasury);
        if (i >= 0) delta = BigInt(tx.meta.postBalances[i]!) - BigInt(tx.meta.preBalances[i]!);
      } else {
        for (const post of tx.meta.postTokenBalances.filter((b) => b.owner === treasury && b.mint === s.mint)) {
          const pre = tx.meta.preTokenBalances.find((b) => b.owner === treasury && b.mint === s.mint);
          delta += BigInt(post.uiTokenAmount.amount) - BigInt(pre?.uiTokenAmount.amount ?? "0");
        }
      }
      if (delta === expected) return { signature: sig.signature, slot: String(tx.slot) };
    }
  }
  return null;
}

async function settle(s: Session): Promise<Session> {
  const config = creditConfiguration();
  const creditToken = config.addresses.creditTokenAddress;
  const signer = config.settlementSignerAddress;
  if (!creditToken || !signer || !s.paymentSignature || !s.paymentSlot) return s;
  const credits = (BigInt(s.netUsdMicros) * USD_MICROS_TO_CREDIT_UNITS).toString();
  try {
    let mintTx = s.settlementTxHash;
    if (!mintTx) {
      const sub = await settleCreditPurchase(config, {
        quoteId: s.id, ownerUserId: s.ownerUserId, recipientAddress: s.recipientAddress,
        creditTokenAddress: creditToken, creditsBaseUnits: credits, paymentChain: "solana",
        paymentTxHash: s.paymentSignature, paymentBlock: s.paymentSlot, netUsdMicros: s.netUsdMicros, quoteRouteId: s.id,
      });
      mintTx = sub.txHash;
      if (mintTx) await setStatus(s.id, { settlementTxHash: mintTx, error: null });
    }
    if (!mintTx) return { ...s, error: null };
    const v = await verifyFinalizedErc20Transfer({
      config, txHash: mintTx, tokenAddress: creditToken, from: "0x0000000000000000000000000000000000000000",
      to: s.recipientAddress, amount: credits, transactionSender: signer,
    });
    if (v.finalized) {
      await setStatus(s.id, { status: "completed", settlementTxHash: mintTx, error: null });
      return { ...s, status: "completed", settlementTxHash: mintTx, error: null };
    }
    return { ...s, settlementTxHash: mintTx };
  } catch (e) {
    const reason = e instanceof Error ? e.message : "settlement_failed";
    await setStatus(s.id, { error: reason });
    return { ...s, error: reason };
  }
}

async function advance(s: Session, treasury: string): Promise<Session> {
  if (s.status !== "awaiting" && s.status !== "detected") return s;
  if (inFlight.has(s.id)) return s;
  if (Date.now() - (lastScan.get(s.id) ?? 0) < 3_000) return s;
  inFlight.add(s.id); lastScan.set(s.id, Date.now());
  try {
    if (s.status === "awaiting") {
      if (Date.now() > s.expiresAt.getTime() + LATE_GRACE_MS) {
        await setStatus(s.id, { status: "expired" });
        return { ...s, status: "expired" };
      }
      const found = await findDeposit(s, treasury).catch(() => null);
      if (!found) return s;
      try {
        const claimed = await db.update(solanaDepositSessions)
          .set({ status: "detected", paymentSignature: found.signature, paymentSlot: found.slot, updatedAt: new Date() })
          .where(and(eq(solanaDepositSessions.id, s.id), eq(solanaDepositSessions.status, "awaiting"))).returning();
        if (!claimed[0]) return s;
        s = claimed[0];
      } catch { return s; } // signature already attributed to another session
    }
    return await settle(s);
  } finally { inFlight.delete(s.id); }
}

router.post("/credit/solana-deposit", requirePrivySession, async (req, res): Promise<void> => {
  if (!req.privySession) { res.status(401).json({ error: "A verified Privy session is required." }); return; }
  const config = creditConfiguration();
  const treasury = config.addresses.solanaTreasuryAddress;
  if (!treasury || !config.settlementEnabled || !config.addresses.creditTokenAddress || !process.env.CREDIT_SOLANA_SETTLEMENT_ADDRESS) {
    res.status(503).json({ error: "Solana payments are not available right now." });
    return;
  }
  const body = (req.body ?? {}) as { asset?: unknown; amount?: unknown };
  const asset = typeof body.asset === "string" ? SOLANA_MAINNET_ASSETS[body.asset.toUpperCase()] : undefined;
  if (!asset) { res.status(400).json({ error: "Choose SOL, USDC or USDT." }); return; }
  const requested = typeof body.amount === "string" ? parseDecimalAmount(body.amount, asset.decimals) : undefined;
  if (!requested || requested.units <= 0n) { res.status(400).json({ error: "Enter a valid amount." }); return; }
  try {
    const wallet = await findVerifiedWallet(req.privySession.userId, "robinhood");
    if (!wallet) { res.status(409).json({ error: "Connect your Robinhood Chain wallet first. Credit is delivered there." }); return; }
    const now = new Date();
    const active = await db.select().from(solanaDepositSessions).where(and(
      eq(solanaDepositSessions.status, "awaiting"), gt(solanaDepositSessions.expiresAt, now)));
    if (active.filter((a) => a.ownerUserId === req.privySession!.userId).length >= 3) {
      res.status(429).json({ error: "You have too many open payment sessions. Wait for them to finish or expire." });
      return;
    }
    const price = asset.address === "native" ? await solUsdMicros() : null;
    const toUsd = (units: bigint) => price ? (units * price) / 10n ** 9n : units;
    if (toUsd(requested.units) < MIN_USD_MICROS || toUsd(requested.units) > MAX_USD_MICROS) {
      res.status(400).json({ error: "Amount must be worth between $1 and $10,000." });
      return;
    }
    const taken = new Set(active.filter((a) => a.mint === asset.address).map((a) => a.expectedUnits));
    const jitterMax = asset.address === "native" ? 99_999 : 9_999;
    let expected = 0n;
    for (let i = 0; i < 30 && expected === 0n; i++) {
      const candidate = requested.units + BigInt(randomInt(1, jitterMax + 1));
      if (!taken.has(candidate.toString())) expected = candidate;
    }
    if (expected === 0n) { res.status(503).json({ error: "Could not reserve a unique amount. Try again." }); return; }
    const [row] = await db.insert(solanaDepositSessions).values({
      id: randomUUID(), ownerUserId: req.privySession.userId, recipientAddress: wallet.walletAddress,
      asset: asset.symbol, mint: asset.address, decimals: asset.decimals, expectedUnits: expected.toString(),
      netUsdMicros: toUsd(expected).toString(), priceUsdMicros: price ? price.toString() : null,
      expiresAt: new Date(Date.now() + SESSION_MS),
    }).returning();
    res.status(201).json(view(row!, treasury, config.addresses.creditTokenAddress));
  } catch (error) {
    req.log.warn({ err: error instanceof Error ? error.message : "unknown" }, "Solana deposit session failed");
    res.status(503).json({ error: "Could not start a Solana payment session. Try again shortly." });
  }
});

router.get("/credit/solana-price", async (_req, res): Promise<void> => {
  try {
    res.json({ solUsd: Number(formatUnits(await solUsdMicros(), 6)) });
  } catch {
    res.status(503).json({ error: "SOL price is unavailable right now." });
  }
});

router.post("/credit/solana-deposit/:id/cancel", requirePrivySession, async (req, res): Promise<void> => {
  if (!req.privySession) { res.status(401).json({ error: "A verified Privy session is required." }); return; }
  try {
    const cancelled = await db.update(solanaDepositSessions).set({ status: "cancelled", updatedAt: new Date() })
      .where(and(eq(solanaDepositSessions.id, String(req.params.id)), eq(solanaDepositSessions.ownerUserId, req.privySession.userId),
        eq(solanaDepositSessions.status, "awaiting"))).returning({ id: solanaDepositSessions.id });
    if (!cancelled[0]) { res.status(409).json({ error: "This payment can no longer be cancelled; it is already being processed or finished." }); return; }
    res.json({ id: cancelled[0].id, status: "cancelled" });
  } catch {
    res.status(503).json({ error: "Could not cancel right now. Try again." });
  }
});

router.get("/credit/solana-deposit/:id", requirePrivySession, async (req, res): Promise<void> => {
  if (!req.privySession) { res.status(401).json({ error: "A verified Privy session is required." }); return; }
  const config = creditConfiguration();
  const treasury = config.addresses.solanaTreasuryAddress;
  try {
    const found = await db.query.solanaDepositSessions.findFirst({
      where: and(eq(solanaDepositSessions.id, String(req.params.id)), eq(solanaDepositSessions.ownerUserId, req.privySession.userId)),
    });
    if (!found || !treasury) { res.status(404).json({ error: "Payment session not found." }); return; }
    const next = await advance(found, treasury);
    res.json(view(next, treasury, config.addresses.creditTokenAddress));
  } catch (error) {
    req.log.warn({ err: error instanceof Error ? error.message : "unknown" }, "Solana deposit status failed");
    res.status(503).json({ error: "Could not check the payment right now." });
  }
});

export default router;
