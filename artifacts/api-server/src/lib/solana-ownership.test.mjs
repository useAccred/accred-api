import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { encodeBase58 } from "ethers";
import {
  canonicalEd25519Signature,
  canonicalSolanaWalletAddress,
  createSolanaOwnershipMessage,
  hashSolanaChallengeNonce,
  isSolanaOwnershipChallengeUsable,
  normalizeSolanaAppDomain,
  parseSolanaOwnershipMessage,
  solanaAppDomain,
  solanaOwnershipChallengeExpiresAt,
  SOLANA_MAINNET_CHAIN_ID,
  SOLANA_OWNERSHIP_TTL_MS,
  verifySolanaOwnershipSignature,
} from "./solana-ownership.ts";

function makeWallet() {
  const pair = generateKeyPairSync("ed25519");
  const der = pair.publicKey.export({ format: "der", type: "spki" });
  const walletAddress = encodeBase58(der.subarray(-32));
  return { ...pair, walletAddress };
}

function signMessage(privateKey, message) {
  return sign(null, Buffer.from(message, "utf8"), privateKey).toString("base64");
}

function ownershipMessage({ domain = "app.example.test", ownerUserId, walletAddress, challengeId, nonceByte = 1, issuedAt }) {
  const issued = issuedAt ?? new Date("2025-01-01T00:00:00.000Z");
  return createSolanaOwnershipMessage({
    domain,
    ownerUserId,
    walletAddress,
    challengeId,
    nonce: Buffer.alloc(32, nonceByte).toString("base64url"),
    issuedAt: issued,
    expiresAt: new Date(issued.getTime() + SOLANA_OWNERSHIP_TTL_MS),
  });
}

test("canonical Solana base58 address and Ed25519 signature verify", () => {
  const { privateKey, walletAddress } = makeWallet();
  const nonce = Buffer.alloc(32, 1).toString("base64url");
  const issuedAt = new Date("2025-01-01T00:00:00.000Z");
  const expiresAt = new Date(issuedAt.getTime() + SOLANA_OWNERSHIP_TTL_MS);
  const message = createSolanaOwnershipMessage({
    domain: "app.example.test",
    ownerUserId: "did:privy:owner-1",
    walletAddress,
    challengeId: "11111111-1111-4111-8111-111111111111",
    nonce,
    issuedAt,
    expiresAt,
  });
  const signature = signMessage(privateKey, message);
  assert.equal(canonicalSolanaWalletAddress(walletAddress), walletAddress);
  assert.equal(canonicalEd25519Signature(signature)?.length, 64);
  assert.equal(verifySolanaOwnershipSignature({ walletAddress, message, signature }), true);
  assert.equal(hashSolanaChallengeNonce(nonce).length, 64);
  assert.equal(SOLANA_MAINNET_CHAIN_ID, "solana-mainnet");
});

test("proof message is bound to app domain, owner, mainnet, and deposit/purchase purpose only", () => {
  const { walletAddress } = makeWallet();
  const message = ownershipMessage({
    domain: "https://app.example.test",
    ownerUserId: "did:privy:owner-2",
    walletAddress,
    challengeId: "22222222-2222-4222-8222-222222222222",
  });
  assert.match(message, /^app\.example\.test requests proof/);
  assert.match(message, /Challenge ID: 22222222-2222-4222-8222-222222222222/);
  assert.match(message, /Nonce: [A-Za-z0-9_-]{43}/);
  assert.match(message, /Issued At: 2025-01-01T00:00:00\.000Z/);
  assert.match(message, /Expires At: 2025-01-01T00:05:00\.000Z/);
  assert.match(message, new RegExp(walletAddress));
  assert.match(message, /Privy owner: did:privy:owner-2/);
  assert.match(message, /Network: Solana mainnet/);
  assert.match(message, /deposits and purchases only/);
  assert.doesNotMatch(message, /authorization|authorize/i);
});

