import { Buffer } from "node:buffer";
import { isSolanaAddress, type CreditConfiguration } from "./credit-config";
import type { ExpectedTransfer } from "./credit-router";

export const SOLANA_SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const SOLANA_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const SOLANA_MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const SOLANA_COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
const ADDRESS_LOOKUP_TABLE_PROGRAM = "AddressLookupTab1e1111111111111111111111111";
const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

type AddressLookup = { tableAddress: string; writableIndexes: number[]; readonlyIndexes: number[] };

export type ParsedSolanaInstruction = {
  programId: string;
  programIdIndex: number;
  accountIndexes: number[];
  accountAddresses: string[];
  data: string;
  dataBase58: string;
};

export type ParsedUnsignedSolanaTransaction = {
  payer: string;
  recentBlockhash: string;
  requiredSigners: string[];
  accountKeys: string[];
  instructions: ParsedSolanaInstruction[];
  addressLookups: AddressLookup[];
};

function decodeShortVec(bytes: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  for (let count = 0; count < 3; count += 1) {
    if (cursor >= bytes.length) throw new Error("invalid_solana_transaction_encoding");
    const byte = bytes[cursor++]!;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: cursor };
    shift += 7;
  }
  throw new Error("invalid_solana_transaction_encoding");
}

function encodeBase58(bytes: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let output = "";
  while (value > 0n) {
    const remainder = Number(value % 58n);
    output = alphabet[remainder]! + output;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    output = `1${output}`;
  }
  return output || "1";
}

function base64ToBuffer(serialized: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(serialized) || serialized.length > 2_000) {
    throw new Error("invalid_prepared_solana_transaction");
  }
  const bytes = Buffer.from(serialized, "base64");
  if (!bytes.length || bytes.length > 1_232 ||
      bytes.toString("base64").replace(/=+$/, "") !== serialized.replace(/=+$/, "")) {
    throw new Error("invalid_prepared_solana_transaction");
  }
  return bytes;
}

