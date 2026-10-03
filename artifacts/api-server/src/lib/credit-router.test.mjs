import test from "node:test";
import assert from "node:assert/strict";
import { Interface, Wallet, keccak256, toUtf8Bytes } from "ethers";
import { creditConfiguration } from "./credit-config.ts";
import { requestExecutableQuote } from "./credit-router.ts";

const purchaseAddress = "0x0000000000000000000000000000000000000010";
const redeemAddress = "0x0000000000000000000000000000000000000011";
const vaultAddress = "0x0000000000000000000000000000000000000012";
const treasuryAddress = "0x0000000000000000000000000000000000000013";
const usdgAddress = "0x0000000000000000000000000000000000000014";
const creditAddress = "0x0000000000000000000000000000000000000015";
const zeroAddress = "0x0000000000000000000000000000000000000000";
const reference = "7eb4f6d5-9c93-4d01-87d0-34e3a09dd86c";

function configureEnvironment() {
  const names = [
    "CREDIT_PURCHASE_ADDRESS", "CREDIT_REDEEM_ADDRESS", "CREDIT_VAULT_ADDRESS",
    "CREDIT_TREASURY_ADDRESS", "CREDIT_USDG_ADDRESS", "CREDIT_TOKEN_ADDRESS",
    "CREDIT_USDG_DECIMALS", "CREDIT_ASSET_REGISTRY", "CREDIT_ROUTER_ALLOWED_HOSTS",
    "CREDIT_ROUTER_QUOTE_URL",
  ];
  const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    CREDIT_PURCHASE_ADDRESS: purchaseAddress,
    CREDIT_REDEEM_ADDRESS: redeemAddress,
    CREDIT_VAULT_ADDRESS: vaultAddress,
    CREDIT_TREASURY_ADDRESS: treasuryAddress,
    CREDIT_USDG_ADDRESS: usdgAddress,
    CREDIT_TOKEN_ADDRESS: creditAddress,
    CREDIT_USDG_DECIMALS: "6",
    CREDIT_ASSET_REGISTRY: JSON.stringify([
      { symbol: "USDG", chain: "robinhood", address: usdgAddress, decimals: 6 },
    ]),
    CREDIT_ROUTER_ALLOWED_HOSTS: "router.example.com",
    CREDIT_ROUTER_QUOTE_URL: "https://router.example.com/quote",
  });
  return () => {
    for (const name of names) {
      if (prior[name] === undefined) delete process.env[name];
      else process.env[name] = prior[name];
    }
  };
}

const purchaseAbi = new Interface([
  "function settle((uint256 chainId,address inputToken,address creditToken,address user,uint256 inputAmount,uint256 creditAmount,uint256 minCredits,uint256 deadline,uint256 nonce) q,bytes signature)",
]);
const redeemAbi = new Interface([
  "function redeem(bytes32 quoteId,bytes32 actionId,uint256 creditAmount,uint256 usdgAmount,uint256 deadline,bytes signature)",
]);
const erc20Abi = new Interface(["function approve(address spender,uint256 amount)"]);
const redemptionTypes = {
  RedeemQuote: [
    { name: "chainId", type: "uint256" },
    { name: "redeemer", type: "address" },
    { name: "creditToken", type: "address" },
    { name: "usdgToken", type: "address" },
    { name: "wallet", type: "address" },
    { name: "creditAmount", type: "uint256" },
    { name: "usdgAmount", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "quoteId", type: "bytes32" },
    { name: "actionId", type: "bytes32" },
  ],
};

function mockRouter(body) {
  const prior = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  return () => { globalThis.fetch = prior; };
}

test("Robinhood direct buys bind treasury payment, quote nonce, and signed atomic mint", async () => {
  const restoreEnv = configureEnvironment();
  const signer = Wallet.createRandom();
  const sender = "0x0000000000000000000000000000000000000020";
  const creditAmount = 100n * 10n ** 18n;
  const inputAmount = 1_000_000n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 180);
  const nonce = BigInt(keccak256(toUtf8Bytes(reference)));
  const quote = {
    chainId: 4663,
    inputToken: usdgAddress,
    creditToken: creditAddress,
    user: sender,
    inputAmount,
    creditAmount,
    minCredits: creditAmount,
    deadline,
    nonce,
  };
  const signature = await signer.signTypedData(
    { name: "Accred", version: "1", chainId: 4663, verifyingContract: purchaseAddress },
    { Quote: [
      { name: "chainId", type: "uint256" },
      { name: "inputToken", type: "address" },
      { name: "creditToken", type: "address" },
      { name: "user", type: "address" },
      { name: "inputAmount", type: "uint256" },
      { name: "creditAmount", type: "uint256" },
      { name: "minCredits", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "nonce", type: "uint256" },
    ] },
    quote,
  );
  const calldata = purchaseAbi.encodeFunctionData("settle", [quote, signature]);
  const expiresAt = new Date(Date.now() + 210_000).toISOString();
  const body = {
    executable: true,
    id: "route-buy",
    expiresAt,
    inputToken: usdgAddress,
    outputToken: creditAddress,
    inputAmount: "1",
    outputAmount: "100",
    netUsdMicros: "1000000",
    expectedTo: purchaseAddress,
    expectedValue: "0",
    expectedCalldata: calldata,
    expectedTransfers: [{
      tokenAddress: usdgAddress, from: sender, to: treasuryAddress, amount: inputAmount.toString(),
    }],
    transaction: { to: purchaseAddress, data: calldata, value: "0" },
  };
  const restoreFetch = mockRouter(body);
  try {
    const prepared = await requestExecutableQuote({
      config: creditConfiguration(),
      mode: "buy",
      chain: "robinhood",
      asset: "USDG",
      amount: "1",
      sender,
      recipient: sender,
      reference,
      purchaseQuoteSigner: signer.address,
    });
    assert.equal(prepared.route.atomicPurchase.nonce, nonce.toString());
    assert.equal(prepared.route.atomicPurchase.treasuryAddress, treasuryAddress);
    assert.equal(prepared.expectedTransfers[0].to, treasuryAddress);

    const badBody = {
      ...body,
      expectedTransfers: [{ ...body.expectedTransfers[0], to: purchaseAddress }],
    };
    const restoreBadFetch = mockRouter(badBody);
    try {
      await assert.rejects(
        requestExecutableQuote({
          config: creditConfiguration(), mode: "buy", chain: "robinhood", asset: "USDG", amount: "1",
          sender, recipient: sender, reference, purchaseQuoteSigner: signer.address,
        }),
        /quote_does_not_deliver_exact_payment_to_configured_treasury/,
      );
    } finally { restoreBadFetch(); }
  } finally {
    restoreFetch();
    restoreEnv();
  }
});

