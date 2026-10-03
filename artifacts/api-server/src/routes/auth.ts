import { Router, type IRouter } from "express";
import { and, asc, eq, isNull } from "drizzle-orm";
import {
  CreateWalletOwnershipChallengeBody,
  GetAuthenticatedSessionResponse,
  VerifyWalletOwnershipChallengeBody,
  CreateWalletOwnershipChallengeResponse,
  VerifyWalletOwnershipChallengeResponse,
  CompleteXAccountLinkResponse,
} from "@workspace/api-zod";
import { db, verifiedWalletOwnerships, walletOwnershipChallenges, verifiedXAccounts, xLinkOwnerGenerations, xOauthLinkStates } from "@workspace/db";
import { randomToken, hashToken, challengeExpiresAt, oauthExpiresAt, challengeMessage, verifyWalletSignature, xLinkConfig, pkceChallenge, buildXAuthorizeUrl, isOAuthBrowserBindingValid } from "../lib/x-link";
import { randomUUID } from "node:crypto";
import { requirePrivySession, getPrivyLinkedX } from "../lib/privy-auth";

const router: IRouter = Router();
const EVM_WALLET_CHAIN_ID = "4663";
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]!));

function walletOwnershipAppDomain(): string | undefined {
  const raw = process.env.APP_DOMAIN?.trim() || process.env.X_LINK_DOMAIN?.trim();
  if (!raw || /[\r\n\s]/.test(raw)) return undefined;
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
    ) return undefined;
    return url.host.toLowerCase();
  } catch {
    return undefined;
  }
}

router.get("/auth/me", requirePrivySession, (req, res) => {
  res.json(GetAuthenticatedSessionResponse.parse(req.privySession));
});

router.get("/auth/wallets", requirePrivySession, async (req, res): Promise<void> => {
  if (!req.privySession) {
    res.status(401).json({ error: "Privy session required." });
    return;
  }
  try {
    const wallets = await db.select({
      walletAddress: verifiedWalletOwnerships.walletAddress,
      chainId: verifiedWalletOwnerships.chainId,
      verifiedAt: verifiedWalletOwnerships.verifiedAt,
    }).from(verifiedWalletOwnerships).where(and(
      eq(verifiedWalletOwnerships.ownerUserId, req.privySession.userId),
      isNull(verifiedWalletOwnerships.revokedAt),
    )).orderBy(asc(verifiedWalletOwnerships.verifiedAt));
    res.json({ wallets });
  } catch (error) {
    req.log.error({ error }, "Verified wallet list unavailable");
    res.status(503).json({ error: "Verified wallet list is temporarily unavailable." });
  }
});

router.post("/auth/wallet/challenge", requirePrivySession, async (req, res): Promise<void> => {
  const parsed = CreateWalletOwnershipChallengeBody.safeParse(req.body);
  if (!parsed.success || !req.privySession) {
    res.status(400).json({ error: "walletAddress, chainId and intent are required" });
    return;
  }
  if (parsed.data.chainId !== EVM_WALLET_CHAIN_ID) {
    res.status(400).json({ error: "EVM wallet ownership proofs are supported only on Robinhood Chain mainnet (4663)." });
    return;
  }
  const domain = walletOwnershipAppDomain();
  if (!domain) {
    res.status(503).json({
      error: "EVM wallet proof domain is not configured.",
      missing: ["APP_DOMAIN or X_LINK_DOMAIN (HTTPS hostname)"],
    });
    return;
  }
  const walletAddress = parsed.data.walletAddress;
  try {
    const nonce = randomToken(32);
    const message = challengeMessage({
      domain,
      userId: req.privySession.userId,
      walletAddress,
      chainId: EVM_WALLET_CHAIN_ID,
      intent: parsed.data.intent,
      nonce,
    });
    const expiresAt = challengeExpiresAt();
    const id = randomUUID();
    await db.insert(walletOwnershipChallenges).values({
      id,
      ownerUserId: req.privySession.userId,
      walletAddress: walletAddress.toLowerCase(),
      chainId: EVM_WALLET_CHAIN_ID,
      intent: parsed.data.intent,
      nonceHash: hashToken(nonce),
      message,
      expiresAt,
    });
    res.status(201).json(CreateWalletOwnershipChallengeResponse.parse({
      challengeId: id, message, walletAddress, chainId: EVM_WALLET_CHAIN_ID, expiresAt,
    }));
  } catch (error) {
    req.log.error({ error }, "Wallet challenge unavailable");
    res.status(503).json({ error: "Wallet linking is not configured or available." });
  }
});

