import { Buffer } from "node:buffer";
import { Interface } from "ethers";
import type { CreditChain } from "./credit-policy";
import { isEvmAddress, isSolanaAddress, type CreditConfiguration } from "./credit-config";
import type { ExpectedTransfer } from "./credit-router";

const erc20 = new Interface(["function balanceOf(address) view returns (uint256)", "event Transfer(address indexed from,address indexed to,uint256 value)"]);
const purchaseEvents = new Interface([
  "event QuoteSettled(address indexed user,address indexed inputToken,uint256 inputAmount,uint256 credits,uint256 nonce)",
]);
const redemptionEvents = new Interface([
  "event Redeemed(address indexed wallet,bytes32 indexed quoteId,bytes32 indexed actionId,uint256 creditAmount,uint256 usdgAmount)",
]);
const contractReaders = new Interface([
  "function quoteSigner() view returns (address)",
  "function credit() view returns (address)",
  "function usdg() view returns (address)",
  "function availableReserve() view returns (uint256)",
  "function eligibleInput(address) view returns (bool)",
]);
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const vault = new Interface([
  "function deposited(address) view returns (uint256)",
  "function reserved(address) view returns (uint256)",
  "function available(address) view returns (uint256)",
]);
const MAINNET_SOLANA_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

type RpcResult<T> = { result?: T; error?: { message?: string; code?: number } };
let rpcId = 0;

async function rpc<T>(url: string, method: string, params: unknown[], timeoutMs = 8_000): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`rpc_http_${response.status}`);
  const payload = await response.json() as RpcResult<T>;
  if (payload.error || payload.result === undefined) throw new Error(`rpc_error_${payload.error?.code ?? "invalid"}`);
  return payload.result;
}

/**
 * Robinhood Chain is sequenced: a receipt from the RPC is already ordered by the sequencer, and every
 * payment is still checked field by field (sender, token, amount, recipient, calldata). So instead of
 * waiting ~15 minutes for L1 finality, a block counts as confirmed once it is a few blocks deep.
 */
const CONFIRMATION_BLOCKS = () => BigInt(process.env.CREDIT_CONFIRMATION_BLOCKS ?? "3");

async function confirmedBlock(url: string): Promise<{ number?: string }> {
  const latest = BigInt(await rpc<string>(url, "eth_blockNumber", []));
  const depth = CONFIRMATION_BLOCKS();
  return { number: `0x${(latest > depth ? latest - depth : 0n).toString(16)}` };
}

/** Block used for contract state reads: the confirmed block described above. */
async function stateAnchorBlock(url: string): Promise<{ number?: string }> {
  return confirmedBlock(url);
}

async function evmChainId(url: string): Promise<number> {
  const chainHex = await rpc<string>(url, "eth_chainId", []);
  return Number(BigInt(chainHex));
}

export type AccountChainState = {
  blockNumber: string;
  balanceCredits: string;
  depositedCredits: string;
  reservedCredits: string;
  availableCredits: string;
};

export type VaultAccountUnits = { deposited: bigint; reserved: bigint; available: bigint };

export async function getRobinhoodVaultStateAtBlock(
  config: CreditConfiguration,
  walletAddress: string,
  blockNumber: string,
): Promise<VaultAccountUnits> {
  const url = config.robinhoodRpcUrl;
  const vaultAddress = config.addresses.vaultAddress;
  if (!url || !vaultAddress || !isEvmAddress(walletAddress) || !/^\d+$/.test(blockNumber) ||
      await evmChainId(url) !== 4663) throw new Error("robinhood_vault_state_not_configured");
  const blockTag = `0x${BigInt(blockNumber).toString(16)}`;
  const call = async (method: string) => rpc<string>(url, "eth_call", [
    { to: vaultAddress, data: vault.encodeFunctionData(method, [walletAddress]) },
    blockTag,
  ]);
  const [depositedRaw, reservedRaw, availableRaw] = await Promise.all([
    call("deposited"), call("reserved"), call("available"),
  ]);
  const state = { deposited: BigInt(depositedRaw), reserved: BigInt(reservedRaw), available: BigInt(availableRaw) };
  if (state.reserved > state.deposited || state.available > state.deposited ||
      state.available !== state.deposited - state.reserved) throw new Error("vault_credit_accounting_mismatch");
  return state;
}

