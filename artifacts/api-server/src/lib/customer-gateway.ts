import {
  Contract,
  Interface,
  JsonRpcProvider,
  NonceManager,
  Wallet,
  ZeroAddress,
  getAddress,
  isAddress,
  isHexString,
} from "ethers";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { exactRequestEventMatches, receiptIsFinalized } from "./customer-recovery-policy";

const CREDIT_SUBUNITS_PER_MICROCREDIT = 1_000_000_000_000n;
const VAULT_ABI = [
  "function credit() view returns (address)",
  "function reservation(bytes32 requestId) view returns (address account, uint256 amount, uint8 status)",
  "function deposited(address account) view returns (uint256)",
  "function reserved(address account) view returns (uint256)",
  "function available(address account) view returns (uint256)",
  "function reserve(address account, bytes32 requestId, uint256 amount)",
  "function settle(bytes32 requestId, uint256 actualAmount)",
  "function release(bytes32 requestId)",
  "event Reserved(address indexed account, bytes32 indexed requestId, uint256 amount)",
  "event Settled(address indexed account, bytes32 indexed requestId, uint256 actualAmount, uint256 releasedAmount)",
  "event Released(address indexed account, bytes32 indexed requestId, uint256 amount)",
];
const CREDIT_ABI = ["event Transfer(address indexed from, address indexed to, uint256 amount)"];
const vaultInterface = new Interface(VAULT_ABI);
const creditInterface = new Interface(CREDIT_ABI);
const vaultEvents = ["Reserved", "Settled", "Released"].map(
  (name) => vaultInterface.getEvent(name)!.topicHash,
);
const SETTLEMENT_FINALITY_TIMEOUT_MS = 5 * 60_000;
const FINALITY_POLL_INTERVAL_MS = 2_000;

export type GatewaySnapshot = {
  deposited: bigint;
  reserved: bigint;
  available: bigint;
};

export type ReservationEvidence = {
  account: string;
  amount: bigint;
  status: "none" | "reserved" | "settled" | "released";
  actualAmount?: bigint;
  releasedAmount?: bigint;
  transactionHash?: string;
  transactionPending?: boolean;
  snapshot?: GatewaySnapshot;
};

export class CustomerGatewayError extends Error {
  constructor(readonly code: "unconfigured" | "insufficient" | "failed" | "unknown") {
    super(code);
  }
}

type GatewayConfig = {
  rpcUrl: string;
  signerKey: string;
  vaultAddress: string;
  creditAddress: string;
  deploymentBlock: number;
  chainId: bigint;
};

type TxSubmissionHook = (transactionHash: string) => Promise<void>;

function configuredGateway(): GatewayConfig | undefined {
  const rpcUrl = process.env.CUSTOMER_GATEWAY_RPC_URL ?? process.env.ROBINHOOD_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
  // Defaults to the deployed vault gateway operator key unless a dedicated key is configured.
  const signerKey = process.env.CUSTOMER_GATEWAY_SIGNER_PRIVATE_KEY ?? process.env.CASHBACK_PRIVATE_KEY;
  const vaultAddress = process.env.CUSTOMER_GATEWAY_VAULT_ADDRESS ?? process.env.CREDIT_VAULT_ADDRESS;
  const creditAddress = process.env.CREDIT_TOKEN_ADDRESS;
  const chainId = process.env.CUSTOMER_GATEWAY_CHAIN_ID ?? process.env.CREDIT_CHAIN_ID;
  const deploymentBlock = Number(process.env.CUSTOMER_GATEWAY_VAULT_DEPLOYMENT_BLOCK);
  const enabled = process.env.CUSTOMER_GATEWAY_ENABLED === "true" || process.env.CREDIT_GATEWAY_ENABLED === "true";
  const dailyBudget = process.env.CUSTOMER_DAILY_BUDGET_CREDITS;
  const userRpm = process.env.CUSTOMER_USER_RPM;
  const keyRpm = process.env.CUSTOMER_KEY_RPM;
  const hasPositiveDailyBudget = typeof dailyBudget === "string" &&
    /^\d+(?:\.\d{1,6})?$/.test(dailyBudget) &&
    /[1-9]/.test(dailyBudget);
  const hasSafeRateLimits = [userRpm, keyRpm].every((value) =>
    typeof value === "string" && /^\d{1,4}$/.test(value) &&
    Number(value) >= 1 && Number(value) <= 1000,
  );
  if (!enabled || !rpcUrl || !signerKey ||
      !vaultAddress || !isAddress(vaultAddress) ||
      !creditAddress || !isAddress(creditAddress) ||
      !Number.isSafeInteger(deploymentBlock) || deploymentBlock < 0 ||
      !chainId || chainId !== "4663" ||
      !/^0x[0-9a-fA-F]{64}$/.test(signerKey) || !hasPositiveDailyBudget || !hasSafeRateLimits) return undefined;
  try {
    new URL(rpcUrl);
    getAddress(vaultAddress);
    getAddress(creditAddress);
  } catch {
    return undefined;
  }
  return {
    rpcUrl,
    signerKey,
    vaultAddress: getAddress(vaultAddress),
    creditAddress: getAddress(creditAddress),
    deploymentBlock,
    chainId: 4663n,
  };
}