router.post("/auth/wallet/verify", requirePrivySession, async (req, res): Promise<void> => {
  const parsed = VerifyWalletOwnershipChallengeBody.safeParse(req.body);
  if (!parsed.success || !req.privySession) {
    res.status(400).json({ error: "challengeId and an EIP-191 signature are required" });
    return;
  }
  try {
    const challenge = await db.query.walletOwnershipChallenges.findFirst({
      where: and(
        eq(walletOwnershipChallenges.id, parsed.data.challengeId),
        eq(walletOwnershipChallenges.ownerUserId, req.privySession.userId),
        eq(walletOwnershipChallenges.chainId, EVM_WALLET_CHAIN_ID),
        isNull(walletOwnershipChallenges.consumedAt),
      ),
    });
    if (!challenge || challenge.expiresAt.getTime() <= Date.now() || !verifyWalletSignature(challenge.message, parsed.data.signature, challenge.walletAddress)) {
      res.status(400).json({ error: "Invalid, expired, replayed, or mismatched wallet signature." });
      return;
    }
    const consumed = await db.update(walletOwnershipChallenges).set({ consumedAt: new Date() }).where(and(eq(walletOwnershipChallenges.id, challenge.id), isNull(walletOwnershipChallenges.consumedAt))).returning({ id: walletOwnershipChallenges.id });
    if (consumed.length !== 1) {
      res.status(400).json({ error: "This wallet challenge has already been consumed." });
      return;
    }
    const existing = await db.query.verifiedWalletOwnerships.findFirst({
      where: and(eq(verifiedWalletOwnerships.walletAddress, challenge.walletAddress), eq(verifiedWalletOwnerships.chainId, challenge.chainId), isNull(verifiedWalletOwnerships.revokedAt)),
    });
    if (existing && existing.ownerUserId !== req.privySession.userId) {
      res.status(409).json({ error: "This wallet is already verified for another user." });
      return;
    }
    const ownership = existing ?? (await db.insert(verifiedWalletOwnerships).values({
      id: randomUUID(), ownerUserId: req.privySession.userId, walletAddress: challenge.walletAddress,
      chainId: challenge.chainId, verifiedAt: new Date(),
    }).returning())[0];
    res.json(VerifyWalletOwnershipChallengeResponse.parse({
      walletAddress: ownership.walletAddress, chainId: ownership.chainId, verifiedAt: ownership.verifiedAt,
    }));
  } catch (error) {
    req.log.error({ error }, "Wallet signature verification unavailable");
    res.status(503).json({ error: "Wallet linking is temporarily unavailable." });
  }
});

router.get("/auth/x/link", requirePrivySession, async (req, res): Promise<void> => {
  const config = xLinkConfig();
  if (!config.configured || !req.privySession) {
    res.status(503).json({ error: "X OAuth linking is not configured.", missing: config.missing });
    return;
  }
  try {
    const wallet = await db.query.verifiedWalletOwnerships.findFirst({
      where: and(
        eq(verifiedWalletOwnerships.ownerUserId, req.privySession.userId),
        eq(verifiedWalletOwnerships.chainId, EVM_WALLET_CHAIN_ID),
        isNull(verifiedWalletOwnerships.revokedAt),
      ),
    });
    if (!wallet) {
      res.status(400).json({ error: "Verify wallet ownership before starting X linking." });
      return;
    }
    const state = randomToken(32);
    const verifier = randomToken(48);
    const browserCookie = randomToken(48);
    const stateHash = hashToken(state);
    const browserCookieHash = hashToken(browserCookie);
    const generation = await db.transaction(async (tx) => {
      await tx.insert(xLinkOwnerGenerations).values({ ownerUserId: req.privySession!.userId }).onConflictDoNothing();
      const [ownerGeneration] = await tx.select().from(xLinkOwnerGenerations).where(eq(xLinkOwnerGenerations.ownerUserId, req.privySession!.userId)).for("update");
      await tx.insert(xOauthLinkStates).values({
        stateHash, ownerUserId: req.privySession!.userId, walletOwnershipId: wallet.id,
        codeVerifier: verifier, redirectUri: config.redirectUri!, browserCookieHash,
        generation: ownerGeneration.generation, expiresAt: oauthExpiresAt(),
      });
      return ownerGeneration.generation;
    });
    res.cookie("credit_terminal_x_link", browserCookie, {
      httpOnly: true, secure: true, sameSite: "lax", maxAge: 10 * 60 * 1000, path: "/api/auth/x",
    });
    const authorizationUrl = buildXAuthorizeUrl({ clientId: config.clientId!, redirectUri: config.redirectUri!, state, codeChallenge: pkceChallenge(verifier) });
    if (req.accepts("json")) {
      res.json({ authorizationUrl });
      return;
    }
    res.redirect(authorizationUrl);
  } catch (error) {
    req.log.error({ error }, "X OAuth start unavailable");
    res.status(503).json({ error: "X OAuth linking is temporarily unavailable." });
  }
});

