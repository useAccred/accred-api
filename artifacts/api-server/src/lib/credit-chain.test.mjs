import test from "node:test";
import assert from "node:assert/strict";
import { Interface } from "ethers";
import { verifyFinalizedRobinhoodTransaction } from "./credit-chain.ts";

const purchaseAddress = "0x0000000000000000000000000000000000000010";
const redeemAddress = "0x0000000000000000000000000000000000000011";
const treasuryAddress = "0x0000000000000000000000000000000000000013";
const usdgAddress = "0x0000000000000000000000000000000000000014";
const creditAddress = "0x0000000000000000000000000000000000000015";
const user = "0x0000000000000000000000000000000000000020";
const zeroAddress = "0x0000000000000000000000000000000000000000";
const purchaseAbi = new Interface([
  "event QuoteSettled(address indexed user,address indexed inputToken,uint256 inputAmount,uint256 credits,uint256 nonce)",
]);
const redemptionAbi = new Interface([
  "event Redeemed(address indexed wallet,bytes32 indexed quoteId,bytes32 indexed actionId,uint256 creditAmount,uint256 usdgAmount)",
]);
const erc20Abi = new Interface(["event Transfer(address indexed from,address indexed to,uint256 value)"]);

function eventLog(abi, address, name, args) {
  const encoded = abi.encodeEventLog(abi.getEvent(name), args);
  return { address, topics: encoded.topics, data: encoded.data };
}

