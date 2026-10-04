import { createHash, randomUUID } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { db, mcpOauthClients, mcpOauthRequests, mcpOauthTokens } from "@workspace/db";
import { requirePrivySession } from "../lib/privy-auth";
import {
  ACCESS_TOKEN_PREFIX, ACCESS_TTL_SECONDS, REFRESH_TOKEN_PREFIX, REFRESH_TTL_SECONDS,
  newSecret, publicOrigin, sha256,
} from "../lib/mcp-oauth";

const router: IRouter = Router();
const REQUEST_TTL_MS = 10 * 60 * 1000;

function oauthError(res: Response, status: number, error: string, description: string): void {
  res.status(status).set("Cache-Control", "no-store").json({ error, error_description: description });
}

function str(value: unknown, max = 2048): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

function validRedirect(uri: string): boolean {
  try {
    const url = new URL(uri);
    if (url.hash) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

router.get("/.well-known/oauth-protected-resource", (req, res) => {
  const origin = publicOrigin(req);
  res.json({
    resource: `${origin}/api/mcp`,
    authorization_servers: [`${origin}/api`],
    bearer_methods_supported: ["header"],
    resource_name: "Accred",
  });
});

function authServerMetadata(req: Request, res: Response): void {
  const origin = publicOrigin(req);
  res.json({
    issuer: `${origin}/api`,
    authorization_endpoint: `${origin}/api/oauth/authorize`,
    token_endpoint: `${origin}/api/oauth/token`,
    registration_endpoint: `${origin}/api/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  });
}
router.get("/.well-known/oauth-authorization-server", authServerMetadata);
router.get("/.well-known/oauth-authorization-server/api", authServerMetadata);

router.post("/oauth/register", async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  if (uris.length < 1 || uris.length > 10 || !uris.every((u) => typeof u === "string" && u.length <= 2048 && validRedirect(u))) {
    oauthError(res, 400, "invalid_redirect_uri", "Provide 1-10 valid https (or localhost) redirect URIs.");
    return;
  }
  const clientName = str(body.client_name, 100) ?? "MCP client";
  const id = `mcp_client_${randomUUID()}`;
  await db.insert(mcpOauthClients).values({ id, clientName, redirectUris: JSON.stringify(uris) });
  res.status(201).json({
    client_id: id,
    client_name: clientName,
    redirect_uris: uris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
});

router.get("/oauth/authorize", async (req, res): Promise<void> => {
  const clientId = str(req.query.client_id, 200);
  const redirectUri = str(req.query.redirect_uri);
  const challenge = str(req.query.code_challenge, 200);
  if (!clientId || !redirectUri) {
    res.status(400).send("Invalid authorization request.");
    return;
  }
  const [client] = await db.select().from(mcpOauthClients).where(eq(mcpOauthClients.id, clientId)).limit(1);
  const allowed: string[] = client ? JSON.parse(client.redirectUris) : [];
  if (!client || !allowed.includes(redirectUri)) {
    res.status(400).send("Unknown client or redirect URI.");
    return;
  }
  const state = str(req.query.state, 1024);
  const back = (error: string) => {
    const url = new URL(redirectUri);
    url.searchParams.set("error", error);
    if (state) url.searchParams.set("state", state);
    res.redirect(url.toString());
  };
  if (req.query.response_type !== "code") return back("unsupported_response_type");
  if (!challenge || req.query.code_challenge_method !== "S256") return back("invalid_request");
  const id = randomUUID();
  await db.insert(mcpOauthRequests).values({
    id, clientId, redirectUri, state, codeChallenge: challenge,
    expiresAt: new Date(Date.now() + REQUEST_TTL_MS),
  });
  res.redirect(`${publicOrigin(req)}/connect?request=${id}`);
});

async function loadPendingRequest(id: string) {
  const [row] = await db.select({
    id: mcpOauthRequests.id,
    clientId: mcpOauthRequests.clientId,
    redirectUri: mcpOauthRequests.redirectUri,
    state: mcpOauthRequests.state,
    clientName: mcpOauthClients.clientName,
  }).from(mcpOauthRequests)
    .innerJoin(mcpOauthClients, eq(mcpOauthClients.id, mcpOauthRequests.clientId))
    .where(and(
      eq(mcpOauthRequests.id, id),
      isNull(mcpOauthRequests.codeHash),
      gt(mcpOauthRequests.expiresAt, new Date()),
    )).limit(1);
  return row ?? null;
}

router.get("/oauth/request/:id", async (req, res): Promise<void> => {
  const row = await loadPendingRequest(String(req.params.id));
  if (!row) {
    res.status(404).json({ error: "This connection request has expired. Start again from your AI app." });
    return;
  }
  res.json({ clientName: row.clientName });
});

router.post("/oauth/approve", requirePrivySession, async (req, res): Promise<void> => {
  const requestId = str((req.body as { requestId?: unknown } | undefined)?.requestId, 100);
  const row = requestId ? await loadPendingRequest(requestId) : null;
  if (!row || !requestId) {
    res.status(404).json({ error: "This connection request has expired. Start again from your AI app." });
    return;
  }
  const code = newSecret("mcp_code_");
  const claimed = await db.update(mcpOauthRequests)
    .set({ ownerUserId: req.privySession!.userId, codeHash: sha256(code), expiresAt: new Date(Date.now() + 5 * 60 * 1000) })
    .where(and(eq(mcpOauthRequests.id, requestId), isNull(mcpOauthRequests.codeHash)))
    .returning({ id: mcpOauthRequests.id });
  if (claimed.length === 0) {
    res.status(409).json({ error: "This connection request was already used." });
    return;
  }
  const url = new URL(row.redirectUri);
  url.searchParams.set("code", code);
  if (row.state) url.searchParams.set("state", row.state);
  res.json({ redirectUrl: url.toString() });
});

function pkceMatches(verifier: string, challenge: string): boolean {
  return createHash("sha256").update(verifier).digest("base64url") === challenge;
}

async function issueTokens(clientId: string, ownerUserId: string, res: Response, tokenId?: string): Promise<void> {
  const access = newSecret(ACCESS_TOKEN_PREFIX);
  const refresh = newSecret(REFRESH_TOKEN_PREFIX);
  const now = Date.now();
  const values = {
    accessHash: sha256(access),
    refreshHash: sha256(refresh),
    accessExpiresAt: new Date(now + ACCESS_TTL_SECONDS * 1000),
    refreshExpiresAt: new Date(now + REFRESH_TTL_SECONDS * 1000),
  };
  if (tokenId) {
    await db.update(mcpOauthTokens).set(values).where(eq(mcpOauthTokens.id, tokenId));
  } else {
    await db.insert(mcpOauthTokens).values({ id: randomUUID(), clientId, ownerUserId, ...values });
  }
  res.set("Cache-Control", "no-store").json({
    access_token: access,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_SECONDS,
    refresh_token: refresh,
  });
}

router.post("/oauth/token", async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const clientId = str(body.client_id, 200);
  if (!clientId) return oauthError(res, 400, "invalid_client", "client_id is required.");

  if (body.grant_type === "authorization_code") {
    const code = str(body.code, 200);
    const verifier = str(body.code_verifier, 200);
    const redirectUri = str(body.redirect_uri);
    if (!code || !verifier || !redirectUri) return oauthError(res, 400, "invalid_request", "code, code_verifier and redirect_uri are required.");
    // Single use: mark used atomically before issuing anything.
    const [row] = await db.update(mcpOauthRequests)
      .set({ usedAt: new Date() })
      .where(and(
        eq(mcpOauthRequests.codeHash, sha256(code)),
        eq(mcpOauthRequests.clientId, clientId),
        isNull(mcpOauthRequests.usedAt),
        gt(mcpOauthRequests.expiresAt, new Date()),
      )).returning();
    if (!row || !row.ownerUserId || row.redirectUri !== redirectUri || !pkceMatches(verifier, row.codeChallenge)) {
      return oauthError(res, 400, "invalid_grant", "The authorization code is invalid or expired.");
    }
    return issueTokens(clientId, row.ownerUserId, res);
  }

  if (body.grant_type === "refresh_token") {
    const refresh = str(body.refresh_token, 200);
    if (!refresh || !refresh.startsWith(REFRESH_TOKEN_PREFIX)) return oauthError(res, 400, "invalid_grant", "The refresh token is invalid.");
    const [row] = await db.select().from(mcpOauthTokens).where(and(
      eq(mcpOauthTokens.refreshHash, sha256(refresh)),
      eq(mcpOauthTokens.clientId, clientId),
      isNull(mcpOauthTokens.revokedAt),
      gt(mcpOauthTokens.refreshExpiresAt, new Date()),
    )).limit(1);
    if (!row) return oauthError(res, 400, "invalid_grant", "The refresh token is invalid or expired.");
    return issueTokens(clientId, row.ownerUserId, res, row.id);
  }

  oauthError(res, 400, "unsupported_grant_type", "Use authorization_code or refresh_token.");
});

export default router;