router.get("/auth/x/account", requirePrivySession, async (req, res): Promise<void> => {
  if (!req.privySession) { res.status(401).json({ error: "Privy session required." }); return; }
  try {
    const account = await db.query.verifiedXAccounts.findFirst({
      where: and(eq(verifiedXAccounts.ownerUserId, req.privySession.userId), isNull(verifiedXAccounts.revokedAt)),
    });
    if (!account) {
      res.json({ linked: false, xAccountId: null, xUsername: null, walletAddress: null, chainId: null, linkedAt: null });
      return;
    }
    const wallet = await db.query.verifiedWalletOwnerships.findFirst({
      where: and(
        eq(verifiedWalletOwnerships.id, account.walletOwnershipId),
        eq(verifiedWalletOwnerships.chainId, EVM_WALLET_CHAIN_ID),
        isNull(verifiedWalletOwnerships.revokedAt),
      ),
    });
    res.json({
      linked: Boolean(wallet), xAccountId: wallet ? account.xAccountId : null,
      xUsername: wallet ? account.xUsername : null, walletAddress: wallet?.walletAddress ?? null,
      chainId: wallet?.chainId ?? null, linkedAt: wallet ? account.linkedAt : null,
    });
  } catch (error) {
    req.log.error({ error }, "X account status unavailable");
    res.status(503).json({ error: "X account status is temporarily unavailable." });
  }
});