export function parseUnsignedSolanaTransaction(serialized: string): ParsedUnsignedSolanaTransaction {
  const bytes = base64ToBuffer(serialized);
  let cursor = 0;
  const signatures = decodeShortVec(bytes, cursor);
  cursor = signatures.next;
  if (signatures.value < 1 || signatures.value > 1) throw new Error("solana_transaction_must_have_one_wallet_signer");
  const signatureBytes = bytes.subarray(cursor, cursor + signatures.value * 64);
  if (signatureBytes.length !== signatures.value * 64 || signatureBytes.some((byte) => byte !== 0)) {
    throw new Error("solana_prepared_transaction_must_be_unsigned");
  }
  cursor += signatures.value * 64;
  if (cursor >= bytes.length) throw new Error("invalid_solana_transaction_encoding");
  let versioned = false;
  let firstHeader = bytes[cursor]!;
  if ((firstHeader & 0x80) !== 0) {
    versioned = true;
    if ((firstHeader & 0x7f) !== 0) throw new Error("unsupported_solana_transaction_version");
    cursor += 1;
    if (cursor >= bytes.length) throw new Error("invalid_solana_transaction_encoding");
    firstHeader = bytes[cursor]!;
  }
  const requiredSignatureCount = firstHeader;
  if (requiredSignatureCount !== 1 || signatures.value !== requiredSignatureCount) {
    throw new Error("solana_transaction_must_have_one_wallet_signer");
  }
  const readonlySigned = bytes[cursor + 1];
  const readonlyUnsigned = bytes[cursor + 2];
  if (readonlySigned === undefined || readonlyUnsigned === undefined) throw new Error("invalid_solana_transaction_encoding");
  cursor += 3;
  const keyCount = decodeShortVec(bytes, cursor);
  cursor = keyCount.next;
  if (keyCount.value < 1 || keyCount.value > 64 || cursor + keyCount.value * 32 > bytes.length) {
    throw new Error("invalid_solana_transaction_encoding");
  }
  const accountKeys: string[] = [];
  for (let index = 0; index < keyCount.value; index += 1) {
    accountKeys.push(encodeBase58(bytes.subarray(cursor, cursor + 32)));
    cursor += 32;
  }
  const requiredSigners = accountKeys.slice(0, requiredSignatureCount);
  cursor += 32;
  if (cursor > bytes.length) throw new Error("invalid_solana_transaction_encoding");
  const recentBlockhash = encodeBase58(bytes.subarray(cursor - 32, cursor));
  const instructionCount = decodeShortVec(bytes, cursor);
  cursor = instructionCount.next;
  if (instructionCount.value < 1 || instructionCount.value > 64) throw new Error("invalid_solana_instruction_count");
  const instructions: ParsedSolanaInstruction[] = [];
  for (let index = 0; index < instructionCount.value; index += 1) {
    if (cursor >= bytes.length) throw new Error("invalid_solana_transaction_encoding");
    const programIndex = bytes[cursor++]!;
    const accountCount = decodeShortVec(bytes, cursor);
    cursor = accountCount.next;
    if (programIndex >= accountKeys.length || accountCount.value > 64 || cursor + accountCount.value > bytes.length) {
      throw new Error("invalid_solana_transaction_encoding");
    }
    const accountIndexes = [...bytes.subarray(cursor, cursor + accountCount.value)];
    cursor += accountCount.value;
    if (accountIndexes.some((accountIndex) => accountIndex >= 256)) throw new Error("invalid_solana_transaction_encoding");
    const dataLength = decodeShortVec(bytes, cursor);
    cursor = dataLength.next;
    if (cursor + dataLength.value > bytes.length) throw new Error("invalid_solana_transaction_encoding");
    const dataBytes = bytes.subarray(cursor, cursor + dataLength.value);
    cursor += dataLength.value;
    const programId = accountKeys[programIndex]!;
    instructions.push({
      programId,
      programIdIndex: programIndex,
      accountIndexes,
      accountAddresses: accountIndexes.map((accountIndex) => accountKeys[accountIndex]!),
      data: dataBytes.toString("base64"),
      dataBase58: encodeBase58(dataBytes),
    });
  }
  const addressLookups: AddressLookup[] = [];
  if (versioned) {
    const lookupCount = decodeShortVec(bytes, cursor);
    cursor = lookupCount.next;
    if (lookupCount.value > 16) throw new Error("solana_lookup_table_count_exceeded");
    for (let index = 0; index < lookupCount.value; index += 1) {
      if (cursor + 32 > bytes.length) throw new Error("invalid_solana_lookup_table");
      const tableAddress = encodeBase58(bytes.subarray(cursor, cursor + 32));
      cursor += 32;
      const writableCount = decodeShortVec(bytes, cursor);
      cursor = writableCount.next;
      if (cursor + writableCount.value > bytes.length) throw new Error("invalid_solana_lookup_table");
      const writableIndexes = [...bytes.subarray(cursor, cursor + writableCount.value)];
      cursor += writableCount.value;
      const readonlyCount = decodeShortVec(bytes, cursor);
      cursor = readonlyCount.next;
      if (cursor + readonlyCount.value > bytes.length) throw new Error("invalid_solana_lookup_table");
      const readonlyIndexes = [...bytes.subarray(cursor, cursor + readonlyCount.value)];
      cursor += readonlyCount.value;
      addressLookups.push({ tableAddress, writableIndexes, readonlyIndexes });
    }
  }
  if (cursor !== bytes.length) throw new Error("invalid_solana_transaction_encoding");
  if (readonlySigned > requiredSignatureCount || readonlyUnsigned > accountKeys.length - requiredSignatureCount) {
    throw new Error("invalid_solana_transaction_header");
  }
  return {
    payer: accountKeys[0]!,
    recentBlockhash,
    requiredSigners,
    accountKeys,
    instructions,
    addressLookups,
  };
}

