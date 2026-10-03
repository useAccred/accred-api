import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  SOLANA_MEMO_PROGRAM,
  SOLANA_SYSTEM_PROGRAM,
  SOLANA_TOKEN_PROGRAM,
  parseUnsignedSolanaTransaction,
  validateSolanaInstructionSet,
} from "./credit-solana.ts";

const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function encodeBase58(bytes) {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let output = "";
  while (value > 0n) {
    output = alphabet[Number(value % 58n)] + output;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    output = `1${output}`;
  }
  return output || "1";
}

function decodeBase58(value) {
  let decoded = 0n;
  for (const character of value) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) throw new Error("invalid test base58");
    decoded = decoded * 58n + BigInt(digit);
  }
  const bytes = [];
  while (decoded > 0n) {
    bytes.unshift(Number(decoded & 255n));
    decoded >>= 8n;
  }
  for (const character of value) {
    if (character !== "1") break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

function shortVec(value) {
  const result = [];
  while (value >= 0x80) {
    result.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  result.push(value);
  return Buffer.from(result);
}

function instruction(programIndex, accounts, data) {
  return Buffer.concat([
    Buffer.from([programIndex]),
    shortVec(accounts.length),
    Buffer.from(accounts),
    shortVec(data.length),
    data,
  ]);
}

function makeUnsignedSolanaTransaction({ memo = "quote-abc", amount = 250_000n, signatureByte = 0 } = {}) {
  const payerBytes = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1));
  const treasuryBytes = Buffer.from(Array.from({ length: 32 }, (_, index) => 80 + index));
  const payer = encodeBase58(payerBytes);
  const treasury = encodeBase58(treasuryBytes);
  const system = decodeBase58(SOLANA_SYSTEM_PROGRAM);
  const memoProgram = decodeBase58(SOLANA_MEMO_PROGRAM);
  const blockhash = Buffer.from(Array.from({ length: 32 }, (_, index) => 160 + index));
  const systemData = Buffer.alloc(12);
  systemData.writeUInt32LE(2, 0);
  systemData.writeBigUInt64LE(amount, 4);
  const memoData = Buffer.from(memo, "utf8");
  const message = Buffer.concat([
    Buffer.from([1, 0, 2]), // one signer, payer is writable, two readonly program keys
    shortVec(4),
    payerBytes,
    treasuryBytes,
    system,
    memoProgram,
    blockhash,
    shortVec(2),
    instruction(2, [0, 1], systemData),
    instruction(3, [], memoData),
  ]);
  const signature = Buffer.alloc(64, signatureByte);
  return {
    payer,
    treasury,
    serialized: Buffer.concat([shortVec(1), signature, message]).toString("base64"),
  };
}

test("unsigned Solana payment parser validates exact payer, amount and quote memo", () => {
  const prepared = makeUnsignedSolanaTransaction();
  const parsed = parseUnsignedSolanaTransaction(prepared.serialized);
  assert.equal(parsed.payer, prepared.payer);
  assert.equal(parsed.instructions.length, 2);
  assert.equal(parsed.instructions[0].programId, SOLANA_SYSTEM_PROGRAM);
  assert.equal(parsed.instructions[1].programId, SOLANA_MEMO_PROGRAM);
  const validated = validateSolanaInstructionSet(parsed, {
    payer: prepared.payer,
    reference: "quote-abc",
    expectedTransfers: [{
      tokenAddress: "native",
      from: prepared.payer,
      to: prepared.treasury,
      amount: "250000",
    }],
    allowedPrograms: [],
  });
  assert.equal(validated.requiredSigners[0], prepared.payer);
});

test("Solana payment rejects a mismatched quote reference, payer, or amount", () => {
  const prepared = makeUnsignedSolanaTransaction();
  const parsed = parseUnsignedSolanaTransaction(prepared.serialized);
  const expectation = {
    payer: prepared.payer,
    reference: "different-quote",
    expectedTransfers: [{
      tokenAddress: "native",
      from: prepared.payer,
      to: prepared.treasury,
      amount: "250000",
    }],
    allowedPrograms: [],
  };
  assert.throws(() => validateSolanaInstructionSet(parsed, expectation), /solana_quote_reference_memo_mismatch/);
  assert.throws(() => validateSolanaInstructionSet(parsed, { ...expectation, payer: prepared.treasury }), /solana_prepared_payer_mismatch/);
  assert.throws(() => validateSolanaInstructionSet(parsed, {
    ...expectation,
    reference: "quote-abc",
    expectedTransfers: [{ ...expectation.expectedTransfers[0], amount: "250001" }],
  }), /solana_prepared_system_instruction_not_authorized/);
});

test("SPL transfer validation distinguishes token owners from token-account addresses", () => {
  const payerBytes = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1));
  const sourceAccountBytes = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 33));
  const mintBytes = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 65));
  const treasuryOwnerBytes = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 97));
  const destinationAccountBytes = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 129));
  const payer = encodeBase58(payerBytes);
  const sourceAccount = encodeBase58(sourceAccountBytes);
  const mint = encodeBase58(mintBytes);
  const treasuryOwner = encodeBase58(treasuryOwnerBytes);
  const destinationAccount = encodeBase58(destinationAccountBytes);
  assert.notEqual(treasuryOwner, destinationAccount);
  const keys = [
    payerBytes, sourceAccountBytes, mintBytes, destinationAccountBytes,
    decodeBase58(SOLANA_TOKEN_PROGRAM), decodeBase58(SOLANA_MEMO_PROGRAM),
  ];
  const transferData = Buffer.alloc(10);
  transferData[0] = 12;
  transferData.writeBigUInt64LE(300_000n, 1);
  transferData[9] = 6;
  const message = Buffer.concat([
    Buffer.from([1, 0, 2]),
    shortVec(keys.length),
    ...keys,
    Buffer.from(Array.from({ length: 32 }, (_, index) => 200 - index)),
    shortVec(2),
    instruction(4, [1, 2, 3, 0], transferData),
    instruction(5, [], Buffer.from("quote-spl-owner-account")),
  ]);
  const serialized = Buffer.concat([shortVec(1), Buffer.alloc(64), message]).toString("base64");
  const parsed = parseUnsignedSolanaTransaction(serialized);
  const validated = validateSolanaInstructionSet(parsed, {
    payer,
    reference: "quote-spl-owner-account",
    expectedTransfers: [{
      tokenAddress: mint,
      tokenDecimals: 6,
      from: payer,
      to: treasuryOwner,
      amount: "300000",
      sourceAccount,
      destinationAccount,
    }],
    allowedPrograms: [],
  });
  assert.equal(validated.instructions[0].accountAddresses[2], destinationAccount);
  assert.equal(validated.instructions[0].accountAddresses[2] === treasuryOwner, false);
});

test("Solana transaction parser rejects signed prepared payloads", () => {
  const signed = makeUnsignedSolanaTransaction({ signatureByte: 1 });
  assert.throws(() => parseUnsignedSolanaTransaction(signed.serialized), /solana_prepared_transaction_must_be_unsigned/);
});