test("redemptions require the signed redeemer ABI, exact burn and reserve payout; vault withdrawals are not redemptions", async () => {
  const restoreEnv = configureEnvironment();
  const signer = Wallet.createRandom();
  const sender = "0x0000000000000000000000000000000000000021";
  const creditAmount = 5n * 10n ** 18n;
  const usdgAmount = 50_000n;
  const quoteId = keccak256(toUtf8Bytes(reference));
  const actionId = keccak256(toUtf8Bytes(`accred-credit-redeem:${reference}`));
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 180);
  const value = {
    chainId: 4663,
    redeemer: redeemAddress,
    creditToken: creditAddress,
    usdgToken: usdgAddress,
    wallet: sender,
    creditAmount,
    usdgAmount,
    deadline,
    quoteId,
    actionId,
  };
  const signature = await signer.signTypedData(
    { name: "Accred Credit Redeemer", version: "1", chainId: 4663, verifyingContract: redeemAddress },
    redemptionTypes,
    value,
  );
  const calldata = redeemAbi.encodeFunctionData("redeem", [
    quoteId, actionId, creditAmount, usdgAmount, deadline, signature,
  ]);
  const expiresAt = new Date(Date.now() + 210_000).toISOString();
  const approvals = [{
    chainId: 4663,
    tokenAddress: creditAddress,
    spender: redeemAddress,
    transaction: {
      to: creditAddress,
      data: erc20Abi.encodeFunctionData("approve", [redeemAddress, creditAmount]),
      value: "0",
    },
  }];
  const expectedTransfers = [
    { tokenAddress: creditAddress, from: sender, to: redeemAddress, amount: creditAmount.toString() },
    { tokenAddress: creditAddress, from: redeemAddress, to: zeroAddress, amount: creditAmount.toString() },
    { tokenAddress: usdgAddress, from: redeemAddress, to: sender, amount: usdgAmount.toString() },
  ];
  const body = {
    executable: true,
    id: "route-redeem",
    expiresAt,
    inputToken: creditAddress,
    outputToken: usdgAddress,
    inputAmount: "5",
    outputAmount: "0.05",
    netUsdMicros: "50000",
    expectedTo: redeemAddress,
    expectedValue: "0",
    expectedCalldata: calldata,
    expectedTransfers,
    approvals,
    transaction: { to: redeemAddress, data: calldata, value: "0" },
  };
  const restoreFetch = mockRouter(body);
  try {
    const prepared = await requestExecutableQuote({
      config: creditConfiguration(),
      mode: "redeem",
      chain: "robinhood",
      asset: "USDG",
      amount: "5",
      sender,
      recipient: sender,
      reference,
      redeemQuoteSigner: signer.address,
    });
    assert.equal(prepared.route.atomicRedemption.quoteId, quoteId);
    assert.equal(prepared.route.atomicRedemption.actionId, actionId);
    assert.equal(prepared.approvals[0].spender, redeemAddress);
    assert.equal(prepared.expectedTransfers[1].to, zeroAddress);

    const restoreWithdrawFetch = mockRouter({
      ...body,
      expectedTo: vaultAddress,
      transaction: { ...body.transaction, to: vaultAddress },
    });
    try {
      await assert.rejects(
        requestExecutableQuote({
          config: creditConfiguration(), mode: "redeem", chain: "robinhood", asset: "USDG", amount: "5",
          sender, recipient: sender, reference, redeemQuoteSigner: signer.address,
        }),
        /redemption_must_atomically_transfer_and_burn_wallet_credits_and_pay_usdg/,
      );
    } finally { restoreWithdrawFetch(); }
  } finally {
    restoreFetch();
    restoreEnv();
  }
});