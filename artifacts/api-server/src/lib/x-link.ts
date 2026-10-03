import { createHash, randomBytes } from "node:crypto";
import { getAddress, verifyMessage } from "ethers";

export const X_OAUTH_SCOPES = ["users.read", "tweet.read", "offline.access"] as const;
const CHALLENGE_TTL_MS = 5 * 60_000;
const OAUTH_TTL_MS = 10 * 60_000;

export function xLinkConfig(env = process.env) {
  const clientId = env.X_CLIENT_ID?.trim();
  const redirectUri = env.X_REDIRECT_URI?.trim();
  const domain = env.X_LINK_DOMAIN?.trim();
  const returnUrl = env.X_RETURN_URL?.trim();
  const missing = [
    !clientId && "X_CLIENT_ID",
    !redirectUri && "X_REDIRECT_URI",
    !domain && "X_LINK_DOMAIN",
  ].filter((item): item is string => Boolean(item));
  if (redirectUri && !redirectUri.startsWith("https://")) missing.push("X_REDIRECT_URI(HTTPS)");
  const safeReturnUrl = returnUrl && returnUrl.startsWith("https://") ? returnUrl : undefined;
  return { clientId, redirectUri, domain, returnUrl: safeReturnUrl, missing, configured: missing.length === 0 };
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}
export function hashToken(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
export function challengeExpiresAt(now = Date.now()) {
  return new Date(now + CHALLENGE_TTL_MS);
}
export function oauthExpiresAt(now = Date.now()) {
  return new Date(now + OAUTH_TTL_MS);
}
export function challengeMessage({ domain, userId, walletAddress, chainId, nonce, intent }: {
  domain: string; userId: string; walletAddress: string; chainId: string; nonce: string; intent: string;
}) {
  return `${domain} wants you to sign in with your Ethereum account:\n${getAddress(walletAddress)}\n\nAccred wallet ownership\n\nUser: ${userId}\nChain ID: ${chainId}\nIntent: ${intent}\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}\n\nThis signature proves control of this wallet for this one-time request. It does not authorize a transaction.`;
}
export function verifyWalletSignature(message: string, signature: string, expectedAddress: string) {
  try {
    return getAddress(verifyMessage(message, signature)) === getAddress(expectedAddress);
  } catch {
    return false;
  }
}
export function pkceChallenge(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}
export function buildXAuthorizeUrl({ clientId, redirectUri, state, codeChallenge }: {
  clientId: string; redirectUri: string; state: string; codeChallenge: string;
}) {
  const query = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: redirectUri,
    scope: X_OAUTH_SCOPES.join(" "), state, code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return `https://x.com/i/oauth2/authorize?${query}`;
}

export function isOAuthBrowserBindingValid(record: {
  stateHash: string; browserCookieHash: string; generation: bigint;
  consumedAt: Date | null; expiresAt: Date;
}, state: string, browserCookie: string, ownerGeneration: bigint, now = Date.now()) {
  return Boolean(
    !record.consumedAt &&
    record.expiresAt.getTime() > now &&
    record.stateHash === hashToken(state) &&
    record.browserCookieHash === hashToken(browserCookie) &&
    record.generation === ownerGeneration,
  );
}