type JsonRpcResult<T> = { result?: T; error?: { code?: number } };
let lookupRpcId = 0;
async function solanaRpc<T>(config: CreditConfiguration, method: string, params: unknown[]): Promise<T> {
  if (!config.solanaRpcUrl) throw new Error("solana_mainnet_rpc_unavailable");
  const response = await fetch(config.solanaRpcUrl, {
    method: "POST", redirect: "error",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++lookupRpcId, method, params }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`solana_rpc_http_${response.status}`);
  const payload = await response.json() as JsonRpcResult<T>;
  if (payload.error || payload.result === undefined) throw new Error(`solana_rpc_error_${payload.error?.code ?? "invalid"}`);
  return payload.result;
}

export async function resolvePreparedSolanaTransaction(
  config: CreditConfiguration,
  serialized: string,
): Promise<ParsedUnsignedSolanaTransaction> {
  const parsed = parseUnsignedSolanaTransaction(serialized);
  if (await solanaRpc<string>(config, "getGenesisHash", []) !== MAINNET_GENESIS_HASH) {
    throw new Error("solana_rpc_wrong_cluster");
  }
  const writable: string[] = [];
  const readonly: string[] = [];
  for (const lookup of parsed.addressLookups) {
    const account = await solanaRpc<{
      value?: { owner?: string; data?: [string, string] | string; executable?: boolean };
    }>(config, "getAccountInfo", [lookup.tableAddress, { commitment: "finalized", encoding: "base64" }]);
    const value = account.value;
    const encoded = Array.isArray(value?.data) ? value.data[0] : undefined;
    if (!value || value.owner !== ADDRESS_LOOKUP_TABLE_PROGRAM || typeof encoded !== "string") {
      throw new Error("solana_lookup_table_not_mainnet_or_missing");
    }
    const data = Buffer.from(encoded, "base64");
    if (data.length < 56 || data.readUInt32LE(0) !== 1 || (data.length - 56) % 32 !== 0) {
      throw new Error("solana_lookup_table_layout_invalid");
    }
    const lastExtendedSlot = data.readBigUInt64LE(12);
    const startIndex = data[20]!;
    const deactivationSlot = data.readBigUInt64LE(4);
    const currentSlot = await solanaRpc<number>(config, "getSlot", [{ commitment: "finalized" }]);
    if (deactivationSlot !== 0xffffffffffffffffn || currentSlot >= Number(deactivationSlot)) {
      throw new Error("solana_lookup_table_deactivated");
    }
    if (BigInt(currentSlot) <= lastExtendedSlot &&
        [...lookup.writableIndexes, ...lookup.readonlyIndexes].some((addressIndex) => addressIndex >= startIndex)) {
      throw new Error("solana_lookup_table_extension_not_finalized");
    }
    const addresses: string[] = [];
    for (let offset = 56; offset < data.length; offset += 32) {
      addresses.push(encodeBase58(data.subarray(offset, offset + 32)));
    }
    for (const addressIndex of lookup.writableIndexes) {
      const address = addresses[addressIndex];
      if (!address) throw new Error("solana_lookup_address_missing");
      writable.push(address);
    }
    for (const addressIndex of lookup.readonlyIndexes) {
      const address = addresses[addressIndex];
      if (!address) throw new Error("solana_lookup_address_missing");
      readonly.push(address);
    }
  }
  parsed.accountKeys = [...parsed.accountKeys, ...writable, ...readonly];
  if (parsed.accountKeys.length > 256) throw new Error("solana_transaction_account_count_exceeded");
  for (const instruction of parsed.instructions) {
    if (instruction.accountIndexes.some((accountIndex) => accountIndex >= parsed.accountKeys.length)) {
      throw new Error("solana_instruction_account_missing");
    }
    instruction.accountAddresses = instruction.accountIndexes.map((accountIndex) => parsed.accountKeys[accountIndex]!);
  }
  const blockhashValid = await solanaRpc<{ value?: boolean }>(config, "isBlockhashValid", [
    parsed.recentBlockhash, { commitment: "finalized" },
  ]);
  if (blockhashValid.value !== true) throw new Error("solana_prepared_blockhash_expired");
  return parsed;
}

