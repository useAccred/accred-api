import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  db,
  verifiedWalletOwnerships,
  walletOwnershipChallenges,
} from "@workspace/db";
import { requirePrivySession } from "../lib/privy-auth";
import {
  canonicalEd25519Signature,
  canonicalSolanaWalletAddress,
  createSolanaChallengeNonce,
  createSolanaOwnershipMessage,
  hashSolanaChallengeNonce,
  isSolanaOwnershipChallengeUsable,
  parseSolanaOwnershipMessage,
  solanaAppDomain,
  solanaOwnershipChallengeExpiresAt,
  SOLANA_MAINNET_CHAIN_ID,
  SOLANA_OWNERSHIP_INTENT,
  verifySolanaOwnershipSignature,
} from "../lib/solana-ownership";

const router: IRouter = Router();

type VerificationResult =
  | { status: "invalid" }
  | { status: "conflict" }
  | { status: "verified"; walletAddress: string; verifiedAt: Date };

function hasOnlyKeys(value: unknown, expected: string[]): value is Record<string, unknown> {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key)),
  );
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505",
  );
}

router.post("/auth/solana/challenge", requirePrivySession, async (req, res): Promise<void> => {
  if (!req.privySession || !hasOnlyKeys(req.body, ["walletAddress"])) {
    res.status(400).json({ error: "Request body must contain only walletAddress." });
    return;
  }
  const walletAddress = canonicalSolanaWalletAddress(req.body.walletAddress);
  if (!walletAddress) {
    res.status(400).json({ error: "walletAddress must be a canonical base58-encoded 32-byte Solana public key." });
    return;
  }
  const domain = solanaAppDomain();
  if (!domain) {
    res.status(503).json({
      error: "Solana wallet proof domain is not configured.",
      missing: ["APP_DOMAIN or X_LINK_DOMAIN (HTTPS hostname)"],
    });
    return;
  }

  try {
    const challengeId = randomUUID();
    const issuedAt = new Date();
    const expiresAt = solanaOwnershipChallengeExpiresAt(issuedAt.getTime());
    const nonce = createSolanaChallengeNonce();
    const message = createSolanaOwnershipMessage({
      domain,
      ownerUserId: req.privySession.userId,
      walletAddress,
      challengeId,
      nonce,
      issuedAt,
      expiresAt,
    });
    await db.insert(walletOwnershipChallenges).values({
      id: challengeId,
      ownerUserId: req.privySession.userId,
      walletAddress,
      chainId: SOLANA_MAINNET_CHAIN_ID,
      intent: SOLANA_OWNERSHIP_INTENT,
      nonceHash: hashSolanaChallengeNonce(nonce),
      message,
      expiresAt,
      createdAt: issuedAt,
    });
    res.status(201).json({ challengeId, message, expiresAt });
  } catch (error) {
    req.log.error({ error }, "Solana wallet challenge unavailable");
    res.status(503).json({ error: "Solana wallet challenge is temporarily unavailable." });
  }
});