export async function getRobinhoodCreditAccount(
  config: CreditConfiguration,
  walletAddress: string,
): Promise<AccountChainState> {
  const url = config.robinhoodRpcUrl;
  const token = config.addresses.creditTokenAddress;
  const vaultAddress = config.addresses.vaultAddress;
  if (!url || !token || !vaultAddress || !isEvmAddress(walletAddress)) throw new Error("robinhood_credit_account_not_configured");
  if (await evmChainId(url) !== 4663) throw new Error("robinhood_rpc_wrong_chain");
  const block = await stateAnchorBlock(url);
  if (!block.number) throw new Error("robinhood_finalized_block_unavailable");
  const blockTag = block.number;
  const call = async (to: string, data: string) => rpc<string>(url, "eth_call", [{ to, data }, blockTag]);
  const [balanceRaw, depositedRaw, reservedRaw, availableRaw] = await Promise.all([
    call(token, erc20.encodeFunctionData("balanceOf", [walletAddress])),
    call(vaultAddress, vault.encodeFunctionData("deposited", [walletAddress])),
    call(vaultAddress, vault.encodeFunctionData("reserved", [walletAddress])),
    call(vaultAddress, vault.encodeFunctionData("available", [walletAddress])),
  ]);
  const balance = BigInt(balanceRaw);
  const deposited = BigInt(depositedRaw);
  const reserved = BigInt(reservedRaw);
  const available = BigInt(availableRaw);
  if (reserved > deposited || available > deposited || available !== deposited - reserved) throw new Error("vault_credit_accounting_mismatch");
  const unit = 10n ** 18n;
  const format = (value: bigint) => {
    const whole = value / unit;
    const fraction = (value % unit).toString().padStart(18, "0").replace(/0+$/, "");
    return fraction ? `${whole}.${fraction}` : whole.toString();
  };
  return {
    blockNumber: BigInt(blockTag).toString(),
    balanceCredits: format(balance),
    depositedCredits: format(deposited),
    reservedCredits: format(reserved),
    availableCredits: format(available),
  };
}

export async function getFinalizedErc20Balance(
  config: CreditConfiguration,
  tokenAddress: string,
  walletAddress: string,
): Promise<bigint> {
  const url = config.robinhoodRpcUrl;
  if (!url || !isEvmAddress(tokenAddress) || !isEvmAddress(walletAddress) || await evmChainId(url) !== 4663) {
    throw new Error("robinhood_token_balance_not_configured");
  }
  const block = await stateAnchorBlock(url);
  if (!block.number) throw new Error("robinhood_finalized_block_unavailable");
  const result = await rpc<string>(url, "eth_call", [
    { to: tokenAddress, data: erc20.encodeFunctionData("balanceOf", [walletAddress]) },
    block.number,
  ]);
  return BigInt(result);
}

export async function getFinalizedNativeBalance(config: CreditConfiguration, walletAddress: string): Promise<bigint> {
  const url = config.robinhoodRpcUrl;
  if (!url || !isEvmAddress(walletAddress) || await evmChainId(url) !== 4663) throw new Error("robinhood_native_balance_not_configured");
  const block = await stateAnchorBlock(url);
  if (!block.number) throw new Error("robinhood_finalized_block_unavailable");
  return BigInt(await rpc<string>(url, "eth_getBalance", [walletAddress, block.number]));
}

export async function hasFinalizedRobinhoodContract(
  config: CreditConfiguration,
  contractAddress: string,
): Promise<boolean> {
  const url = config.robinhoodRpcUrl;
  if (!url || !isEvmAddress(contractAddress) || await evmChainId(url) !== 4663) {
    throw new Error("robinhood_contract_code_not_configured");
  }
  const block = await stateAnchorBlock(url);
  if (!block.number) throw new Error("robinhood_finalized_block_unavailable");
  const code = await rpc<string>(url, "eth_getCode", [contractAddress, block.number]);
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(code)) throw new Error("robinhood_contract_code_invalid");
  return code.length > 2;
}

export type FinalizedRedeemerState = {
  quoteSigner: string;
  creditToken: string;
  usdgToken: string;
  reserve: bigint;
};

