import { createHash, createPublicKey, randomBytes, verify as verifySignature } from "node:crypto";
import { decodeBase58, encodeBase58 } from "ethers";

export const SOLANA_MAINNET_CHAIN_ID = "solana-mainnet" as const;
export const SOLANA_OWNERSHIP_INTENT = "solana_deposit_purchase_ownership";
export const SOLANA_OWNERSHIP_TTL_MS = 5 * 60_000;

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function normalizeSolanaAppDomain(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim() || /[\s\r\n]/.test(value)) return undefined;
  const raw = value.trim();
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    return url.host.toLowerCase();
  } catch {
    return undefined;
  }
}

/** APP_DOMAIN is preferred; X_LINK_DOMAIN remains the configured app-domain fallback. */
export function solanaAppDomain(env = process.env): string | undefined {
  return normalizeSolanaAppDomain(env.APP_DOMAIN?.trim() || env.X_LINK_DOMAIN?.trim());
}

function decodeSolanaPublicKey32(value: string): Buffer | undefined {
  try {
    let integer = decodeBase58(value);
    if (integer < 0n || integer >= (1n << 256n)) return undefined;
    const bytes = Buffer.alloc(32);
    for (let i = bytes.length - 1; i >= 0; i -= 1) {
      bytes[i] = Number(integer & 0xffn);
      integer >>= 8n;
    }
    return integer === 0n ? bytes : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Decode and re-encode so only the canonical base58 representation of a
 * 32-byte Solana Ed25519 public key is accepted.
 */
export function canonicalSolanaWalletAddress(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.trim() !== value) return undefined;
  const publicKey = decodeSolanaPublicKey32(value);
  return publicKey && encodeBase58(publicKey) === value ? value : undefined;
}

export function createSolanaOwnershipMessage({
  domain,
  ownerUserId,
  walletAddress,
  challengeId,
  nonce,
  issuedAt,
  expiresAt,
}: {
  domain: string;
  ownerUserId: string;
  walletAddress: string;
  challengeId: string;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
}): string {
  const canonicalDomain = normalizeSolanaAppDomain(domain);
  const canonicalAddress = canonicalSolanaWalletAddress(walletAddress);
  if (
    !canonicalDomain ||
    !ownerUserId ||
    /[\r\n]/.test(ownerUserId) ||
    !canonicalAddress ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(challengeId) ||
    !isCanonicalSolanaNonce(nonce) ||
    !Number.isFinite(issuedAt.getTime()) ||
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt.getTime() <= issuedAt.getTime()
  ) {
    throw new Error("Invalid Solana ownership message context.");
  }
  return `${canonicalDomain} requests proof of control of this Solana wallet.

Accred Solana payment-wallet ownership proof
Challenge ID: ${challengeId}
Nonce: ${nonce}
Issued At: ${issuedAt.toISOString()}
Expires At: ${expiresAt.toISOString()}
Wallet: ${canonicalAddress}
Privy owner: ${ownerUserId}
Network: Solana mainnet
Purpose: identify the payer for deposits and purchases only.

This signature proves wallet control for deposit and purchase attribution only. It cannot initiate or approve a transaction.`;
}

export function createSolanaChallengeNonce(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSolanaChallengeNonce(nonce: string): string {
  return createHash("sha256").update(nonce, "utf8").digest("hex");
}

function isCanonicalSolanaNonce(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.length === 32 && decoded.toString("base64url") === value;
  } catch {
    return false;
  }
}

export function parseSolanaOwnershipMessage(message: string): {
  domain: string;
  challengeId: string;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
  walletAddress: string;
  ownerUserId: string;
} | undefined {
  const match = message.match(
    /^([^\r\n]+) requests proof of control of this Solana wallet\.\n\nAccred Solana payment-wallet ownership proof\nChallenge ID: ([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\nNonce: ([A-Za-z0-9_-]{43})\nIssued At: ([^\r\n]+)\nExpires At: ([^\r\n]+)\nWallet: ([1-9A-HJ-NP-Za-km-z]+)\nPrivy owner: ([^\r\n]+)\nNetwork: Solana mainnet\nPurpose: identify the payer for deposits and purchases only\.\n\nThis signature proves wallet control for deposit and purchase attribution only\. It cannot initiate or approve a transaction\.$/,
  );
  if (!match || !isCanonicalSolanaNonce(match[3])) return undefined;
  const issuedAt = new Date(match[4]);
  const expiresAt = new Date(match[5]);
  if (
    !Number.isFinite(issuedAt.getTime()) ||
    !Number.isFinite(expiresAt.getTime()) ||
    issuedAt.toISOString() !== match[4] ||
    expiresAt.toISOString() !== match[5] ||
    !normalizeSolanaAppDomain(match[1]) ||
    !canonicalSolanaWalletAddress(match[6]) ||
    !match[7]
  ) {
    return undefined;
  }
  return {
    domain: normalizeSolanaAppDomain(match[1])!,
    challengeId: match[2],
    nonce: match[3],
    issuedAt,
    expiresAt,
    walletAddress: match[6],
    ownerUserId: match[7],
  };
}

export function canonicalEd25519Signature(value: unknown): Buffer | undefined {
  if (typeof value !== "string" || !CANONICAL_BASE64.test(value)) return undefined;
  try {
    const signature = Buffer.from(value, "base64");
    if (signature.length !== 64 || signature.toString("base64") !== value) return undefined;
    return signature;
  } catch {
    return undefined;
  }
}

export function verifySolanaOwnershipSignature({
  walletAddress,
  message,
  signature,
}: {
  walletAddress: string;
  message: string;
  signature: unknown;
}): boolean {
  const address = canonicalSolanaWalletAddress(walletAddress);
  const signatureBytes = canonicalEd25519Signature(signature);
  if (!address || !signatureBytes) return false;
  try {
    const rawKey = decodeSolanaPublicKey32(address);
    if (!rawKey) return false;
    const publicKey = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, rawKey]),
      format: "der",
      type: "spki",
    });
    return verifySignature(null, Buffer.from(message, "utf8"), publicKey, signatureBytes);
  } catch {
    return false;
  }
}

export function solanaOwnershipChallengeExpiresAt(now = Date.now()): Date {
  return new Date(now + SOLANA_OWNERSHIP_TTL_MS);
}

export function isSolanaOwnershipChallengeUsable(
  record: { consumedAt: Date | null; expiresAt: Date },
  now = Date.now(),
): boolean {
  return !record.consumedAt && record.expiresAt.getTime() > now;
}