test("wrong domain, owner, wallet, or signature fails verification", () => {
  const first = makeWallet();
  const second = makeWallet();
  const message = ownershipMessage({
    domain: "app.example.test",
    ownerUserId: "did:privy:owner-3",
    walletAddress: first.walletAddress,
    challengeId: "33333333-3333-4333-8333-333333333333",
  });
  const signature = signMessage(first.privateKey, message);
  assert.equal(verifySolanaOwnershipSignature({
    walletAddress: first.walletAddress,
    message: message.replace("app.example.test", "evil.example.test"),
    signature,
  }), false);
  assert.equal(verifySolanaOwnershipSignature({
    walletAddress: first.walletAddress,
    message: message.replace("owner-3", "owner-4"),
    signature,
  }), false);
  assert.equal(verifySolanaOwnershipSignature({
    walletAddress: second.walletAddress,
    message,
    signature,
  }), false);
  assert.equal(verifySolanaOwnershipSignature({
    walletAddress: first.walletAddress,
    message,
    signature: signMessage(second.privateKey, message),
  }), false);
});

test("addresses and signatures require canonical encodings and exact lengths", () => {
  assert.equal(canonicalSolanaWalletAddress("not-base58-0O"), undefined);
  assert.equal(canonicalSolanaWalletAddress("111"), undefined);
  assert.equal(canonicalEd25519Signature("a".repeat(88)), undefined);
  assert.equal(canonicalEd25519Signature(""), undefined);
  const { privateKey, walletAddress } = makeWallet();
  const message = ownershipMessage({
    domain: "app.example.test",
    ownerUserId: "did:privy:owner-5",
    walletAddress,
    challengeId: "55555555-5555-4555-8555-555555555555",
  });
  const signature = signMessage(privateKey, message);
  assert.equal(canonicalEd25519Signature(` ${signature}`), undefined);
  assert.equal(canonicalEd25519Signature(signature.replace(/=$/, "")), undefined);
});

test("signature captured from an old challenge fails for a new challenge with the same owner and wallet", () => {
  const { privateKey, walletAddress } = makeWallet();
  const oldMessage = ownershipMessage({
    domain: "app.example.test",
    ownerUserId: "did:privy:owner-replay",
    walletAddress,
    challengeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    nonceByte: 3,
    issuedAt: new Date("2025-02-01T00:00:00.000Z"),
  });
  const freshMessage = ownershipMessage({
    domain: "app.example.test",
    ownerUserId: "did:privy:owner-replay",
    walletAddress,
    challengeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    nonceByte: 4,
    issuedAt: new Date("2025-02-01T00:01:00.000Z"),
  });
  const oldSignature = signMessage(privateKey, oldMessage);
  assert.equal(verifySolanaOwnershipSignature({
    walletAddress,
    message: freshMessage,
    signature: oldSignature,
  }), false);
  const parsed = parseSolanaOwnershipMessage(freshMessage);
  assert.equal(parsed?.challengeId, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  assert.equal(parsed?.ownerUserId, "did:privy:owner-replay");
});

test("domain configuration accepts only HTTPS hostnames and challenge expires in five minutes", () => {
  assert.equal(normalizeSolanaAppDomain("https://APP.Example.test"), "app.example.test");
  assert.equal(normalizeSolanaAppDomain("http://app.example.test"), undefined);
  assert.equal(normalizeSolanaAppDomain("app.example.test/path"), undefined);
  assert.equal(solanaAppDomain({ APP_DOMAIN: "", X_LINK_DOMAIN: "app.example.test" }), "app.example.test");
  const now = 1_700_000_000_000;
  assert.equal(solanaOwnershipChallengeExpiresAt(now).getTime(), now + SOLANA_OWNERSHIP_TTL_MS);
});

test("expired and already-consumed challenges cannot be replayed", () => {
  const now = 100_000;
  assert.equal(isSolanaOwnershipChallengeUsable({
    consumedAt: null,
    expiresAt: new Date(now + 1),
  }, now), true);
  assert.equal(isSolanaOwnershipChallengeUsable({
    consumedAt: null,
    expiresAt: new Date(now),
  }, now), false);
  assert.equal(isSolanaOwnershipChallengeUsable({
    consumedAt: new Date(now - 1),
    expiresAt: new Date(now + 1_000),
  }, now), false);
});