export async function getFinalizedRedeemerState(
  config: CreditConfiguration,
): Promise<FinalizedRedeemerState> {
  const url = config.robinhoodRpcUrl;
  const redeemerAddress = config.addresses.redeemAddress;
  if (!url || !redeemerAddress || await evmChainId(url) !== 4663) {
    throw new Error("robinhood_redeemer_not_configured");
  }
  const block = await stateAnchorBlock(url);
  if (!block.number) throw new Error("robinhood_finalized_block_unavailable");
  const code = await rpc<string>(url, "eth_getCode", [redeemerAddress, block.number]);
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(code) || code.length <= 2) {
    throw new Error("credit_redeemer_not_deployed");
  }
  const call = async (method: string) => rpc<string>(url, "eth_call", [
    { to: redeemerAddress, data: contractReaders.encodeFunctionData(method) },
    block.number,
  ]);
  const [quoteSignerRaw, creditRaw, usdgRaw, reserveRaw] = await Promise.all([
    call("quoteSigner"), call("credit"), call("usdg"), call("availableReserve"),
  ]);
  const quoteSigner = String(contractReaders.decodeFunctionResult("quoteSigner", quoteSignerRaw)[0]);
  const creditToken = String(contractReaders.decodeFunctionResult("credit", creditRaw)[0]);
  const usdgToken = String(contractReaders.decodeFunctionResult("usdg", usdgRaw)[0]);
  const reserve = BigInt(contractReaders.decodeFunctionResult("availableReserve", reserveRaw)[0]);
  if (!isEvmAddress(quoteSigner) || /^0x0{40}$/i.test(quoteSigner) ||
      !isEvmAddress(creditToken) || !isEvmAddress(usdgToken)) {
    throw new Error("credit_redeemer_immutable_configuration_invalid");
  }
  return { quoteSigner, creditToken, usdgToken, reserve };
}

export async function getFinalizedQuoteSigner(
  config: CreditConfiguration,
  contractAddress: string,
): Promise<string> {
  const url = config.robinhoodRpcUrl;
  if (!url || !isEvmAddress(contractAddress) || await evmChainId(url) !== 4663) {
    throw new Error("robinhood_quote_contract_not_configured");
  }
  const block = await stateAnchorBlock(url);
  if (!block.number) throw new Error("robinhood_finalized_block_unavailable");
  const code = await rpc<string>(url, "eth_getCode", [contractAddress, block.number]);
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(code) || code.length <= 2) {
    throw new Error("robinhood_quote_contract_not_deployed");
  }
  const result = await rpc<string>(url, "eth_call", [
    { to: contractAddress, data: contractReaders.encodeFunctionData("quoteSigner") },
    block.number,
  ]);
  const signer = String(contractReaders.decodeFunctionResult("quoteSigner", result)[0]);
  if (!isEvmAddress(signer) || /^0x0{40}$/i.test(signer)) throw new Error("robinhood_quote_signer_invalid");
  return signer;
}

export async function isFinalizedPurchaseInputEligible(
  config: CreditConfiguration,
  contractAddress: string,
  inputTokenAddress: string,
): Promise<boolean> {
  const url = config.robinhoodRpcUrl;
  if (!url || !isEvmAddress(contractAddress) || !isEvmAddress(inputTokenAddress) ||
      await evmChainId(url) !== 4663) throw new Error("robinhood_purchase_input_not_configured");
  const block = await stateAnchorBlock(url);
  if (!block.number) throw new Error("robinhood_finalized_block_unavailable");
  const result = await rpc<string>(url, "eth_call", [{
    to: contractAddress,
    data: contractReaders.encodeFunctionData("eligibleInput", [inputTokenAddress]),
  }, block.number]);
  return Boolean(contractReaders.decodeFunctionResult("eligibleInput", result)[0]);
}