function readU64LE(bytes: Buffer, offset: number): bigint {
  if (offset + 8 > bytes.length) throw new Error("invalid_solana_instruction_data");
  return bytes.readBigUInt64LE(offset);
}

function verifySystemTransfer(instruction: ParsedSolanaInstruction, payer: string, transfers: ExpectedTransfer[]): boolean {
  const data = Buffer.from(instruction.data, "base64");
  if (data.length !== 12 || data.readUInt32LE(0) !== 2 || instruction.accountAddresses.length < 2) return false;
  const source = instruction.accountAddresses[0]!;
  const destination = instruction.accountAddresses[1]!;
  const amount = readU64LE(data, 4);
  return source === payer && transfers.some((transfer) =>
    transfer.tokenAddress === "native" && transfer.from === source &&
    transfer.to === destination && BigInt(transfer.amount) === amount);
}

function verifyTokenTransfer(instruction: ParsedSolanaInstruction, payer: string, transfers: ExpectedTransfer[]): boolean {
  const data = Buffer.from(instruction.data, "base64");
  if (!instruction.accountAddresses.length) return false;
  if (data.length === 10 && data[0] === 12 && instruction.accountAddresses.length >= 4) {
    const [source, mint, destination, authority] = instruction.accountAddresses;
    const amount = readU64LE(data, 1);
    const decimals = data[9]!;
    return authority === payer && transfers.some((transfer) =>
      transfer.from === payer && transfer.tokenAddress === mint &&
      transfer.sourceAccount === source && transfer.destinationAccount === destination &&
      BigInt(transfer.amount) === amount && transfer.tokenDecimals === decimals);
  }
  if (data.length === 9 && data[0] === 3 && instruction.accountAddresses.length >= 3) {
    const [source, destination, authority] = instruction.accountAddresses;
    const amount = readU64LE(data, 1);
    return authority === payer && transfers.some((transfer) =>
      transfer.from === payer &&
      transfer.sourceAccount === source && transfer.destinationAccount === destination &&
      BigInt(transfer.amount) === amount);
  }
  return false;
}

function payerOrTransferDestination(transfer: ExpectedTransfer): string {
  return transfer.destinationAccount ?? transfer.to;
}

export async function validatePreparedSolanaPayment(args: {
  config: CreditConfiguration;
  serialized: string;
  payer: string;
  reference: string;
  expectedTransfers: ExpectedTransfer[];
  allowedPrograms: string[];
}): Promise<ParsedUnsignedSolanaTransaction> {
  const parsed = await resolvePreparedSolanaTransaction(args.config, args.serialized);
  await verifyExpectedTokenAccounts(args.config, args.expectedTransfers);
  return validateSolanaInstructionSet(parsed, args);
}

async function verifyExpectedTokenAccounts(config: CreditConfiguration, transfers: ExpectedTransfer[]): Promise<void> {
  const accounts = new Map<string, { mint?: string; owner?: string; tokenProgram?: string }>();
  for (const transfer of transfers) {
    if (transfer.tokenAddress === "native") continue;
    for (const [accountAddress, expectedOwner] of [
      [transfer.sourceAccount, transfer.from],
      [transfer.destinationAccount, transfer.to],
    ] as const) {
      if (!accountAddress || !expectedOwner) throw new Error("solana_transfer_accounts_or_owners_missing");
      let account = accounts.get(accountAddress);
      if (!account) {
        const response = await solanaRpc<{
          value?: {
            owner?: string;
            data?: { parsed?: { info?: { mint?: string; owner?: string } } };
          } | null;
        }>(config, "getAccountInfo", [accountAddress, { commitment: "finalized", encoding: "jsonParsed" }]);
        const value = response.value;
        account = {
          tokenProgram: value?.owner,
          mint: value?.data?.parsed?.info?.mint,
          owner: value?.data?.parsed?.info?.owner,
        };
        accounts.set(accountAddress, account);
      }
      if (account.tokenProgram !== SOLANA_TOKEN_PROGRAM ||
          account.mint !== transfer.tokenAddress || account.owner !== expectedOwner) {
        throw new Error("solana_token_account_owner_or_mint_mismatch");
      }
    }
  }
}

