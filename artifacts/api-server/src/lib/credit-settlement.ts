import { isTxHash, type CreditChain } from "./credit-policy";
import type { CreditConfiguration } from "./credit-config";

type SettlementCall = {
  txHash: string | null;
  state: "submitted" | "pending";
};

async function signerRequest(config: CreditConfiguration, payload: Record<string, unknown>): Promise<SettlementCall> {
  if (!config.settlementEnabled || !config.settlementServiceUrl || !config.settlementSignerAddress) {
    throw new Error("secure_settlement_signer_not_configured");
  }
  const token = process.env.CREDIT_SETTLEMENT_SERVICE_TOKEN;
  if (!token) throw new Error("secure_settlement_signer_not_configured");
  const response = await fetch(config.settlementServiceUrl, {
    method: "POST",
    redirect: "error",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "idempotency-key": String(payload.idempotencyKey),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`secure_settlement_service_http_${response.status}`);
  const data = await response.json() as {
    state?: unknown; txHash?: unknown; settlementTxHash?: unknown; payoutTxHash?: unknown;
  };
  const candidate = data.settlementTxHash ?? data.payoutTxHash ?? data.txHash;
  const txHash = typeof candidate === "string" && isTxHash(candidate, "robinhood") ? candidate : null;
  return { txHash, state: txHash ? "submitted" : "pending" };
}

export function settleCreditPurchase(config: CreditConfiguration, args: {
  quoteId: string;
  ownerUserId: string;
  recipientAddress: string;
  creditTokenAddress: string;
  creditsBaseUnits: string;
  paymentChain: CreditChain;
  paymentTxHash: string;
  paymentBlock: string;
  netUsdMicros: string;
  quoteRouteId: string;
}): Promise<SettlementCall> {
  return signerRequest(config, {
    operation: "settle_credit_purchase",
    idempotencyKey: `credit-purchase:${args.quoteId}`,
    chainId: 4663,
    quoteId: args.quoteId,
    ownerUserId: args.ownerUserId,
    recipientAddress: args.recipientAddress,
    creditTokenAddress: args.creditTokenAddress,
    creditsBaseUnits: args.creditsBaseUnits,
    netUsdMicros: args.netUsdMicros,
    quoteRouteId: args.quoteRouteId,
    payment: { chain: args.paymentChain, txHash: args.paymentTxHash, finalizedBlock: args.paymentBlock },
    // The signing service must independently validate the quote and finalized payment
    // and authorize only this exact configured-token mint amount to this recipient.
  });
}

export function payoutReservedCashback(config: CreditConfiguration, args: {
  quoteId: string;
  recipientAddress: string;
  cashbackAddress: string;
  usdgAddress: string;
  amountBaseUnits: string;
}): Promise<SettlementCall> {
  return signerRequest(config, {
    operation: "payout_reserved_cashback",
    idempotencyKey: `credit-cashback:${args.quoteId}`,
    chainId: 4663,
    quoteId: args.quoteId,
    senderAddress: args.cashbackAddress,
    recipientAddress: args.recipientAddress,
    tokenAddress: args.usdgAddress,
    amountBaseUnits: args.amountBaseUnits,
    // The signing service must enforce the cashback wallet as sender, exact
    // funded token balance, and idempotent one-time payout for this quote.
  });
}
export function payoutRedemption(config: CreditConfiguration, args: {
  quoteId: string;
  recipientAddress: string;
  creditTokenAddress: string;
  creditTransferTxHash: string;
  creditAmountBaseUnits: string;
  outputTokenAddress: string;
  minOutBaseUnits: string;
}): Promise<SettlementCall> {
  return signerRequest(config, {
    operation: "payout_redemption",
    idempotencyKey: `credit-redeem:${args.quoteId}`,
    chainId: 4663,
    ...args,
  });
}