export async function getFinalizedSolanaAssetBalance(args: {
  config: CreditConfiguration;
  tokenAddress: string;
  walletAddress: string;
}): Promise<bigint> {
  const url = args.config.solanaRpcUrl;
  if (!url || await rpc<string>(url, "getGenesisHash", []) !== MAINNET_SOLANA_GENESIS_HASH) {
    throw new Error("solana_rpc_wrong_cluster");
  }
  if (args.tokenAddress === "native") {
    const result = await rpc<{ value?: number }>(url, "getBalance", [args.walletAddress, { commitment: "finalized" }]);
    if (!Number.isSafeInteger(result.value) || result.value! < 0) throw new Error("solana_balance_invalid");
    return BigInt(result.value!);
  }
  const result = await rpc<{
    value?: Array<{ account?: { data?: { parsed?: { info?: { tokenAmount?: { amount?: string } } } } } }>;
  }>(url, "getTokenAccountsByOwner", [
    args.walletAddress, { mint: args.tokenAddress }, { commitment: "finalized", encoding: "jsonParsed" },
  ]);
  return (result.value ?? []).reduce((sum, account) => {
    const amount = account.account?.data?.parsed?.info?.tokenAmount?.amount;
    return typeof amount === "string" && /^\d+$/.test(amount) ? sum + BigInt(amount) : sum;
  }, 0n);
}

export async function verifyFinalizedErc20Transfer(args: {
  config: CreditConfiguration;
  txHash: string;
  tokenAddress: string;
  from: string;
  to: string;
  amount: string;
  transactionSender?: string;
}): Promise<{ finalized: boolean; blockNumber: string | null }> {
  const url = args.config.robinhoodRpcUrl;
  if (!url || await evmChainId(url) !== 4663) throw new Error("robinhood_rpc_wrong_chain");
  const [receipt, transaction, finalized] = await Promise.all([
    rpc<{
      status?: string; blockNumber?: string;
      logs?: Array<{ address?: string; topics?: string[]; data?: string }>;
    } | null>(url, "eth_getTransactionReceipt", [args.txHash]),
    rpc<{ from?: string } | null>(url, "eth_getTransactionByHash", [args.txHash]),
    confirmedBlock(url),
  ]);
  if (!receipt || !transaction) return { finalized: false, blockNumber: null };
  if (receipt.status !== "0x1" || !receipt.blockNumber) throw new Error("settlement_transaction_failed");
  // Our own signer's mint is verified field by field below, so it counts as soon as it is mined; no extra depth wait.
  if (!args.transactionSender && (!finalized.number || BigInt(receipt.blockNumber) > BigInt(finalized.number))) return { finalized: false, blockNumber: null };
  if (args.transactionSender && transaction.from?.toLowerCase() !== args.transactionSender.toLowerCase()) {
    throw new Error("settlement_signer_mismatch");
  }
  const value = (receipt.logs ?? []).reduce((sum, log) => {
    if (log.address?.toLowerCase() !== args.tokenAddress.toLowerCase()) return sum;
    try {
      const parsed = erc20.parseLog({ topics: log.topics ?? [], data: log.data ?? "0x" });
      return parsed?.name === "Transfer" &&
        String(parsed.args.from).toLowerCase() === args.from.toLowerCase() &&
        String(parsed.args.to).toLowerCase() === args.to.toLowerCase()
        ? sum + BigInt(parsed.args.value)
        : sum;
    } catch { return sum; }
  }, 0n);
  if (value !== BigInt(args.amount)) throw new Error("settlement_exact_transfer_not_found");
  if (args.from.toLowerCase() === ZERO_ADDRESS && !receipt.logs?.some((log) => {
    if (log.address?.toLowerCase() !== args.tokenAddress.toLowerCase()) return false;
    try {
      const parsed = erc20.parseLog({ topics: log.topics ?? [], data: log.data ?? "0x" });
      return parsed?.name === "Transfer" &&
        String(parsed.args.from).toLowerCase() === ZERO_ADDRESS &&
        String(parsed.args.to).toLowerCase() === args.to.toLowerCase() &&
        BigInt(parsed.args.value) === BigInt(args.amount);
    } catch { return false; }
  })) throw new Error("credit_mint_event_not_found");
  return { finalized: true, blockNumber: BigInt(receipt.blockNumber).toString() };
}

