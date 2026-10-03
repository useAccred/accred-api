import { Contract, Wallet, getAddress, isAddress, keccak256, parseUnits, toUtf8Bytes, zeroPadValue } from "ethers";
import { findCreditAsset } from "./credit-assets";
import { and, eq } from "drizzle-orm";
import { creditEconomyQuotes, db, settlementOperationsTable } from "@workspace/db";
import { creditConfiguration } from "./credit-config";
import { PROJECT_TOKEN_BURN_ADDRESS, isProjectToken } from "./dex-tokens";
import { RouterError, decodeBase58, rpcProvider, signerWallet, solUsdMicros, solanaRpc } from "./internal-router";

const MAX_CASHBACK_USDG_UNITS = 10_000_000n; // 10 USDG per payout, matching the cashback vault cap
const SOLANA_MINTS: Record<string, string> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
};

const settlementAbi = [
  "function settle((uint256 chainId,address creditToken,address recipient,bytes32 quoteId,bytes32 paymentId,bytes32 sourcePayer,bytes32 assetId,uint256 paidAmount,uint256 creditAmount,uint256 deadline) q,bytes signature)",
];
const erc20Abi = ["function transfer(address to,uint256 amount) returns (bool)", "function balanceOf(address) view returns (uint256)"];

type Call = Record<string, unknown>;

/** Runs an operation once per idempotency key; replays return the recorded transaction hash. */
export async function runOnce(key: string, operation: string, run: () => Promise<string>): Promise<{ txHash: string | null; state: string }> {
  const inserted = await db.insert(settlementOperationsTable)
    .values({ idempotencyKey: key, operation, status: "pending" })
    .onConflictDoNothing().returning();
  if (!inserted.length) {
    const [existing] = await db.select().from(settlementOperationsTable).where(eq(settlementOperationsTable.idempotencyKey, key));
    if (existing?.txHash) return { txHash: existing.txHash, state: "submitted" };
    if (existing?.status === "failed" && existing.error?.startsWith("presend:")) {
      // Nothing was broadcast, so retrying cannot pay twice.
      const reopened = await db.update(settlementOperationsTable)
        .set({ status: "pending", error: null, updatedAt: new Date() })
        .where(and(eq(settlementOperationsTable.idempotencyKey, key), eq(settlementOperationsTable.status, "failed"))).returning();
      if (reopened.length) return execute(key, run);
    }
    return { txHash: null, state: existing?.status === "failed" ? "failed" : "pending" };
  }
  return execute(key, run);
}

async function execute(key: string, run: () => Promise<string>): Promise<{ txHash: string | null; state: string }> {
  try {
    const txHash = await run();
    await db.update(settlementOperationsTable).set({ status: "submitted", txHash, updatedAt: new Date() }).where(eq(settlementOperationsTable.idempotencyKey, key));
    return { txHash, state: "submitted" };
  } catch (error) {
    const raw = error instanceof Error ? error.message : "unknown_error";
    // Gas shortfalls are rejected before broadcast, so the operation can be retried safely once the signer is funded.
    // Validation rejections (RouterError) are also thrown before anything is broadcast.
    const message = (error as { code?: string })?.code === "INSUFFICIENT_FUNDS" || error instanceof RouterError ? `presend: ${raw}` : raw;
    await db.update(settlementOperationsTable).set({ status: "failed", error: message.slice(0, 500), updatedAt: new Date() }).where(eq(settlementOperationsTable.idempotencyKey, key));
    throw error;
  }
}

export async function handleSettlement(body: Call): Promise<{ txHash: string | null; state: string }> {
  const config = creditConfiguration();
  const key = String(body.idempotencyKey ?? "");
  if (!key || body.chainId !== 4663) throw new RouterError("invalid_settlement_request");
  if (body.operation === "payout_reserved_cashback") return runOnce(key, "payout_reserved_cashback", () => payoutCashback(body, config.addresses));
  if (body.operation === "payout_redemption") return runOnce(key, "payout_redemption", () => payoutRedemptionOp(body, config.addresses));
  if (body.operation === "settle_credit_purchase") return runOnce(key, "settle_credit_purchase", () => settleSolanaPurchase(body, config.addresses));
  throw new RouterError("unsupported_settlement_operation");
}

