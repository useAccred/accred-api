import { Buffer } from "node:buffer";
import { Interface, keccak256, toUtf8Bytes, verifyTypedData } from "ethers";
import { assetRegistry, findCreditAsset, isDirectBuyAsset, type CreditAsset } from "./credit-assets";
import { isEvmAddress, isSolanaAddress, type CreditConfiguration } from "./credit-config";
import { validatePreparedSolanaPayment } from "./credit-solana";
import { formatUnits, parseDecimalAmount, type CreditChain, type CreditMode } from "./credit-policy";

const erc20 = new Interface([
  "function approve(address spender,uint256 amount)",
  "function transfer(address to,uint256 amount)",
]);
const purchaseContract = new Interface([
  "function settle((uint256 chainId,address inputToken,address creditToken,address user,uint256 inputAmount,uint256 creditAmount,uint256 minCredits,uint256 deadline,uint256 nonce) q,bytes signature)",
]);
export type ExpectedTransfer = {
  tokenAddress: string;
  from: string;
  to: string;
  amount: string;
  sourceAccount?: string;
  destinationAccount?: string;
  tokenDecimals?: number;
};
export type AtomicPurchaseExpectation = {
  purchaseAddress: string;
  treasuryAddress: string;
  user: string;
  inputToken: string;
  inputAmount: string;
  creditToken: string;
  creditAmount: string;
  nonce: string;
};
export type AtomicRedemptionExpectation = {
  redeemAddress: string;
  user: string;
  creditToken: string;
  creditAmount: string;
  usdgToken: string;
  usdgAmount: string;
  quoteId: string;
  actionId: string;
};

export type PreparedTransaction = {
  chainId: number | string;
  to: string;
  data: string | null;
  value: string;
  serialized: string | null;
  payer?: string;
  recentBlockhash?: string;
  instructions?: unknown[];
};

export type PreparedApproval = {
  chainId: number;
  tokenAddress: string;
  spender: string;
  amount: string;
  transaction: { to: string; data: string; value: string };
};

export type ExecutableCreditQuote = {
  id: string;
  expiresAt: Date;
  inputToken: string;
  outputToken: string;
  inputAmount: string;
  outputAmount: string;
  netUsdMicros: string;
  expectedTo: string;
  expectedValue: string;
  expectedCalldata: string | null;
  expectedToken: string | null;
  expectedRecipient: string | null;
  expectedTokenAmount: string | null;
  expectedTransfers: ExpectedTransfer[];
  transaction: PreparedTransaction;
  approvals: PreparedApproval[];
  route: Record<string, unknown>;
  credits: string;
  inputAsset: CreditAsset;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function publicRouteSummary(value: unknown): Record<string, unknown> {
  const route = asRecord(value);
  if (!route) return {};
  const result: Record<string, unknown> = {};
  for (const key of ["provider", "name", "protocol", "path", "routeName", "estimatedFee"]) {
    const field = route[key];
    if (typeof field === "string" && field.length <= 256) result[key] = field;
  }
  for (const key of ["priceImpactBps", "feeBps"]) {
    const field = route[key];
    if (Number.isInteger(field) && Number(field) >= 0 && Number(field) <= 10_000) result[key] = field;
  }
  return result;
}

function parseAtomic(value: unknown): string | undefined {
  return typeof value === "string" && /^\d+$/.test(value) && BigInt(value) > 0n ? value : undefined;
}

function parseTransfers(value: unknown): ExpectedTransfer[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 12) return undefined;
  const result: ExpectedTransfer[] = [];
  for (const item of value) {
    const transfer = asRecord(item);
    if (!transfer || typeof transfer.tokenAddress !== "string" ||
        typeof transfer.from !== "string" || typeof transfer.to !== "string") return undefined;
    const amount = parseAtomic(transfer.amount);
    if (!amount) return undefined;
    const sourceAccount = typeof transfer.sourceAccount === "string" ? transfer.sourceAccount : undefined;
    const destinationAccount = typeof transfer.destinationAccount === "string" ? transfer.destinationAccount : undefined;
    const tokenDecimals = Number.isInteger(transfer.tokenDecimals) &&
      Number(transfer.tokenDecimals) >= 0 && Number(transfer.tokenDecimals) <= 18
      ? Number(transfer.tokenDecimals) : undefined;
    result.push({
      tokenAddress: transfer.tokenAddress, from: transfer.from, to: transfer.to, amount,
      ...(sourceAccount ? { sourceAccount } : {}),
      ...(destinationAccount ? { destinationAccount } : {}),
      ...(tokenDecimals !== undefined ? { tokenDecimals } : {}),
    });
  }
  return result;
}