export type EvmExpectedTransaction = {
  expectedTo: string;
  expectedValue: string;
  expectedCalldata: string | null;
  expectedToken: string | null;
  expectedRecipient: string | null;
  expectedTokenAmount: string | null;
  atomicPurchase?: {
    purchaseAddress: string;
    user: string;
    inputToken: string;
    inputAmount: string;
    creditToken: string;
    creditAmount: string;
    nonce: string;
  };
  atomicRedemption?: {
    redeemAddress: string;
    user: string;
    creditToken: string;
    creditAmount: string;
    usdgToken: string;
    usdgAmount: string;
    quoteId: string;
    actionId: string;
  };
};

export async function verifyFinalizedRobinhoodTransaction(
  config: CreditConfiguration,
  args: { txHash: string; sender: string; expected: EvmExpectedTransaction; expectedTransfers: ExpectedTransfer[] },
): Promise<{ finalized: true; blockNumber: string; confirmedAtMs: number | null } | { finalized: false; blockNumber: null; confirmedAtMs: null }> {
  const url = config.robinhoodRpcUrl;
  if (!url || await evmChainId(url) !== 4663) throw new Error("robinhood_rpc_wrong_chain");
  const [receipt, transaction, finalizedBlock] = await Promise.all([
    rpc<{
      status?: string; blockNumber?: string;
      logs?: Array<{ address?: string; topics?: string[]; data?: string }>;
    } | null>(url, "eth_getTransactionReceipt", [args.txHash]),
    rpc<{
      from?: string; to?: string | null; input?: string; value?: string;
    } | null>(url, "eth_getTransactionByHash", [args.txHash]),
    confirmedBlock(url),
  ]);
  if (!receipt || !transaction || !receipt.blockNumber) return { finalized: false, blockNumber: null, confirmedAtMs: null };
  if (receipt.status !== "0x1") throw new Error("transaction_failed");
  if (!finalizedBlock.number || BigInt(receipt.blockNumber) > BigInt(finalizedBlock.number)) return { finalized: false, blockNumber: null, confirmedAtMs: null };
  const block = await rpc<{ timestamp?: string }>(url, "eth_getBlockByNumber", [receipt.blockNumber, false]);
  const confirmedAtMs = block.timestamp ? Number(BigInt(block.timestamp) * 1000n) : null;
  if (transaction.from?.toLowerCase() !== args.sender.toLowerCase() ||
      transaction.to?.toLowerCase() !== args.expected.expectedTo.toLowerCase() ||
      BigInt(transaction.value ?? "0x0") !== BigInt(args.expected.expectedValue)) {
    throw new Error("transaction_sender_recipient_or_value_mismatch");
  }
  if (args.expected.expectedCalldata && transaction.input?.toLowerCase() !== args.expected.expectedCalldata.toLowerCase()) {
    throw new Error("transaction_calldata_mismatch");
  }
  if (args.expected.expectedToken !== "native" &&
      (args.expected.expectedToken || args.expected.expectedRecipient || args.expected.expectedTokenAmount)) {
    if (!args.expected.expectedToken || !args.expected.expectedRecipient || !args.expected.expectedTokenAmount) throw new Error("quote_transfer_expectation_incomplete");
    const expectedAmount = BigInt(args.expected.expectedTokenAmount);
    const matchingTransfer = (receipt.logs ?? []).some((log) => {
      if (log.address?.toLowerCase() !== args.expected.expectedToken!.toLowerCase()) return false;
      try {
        const parsed = erc20.parseLog({ topics: log.topics ?? [], data: log.data ?? "0x" });
        return parsed?.name === "Transfer" &&
          String(parsed.args.to).toLowerCase() === args.expected.expectedRecipient!.toLowerCase() &&
          BigInt(parsed.args.value) === expectedAmount;
      } catch { return false; }
    });
    if (!matchingTransfer) throw new Error("expected_exact_token_transfer_not_found");
  }
  for (const transfer of args.expectedTransfers) {
    if (transfer.tokenAddress === "native") {
      const nativeReceived = transaction.from?.toLowerCase() === transfer.from.toLowerCase() &&
        transaction.to?.toLowerCase() === transfer.to.toLowerCase() ? BigInt(transaction.value ?? "0x0") : 0n;
      if (nativeReceived !== BigInt(transfer.amount)) throw new Error("expected_exact_native_transfer_not_found");
      continue;
    }
    const received = (receipt.logs ?? []).reduce((sum, log) => {
      if (log.address?.toLowerCase() !== transfer.tokenAddress.toLowerCase()) return sum;
      try {
        const parsed = erc20.parseLog({ topics: log.topics ?? [], data: log.data ?? "0x" });
        return parsed?.name === "Transfer" &&
          String(parsed.args.from).toLowerCase() === transfer.from.toLowerCase() &&
          String(parsed.args.to).toLowerCase() === transfer.to.toLowerCase()
          ? sum + BigInt(parsed.args.value)
          : sum;
      } catch { return sum; }
    }, 0n);
    // A swap's output to the treasury is a guaranteed minimum (amountOutMinimum); the pool may deliver more.
    const isSwapOutputToTreasury = Boolean(config.addresses.treasuryAddress) &&
      transfer.to.toLowerCase() === config.addresses.treasuryAddress!.toLowerCase() &&
      transfer.from.toLowerCase() !== args.sender.toLowerCase() &&
      args.expectedTransfers.some((other) => other.from.toLowerCase() === args.sender.toLowerCase() && other.to.toLowerCase() === transfer.from.toLowerCase());
    if (isSwapOutputToTreasury ? received < BigInt(transfer.amount) : received !== BigInt(transfer.amount)) {
      throw new Error("expected_exact_token_transfer_not_found");
    }
  }
  if (args.expected.atomicPurchase) {
    const purchase = args.expected.atomicPurchase;
    const purchaseLogs = (receipt.logs ?? []).filter((log) =>
      log.address?.toLowerCase() === purchase.purchaseAddress.toLowerCase(),
    );
    const settled = purchaseLogs.flatMap((log) => {
      try {
        const parsed = purchaseEvents.parseLog({ topics: log.topics ?? [], data: log.data ?? "0x" });
        return parsed?.name === "QuoteSettled" ? [parsed] : [];
      } catch { return []; }
    });
    if (settled.length !== 1 ||
        String(settled[0]!.args.user).toLowerCase() !== purchase.user.toLowerCase() ||
        String(settled[0]!.args.inputToken).toLowerCase() !== purchase.inputToken.toLowerCase() ||
        BigInt(settled[0]!.args.inputAmount) !== BigInt(purchase.inputAmount) ||
        BigInt(settled[0]!.args.credits) !== BigInt(purchase.creditAmount) ||
        BigInt(settled[0]!.args.nonce) !== BigInt(purchase.nonce)) {
      throw new Error("atomic_purchase_event_mismatch");
    }
    const mintAmount = BigInt(purchase.creditAmount);
    const minted = (receipt.logs ?? []).filter((log) => {
      if (log.address?.toLowerCase() !== purchase.creditToken.toLowerCase()) return false;
      try {
        const parsed = erc20.parseLog({ topics: log.topics ?? [], data: log.data ?? "0x" });
        return parsed?.name === "Transfer" &&
          String(parsed.args.from).toLowerCase() === ZERO_ADDRESS &&
          String(parsed.args.to).toLowerCase() === purchase.user.toLowerCase() &&
          BigInt(parsed.args.value) === mintAmount;
      } catch { return false; }
    });
    if (minted.length !== 1) throw new Error("atomic_purchase_credit_mint_not_found");
  }
  if (args.expected.atomicRedemption) {
    const redemption = args.expected.atomicRedemption;
    const events = (receipt.logs ?? []).flatMap((log) => {
      if (log.address?.toLowerCase() !== redemption.redeemAddress.toLowerCase()) return [];
      try {
        const parsed = redemptionEvents.parseLog({ topics: log.topics ?? [], data: log.data ?? "0x" });
        return parsed?.name === "Redeemed" ? [parsed] : [];
      } catch { return []; }
    });
    if (events.length !== 1 ||
        String(events[0]!.args.wallet).toLowerCase() !== redemption.user.toLowerCase() ||
        String(events[0]!.args.quoteId).toLowerCase() !== redemption.quoteId.toLowerCase() ||
        String(events[0]!.args.actionId).toLowerCase() !== redemption.actionId.toLowerCase() ||
        BigInt(events[0]!.args.creditAmount) !== BigInt(redemption.creditAmount) ||
        BigInt(events[0]!.args.usdgAmount) !== BigInt(redemption.usdgAmount)) {
      throw new Error("atomic_redemption_event_mismatch");
    }
  }
  return { finalized: true, blockNumber: BigInt(receipt.blockNumber).toString(), confirmedAtMs };
}

