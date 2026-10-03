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

export async function requirePlatformApiKey(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const secret = req.get("x-platform-api-key");
  if (!secret || secret.length < 24 || secret.length > 256) {
    res.status(401).json({ error: "A platform API key is required." });
    return;
  }
  try {
    const [key] = await db.select({
      id: platformApiKeys.id,
      ownerUserId: platformApiKeys.ownerUserId,
      walletAddress: platformApiKeys.walletAddress,
    }).from(platformApiKeys).where(and(
      eq(platformApiKeys.keyHash, hashPlatformKey(secret)),
      isNull(platformApiKeys.revokedAt),
    )).limit(1);
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