router.post("/auth/solana/verify", requirePrivySession, async (req, res): Promise<void> => {
  if (
    !req.privySession ||
    !hasOnlyKeys(req.body, ["challengeId", "signature"]) ||
    typeof req.body.challengeId !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(req.body.challengeId) ||
    typeof req.body.signature !== "string" ||
    !canonicalEd25519Signature(req.body.signature)
  ) {
    res.status(400).json({ error: "challengeId and a canonical base64 Ed25519 signature are required." });
    return;
  }
  const domain = solanaAppDomain();
  if (!domain) {
    res.status(503).json({
      error: "Solana wallet proof domain is not configured.",
      missing: ["APP_DOMAIN or X_LINK_DOMAIN (HTTPS hostname)"],
    });
    return;
  }

  const { challengeId, signature } = req.body as { challengeId: string; signature: string };
  const ownerUserId = req.privySession.userId;
  try {
    const result = await db.transaction(async (tx): Promise<VerificationResult> => {
      const [challenge] = await tx.select().from(walletOwnershipChallenges).where(and(
        eq(walletOwnershipChallenges.id, challengeId),
        eq(walletOwnershipChallenges.ownerUserId, ownerUserId),
        eq(walletOwnershipChallenges.chainId, SOLANA_MAINNET_CHAIN_ID),
        eq(walletOwnershipChallenges.intent, SOLANA_OWNERSHIP_INTENT),
        isNull(walletOwnershipChallenges.consumedAt),
      )).for("update").limit(1);
      const now = new Date();
      if (!challenge || !isSolanaOwnershipChallengeUsable(challenge, now.getTime())) {
        return { status: "invalid" };
      }

      const messageFields = parseSolanaOwnershipMessage(challenge.message);
      const expectedMessage = messageFields && createSolanaOwnershipMessage({
        domain,
        ownerUserId,
        walletAddress: challenge.walletAddress,
        challengeId: challenge.id,
        nonce: messageFields.nonce,
        issuedAt: challenge.createdAt,
        expiresAt: challenge.expiresAt,
      });
      if (
        !messageFields ||
        messageFields.domain !== domain ||
        messageFields.challengeId !== challenge.id ||
        hashSolanaChallengeNonce(messageFields.nonce) !== challenge.nonceHash ||
        messageFields.issuedAt.getTime() !== challenge.createdAt.getTime() ||
        messageFields.expiresAt.getTime() !== challenge.expiresAt.getTime() ||
        messageFields.walletAddress !== challenge.walletAddress ||
        messageFields.ownerUserId !== ownerUserId ||
        challenge.message !== expectedMessage ||
        !verifySolanaOwnershipSignature({
          walletAddress: challenge.walletAddress,
          message: challenge.message,
          signature,
        })
      ) {
        return { status: "invalid" };
      }

      const [consumed] = await tx.update(walletOwnershipChallenges).set({
        consumedAt: now,
      }).where(and(
        eq(walletOwnershipChallenges.id, challenge.id),
        isNull(walletOwnershipChallenges.consumedAt),
      )).returning({ id: walletOwnershipChallenges.id });
      if (!consumed) return { status: "invalid" };

      const [byAddress] = await tx.select().from(verifiedWalletOwnerships).where(and(
        eq(verifiedWalletOwnerships.walletAddress, challenge.walletAddress),
        eq(verifiedWalletOwnerships.chainId, SOLANA_MAINNET_CHAIN_ID),
        isNull(verifiedWalletOwnerships.revokedAt),
      )).for("update").limit(1);
      if (byAddress && byAddress.ownerUserId !== ownerUserId) {
        return { status: "conflict" };
      }

      const [byOwner] = await tx.select().from(verifiedWalletOwnerships).where(and(
        eq(verifiedWalletOwnerships.ownerUserId, ownerUserId),
        eq(verifiedWalletOwnerships.chainId, SOLANA_MAINNET_CHAIN_ID),
        isNull(verifiedWalletOwnerships.revokedAt),
      )).for("update").limit(1);
      if (byOwner && byOwner.walletAddress !== challenge.walletAddress) {
        return { status: "conflict" };
      }

      if (byAddress) {
        return {
          status: "verified",
          walletAddress: byAddress.walletAddress,
          verifiedAt: byAddress.verifiedAt,
        };
      }
      const [ownership] = await tx.insert(verifiedWalletOwnerships).values({
        id: randomUUID(),
        ownerUserId,
        walletAddress: challenge.walletAddress,
        chainId: SOLANA_MAINNET_CHAIN_ID,
        verifiedAt: now,
      }).returning({
        walletAddress: verifiedWalletOwnerships.walletAddress,
        verifiedAt: verifiedWalletOwnerships.verifiedAt,
      });
      if (!ownership) throw new Error("Solana wallet ownership was not persisted.");
      return { status: "verified", ...ownership };
    });

    if (result.status === "invalid") {
      res.status(400).json({ error: "Invalid, expired, replayed, or mismatched Solana ownership proof." });
      return;
    }
    if (result.status === "conflict") {
      res.status(409).json({ error: "This Solana wallet or owner already has a different verified mainnet wallet." });
      return;
    }
    res.json({
      verified: true,
      walletAddress: result.walletAddress,
      chainId: SOLANA_MAINNET_CHAIN_ID,
      verifiedAt: result.verifiedAt,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      res.status(409).json({ error: "This Solana wallet or owner already has a different verified mainnet wallet." });
      return;
    }
    req.log.error({ error }, "Solana wallet ownership verification unavailable");
    res.status(503).json({ error: "Solana wallet ownership verification is temporarily unavailable." });
  }
});

export default router;