export type SolanaExpectedTransaction = {
  expectedToken: string;
  expectedRecipient: string;
  expectedTokenAmount: string;
};

export type PreparedSolanaMessage = {
  payer: string;
  recentBlockhash: string;
  requiredSigners: string[];
  accountKeys: string[];
  instructions: Array<{ programIdIndex: number; accountIndexes: number[]; dataBase58: string; data: string }>;
};

function accountKeyText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "pubkey" in value && typeof value.pubkey === "string") return value.pubkey;
  return undefined;
}

export async function verifyFinalizedSolanaTransaction(
  config: CreditConfiguration,
  args: {
    txHash: string;
    sender: string;
    expected: SolanaExpectedTransaction;
    expectedTransfers: ExpectedTransfer[];
    preparedMessage: PreparedSolanaMessage;
  },
): Promise<{ finalized: true; slot: string; confirmedAtMs: number | null } | { finalized: false; slot: null; confirmedAtMs: null }> {
  const url = config.solanaRpcUrl;
  if (!url || await rpc<string>(url, "getGenesisHash", []) !== MAINNET_SOLANA_GENESIS_HASH) throw new Error("solana_rpc_wrong_cluster");
  const transaction = await rpc<{
    slot?: number;
    blockTime?: number | null;
    meta?: {
      err?: unknown;
      preTokenBalances?: Array<{ accountIndex?: number; mint?: string; owner?: string; uiTokenAmount?: { amount?: string } }>;
      postTokenBalances?: Array<{ accountIndex?: number; mint?: string; owner?: string; uiTokenAmount?: { amount?: string } }>;
      loadedAddresses?: { writable?: string[]; readonly?: string[] };
    } | null;
    transaction?: { message?: {
      header?: { numRequiredSignatures?: number };
      accountKeys?: unknown[];
      recentBlockhash?: string;
      instructions?: Array<{ programIdIndex?: number; accounts?: number[]; data?: string }>;
    } };
  } | null>(url, "getTransaction", [args.txHash, { commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 0 }]);
  if (!transaction) return { finalized: false, slot: null, confirmedAtMs: null };
  if (transaction.meta?.err) throw new Error("transaction_failed");
  if (transaction.slot === undefined) return { finalized: false, slot: null, confirmedAtMs: null };
  if (!transaction.meta) throw new Error("solana_transaction_metadata_missing");
  const message = transaction.transaction?.message;
  const staticKeys = message?.accountKeys?.map(accountKeyText) ?? [];
  const keys = [
    ...staticKeys,
    ...(transaction.meta?.loadedAddresses?.writable ?? []),
    ...(transaction.meta?.loadedAddresses?.readonly ?? []),
  ];
  if (!message || message.header?.numRequiredSignatures !== 1 ||
      keys[0] !== args.sender || args.preparedMessage.payer !== args.sender ||
      message.recentBlockhash !== args.preparedMessage.recentBlockhash ||
      keys.length !== args.preparedMessage.accountKeys.length ||
      keys.some((key, index) => key !== args.preparedMessage.accountKeys[index])) {
    throw new Error("transaction_sender_mismatch");
  }
  const actualInstructions = message.instructions ?? [];
  if (actualInstructions.length !== args.preparedMessage.instructions.length ||
      actualInstructions.some((instruction, index) => {
        const expected = args.preparedMessage.instructions[index]!;
        return instruction.programIdIndex !== expected.programIdIndex ||
          instruction.data !== expected.dataBase58 ||
          !instruction.accounts || instruction.accounts.length !== expected.accountIndexes.length ||
          instruction.accounts.some((accountIndex, accountIndexPosition) =>
            accountIndex !== expected.accountIndexes[accountIndexPosition],
          );
      })) throw new Error("solana_signed_message_differs_from_prepared_quote");
  for (const transfer of args.expectedTransfers) {
    if (transfer.tokenAddress === "native") {
      if (!args.preparedMessage.instructions.some((instruction) => {
        const program = args.preparedMessage.accountKeys[instruction.programIdIndex];
        const accounts = instruction.accountIndexes.map((index) => args.preparedMessage.accountKeys[index]);
        if (program !== "11111111111111111111111111111111" || accounts[0] !== transfer.from || accounts[1] !== transfer.to) return false;
        const data = Buffer.from(instruction.data, "base64");
        return data.length === 12 && data.readUInt32LE(0) === 2 &&
          data.readBigUInt64LE(4) === BigInt(transfer.amount);
      })) {
        // Exact system-transfer amount and memo were decoded while the quote was
        // prepared; the signed message must match those exact compiled bytes.
        throw new Error("expected_exact_native_transfer_not_found");
      }
      continue;
    }
    const pre = transaction.meta.preTokenBalances ?? [];
    const post = transaction.meta.postTokenBalances ?? [];
    const sourceAccountIndex = transfer.sourceAccount ? keys.indexOf(transfer.sourceAccount) : -1;
    const destinationAccountIndex = transfer.destinationAccount ? keys.indexOf(transfer.destinationAccount) : -1;
    if ((transfer.sourceAccount && sourceAccountIndex < 0) || (transfer.destinationAccount && destinationAccountIndex < 0)) {
      throw new Error("solana_transfer_account_not_in_signed_message");
    }
    const indices = new Set([...pre, ...post].filter((balance) => balance.mint === transfer.tokenAddress).map((balance) => balance.accountIndex));
    let senderDebit = 0n;
    let recipientCredit = 0n;
    for (const index of indices) {
      const before = pre.find((balance) => balance.accountIndex === index && balance.mint === transfer.tokenAddress);
      const after = post.find((balance) => balance.accountIndex === index && balance.mint === transfer.tokenAddress);
      const beforeAmount = BigInt(before?.uiTokenAmount?.amount ?? "0");
      const afterAmount = BigInt(after?.uiTokenAmount?.amount ?? "0");
      if (before?.owner === transfer.from && (sourceAccountIndex < 0 || index === sourceAccountIndex)) {
        senderDebit += beforeAmount > afterAmount ? beforeAmount - afterAmount : 0n;
      }
      if (after?.owner === transfer.to && (destinationAccountIndex < 0 || index === destinationAccountIndex)) {
        recipientCredit += afterAmount > beforeAmount ? afterAmount - beforeAmount : 0n;
      }
    }
    const expected = BigInt(transfer.amount);
    if (senderDebit !== expected || recipientCredit !== expected) throw new Error("expected_exact_token_transfer_not_found");
  }
  return {
    finalized: true,
    slot: String(transaction.slot),
    confirmedAtMs: Number.isSafeInteger(transaction.blockTime) ? Number(transaction.blockTime) * 1000 : null,
  };
}