async function payoutCashback(body: Call, addresses: ReturnType<typeof creditConfiguration>["addresses"]): Promise<string> {
  // Cashback is paid from its own dedicated wallet, separate from the quote-signing key.
  const payoutKey = process.env.CASHBACK_PAYOUT_PRIVATE_KEY;
  if (!payoutKey) throw new RouterError("cashback_payout_wallet_not_configured", 503);
  const signer = new Wallet(payoutKey).connect(rpcProvider());
  const recipient = String(body.recipientAddress);
  const amount = BigInt(String(body.amountBaseUnits));
  if (!addresses.usdgAddress || !addresses.cashbackAddress || !isAddress(recipient) ||
      getAddress(String(body.senderAddress)) !== getAddress(addresses.cashbackAddress) ||
      getAddress(addresses.cashbackAddress) !== signer.address ||
      getAddress(String(body.tokenAddress)) !== getAddress(addresses.usdgAddress)) throw new RouterError("cashback_payout_not_bound_to_configured_wallet_and_token");
  if (amount <= 0n || amount > MAX_CASHBACK_USDG_UNITS) throw new RouterError("cashback_amount_out_of_bounds");
  const usdg = new Contract(addresses.usdgAddress, erc20Abi, signer);
  if ((await usdg.balanceOf!(signer.address) as bigint) < amount) throw new RouterError("cashback_wallet_unfunded", 503);
  const tx = await usdg.transfer!(recipient, amount);
  return tx.hash as string;
}

type SolanaTx = {
  blockTime: number | null;
  meta: { err: unknown; preBalances: number[]; postBalances: number[];
    preTokenBalances: Array<{ owner?: string; mint: string; uiTokenAmount: { amount: string } }>;
    postTokenBalances: Array<{ owner?: string; mint: string; uiTokenAmount: { amount: string } }> } | null;
  transaction: { signatures: string[]; message: { accountKeys: Array<{ pubkey: string; signer: boolean }> } };
} | null;