export function isCustomerGatewayConfigured(): boolean {
  return Boolean(configuredGateway());
}

function createVault(config: GatewayConfig) {
  const provider = new JsonRpcProvider(config.rpcUrl);
  const signer = new NonceManager(new Wallet(config.signerKey, provider));
  const vault = new Contract(config.vaultAddress, VAULT_ABI, signer);
  return { provider, vault };
}

async function withSignerQueue<T>(work: () => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(5496434245349)`);
    return work();
  });
}

function subunits(microcredits: bigint): bigint {
  if (microcredits <= 0n) throw new CustomerGatewayError("unknown");
  return microcredits * CREDIT_SUBUNITS_PER_MICROCREDIT;
}

export function vaultUnitsToCreditsDecimal(baseUnits: bigint): string {
  if (baseUnits < 0n) throw new CustomerGatewayError("unknown");
  const scale = 10n ** 18n;
  const whole = baseUnits / scale;
  const fraction = (baseUnits % scale).toString().padStart(18, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

async function assertGateway(provider: JsonRpcProvider, vault: Contract, config: GatewayConfig): Promise<void> {
  const network = await provider.getNetwork();
  if (network.chainId !== config.chainId) throw new CustomerGatewayError("unconfigured");
  const finalizedBlock = await latestFinalizedBlock(provider);
  const [vaultCode, tokenCode, configuredCredit] = await Promise.all([
    provider.getCode(config.vaultAddress, finalizedBlock),
    provider.getCode(config.creditAddress, finalizedBlock),
    vault.getFunction("credit").staticCall({ blockTag: finalizedBlock }) as Promise<string>,
  ]);
  if (vaultCode === "0x" || tokenCode === "0x" ||
      getAddress(configuredCredit) !== config.creditAddress) {
    throw new CustomerGatewayError("unconfigured");
  }
}

/**
 * Newest block treated as settled: the chain head minus a small confirmation depth.
 * Waiting for L1 finality on Robinhood Chain takes ~20 minutes, which would stall every chat reply.
 */
async function latestFinalizedBlock(provider: JsonRpcProvider): Promise<number> {
  const depth = Math.max(1, Number(process.env.CREDIT_CONFIRMATION_BLOCKS ?? 3) || 3);
  const head = await provider.getBlockNumber();
  const number = head - depth;
  if (!Number.isSafeInteger(number) || number < 0) throw new CustomerGatewayError("unknown");
  return number;
}

async function waitUntilFinalized(provider: JsonRpcProvider, blockNumber: number): Promise<void> {
  const deadline = Date.now() + SETTLEMENT_FINALITY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (receiptIsFinalized(blockNumber, await latestFinalizedBlock(provider))) return;
    await new Promise((resolve) => setTimeout(resolve, FINALITY_POLL_INTERVAL_MS));
  }
  throw new CustomerGatewayError("unknown");
}

async function sendAndWaitFinalized(
  provider: JsonRpcProvider,
  transaction: () => Promise<any>,
  onSubmitted?: TxSubmissionHook,
): Promise<{ hash: string; receipt: any; finalizedBlock: number }> {
  let tx: any;
  try {
    // Serialize only nonce selection and RPC broadcast. Waiting for mining and
    // finality must not keep the advisory-lock transaction/DB connection open.
    tx = await withSignerQueue(transaction);
  } catch {
    // A JSON-RPC send error may be returned after the node accepted a
    // transaction but before its hash reached the caller.
    throw new CustomerGatewayError("unknown");
  }
  if (typeof tx?.hash !== "string" || !isHexString(tx.hash, 32)) {
    throw new CustomerGatewayError("unknown");
  }
  try {
    await onSubmitted?.(tx.hash);
  } catch {
    // The caller must not continue to another external operation unless the
    // broadcast transaction identity is durable.
    throw new CustomerGatewayError("unknown");
  }
  let receipt: any;
  try {
    receipt = await tx.wait(1, 120_000);
  } catch {
    const fetched = await provider.getTransactionReceipt(tx.hash).catch(() => null);
    if (!fetched) throw new CustomerGatewayError("unknown");
    receipt = fetched;
  }
  if (!receipt || receipt.status !== 1 || !Number.isSafeInteger(receipt.blockNumber)) {
    throw new CustomerGatewayError(receipt?.status === 0 ? "failed" : "unknown");
  }
  await waitUntilFinalized(provider, receipt.blockNumber);
  const finalizedBlock = await latestFinalizedBlock(provider);
  if (!receiptIsFinalized(receipt.blockNumber, finalizedBlock)) throw new CustomerGatewayError("unknown");
  return { hash: tx.hash, receipt, finalizedBlock };
}

function parsedVaultEvents(logs: readonly any[], requestId: string): any[] {
  const parsed: any[] = [];
  for (const log of logs) {
    try {
      if (!log.topics?.[0] || !vaultEvents.includes(log.topics[0].toLowerCase())) continue;
      const event = vaultInterface.parseLog(log);
      if (event && String(event.args.requestId).toLowerCase() === requestId.toLowerCase()) {
        parsed.push({ log, event });
      }
    } catch {
      // Ignore unrelated logs; matching request logs are validated below.
    }
  }
  return parsed;
}

async function verifyEventReceipt(
  provider: JsonRpcProvider,
  config: GatewayConfig,
  eventLog: any,
  expectedName: "Reserved" | "Settled" | "Released",
): Promise<any> {
  const receipt = await provider.getTransactionReceipt(eventLog.transactionHash);
  if (!receipt || receipt.status !== 1 ||
      receipt.blockNumber !== eventLog.blockNumber ||
      getAddress(receipt.to ?? "") !== config.vaultAddress ||
      !receipt.logs.some((log: any) =>
        log.transactionHash === eventLog.transactionHash &&
        log.index === eventLog.index &&
        log.blockHash === eventLog.blockHash,
      )) {
    throw new CustomerGatewayError("unknown");
  }
  await waitUntilFinalized(provider, receipt.blockNumber);
  const matching = parsedVaultEvents(receipt.logs, String(eventLog.topics[2] ?? ""));
  if (!matching.some(({ log, event }) =>
    log.index === eventLog.index && event.name === expectedName,
  )) throw new CustomerGatewayError("unknown");
  return receipt;
}

async function finalizedEventsForRequest(
  provider: JsonRpcProvider,
  config: GatewayConfig,
  requestId: string,
): Promise<any[]> {
  if (!isHexString(requestId, 32)) throw new CustomerGatewayError("unknown");
  const finalizedBlock = await latestFinalizedBlock(provider);
  if (finalizedBlock < config.deploymentBlock) return [];
  const logs = await provider.getLogs({
    address: config.vaultAddress,
    topics: [vaultEvents, null, requestId],
    fromBlock: config.deploymentBlock,
    toBlock: finalizedBlock,
  }).catch(() => {
    throw new CustomerGatewayError("unknown");
  });
  const events = parsedVaultEvents(logs, requestId);
  for (const item of events) {
    await verifyEventReceipt(provider, config, item.log, item.event.name);
  }
  return events;
}

async function readReservation(
  vault: Contract,
  provider: JsonRpcProvider,
  config: GatewayConfig,
  requestId: string,
  account: string,
): Promise<ReservationEvidence> {
  const finalizedBlock = await latestFinalizedBlock(provider);
  const [rawAccount, rawAmount, rawStatus] = await vault.getFunction("reservation")
    .staticCall(requestId, { blockTag: finalizedBlock }) as [string, bigint, bigint];
  const statusNumber = Number(rawStatus);
  if (![0, 1, 2, 3].includes(statusNumber)) throw new CustomerGatewayError("unknown");
  const events = await finalizedEventsForRequest(provider, config, requestId);
  const reservationEvents = events.filter(({ event }) => event.name === "Reserved");
  const settleEvents = events.filter(({ event }) => event.name === "Settled");
  const releaseEvents = events.filter(({ event }) => event.name === "Released");
  if (statusNumber === 0) {
    if (events.length !== 0 || rawAmount !== 0n || getAddress(rawAccount) !== ZeroAddress) {
      throw new CustomerGatewayError("unknown");
    }
    return { account, amount: 0n, status: "none" };
  }
  if (getAddress(rawAccount) !== account || rawAmount <= 0n || reservationEvents.length !== 1) {
    throw new CustomerGatewayError("unknown");
  }
  const reservedEvent = reservationEvents[0].event;
  if (!exactRequestEventMatches({
    name: reservedEvent.name,
    args: {
      account: getAddress(String(reservedEvent.args.account)),
      requestId: String(reservedEvent.args.requestId),
      amount: BigInt(reservedEvent.args.amount),
    },
  }, { account, requestId, reservedAmount: rawAmount })) throw new CustomerGatewayError("unknown");
  const reserveTxHash = reservationEvents[0].log.transactionHash as string;
  if (statusNumber === 1) {
    if (settleEvents.length || releaseEvents.length) throw new CustomerGatewayError("unknown");
    return {
      account,
      amount: rawAmount,
      status: "reserved",
      transactionHash: reserveTxHash,
      snapshot: await readSnapshot(vault, account, finalizedBlock),
    };
  }
  if (statusNumber === 2) {
    if (settleEvents.length !== 1 || releaseEvents.length) throw new CustomerGatewayError("unknown");
    const { event, log } = settleEvents[0];
    const actualAmount = BigInt(event.args.actualAmount);
    const releasedAmount = BigInt(event.args.releasedAmount);
    if (!exactRequestEventMatches({
      name: event.name,
      args: {
        account: getAddress(String(event.args.account)),
        requestId: String(event.args.requestId),
        actualAmount,
        releasedAmount,
      },
    }, { account, requestId, reservedAmount: rawAmount })) throw new CustomerGatewayError("unknown");
    await verifyBurnReceipt(provider, config, log.transactionHash, actualAmount);
    return {
      account,
      amount: rawAmount,
      status: "settled",
      actualAmount,
      releasedAmount,
      transactionHash: log.transactionHash,
      snapshot: await readSnapshot(vault, account, finalizedBlock),
    };
  }
  if (settleEvents.length || releaseEvents.length !== 1) throw new CustomerGatewayError("unknown");
  const { event, log } = releaseEvents[0];
  if (!exactRequestEventMatches({
    name: event.name,
    args: {
      account: getAddress(String(event.args.account)),
      requestId: String(event.args.requestId),
      amount: BigInt(event.args.amount),
    },
  }, { account, requestId, reservedAmount: rawAmount })) throw new CustomerGatewayError("unknown");
  return {
    account,
    amount: rawAmount,
    status: "released",
    releasedAmount: rawAmount,
    transactionHash: log.transactionHash,
    snapshot: await readSnapshot(vault, account, finalizedBlock),
  };
}

async function hasPendingKnownTransaction(
  provider: JsonRpcProvider,
  transactionHashes: readonly (string | null)[],
): Promise<boolean> {
  const finalizedBlock = await latestFinalizedBlock(provider);
  for (const hash of transactionHashes) {
    if (!hash || !isHexString(hash, 32)) continue;
    const receipt = await provider.getTransactionReceipt(hash);
    if (receipt) {
      if (!receiptIsFinalized(receipt.blockNumber, finalizedBlock) || receipt.status === 1) return true;
      continue;
    }
    if (await provider.getTransaction(hash)) return true;
  }
  return false;
}

async function readSnapshot(vault: Contract, account: string, blockTag: number): Promise<GatewaySnapshot> {
  const [deposited, reserved, available] = await Promise.all([
    vault.getFunction("deposited").staticCall(account, { blockTag }) as Promise<bigint>,
    vault.getFunction("reserved").staticCall(account, { blockTag }) as Promise<bigint>,
    vault.getFunction("available").staticCall(account, { blockTag }) as Promise<bigint>,
  ]);
  const snapshot = { deposited: BigInt(deposited), reserved: BigInt(reserved), available: BigInt(available) };
  if (snapshot.deposited < 0n || snapshot.reserved < 0n || snapshot.available < 0n ||
      snapshot.reserved > snapshot.deposited ||
      snapshot.available !== snapshot.deposited - snapshot.reserved) {
    throw new CustomerGatewayError("unknown");
  }
  return snapshot;
}

async function verifyBurnReceipt(
  provider: JsonRpcProvider,
  config: GatewayConfig,
  transactionHash: string,
  actualAmount: bigint,
): Promise<void> {
  if (actualAmount === 0n) return;
  const receipt = await provider.getTransactionReceipt(transactionHash);
  if (!receipt || receipt.status !== 1 ||
      getAddress(receipt.to ?? "") !== config.vaultAddress) throw new CustomerGatewayError("unknown");
  await waitUntilFinalized(provider, receipt.blockNumber);
  const burned = receipt.logs.some((log: any) => {
    if (getAddress(log.address) !== config.creditAddress) return false;
    try {
      const event = creditInterface.parseLog(log);
      return event?.name === "Transfer" &&
        getAddress(String(event.args.from)) === config.vaultAddress &&
        getAddress(String(event.args.to)) === ZeroAddress &&
        BigInt(event.args.amount) === actualAmount;
    } catch {
      return false;
    }
  });
  if (!burned) throw new CustomerGatewayError("unknown");
}

async function normalizedAccount(walletAddress: string): Promise<string> {
  try {
    return getAddress(walletAddress);
  } catch {
    throw new CustomerGatewayError("unknown");
  }
}

export async function inspectOnchainReservation(
  walletAddress: string,
  requestId: string,
  knownTransactionHashes: { reserve?: string | null; settle?: string | null; release?: string | null } = {},
): Promise<ReservationEvidence> {
  const config = configuredGateway();
  if (!config) throw new CustomerGatewayError("unconfigured");
  const account = await normalizedAccount(walletAddress);
  const { provider, vault } = createVault(config);
  try {
    await assertGateway(provider, vault, config);
    const evidence = await readReservation(vault, provider, config, requestId, account);
    if (evidence.status === "none") {
      evidence.transactionPending = await hasPendingKnownTransaction(provider, [knownTransactionHashes.reserve ?? null]);
    } else if (evidence.status === "reserved") {
      evidence.transactionPending = await hasPendingKnownTransaction(provider, [
        knownTransactionHashes.settle ?? null,
        knownTransactionHashes.release ?? null,
      ]);
    }
    return evidence;
  } catch (error) {
    if (error instanceof CustomerGatewayError) throw error;
    throw new CustomerGatewayError("unknown");
  } finally {
    await provider.destroy();
  }
}

export async function reserveOnchain(
  walletAddress: string,
  requestId: string,
  microcredits: bigint,
  onSubmitted?: TxSubmissionHook,
): Promise<ReservationEvidence> {
  const config = configuredGateway();
  if (!config) throw new CustomerGatewayError("unconfigured");
  const account = await normalizedAccount(walletAddress);
  const amount = subunits(microcredits);
  const { provider, vault } = createVault(config);
  try {
    await assertGateway(provider, vault, config);
    const current = await readReservation(vault, provider, config, requestId, account);
    if (current.status === "reserved" && current.amount === amount) return current;
    if (current.status !== "none") throw new CustomerGatewayError("unknown");
    const available = await vault.getFunction("available").staticCall(account) as bigint;
    if (BigInt(available) < amount) throw new CustomerGatewayError("insufficient");
    const submitted = await sendAndWaitFinalized(
      provider,
      () => vault.getFunction("reserve")(account, requestId, amount),
      onSubmitted,
    );
    const evidence = await readReservation(vault, provider, config, requestId, account);
    if (evidence.status !== "reserved" || evidence.amount !== amount) {
      throw new CustomerGatewayError("unknown");
    }
    if (evidence.transactionHash !== submitted.hash) throw new CustomerGatewayError("unknown");
    return evidence;
  } catch (error) {
    if (error instanceof CustomerGatewayError) throw error;
    throw new CustomerGatewayError("unknown");
  } finally {
    await provider.destroy();
  }
}

export async function settleOnchain(
  walletAddress: string,
  requestId: string,
  reservedMicrocredits: bigint,
  actualMicrocredits: bigint,
  onSubmitted?: TxSubmissionHook,
): Promise<ReservationEvidence> {
  const config = configuredGateway();
  if (!config) throw new CustomerGatewayError("unconfigured");
  const account = await normalizedAccount(walletAddress);
  if (actualMicrocredits <= 0n || actualMicrocredits > reservedMicrocredits) {
    throw new CustomerGatewayError("unknown");
  }
  const reservedAmount = subunits(reservedMicrocredits);
  const actualAmount = subunits(actualMicrocredits);
  const { provider, vault } = createVault(config);
  try {
    await assertGateway(provider, vault, config);
    const current = await readReservation(vault, provider, config, requestId, account);
    if (current.status !== "reserved" || current.amount !== reservedAmount) {
      throw new CustomerGatewayError("unknown");
    }
    const submitted = await sendAndWaitFinalized(
      provider,
      () => vault.getFunction("settle")(requestId, actualAmount),
      onSubmitted,
    );
    const evidence = await readReservation(vault, provider, config, requestId, account);
    if (evidence.status !== "settled" || evidence.amount !== reservedAmount ||
        evidence.actualAmount !== actualAmount || evidence.releasedAmount !== reservedAmount - actualAmount) {
      throw new CustomerGatewayError("unknown");
    }
    if (evidence.transactionHash !== submitted.hash) throw new CustomerGatewayError("unknown");
    return evidence;
  } catch (error) {
    if (error instanceof CustomerGatewayError) throw error;
    throw new CustomerGatewayError("unknown");
  } finally {
    await provider.destroy();
  }
}

export async function releaseOnchain(
  walletAddress: string,
  requestId: string,
  reservedMicrocredits: bigint,
  onSubmitted?: TxSubmissionHook,
): Promise<ReservationEvidence> {
  const config = configuredGateway();
  if (!config) throw new CustomerGatewayError("unconfigured");
  const account = await normalizedAccount(walletAddress);
  const reservedAmount = subunits(reservedMicrocredits);
  const { provider, vault } = createVault(config);
  try {
    await assertGateway(provider, vault, config);
    const current = await readReservation(vault, provider, config, requestId, account);
    if (current.status !== "reserved" || current.amount !== reservedAmount) {
      throw new CustomerGatewayError("unknown");
    }
    const submitted = await sendAndWaitFinalized(
      provider,
      () => vault.getFunction("release")(requestId),
      onSubmitted,
    );
    const evidence = await readReservation(vault, provider, config, requestId, account);
    if (evidence.status !== "released" || evidence.amount !== reservedAmount ||
        evidence.releasedAmount !== reservedAmount) throw new CustomerGatewayError("unknown");
    if (evidence.transactionHash !== submitted.hash) throw new CustomerGatewayError("unknown");
    return evidence;
  } catch (error) {
    if (error instanceof CustomerGatewayError) throw error;
    throw new CustomerGatewayError("unknown");
  } finally {
    await provider.destroy();
  }
}