export async function verifyFinalizedTransaction(
  config: CreditConfiguration,
  chain: CreditChain,
  details: {
    txHash: string;
    sender: string;
    expectedTo: string;
    expectedValue: string;
    expectedCalldata: string | null;
    expectedToken: string | null;
    expectedRecipient: string | null;
    expectedTokenAmount: string | null;
    expectedTransfers: ExpectedTransfer[];
    preparedMessage?: PreparedSolanaMessage;
    atomicPurchase?: EvmExpectedTransaction["atomicPurchase"];
    atomicRedemption?: EvmExpectedTransaction["atomicRedemption"];
  },
): Promise<{ finalized: boolean; blockNumber?: string | null; slot?: string | null; confirmedAtMs: number | null }> {
  if (chain === "robinhood") return verifyFinalizedRobinhoodTransaction(config, {
    txHash: details.txHash,
    sender: details.sender,
    expected: details,
    expectedTransfers: details.expectedTransfers,
  });
  if (!isSolanaAddress(details.sender) || !details.expectedToken || !details.expectedRecipient ||
      !details.expectedTokenAmount || !details.preparedMessage) {
    throw new Error("solana_quote_transfer_expectation_incomplete");
  }
  return verifyFinalizedSolanaTransaction(config, {
    txHash: details.txHash,
    sender: details.sender,
    expected: { expectedToken: details.expectedToken, expectedRecipient: details.expectedRecipient, expectedTokenAmount: details.expectedTokenAmount },
    expectedTransfers: details.expectedTransfers,
    preparedMessage: details.preparedMessage!,
  });
}