async function settleSolanaPurchase(body: Call, addresses: ReturnType<typeof creditConfiguration>["addresses"]): Promise<string> {
  const payment = body.payment as { chain?: string; txHash?: string } | undefined;
  const treasury = addresses.solanaTreasuryAddress;
  if (payment?.chain === "robinhood" && payment.txHash) return settleRobinhoodSwap(body, payment.txHash, addresses);
  if (payment?.chain !== "solana" || !payment.txHash || !treasury || !addresses.creditTokenAddress) throw new RouterError("only_solana_direct_purchases_are_settled_here");
  const recipient = String(body.recipientAddress);
  if (!isAddress(recipient) || getAddress(String(body.creditTokenAddress)) !== getAddress(addresses.creditTokenAddress)) throw new RouterError("invalid_recipient_or_credit_token");
  const netUsdMicros = BigInt(String(body.netUsdMicros));
  const credits = BigInt(String(body.creditsBaseUnits));
  if (netUsdMicros <= 0n || credits !== netUsdMicros * 100n * 10n ** 12n) throw new RouterError("credit_amount_does_not_match_usd_value");

  // Independent check of the finalized payment: the treasury must have actually received the value.
  const tx = await solanaRpc<SolanaTx>("getTransaction", [payment.txHash, { commitment: "finalized", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
  if (!tx?.meta || tx.meta.err !== null || tx.transaction.signatures[0] !== payment.txHash) throw new RouterError("solana_payment_not_finalized_or_failed");
  const keys = tx.transaction.message.accountKeys;
  const payer = keys.find((k) => k.signer)?.pubkey;
  if (!payer) throw new RouterError("solana_payer_missing");
  let paidAmount = 0n, assetKey = "", usdMicros = 0n;
  const treasuryIndex = keys.findIndex((k) => k.pubkey === treasury);
  const lamports = treasuryIndex >= 0 ? BigInt(tx.meta.postBalances[treasuryIndex]!) - BigInt(tx.meta.preBalances[treasuryIndex]!) : 0n;
  if (lamports > 0n) {
    paidAmount = lamports; assetKey = "native";
    usdMicros = (lamports * (await solUsdMicros())) / 10n ** 9n;
    usdMicros = (usdMicros * 100n) / 97n; // accept up to 3% SOL price drop between quote and settlement
  } else {
    for (const post of tx.meta.postTokenBalances.filter((b) => b.owner === treasury && SOLANA_MINTS[b.mint])) {
      const pre = tx.meta.preTokenBalances.find((b) => b.owner === treasury && b.mint === post.mint);
      const delta = BigInt(post.uiTokenAmount.amount) - BigInt(pre?.uiTokenAmount.amount ?? "0");
      if (delta > 0n) { paidAmount = delta; assetKey = post.mint; usdMicros = delta; break; }
    }
  }
  if (paidAmount <= 0n || netUsdMicros > usdMicros) throw new RouterError("solana_payment_does_not_cover_credit_value");

  const signer = signerWallet().connect(rpcProvider());
  const settlementAddress = process.env.CREDIT_SOLANA_SETTLEMENT_ADDRESS;
  if (!settlementAddress || !isAddress(settlementAddress)) throw new RouterError("solana_settlement_contract_not_configured", 503);
  const paid = {
    chainId: 4663n, creditToken: addresses.creditTokenAddress, recipient,
    quoteId: keccak256(toUtf8Bytes(String(body.quoteId))), paymentId: keccak256(decodeBase58(payment.txHash)),
    sourcePayer: zeroPadValue(decodeBase58(payer), 32),
    assetId: assetKey === "native" ? keccak256(toUtf8Bytes("solana:native")) : zeroPadValue(decodeBase58(assetKey), 32),
    paidAmount, creditAmount: credits, deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
  };
  const signature = await signer.signTypedData(
    { name: "Accred Solana Paid Settlement", version: "1", chainId: 4663, verifyingContract: settlementAddress },
    { PaidQuote: [
      { name: "chainId", type: "uint256" }, { name: "creditToken", type: "address" }, { name: "recipient", type: "address" },
      { name: "quoteId", type: "bytes32" }, { name: "paymentId", type: "bytes32" }, { name: "sourcePayer", type: "bytes32" },
      { name: "assetId", type: "bytes32" }, { name: "paidAmount", type: "uint256" }, { name: "creditAmount", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ] },
    paid,
  );
  const contract = new Contract(settlementAddress, settlementAbi, signer);
  const sent = await contract.settle!(paid, signature);
  return sent.hash as string;
}

async function settleRobinhoodSwap(body: Call, txHash: string, addresses: ReturnType<typeof creditConfiguration>["addresses"]): Promise<string> {
  const { treasuryAddress, creditTokenAddress } = addresses;
  const settlementAddress = process.env.CREDIT_SOLANA_SETTLEMENT_ADDRESS;
  if (!treasuryAddress || !creditTokenAddress || !settlementAddress || !isAddress(settlementAddress)) {
    throw new RouterError("swap_settlement_not_configured", 503);
  }
  const recipient = String(body.recipientAddress);
  if (!isAddress(recipient) || getAddress(String(body.creditTokenAddress)) !== getAddress(creditTokenAddress)) throw new RouterError("invalid_recipient_or_credit_token");
  const netUsdMicros = BigInt(String(body.netUsdMicros));
  const credits = BigInt(String(body.creditsBaseUnits));
  if (netUsdMicros <= 0n || credits !== netUsdMicros * 100n * 10n ** 12n) throw new RouterError("credit_amount_does_not_match_usd_value");

  // The credited value is the locked quote; the payment must be a finalized direct deposit of exactly that quote's input.
  const [quote] = await db.select().from(creditEconomyQuotes).where(eq(creditEconomyQuotes.id, String(body.quoteId)));
  if (!quote || quote.mode !== "swap" || quote.netUsdMicros !== String(netUsdMicros) ||
      getAddress(quote.walletAddress) !== getAddress(recipient)) throw new RouterError("swap_quote_mismatch");
  const asset = findCreditAsset(creditConfiguration(), "robinhood", quote.asset);
  if (!asset) throw new RouterError("swap_asset_not_registered");
  const inputUnits = parseUnits(quote.inputAmount, asset.decimals);

  const provider = rpcProvider();
  const [receipt, tx, finalized] = await Promise.all([
    provider.getTransactionReceipt(txHash), provider.getTransaction(txHash),
    provider.getBlockNumber().then((n) => ({ number: String(Math.max(0, n - Number(process.env.CREDIT_CONFIRMATION_BLOCKS ?? "3"))) })),
  ]);
  if (!receipt || !tx || receipt.status !== 1 || BigInt(receipt.blockNumber) > BigInt(finalized.number)) throw new RouterError("swap_not_finalized_or_failed");
  if (getAddress(tx.from) !== getAddress(quote.sourceWalletAddress)) throw new RouterError("swap_sender_mismatch");
  let received = 0n;
  if (asset.address === "native") {
    if (tx.to && getAddress(tx.to) === getAddress(treasuryAddress)) received = tx.value;
  } else {
    const transferTopic = keccak256(toUtf8Bytes("Transfer(address,address,uint256)"));
    received = receipt.logs
      .filter((log) => getAddress(log.address) === getAddress(asset.address) && log.topics[0] === transferTopic && log.topics.length === 3 &&
        getAddress(`0x${log.topics[1]!.slice(26)}`) === getAddress(tx.from) &&
        getAddress(`0x${log.topics[2]!.slice(26)}`) === getAddress(treasuryAddress))
      .reduce((sum, log) => sum + BigInt(log.data), 0n);
  }
  if (received < inputUnits) throw new RouterError("deposit_below_quoted_amount");

  const signer = signerWallet().connect(provider);
  const inputToken = asset.address;
  const paid = {
    chainId: 4663n, creditToken: creditTokenAddress, recipient,
    quoteId: keccak256(toUtf8Bytes(String(body.quoteId))), paymentId: txHash,
    sourcePayer: zeroPadValue(tx.from, 32),
    assetId: isAddress(inputToken) ? zeroPadValue(inputToken, 32) : keccak256(toUtf8Bytes("robinhood:swap")),
    paidAmount: received, creditAmount: credits, deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
  };
  const signature = await signer.signTypedData(
    { name: "Accred Solana Paid Settlement", version: "1", chainId: 4663, verifyingContract: settlementAddress },
    { PaidQuote: [
      { name: "chainId", type: "uint256" }, { name: "creditToken", type: "address" }, { name: "recipient", type: "address" },
      { name: "quoteId", type: "bytes32" }, { name: "paymentId", type: "bytes32" }, { name: "sourcePayer", type: "bytes32" },
      { name: "assetId", type: "bytes32" }, { name: "paidAmount", type: "uint256" }, { name: "creditAmount", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ] },
    paid,
  );
  const sent = await new Contract(settlementAddress, settlementAbi, signer).settle!(paid, signature);
  return sent.hash as string;
}

const TRANSFER_TOPIC = keccak256(toUtf8Bytes("Transfer(address,address,uint256)"));

/** Treasury pays the redeemer wallet-to-wallet in the same token (or native ETH) the redeemer chose. */
async function payoutRedemptionOp(body: Call, addresses: ReturnType<typeof creditConfiguration>["addresses"]): Promise<string> {
  const key = process.env.TREASURY_PRIVATE_KEY;
  if (!key) throw new RouterError("treasury_wallet_not_configured", 503);
  const provider = rpcProvider();
  const signer = new Wallet(key).connect(provider);
  const { treasuryAddress, creditTokenAddress } = addresses;
  const recipient = String(body.recipientAddress);
  const outputToken = String(body.outputTokenAddress);
  const native = outputToken === "native";
  if (!native && isProjectToken(outputToken)) throw new RouterError("asset_not_redeemable", 400);
  if (!treasuryAddress || !creditTokenAddress || !isAddress(recipient) || (!native && !isAddress(outputToken)) ||
      getAddress(treasuryAddress) !== signer.address ||
      getAddress(String(body.creditTokenAddress)) !== getAddress(creditTokenAddress)) {
    throw new RouterError("redemption_not_bound_to_configured_treasury_and_tokens", 400);
  }
  const creditUnits = BigInt(String(body.creditAmountBaseUnits));
  const payout = BigInt(String(body.minOutBaseUnits));
  if (creditUnits <= 0n || creditUnits % 10n ** 14n !== 0n || payout <= 0n) {
    throw new RouterError("redemption_amounts_invalid");
  }
  // Re-prove the real credit token reached the treasury from the redeemer's wallet.
  const receipt = await provider.getTransactionReceipt(String(body.creditTransferTxHash));
  const received = receipt?.status === 1 ? receipt.logs.filter((log) =>
    getAddress(log.address) === getAddress(creditTokenAddress) && log.topics[0] === TRANSFER_TOPIC &&
    log.topics.length === 3 &&
    getAddress(`0x${log.topics[1]!.slice(26)}`) === getAddress(recipient) &&
    getAddress(`0x${log.topics[2]!.slice(26)}`) === signer.address,
  ).reduce((sum, log) => sum + BigInt(log.data), 0n) : 0n;
  if (received < creditUnits) throw new RouterError("redemption_credit_transfer_not_proven");

  if (native) {
    const balance = await provider.getBalance(signer.address);
    if (balance < payout + 1_000_000_000_000_000n) throw new Error("presend:redemption_liquidity_unavailable");
    const tx = await signer.sendTransaction({ to: recipient, value: payout });
    const done = await tx.wait();
    if (done?.status !== 1) throw new Error("redemption_payout_reverted");
    return tx.hash;
  }
  const token = new Contract(outputToken, erc20Abi, signer);
  if ((await token.balanceOf!(signer.address) as bigint) < payout) throw new Error("presend:redemption_liquidity_unavailable");
  try { await token.transfer!.estimateGas(recipient, payout); } catch { throw new Error("presend:payout_simulation_failed"); }
  const tx = await token.transfer!(recipient, payout);
  const done = await tx.wait();
  if (done?.status !== 1) throw new Error("redemption_payout_reverted");
  return tx.hash as string;
}

/**
 * Burns the $CRED a user paid for credit: the treasury wallet sends exactly that amount to the dead address.
 * Runs once per quote; replays return the recorded burn transaction.
 */
export async function burnProjectTokenDeposit(quoteId: string, tokenAddress: string, amount: bigint): Promise<{ txHash: string | null; state: string }> {
  return runOnce(`cred-burn:${quoteId}`, "burn_project_token", async () => {
    const key = process.env.TREASURY_PRIVATE_KEY;
    if (!key) throw new RouterError("treasury_wallet_not_configured", 503);
    const { treasuryAddress } = creditConfiguration().addresses;
    const signer = new Wallet(key).connect(rpcProvider());
    if (!treasuryAddress || getAddress(treasuryAddress) !== signer.address) throw new RouterError("burn_not_bound_to_configured_treasury");
    if (!isProjectToken(tokenAddress) || amount <= 0n) throw new RouterError("burn_request_invalid");
    const token = new Contract(tokenAddress, erc20Abi, signer);
    if ((await token.balanceOf!(signer.address) as bigint) < amount) throw new RouterError("burn_balance_short", 503);
    const sent = await token.transfer!(PROJECT_TOKEN_BURN_ADDRESS, amount);
    return sent.hash as string;
  });
}
