import type { NextFunction, Request, Response } from "express";
import { PrivyClient } from "@privy-io/node";
import { isInternalMcpCall, lookupAccessToken } from "./mcp-oauth";

export type VerifiedPrivySession = {
  provider: "privy";
  userId: string;
  sessionId: string;
  verifiedAt: string;
};

declare global {
  namespace Express {
    interface Request {
      privySession?: VerifiedPrivySession;
    }
  }
}

const appId = process.env.PRIVY_APP_ID;
const appSecret = process.env.PRIVY_APP_SECRET;
const verificationKey = process.env.PRIVY_VERIFICATION_KEY;

const privyClient =
  appId && appSecret
    ? new PrivyClient({
        appId,
        appSecret,
        ...(verificationKey ? { jwtVerificationKey: verificationKey } : {}),
      })
    : undefined;

export function privyConfiguration() {
  return {
    configured: Boolean(privyClient),
    missing: [
      !appId && "PRIVY_APP_ID",
      !appSecret && "PRIVY_APP_SECRET",
    ].filter((value): value is string => Boolean(value)),
  };
}

export async function requirePrivySession(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.get("authorization");
  if (isInternalMcpCall(req)) {
    const mcpToken = header && /^Bearer\s+\S+$/i.test(header) ? header.replace(/^Bearer\s+/i, "") : "";
    const ctx = mcpToken ? await lookupAccessToken(mcpToken).catch(() => null) : null;
    if (!ctx) {
      res.status(401).json({ error: "The connector token is invalid or expired." });
      return;
    }
    req.privySession = {
      provider: "privy",
      userId: ctx.ownerUserId,
      sessionId: `mcp:${ctx.tokenId}`,
      verifiedAt: new Date().toISOString(),
    };
    next();
    return;
  }

  if (!privyClient) {
    res.status(503).json({
      error: "Privy server verification is not configured.",
      missing: privyConfiguration().missing,
    });
    return;
  }

  const token =
    header && /^Bearer\s+\S+$/i.test(header)
      ? header.replace(/^Bearer\s+/i, "")
      : undefined;
  if (!token) {
    res.status(401).json({ error: "A Privy Bearer access token is required." });
    return;
  }

  try {
    const verified = await privyClient.utils().auth().verifyAccessToken(token);
    req.privySession = {
      provider: "privy",
      userId: verified.user_id,
      sessionId: verified.session_id,
      verifiedAt: new Date().toISOString(),
    };
    next();
  } catch (error) {
    req.log.warn({ error }, "Privy access-token verification failed");
    res.status(401).json({ error: "The Privy access token is invalid or expired." });
  }
}

/** Server-side read of the X account Privy has verified for this user. */
export async function getPrivyLinkedX(userId: string): Promise<{ xAccountId: string; xUsername: string | null } | null> {
  if (!privyClient) throw new Error("Privy server verification is not configured.");
  const user = await privyClient.users()._get(userId);
  const account = (user.linked_accounts as Array<{ type: string; subject?: string; username?: string | null }>)
    .find((a) => a.type === "twitter_oauth" && typeof a.subject === "string" && /^\d{1,30}$/.test(a.subject));
  return account ? { xAccountId: account.subject!, xUsername: account.username ?? null } : null;
}