router.get("/auth/x/callback", async (req, res): Promise<void> => {
  const config = xLinkConfig();
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const browserCookie = req.cookies?.credit_terminal_x_link;
  if (!config.configured) {
    res.status(503).json({ error: "X OAuth linking is not configured.", missing: config.missing });
    return;
  }
  if (!code || !state) {
    res.status(400).json({ error: "Invalid X OAuth callback or unavailable configuration." });
    return;
  }
  if (!browserCookie) {
    res.status(400).json({ error: "X OAuth browser transaction cookie is missing." });
    return;
  }
  try {
    const linkState = await db.query.xOauthLinkStates.findFirst({ where: and(eq(xOauthLinkStates.stateHash, hashToken(state)), eq(xOauthLinkStates.browserCookieHash, hashToken(browserCookie)), isNull(xOauthLinkStates.consumedAt)) });
    if (!linkState || !isOAuthBrowserBindingValid(linkState, state, browserCookie, linkState.generation) || linkState.redirectUri !== config.redirectUri) {
      res.status(400).json({ error: "Invalid or expired X OAuth state." });
      return;
    }
    const wallet = await db.query.verifiedWalletOwnerships.findFirst({
      where: and(
        eq(verifiedWalletOwnerships.id, linkState.walletOwnershipId),
        eq(verifiedWalletOwnerships.ownerUserId, linkState.ownerUserId),
        eq(verifiedWalletOwnerships.chainId, EVM_WALLET_CHAIN_ID),
        isNull(verifiedWalletOwnerships.revokedAt),
      ),
    });
    if (!wallet) {
      res.status(400).json({ error: "The verified wallet for this X link is no longer active." });
      return;
    }
    const consumed = await db.transaction(async (tx) => {
      const [generation] = await tx.select().from(xLinkOwnerGenerations).where(eq(xLinkOwnerGenerations.ownerUserId, linkState.ownerUserId)).for("update");
      if (!generation || generation.generation !== linkState.generation) return [];
      return tx.update(xOauthLinkStates).set({ consumedAt: new Date() }).where(and(eq(xOauthLinkStates.stateHash, linkState.stateHash), eq(xOauthLinkStates.browserCookieHash, hashToken(browserCookie)), eq(xOauthLinkStates.generation, generation.generation), isNull(xOauthLinkStates.consumedAt))).returning({ stateHash: xOauthLinkStates.stateHash });
    });
    if (consumed.length !== 1) { res.status(400).json({ error: "X OAuth state already used, expired, or invalidated." }); return; }
    const tokenResponse = await fetch("https://api.x.com/2/oauth2/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, grant_type: "authorization_code", client_id: config.clientId!, redirect_uri: config.redirectUri!, code_verifier: linkState.codeVerifier }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!tokenResponse.ok) { res.status(400).json({ error: "X OAuth code exchange failed." }); return; }
    const tokens = await tokenResponse.json() as { access_token?: string };
    if (!tokens.access_token) { res.status(400).json({ error: "X OAuth did not return a user token." }); return; }
    const userResponse = await fetch("https://api.x.com/2/users/me", {
      headers: { authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(10_000),
    });
    if (!userResponse.ok) { res.status(400).json({ error: "X account verification failed." }); return; }
    const userPayload = await userResponse.json() as { data?: { id?: string; username?: string } };
    const xUser = userPayload.data;
    if (!xUser?.id) { res.status(400).json({ error: "X account verification returned no account." }); return; }
    const xAccountId = xUser.id;
    const linked = await db.transaction(async (tx) => {
      const [generation] = await tx.select().from(xLinkOwnerGenerations).where(eq(xLinkOwnerGenerations.ownerUserId, linkState.ownerUserId)).for("update");
      if (!generation || generation.generation !== linkState.generation) return null;
      const existing = await tx.query.verifiedXAccounts.findFirst({ where: and(eq(verifiedXAccounts.xAccountId, xAccountId), isNull(verifiedXAccounts.revokedAt)) });
      if (existing && existing.ownerUserId !== linkState.ownerUserId) throw new Error("X_ACCOUNT_COLLISION");
      if (existing) return existing;
      const [created] = await tx.insert(verifiedXAccounts).values({
        id: randomUUID(), xAccountId, xUsername: xUser.username ?? null,
        ownerUserId: linkState.ownerUserId, walletOwnershipId: linkState.walletOwnershipId, linkedAt: new Date(),
      }).returning();
      return created;
    });
    if (!linked) { res.status(400).json({ error: "X OAuth link was invalidated by unlink or a newer session." }); return; }
    const result = CompleteXAccountLinkResponse.parse({ xAccountId: linked.xAccountId, xUsername: linked.xUsername, linkedAt: linked.linkedAt });
    res.clearCookie("credit_terminal_x_link", { httpOnly: true, secure: true, sameSite: "lax", path: "/api/auth/x" });
    if (req.accepts("json")) {
      res.json(result);
      return;
    }
    const returnUrl = config.returnUrl
      ? `<a href="${escapeHtml(config.returnUrl)}">Back to Accred</a>`
      : `<p>Close this tab and return to the Accred app.</p>`;
    res.type("html").send(`<!doctype html><meta charset="utf-8"><title>X account linked</title><main><h1>X account linked</h1><p>Your verified X account is linked. No OAuth token was stored.</p>${returnUrl}</main>`);
  } catch (error) {
    if (error instanceof Error && error.message === "X_ACCOUNT_COLLISION") {
      res.status(409).json({ error: "This X account is already linked to another user." });
      return;
    }
    req.log.error({ error }, "X OAuth callback unavailable");
    res.status(503).json({ error: "X OAuth linking is temporarily unavailable." });
  }
});

/** Removes the signed-in user's verified Robinhood Chain wallet so a wallet can be verified again from scratch. */
router.post("/auth/wallet/remove", requirePrivySession, async (req, res): Promise<void> => {
  if (!req.privySession) { res.status(401).json({ error: "Privy session required." }); return; }
  try {
    const removed = await db.delete(verifiedWalletOwnerships).where(and(
      eq(verifiedWalletOwnerships.ownerUserId, req.privySession.userId),
      eq(verifiedWalletOwnerships.chainId, EVM_WALLET_CHAIN_ID),
    )).returning();
    if (!removed.length) { res.status(404).json({ error: "No verified wallet to remove." }); return; }
    res.status(204).send();
  } catch (error) {
    req.log.error({ error }, "Wallet removal unavailable");
    res.status(503).json({ error: "Wallet removal is temporarily unavailable." });
  }
});

router.post("/auth/x/privy-link", requirePrivySession, async (req, res): Promise<void> => {
  if (!req.privySession) { res.status(401).json({ error: "Privy session required." }); return; }
  try {
    const wallet = await db.query.verifiedWalletOwnerships.findFirst({
      where: and(
        eq(verifiedWalletOwnerships.ownerUserId, req.privySession.userId),
        eq(verifiedWalletOwnerships.chainId, EVM_WALLET_CHAIN_ID),
        isNull(verifiedWalletOwnerships.revokedAt),
      ),
    });
    if (!wallet) { res.status(400).json({ error: "Verify wallet ownership before linking X." }); return; }
    const x = await getPrivyLinkedX(req.privySession.userId);
    if (!x) { res.status(400).json({ error: "No X account is connected to this login yet." }); return; }
    const userId = req.privySession.userId;
    const linked = await db.transaction(async (tx) => {
      const existing = await tx.query.verifiedXAccounts.findFirst({ where: and(eq(verifiedXAccounts.xAccountId, x.xAccountId), isNull(verifiedXAccounts.revokedAt)) });
      if (existing && existing.ownerUserId !== userId) return "collision" as const;
      if (existing) return existing;
      await tx.update(verifiedXAccounts).set({ revokedAt: new Date() }).where(and(eq(verifiedXAccounts.ownerUserId, userId), isNull(verifiedXAccounts.revokedAt)));
      const [created] = await tx.insert(verifiedXAccounts).values({
        id: randomUUID(), xAccountId: x.xAccountId, xUsername: x.xUsername,
        ownerUserId: userId, walletOwnershipId: wallet.id, linkedAt: new Date(),
      }).returning();
      return created;
    });
    if (linked === "collision") { res.status(409).json({ error: "This X account is already linked to another wallet." }); return; }
    res.json({ xAccountId: linked.xAccountId, xUsername: linked.xUsername, linkedAt: linked.linkedAt });
  } catch (error) {
    req.log.error({ error }, "Privy X link unavailable");
    res.status(503).json({ error: "X linking is temporarily unavailable." });
  }
});

router.post("/auth/x/unlink", requirePrivySession, async (req, res): Promise<void> => {
  if (!req.privySession) { res.status(401).json({ error: "Privy session required." }); return; }
  try {
    const updated = await db.transaction(async (tx) => {
      await tx.insert(xLinkOwnerGenerations).values({ ownerUserId: req.privySession!.userId }).onConflictDoNothing();
      const [generation] = await tx.select().from(xLinkOwnerGenerations).where(eq(xLinkOwnerGenerations.ownerUserId, req.privySession!.userId)).for("update");
      await tx.update(xLinkOwnerGenerations).set({ generation: generation.generation + 1n, updatedAt: new Date() }).where(eq(xLinkOwnerGenerations.ownerUserId, req.privySession!.userId));
      await tx.update(xOauthLinkStates).set({ consumedAt: new Date() }).where(and(eq(xOauthLinkStates.ownerUserId, req.privySession!.userId), isNull(xOauthLinkStates.consumedAt)));
      return tx.update(verifiedXAccounts).set({ revokedAt: new Date() }).where(and(eq(verifiedXAccounts.ownerUserId, req.privySession!.userId), isNull(verifiedXAccounts.revokedAt))).returning({ id: verifiedXAccounts.id });
    });
    if (!updated.length) { res.status(404).json({ error: "No linked X account." }); return; }
    res.status(204).send();
  } catch (error) {
    req.log.error({ error }, "X unlink unavailable");
    res.status(503).json({ error: "X unlink is temporarily unavailable." });
  }
});

export default router;