function rpcMock({ txHash, to, input, logs }) {
  const prior = globalThis.fetch;
  const finalizedBlock = "0x100";
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    let result;
    switch (request.method) {
      case "eth_chainId": result = "0x1237"; break;
      case "eth_getTransactionReceipt":
        result = { status: "0x1", blockNumber: finalizedBlock, logs };
        break;
      case "eth_getTransactionByHash":
        result = { from: user, to, input, value: "0x0" };
        break;
      case "eth_getBlockByNumber":
        result = request.params[0] === "finalized"
          ? { number: finalizedBlock }
          : { timestamp: "0x65a00000" };
        break;
      default: throw new Error(`unexpected test RPC method ${request.method}`);
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  return () => { globalThis.fetch = prior; };
}

const config = { robinhoodRpcUrl: "https://rpc.mainnet.chain.robinhood.com" };

test("atomic purchase finality requires the exact treasury payment, QuoteSettled nonce, and same-receipt mint", async () => {
  const txHash = `0x${"1".repeat(64)}`;
  const calldata = `0x${"ab".repeat(32)}`;
  const inputAmount = 1_000_000n;
  const creditAmount = 100n * 10n ** 18n;
  const nonce = 123456789n;
  const logs = [
    eventLog(purchaseAbi, purchaseAddress, "QuoteSettled", [user, usdgAddress, inputAmount, creditAmount, nonce]),
    eventLog(erc20Abi, usdgAddress, "Transfer", [user, treasuryAddress, inputAmount]),
    eventLog(erc20Abi, creditAddress, "Transfer", [zeroAddress, user, creditAmount]),
  ];
  const restoreFetch = rpcMock({ txHash, to: purchaseAddress, input: calldata, logs });
  try {
    const result = await verifyFinalizedRobinhoodTransaction(config, {
      txHash,
      sender: user,
      expected: {
        expectedTo: purchaseAddress,
        expectedValue: "0",
        expectedCalldata: calldata,
        expectedToken: usdgAddress,
        expectedRecipient: treasuryAddress,
        expectedTokenAmount: inputAmount.toString(),
        atomicPurchase: {
          purchaseAddress, user, inputToken: usdgAddress, inputAmount: inputAmount.toString(),
          creditToken: creditAddress, creditAmount: creditAmount.toString(), nonce: nonce.toString(),
        },
      },
      expectedTransfers: [{
        tokenAddress: usdgAddress, from: user, to: treasuryAddress, amount: inputAmount.toString(),
      }],
    });
    assert.equal(result.finalized, true);
    const missingMint = rpcMock({ txHash, to: purchaseAddress, input: calldata, logs: logs.slice(0, 2) });
    try {
      await assert.rejects(
        verifyFinalizedRobinhoodTransaction(config, {
          txHash,
          sender: user,
          expected: {
            expectedTo: purchaseAddress, expectedValue: "0", expectedCalldata: calldata,
            expectedToken: usdgAddress, expectedRecipient: treasuryAddress,
            expectedTokenAmount: inputAmount.toString(),
            atomicPurchase: {
              purchaseAddress, user, inputToken: usdgAddress, inputAmount: inputAmount.toString(),
              creditToken: creditAddress, creditAmount: creditAmount.toString(), nonce: nonce.toString(),
            },
          },
          expectedTransfers: [{
            tokenAddress: usdgAddress, from: user, to: treasuryAddress, amount: inputAmount.toString(),
          }],
        }),
        /atomic_purchase_credit_mint_not_found/,
      );
    } finally { missingMint(); }
  } finally { restoreFetch(); }
});

test("atomic redemption finality requires the quote/action event, observable credit burn, and redeemer USDG payout", async () => {
  const txHash = `0x${"2".repeat(64)}`;
  const calldata = `0x${"cd".repeat(32)}`;
  const creditAmount = 5n * 10n ** 18n;
  const usdgAmount = 50_000n;
  const quoteId = `0x${"3".repeat(64)}`;
  const actionId = `0x${"4".repeat(64)}`;
  const logs = [
    eventLog(erc20Abi, creditAddress, "Transfer", [user, redeemAddress, creditAmount]),
    eventLog(erc20Abi, creditAddress, "Transfer", [redeemAddress, zeroAddress, creditAmount]),
    eventLog(erc20Abi, usdgAddress, "Transfer", [redeemAddress, user, usdgAmount]),
    eventLog(redemptionAbi, redeemAddress, "Redeemed", [user, quoteId, actionId, creditAmount, usdgAmount]),
  ];
  const expectedTransfers = [
    { tokenAddress: creditAddress, from: user, to: redeemAddress, amount: creditAmount.toString() },
    { tokenAddress: creditAddress, from: redeemAddress, to: zeroAddress, amount: creditAmount.toString() },
    { tokenAddress: usdgAddress, from: redeemAddress, to: user, amount: usdgAmount.toString() },
  ];
  const restoreFetch = rpcMock({ txHash, to: redeemAddress, input: calldata, logs });
  try {
    const result = await verifyFinalizedRobinhoodTransaction(config, {
      txHash,
      sender: user,
      expected: {
        expectedTo: redeemAddress,
        expectedValue: "0",
        expectedCalldata: calldata,
        expectedToken: creditAddress,
        expectedRecipient: redeemAddress,
        expectedTokenAmount: creditAmount.toString(),
        atomicRedemption: {
          redeemAddress, user, creditToken: creditAddress, creditAmount: creditAmount.toString(),
          usdgToken: usdgAddress, usdgAmount: usdgAmount.toString(), quoteId, actionId,
        },
      },
      expectedTransfers,
    });
    assert.equal(result.finalized, true);
    const withoutBurn = rpcMock({ txHash, to: redeemAddress, input: calldata, logs: logs.filter((_log, index) => index !== 1) });
    try {
      await assert.rejects(
        verifyFinalizedRobinhoodTransaction(config, {
          txHash,
          sender: user,
          expected: {
            expectedTo: redeemAddress, expectedValue: "0", expectedCalldata: calldata,
            expectedToken: creditAddress, expectedRecipient: redeemAddress,
            expectedTokenAmount: creditAmount.toString(),
            atomicRedemption: {
              redeemAddress, user, creditToken: creditAddress, creditAmount: creditAmount.toString(),
              usdgToken: usdgAddress, usdgAmount: usdgAmount.toString(), quoteId, actionId,
            },
          },
          expectedTransfers,
        }),
        /expected_exact_token_transfer_not_found/,
      );
    } finally { withoutBurn(); }
  } finally { restoreFetch(); }
});