function transferAmounts(
  transfers: ExpectedTransfer[],
  token: string,
  from: string,
  chain: CreditChain,
): bigint {
  return transfers.filter((transfer) =>
    sameAddress(chain, transfer.tokenAddress, token) &&
    sameAddress(chain, transfer.from, from),
  ).reduce((sum, transfer) => sum + BigInt(transfer.amount), 0n);
}

function sameAddress(chain: CreditChain, first: string, second: string): boolean {
  return chain === "robinhood" ? first.toLowerCase() === second.toLowerCase() : first === second;
}

function validDirectMode(mode: CreditMode, chain: CreditChain, asset: string): boolean {
  if (mode === "redeem") return chain === "robinhood";
  return isDirectBuyAsset(chain, asset) ? mode === "buy" : mode !== "buy";
}

export async function requestExecutableQuote(args: {
  config: CreditConfiguration;
  mode: CreditMode;
  chain: CreditChain;
  asset: string;
  amount: string;
  sender: string;
  recipient: string;
  reference: string;
  redeemQuoteSigner?: string;
  purchaseQuoteSigner?: string;
}): Promise<ExecutableCreditQuote> {
  const { config, mode, chain, sender, recipient } = args;
  if (!config.routerQuoteUrl) throw new Error("trusted_router_unavailable");
  if (!validDirectMode(mode, chain, args.asset)) throw new Error("asset_requires_direct_buy_or_swap");
  const inputAsset = mode === "redeem"
    ? findCreditAsset(config, "robinhood", "CREDIT")
    : findCreditAsset(config, chain, args.asset);
  if (mode === "redeem") {
    if (chain !== "robinhood") throw new Error("cross_chain_redemption_not_enabled");
    const credit = config.addresses.creditTokenAddress;
    if (!credit) throw new Error("credit_token_not_configured");
    const amount = parseDecimalAmount(args.amount, 18);
    if (!amount) throw new Error("invalid_amount");
    // Wallet-held CREDIT goes to the treasury wallet; the treasury pays the requested token from its USDG.
    const outputAsset = findCreditAsset(config, chain, args.asset);
    if (!outputAsset) throw new Error("redemption_asset_not_registered");
    return requestRoute({
      ...args, inputAsset: { symbol: "CREDIT", chain: "robinhood", address: credit, decimals: 18 },
      amount: amount.normalized, outputAsset,
    });
  }
  if (!inputAsset) throw new Error("asset_not_registered_for_mainnet");
  const amount = parseDecimalAmount(args.amount, inputAsset.decimals);
  if (!amount) throw new Error("invalid_amount");
  if (mode === "buy" && inputAsset.chain === "solana" && !["SOL", "USDC", "USDT"].includes(inputAsset.symbol)) {
    throw new Error("direct_solana_buy_supports_only_SOL_USDC_USDT");
  }
  if (mode === "buy" && inputAsset.chain === "robinhood" && inputAsset.symbol !== "USDG") {
    throw new Error("direct_robinhood_buy_supports_only_USDG");
  }
  if (!config.addresses.creditTokenAddress) throw new Error("credit_token_not_configured");
  return requestRoute({ ...args, inputAsset: { ...inputAsset }, amount: amount.normalized });
}

