import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Request } from "express";
import { db, mcpOauthTokens } from "@workspace/db";

export const ACCESS_TOKEN_PREFIX = "mcp_at_";
export const REFRESH_TOKEN_PREFIX = "mcp_rt_";
export const ACCESS_TTL_SECONDS = 60 * 60;
export const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 30;

/**
 * Per-process secret. MCP access tokens are only honoured on the regular API
 * routes when the call comes from this process's own MCP handler, so a leaked
 * connector token cannot be replayed against wallet or quote endpoints.
 */
export const MCP_INTERNAL_SECRET = randomBytes(32).toString("hex");

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function newSecret(prefix: string): string {
  return prefix + randomBytes(32).toString("base64url");
}

export function isInternalMcpCall(req: Request): boolean {
  const supplied = req.get("x-mcp-internal");
  if (!supplied) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(MCP_INTERNAL_SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type McpTokenContext = { tokenId: string; ownerUserId: string; clientId: string };

export async function lookupAccessToken(token: string): Promise<McpTokenContext | null> {
  if (!token.startsWith(ACCESS_TOKEN_PREFIX) || token.length > 200) return null;
  const [row] = await db.select({
    id: mcpOauthTokens.id,
    ownerUserId: mcpOauthTokens.ownerUserId,
    clientId: mcpOauthTokens.clientId,
  }).from(mcpOauthTokens).where(and(
    eq(mcpOauthTokens.accessHash, sha256(token)),
    isNull(mcpOauthTokens.revokedAt),
    gt(mcpOauthTokens.accessExpiresAt, new Date()),
  )).limit(1);
  return row ? { tokenId: row.id, ownerUserId: row.ownerUserId, clientId: row.clientId } : null;
}

export function publicOrigin(req: Request): string {
  const proto = (req.get("x-forwarded-proto") ?? req.protocol ?? "https").split(",")[0]!.trim();
  const host = (req.get("x-forwarded-host") ?? req.get("host") ?? "").split(",")[0]!.trim();
  return `${proto}://${host}`;
}