export function validateSolanaInstructionSet(
  parsed: ParsedUnsignedSolanaTransaction,
  args: {
    payer: string;
    reference: string;
    expectedTransfers: ExpectedTransfer[];
    allowedPrograms: string[];
  },
): ParsedUnsignedSolanaTransaction {
  if (!isSolanaAddress(args.payer) || parsed.payer !== args.payer ||
      parsed.requiredSigners.length !== 1 || parsed.requiredSigners[0] !== args.payer) {
    throw new Error("solana_prepared_payer_mismatch");
  }
  const allowed = new Set([
    SOLANA_SYSTEM_PROGRAM,
    SOLANA_TOKEN_PROGRAM,
    SOLANA_MEMO_PROGRAM,
    SOLANA_COMPUTE_BUDGET_PROGRAM,
    ...args.allowedPrograms,
  ]);
  let memoCount = 0;
  let allowlistedExecutorInstruction = false;
  const transferSeen = new Set<string>();
  for (const instruction of parsed.instructions) {
    if (!allowed.has(instruction.programId)) throw new Error("solana_prepared_program_not_allowlisted");
    if (instruction.programId === SOLANA_MEMO_PROGRAM) {
      const memo = Buffer.from(instruction.data, "base64").toString("utf8");
      if (memo !== args.reference) throw new Error("solana_quote_reference_memo_mismatch");
      memoCount += 1;
      continue;
    }
    if (instruction.programId === SOLANA_SYSTEM_PROGRAM) {
      if (verifySystemTransfer(instruction, args.payer, args.expectedTransfers)) {
        const data = Buffer.from(instruction.data, "base64");
        transferSeen.add(`native:${instruction.accountAddresses[1]}:${readU64LE(data, 4)}`);
        continue;
      }
      // Non-transfer system instructions are not accepted: no arbitrary account
      // creation, authority changes, or user-funded instructions.
      throw new Error("solana_prepared_system_instruction_not_authorized");
    }
    if (instruction.programId === SOLANA_TOKEN_PROGRAM) {
      if (verifyTokenTransfer(instruction, args.payer, args.expectedTransfers)) {
        const data = Buffer.from(instruction.data, "base64");
        const isChecked = data[0] === 12;
        const destination = instruction.accountAddresses[isChecked ? 2 : 1]!;
        const amount = readU64LE(data, 1);
        const mint = isChecked ? instruction.accountAddresses[1]! : args.expectedTransfers.find((entry) =>
          entry.from === args.payer && payerOrTransferDestination(entry) === destination,
        )?.tokenAddress ?? "";
        transferSeen.add(`${mint}:${destination}:${amount}`);
        continue;
      }
      throw new Error("solana_prepared_token_instruction_not_authorized");
    }
    if (instruction.programId === SOLANA_COMPUTE_BUDGET_PROGRAM) {
      const data = Buffer.from(instruction.data, "base64");
      if ((data.length === 5 && data[0] === 2 && data.readUInt32LE(1) <= 1_400_000) ||
          (data.length === 9 && data[0] === 3 && readU64LE(data, 1) <= BigInt(process.env.CREDIT_MAX_SOLANA_PRIORITY_FEE_MICROLAMPORTS ?? "100000"))) {
        continue;
      }
      throw new Error("solana_compute_budget_not_authorized");
    }
    // Allowlisted swap executors are constrained by the exact user payer,
    // reference memo, expected token movement and finalized receipt verification.
    allowlistedExecutorInstruction = true;
  }
  if (memoCount !== 1) throw new Error("solana_quote_reference_memo_missing");
  for (const transfer of args.expectedTransfers) {
    if (transfer.from === args.payer &&
        !transferSeen.has(`${transfer.tokenAddress}:${payerOrTransferDestination(transfer)}:${transfer.amount}`)) {
      if (!allowlistedExecutorInstruction) throw new Error("solana_prepared_exact_input_instruction_missing");
    }
  }
  return parsed;
}