async function requestRoute(args: {
  config: CreditConfiguration;
  mode: CreditMode;
  chain: CreditChain;
  asset: string;
  amount: string;
  sender: string;
  recipient: string;
  reference: string;
  redeemQuoteSigner?: string;
  purchaseQuoteSigner?: string;
  inputAsset: CreditAsset;
  outputAsset?: CreditAsset;
}): Promise<ExecutableCreditQuote> {
  const { config, mode, chain, sender, recipient, inputAsset } = args;
  const redeemIds = mode === "redeem" ? {
    quoteId: keccak256(toUtf8Bytes(args.reference)),
    actionId: keccak256(toUtf8Bytes(`accred-credit-redeem:${args.reference}`)),
  } : undefined;
  const purchaseNonce = mode === "buy" && chain === "robinhood"
    ? BigInt(keccak256(toUtf8Bytes(args.reference))).toString()
    : undefined;
  const directDestination = chain === "robinhood"
    ? (mode === "redeem" ? config.addresses.treasuryAddress
      : mode === "buy" ? config.addresses.purchaseAddress
        : config.addresses.treasuryAddress)
    : config.addresses.solanaTreasuryAddress;
  if (!directDestination) throw new Error("chain_treasury_or_purchase_address_not_configured");
  const configuredPaymentDestination = chain === "robinhood" && mode === "buy"
    ? config.addresses.treasuryAddress
    : directDestination;
  if (chain === "robinhood" && mode === "buy" && !configuredPaymentDestination) {
    throw new Error("robinhood_purchase_treasury_not_configured");
  }
  if (chain === "robinhood" && !isEvmAddress(sender)) throw new Error("verified_robinhood_wallet_required");
  if (chain === "solana" && !isSolanaAddress(sender)) throw new Error("verified_solana_wallet_required");
  const authToken = process.env.CREDIT_ROUTER_AUTH_TOKEN;
  const response = await fetch(config.routerQuoteUrl!, {
    method: "POST",
    redirect: "error",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
    },
    body: JSON.stringify({
      mode, chain, chainId: chain === "robinhood" ? 4663 : "solana-mainnet",
      asset: args.asset, assetAddress: inputAsset.address, amount: args.amount,
      sender, recipient, configuredDestination: directDestination, configuredPaymentDestination,
      ...(redeemIds ? { redeemQuoteId: redeemIds.quoteId, redeemActionId: redeemIds.actionId } : {}),
      ...(purchaseNonce ? { purchaseNonce } : {}),
      reference: args.reference,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const failure = asRecord(await response.json().catch(() => undefined));
    const known = typeof failure?.error === "string" && /^(low_liquidity|amount_too_small|amount_above_limit)$/.test(failure.error);
    throw new Error(known ? String(failure!.error) : `trusted_router_http_${response.status}`);
  }
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 128_000) throw new Error("trusted_router_response_too_large");
  const responseText = await response.text();
  if (Buffer.byteLength(responseText, "utf8") > 128_000) throw new Error("trusted_router_response_too_large");
  let responseJson: unknown;
  try { responseJson = JSON.parse(responseText); } catch { throw new Error("trusted_router_response_not_json"); }
  const body = asRecord(responseJson);
  if (!body || body.executable !== true || typeof body.id !== "string" || !body.id ||
      typeof body.expiresAt !== "string") throw new Error("trusted_router_quote_not_executable");
  const expiresAt = new Date(body.expiresAt);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now() ||
      expiresAt.getTime() > Date.now() + 5 * 60_000) throw new Error("trusted_router_quote_expired_or_too_long");
  const transactionData = asRecord(body.transaction);
  if (!transactionData || typeof transactionData.to !== "string") throw new Error("prepared_transaction_missing");
  const expectedTo = typeof body.expectedTo === "string" ? body.expectedTo : transactionData.to;
  const transactionValue = typeof transactionData.value === "string" && /^\d+$/.test(transactionData.value)
    ? transactionData.value
    : chain === "solana" && transactionData.value === undefined ? "0" : undefined;
  const expectedValue = typeof body.expectedValue === "string" && /^\d+$/.test(body.expectedValue)
    ? body.expectedValue
    : chain === "solana" && body.expectedValue === undefined ? "0" : undefined;
  if (transactionValue === undefined || expectedValue === undefined) throw new Error("prepared_transaction_value_missing_or_invalid");
  const expectedCalldata = typeof body.expectedCalldata === "string" ? body.expectedCalldata : null;
  const transaction: PreparedTransaction = {
    chainId: chain === "robinhood" ? 4663 : "solana-mainnet",
    to: transactionData.to,
    data: typeof transactionData.data === "string" ? transactionData.data : null,
    value: transactionValue,
    serialized: typeof transactionData.serialized === "string" ? transactionData.serialized : null,
  };
  if (transaction.value !== expectedValue || expectedTo !== transaction.to) throw new Error("prepared_transaction_expectation_mismatch");
  if (chain === "robinhood") {
    if (!isEvmAddress(transaction.to) || !expectedCalldata || !/^0x(?:[a-fA-F0-9]{2})*$/.test(expectedCalldata) ||
        expectedCalldata.toLowerCase() !== transaction.data?.toLowerCase() || transaction.chainId !== 4663) {
      throw new Error("invalid_prepared_robinhood_transaction");
    }
    const allowed = new Set([
      config.addresses.purchaseAddress?.toLowerCase(),
      config.addresses.treasuryAddress?.toLowerCase(),
      config.addresses.vaultAddress?.toLowerCase(),
      config.addresses.redeemAddress?.toLowerCase(),
      config.addresses.creditTokenAddress?.toLowerCase(),
      inputAsset.address.toLowerCase(),
      ...(process.env.CREDIT_APPROVED_EXECUTOR_ADDRESSES ?? "").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean),
    ].filter((entry): entry is string => Boolean(entry)));
    if (!allowed.has(transaction.to.toLowerCase())) throw new Error("prepared_transaction_target_not_configured");
    if (inputAsset.address !== "native" && expectedValue !== "0") throw new Error("unexpected_native_value_for_token_transaction");
  } else if (transaction.serialized === null || !/^[A-Za-z0-9+/]+={0,2}$/.test(transaction.serialized) ||
      transaction.serialized.length > 2_000 || !isSolanaAddress(transaction.to) ||
      transaction.value !== "0" || expectedValue !== "0" || (transaction.data !== null && transaction.data !== "")) {
    throw new Error("invalid_prepared_solana_transaction");
  }
  const inputToken = typeof body.inputToken === "string" ? body.inputToken : inputAsset.address;
  const outputToken = typeof body.outputToken === "string"
    ? body.outputToken
    : mode === "redeem" ? args.outputAsset?.address : config.addresses.creditTokenAddress;
  if (!outputToken) throw new Error("quote_output_token_missing");
  const inputAmount = typeof body.inputAmount === "string" ? body.inputAmount : args.amount;
  const outputAmount = typeof body.outputAmount === "string" ? body.outputAmount : "";
  const netUsdMicros = typeof body.netUsdMicros === "string" ? body.netUsdMicros : "";
  if (!sameAddress(chain, inputToken, inputAsset.address) ||
      !/^\d+$/.test(netUsdMicros) || BigInt(netUsdMicros) <= 0n ||
      !parseDecimalAmount(inputAmount, inputAsset.decimals) ||
      !parseDecimalAmount(outputAmount, mode === "redeem" ? (args.outputAsset?.decimals ?? 18) : 18)) {
    throw new Error("invalid_router_net_quote_amounts");
  }
  if (inputAmount !== args.amount) throw new Error("router_changed_requested_input_amount");
  if (mode !== "redeem" && outputToken.toLowerCase() !== config.addresses.creditTokenAddress?.toLowerCase()) {
    throw new Error("quote_does_not_output_configured_credit_token");
  }
  if (mode === "redeem" && outputToken.toLowerCase() !== args.outputAsset?.address.toLowerCase()) {
    throw new Error("quote_does_not_output_requested_asset");
  }
  const credits = mode === "redeem" ? inputAmount : formatUnits(BigInt(netUsdMicros) * 100n * 10n ** 12n, 18);
  if (mode !== "redeem" && parseDecimalAmount(outputAmount, 18)?.units !== BigInt(netUsdMicros) * 100n * 10n ** 12n) {
    throw new Error("quote_credits_do_not_match_net_usd_value");
  }
  const transfers = parseTransfers(body.expectedTransfers);
  if (!transfers) throw new Error("quote_transfer_expectations_missing");
  if (chain === "solana") {
    for (const transfer of transfers) {
      if (transfer.tokenAddress !== "native" && !isSolanaAddress(transfer.tokenAddress)) throw new Error("invalid_solana_transfer_mint");
      if (!isSolanaAddress(transfer.from) || !isSolanaAddress(transfer.to) ||
          (transfer.sourceAccount && !isSolanaAddress(transfer.sourceAccount)) ||
          (transfer.destinationAccount && !isSolanaAddress(transfer.destinationAccount))) throw new Error("invalid_solana_transfer_address");
      if (transfer.tokenAddress !== "native" && transfer.tokenDecimals === undefined) {
        const known = assetRegistry(config).find((entry) => entry.chain === "solana" && entry.address === transfer.tokenAddress);
        if (!known) throw new Error("solana_transfer_token_not_registered");
        transfer.tokenDecimals = known.decimals;
      }
      if (transfer.tokenAddress !== "native") {
        const known = assetRegistry(config).find((entry) => entry.chain === "solana" && entry.address === transfer.tokenAddress);
        if (!known || transfer.tokenDecimals !== known.decimals ||
            !transfer.sourceAccount || !transfer.destinationAccount) {
          throw new Error("solana_transfer_accounts_or_decimals_not_verified");
        }
      }
    }
  } else {
    for (const transfer of transfers) {
      if ((transfer.tokenAddress !== "native" && !isEvmAddress(transfer.tokenAddress)) || !isEvmAddress(transfer.from) || !isEvmAddress(transfer.to)) throw new Error("invalid_robinhood_transfer_expectation");
    }
  }
  const expectedInputUnits = parseDecimalAmount(args.amount, inputAsset.decimals)?.units;
  if (!expectedInputUnits || transferAmounts(transfers, inputAsset.address, sender, chain) !== expectedInputUnits) {
    throw new Error("quote_input_transfer_does_not_match_requested_amount");
  }
  let atomicPurchase: AtomicPurchaseExpectation | undefined;
  let redeemPayout: { minOut: string } | undefined;
  if (mode === "buy" && chain === "robinhood") {
    const creditToken = config.addresses.creditTokenAddress;
    const purchaseAddress = config.addresses.purchaseAddress;
    const treasuryAddress = config.addresses.treasuryAddress;
    const exactCredits = parseDecimalAmount(outputAmount, 18)?.units;
    let parsedPurchase;
    try { parsedPurchase = purchaseContract.parseTransaction({ data: transaction.data ?? "" }); } catch {
      throw new Error("invalid_robinhood_purchase_calldata");
    }
    const purchaseQuote = parsedPurchase?.args[0];
    const purchaseSignature = parsedPurchase?.args[1];
    const expectedNonce = BigInt(keccak256(toUtf8Bytes(args.reference)));
    let recoveredPurchaseSigner = "";
    if (purchaseQuote && typeof purchaseSignature === "string" &&
        /^0x[0-9a-fA-F]{130}$/.test(purchaseSignature) &&
        (parseInt(purchaseSignature.slice(-2), 16) === 27 || parseInt(purchaseSignature.slice(-2), 16) === 28) &&
        BigInt(`0x${purchaseSignature.slice(66, 130)}`) <= 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n &&
        purchaseAddress && args.purchaseQuoteSigner) {
      try {
        recoveredPurchaseSigner = verifyTypedData(
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
          {
            chainId: BigInt(purchaseQuote.chainId),
            inputToken: String(purchaseQuote.inputToken),
            creditToken: String(purchaseQuote.creditToken),
            user: String(purchaseQuote.user),
            inputAmount: BigInt(purchaseQuote.inputAmount),
            creditAmount: BigInt(purchaseQuote.creditAmount),
            minCredits: BigInt(purchaseQuote.minCredits),
            deadline: BigInt(purchaseQuote.deadline),
            nonce: BigInt(purchaseQuote.nonce),
          },
          purchaseSignature,
        );
      } catch { recoveredPurchaseSigner = ""; }
    }
    if (!purchaseAddress || !treasuryAddress || !creditToken || !exactCredits ||
        !args.purchaseQuoteSigner || recoveredPurchaseSigner.toLowerCase() !== args.purchaseQuoteSigner.toLowerCase() ||
        transaction.to.toLowerCase() !== purchaseAddress.toLowerCase() ||
        parsedPurchase?.name !== "settle" || !purchaseQuote ||
        BigInt(purchaseQuote.chainId) !== 4663n ||
        String(purchaseQuote.inputToken).toLowerCase() !== inputAsset.address.toLowerCase() ||
        String(purchaseQuote.creditToken).toLowerCase() !== creditToken.toLowerCase() ||
        String(purchaseQuote.user).toLowerCase() !== recipient.toLowerCase() ||
        BigInt(purchaseQuote.inputAmount) !== expectedInputUnits ||
        BigInt(purchaseQuote.creditAmount) !== exactCredits ||
        BigInt(purchaseQuote.minCredits) !== exactCredits ||
        BigInt(purchaseQuote.deadline) <= BigInt(Math.floor(Date.now() / 1000)) ||
        BigInt(purchaseQuote.deadline) > BigInt(Math.floor(expiresAt.getTime() / 1000)) ||
        BigInt(purchaseQuote.nonce) !== expectedNonce) {
      throw new Error("robinhood_purchase_quote_not_bound_to_exact_payment_credit_and_reference");
    }
    atomicPurchase = {
      purchaseAddress, treasuryAddress, user: recipient, inputToken: inputAsset.address,
      inputAmount: expectedInputUnits.toString(), creditToken, creditAmount: exactCredits.toString(),
      nonce: expectedNonce.toString(),
    };
  }
  if (mode === "redeem") {
    const treasury = config.addresses.treasuryAddress;
    const creditToken = config.addresses.creditTokenAddress;
    const redeemOutputUnits = parseDecimalAmount(outputAmount, args.outputAsset?.decimals ?? 18)?.units;
    let parsedTransfer;
    try { parsedTransfer = erc20.parseTransaction({ data: transaction.data ?? "" }); } catch {
      throw new Error("invalid_robinhood_redemption_calldata");
    }
    const payout = asRecord(asRecord(body.route)?.redeemPayout);
    const payoutMinOut = parseAtomic(payout?.minOut);
    if (chain !== "robinhood" || !treasury || !creditToken || !redeemOutputUnits ||
        transaction.to.toLowerCase() !== creditToken.toLowerCase() ||
        parsedTransfer?.name !== "transfer" ||
        String(parsedTransfer.args.to).toLowerCase() !== treasury.toLowerCase() ||
        BigInt(parsedTransfer.args.amount) !== expectedInputUnits ||
        expectedInputUnits % 10n ** 14n !== 0n ||
        BigInt(netUsdMicros) !== expectedInputUnits / 10n ** 14n ||
        !payoutMinOut || BigInt(payoutMinOut) !== redeemOutputUnits ||
        !transfers.some((transfer) =>
          sameAddress(chain, transfer.from, sender) &&
          sameAddress(chain, transfer.to, treasury) &&
          sameAddress(chain, transfer.tokenAddress, creditToken) &&
          BigInt(transfer.amount) === expectedInputUnits)) {
      throw new Error("redemption_must_transfer_wallet_credits_to_treasury");
    }
    redeemPayout = { minOut: payoutMinOut };
  } else {
    const requiredRecipient = chain === "robinhood" ? config.addresses.treasuryAddress : config.addresses.solanaTreasuryAddress;
    if (!requiredRecipient || !transfers.some((transfer) =>
      sameAddress(chain, transfer.tokenAddress, inputAsset.address) &&
      sameAddress(chain, transfer.from, sender) &&
      sameAddress(chain, transfer.to, requiredRecipient) &&
      BigInt(transfer.amount) === expectedInputUnits,
    )) throw new Error("quote_does_not_deliver_exact_payment_to_configured_treasury");
    if (mode === "swap" && chain === "robinhood") {
      const treasury = config.addresses.treasuryAddress!.toLowerCase();
      if (inputAsset.address === "native") {
        if (transaction.to.toLowerCase() !== treasury || BigInt(transaction.value) !== expectedInputUnits) {
          throw new Error("swap_native_transfer_not_bound_to_treasury");
        }
      } else {
        let parsedDeposit;
        try { parsedDeposit = erc20.parseTransaction({ data: transaction.data ?? "" }); } catch { throw new Error("invalid_swap_deposit_calldata"); }
        if (transaction.to.toLowerCase() !== inputAsset.address.toLowerCase() || parsedDeposit?.name !== "transfer" ||
            String(parsedDeposit.args.to).toLowerCase() !== treasury || BigInt(parsedDeposit.args.amount) !== expectedInputUnits) {
          throw new Error("swap_deposit_not_bound_to_treasury");
        }
      }
    }
  }
  let solanaPayment: Awaited<ReturnType<typeof validatePreparedSolanaPayment>> | undefined;
  if (chain === "solana") {
    solanaPayment = await validatePreparedSolanaPayment({
      config,
      serialized: transaction.serialized!,
      payer: sender,
      reference: args.reference,
      expectedTransfers: transfers,
      allowedPrograms: (process.env.CREDIT_SOLANA_EXECUTOR_PROGRAMS ?? "").split(",").map((entry) => entry.trim()).filter((entry) => isSolanaAddress(entry)),
    });
    if (!solanaPayment.instructions.some((instruction) => instruction.programId === transaction.to)) {
      throw new Error("solana_quote_to_not_in_prepared_message");
    }
    transaction.payer = solanaPayment.payer;
    transaction.recentBlockhash = solanaPayment.recentBlockhash;
    transaction.instructions = solanaPayment.instructions;
    transaction.data = null;
  }
  const approvals = validateApprovals(body.approvals, chain, inputAsset, transaction.to, args.amount, inputAsset.decimals);
  const route = publicRouteSummary(body.route);
  const expectedTokenTransfer = transfers.find((transfer) =>
    sameAddress(chain, transfer.tokenAddress, inputAsset.address) &&
    sameAddress(chain, transfer.from, sender),
  );
  return {
    id: body.id,
    expiresAt,
    inputToken,
    outputToken,
    inputAmount,
    outputAmount,
    netUsdMicros,
    expectedTo,
    expectedValue,
    expectedCalldata,
    expectedToken: expectedTokenTransfer?.tokenAddress ?? null,
    expectedRecipient: expectedTokenTransfer?.to ?? null,
    expectedTokenAmount: expectedTokenTransfer?.amount ?? null,
    expectedTransfers: transfers,
    transaction,
    approvals,
    route: {
      ...route, id: body.id,
      ...(atomicPurchase ? { atomicPurchase } : {}),
      ...(redeemPayout ? { redeemPayout } : {}),
      ...(solanaPayment ? { solanaPayment } : {}),
    },
    credits,
    inputAsset,
  };
}

