import test from "node:test";
import assert from "node:assert/strict";
import { payoutReservedCashback, settleCreditPurchase } from "./credit-settlement.ts";

const quoteId = "quote-settlement-test";
const settlementHash = `0x${"ab".repeat(32)}`;

function testConfig() {
  return {
    settlementEnabled: true,
    settlementServiceUrl: "https://signer.example.test/settle",
    settlementSignerAddress: `0x${"11".repeat(20)}`,
  };
}

test("settlement adapter makes an idempotent signer-service request and accepts a tx hash", async () => {
  const priorFetch = globalThis.fetch;
  const priorToken = process.env.CREDIT_SETTLEMENT_SERVICE_TOKEN;
  process.env.CREDIT_SETTLEMENT_SERVICE_TOKEN = "test-service-token";
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url, init, body: JSON.parse(init.body) };
    return { ok: true, json: async () => ({ state: "submitted", txHash: settlementHash }) };
  };
  try {
    const result = await settleCreditPurchase(testConfig(), {
      quoteId,
      ownerUserId: "user-test",
      recipientAddress: `0x${"22".repeat(20)}`,
      creditTokenAddress: `0x${"33".repeat(20)}`,
      creditsBaseUnits: "1000000000000000000",
      paymentChain: "solana",
      paymentTxHash: "A".repeat(64),
      paymentBlock: "123456",
      netUsdMicros: "1000000",
      quoteRouteId: "router-test",
    });
    assert.equal(result.txHash, settlementHash);
    assert.equal(request.url, "https://signer.example.test/settle");
    assert.equal(request.init.headers.authorization, "Bearer test-service-token");
    assert.equal(request.init.headers["idempotency-key"], `credit-purchase:${quoteId}`);
    assert.equal(request.body.operation, "settle_credit_purchase");
    assert.equal(request.body.payment.finalizedBlock, "123456");
    assert.equal("privateKey" in request.body, false);
  } finally {
    globalThis.fetch = priorFetch;
    if (priorToken === undefined) delete process.env.CREDIT_SETTLEMENT_SERVICE_TOKEN;
    else process.env.CREDIT_SETTLEMENT_SERVICE_TOKEN = priorToken;
  }
});

test("cashback adapter remains pending when the service does not return a valid mainnet hash", async () => {
  const priorFetch = globalThis.fetch;
  const priorToken = process.env.CREDIT_SETTLEMENT_SERVICE_TOKEN;
  process.env.CREDIT_SETTLEMENT_SERVICE_TOKEN = "test-service-token";
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ state: "pending" }) });
  try {
    const result = await payoutReservedCashback(testConfig(), {
      quoteId,
      recipientAddress: `0x${"22".repeat(20)}`,
      cashbackAddress: `0x${"44".repeat(20)}`,
      usdgAddress: `0x${"55".repeat(20)}`,
      amountBaseUnits: "20000",
    });
    assert.deepEqual(result, { txHash: null, state: "pending" });
  } finally {
    globalThis.fetch = priorFetch;
    if (priorToken === undefined) delete process.env.CREDIT_SETTLEMENT_SERVICE_TOKEN;
    else process.env.CREDIT_SETTLEMENT_SERVICE_TOKEN = priorToken;
  }
});