import { createHash } from "node:crypto";
import { eq, and, isNull } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import { db, platformApiKeys } from "@workspace/db";

export type PlatformApiKeyContext = { id: string; ownerUserId: string; walletAddress: string | null };

declare global {
  namespace Express {
    interface Request {
      platformApiKey?: PlatformApiKeyContext;
    }
  }
}

export function hashPlatformKey(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** Key from X-Platform-API-Key, Authorization: Bearer, or x-api-key (Anthropic clients). */
export function extractPlatformKey(req: Request): string | undefined {
  const direct = req.get("x-platform-api-key")?.trim();
  if (direct) return direct;
  const bearer = /^Bearer\s+(.+)$/i.exec((req.get("authorization") ?? "").trim())?.[1]?.trim();
  if (bearer) return bearer;
  return req.get("x-api-key")?.trim() || undefined;
}

export function isPlausiblePlatformKey(secret: string | undefined): secret is string {
  return Boolean(secret && secret.length >= 24 && secret.length <= 256);
}

/** Looks up an active (non-revoked) platform key. Throws if the database is unavailable. */
export async function findPlatformApiKey(secret: string): Promise<PlatformApiKeyContext | undefined> {
  const [key] = await db.select({
    id: platformApiKeys.id,
    ownerUserId: platformApiKeys.ownerUserId,
    walletAddress: platformApiKeys.walletAddress,
  }).from(platformApiKeys).where(and(
    eq(platformApiKeys.keyHash, hashPlatformKey(secret)),
    isNull(platformApiKeys.revokedAt),
  )).limit(1);
  return key;
}

export async function requirePlatformApiKey(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const secret = extractPlatformKey(req);
  if (!isPlausiblePlatformKey(secret)) {
    res.status(401).json({ error: "A platform API key is required." });
    return;
  }
  try {
    const key = await findPlatformApiKey(secret);
    if (!key) {
      res.status(401).json({ error: "The platform API key is invalid or revoked." });
      return;
    }
    req.platformApiKey = key;
    next();
  } catch (error) {
    req.log.error({ error }, "Platform API key lookup failed");
    res.status(503).json({ error: "The platform API key service is unavailable." });
  }
}