function validateApprovals(
  value: unknown,
  chain: CreditChain,
  inputAsset: CreditAsset,
  target: string,
  amount: string,
  decimals: number,
): PreparedApproval[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 4) throw new Error("invalid_approval_list");
  if (chain === "solana" && value.length) throw new Error("solana_approval_transactions_not_supported");
  const exactAmount = parseDecimalAmount(amount, decimals)?.units;
  if (!exactAmount) throw new Error("invalid_approval_amount");
  return value.map((entry) => {
    const approval = asRecord(entry);
    const tx = asRecord(approval?.transaction);
    if (chain !== "robinhood" || !approval || !tx || approval.chainId !== 4663 ||
        approval.tokenAddress?.toString().toLowerCase() !== inputAsset.address.toLowerCase() ||
        approval.spender?.toString().toLowerCase() !== target.toLowerCase() ||
        typeof tx.to !== "string" || tx.to.toLowerCase() !== inputAsset.address.toLowerCase() ||
        typeof tx.data !== "string" || tx.value !== "0") throw new Error("approval_not_bound_to_quote_executor");
    let parsed;
    try { parsed = erc20.parseTransaction({ data: tx.data }); } catch { throw new Error("invalid_approval_calldata"); }
    if (parsed?.name !== "approve" || String(parsed.args.spender).toLowerCase() !== target.toLowerCase() ||
        BigInt(parsed.args.amount) !== exactAmount) throw new Error("approval_amount_or_spender_mismatch");
    return {
      chainId: 4663,
      tokenAddress: inputAsset.address,
      spender: target,
      amount: exactAmount.toString(),
      transaction: { to: tx.to, data: tx.data, value: "0" },
    };
  });
}