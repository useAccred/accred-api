import assert from "node:assert/strict";
import test from "node:test";
import { Wallet } from "ethers";
import {
  buildXAuthorizeUrl,
  challengeMessage,
  hashToken,
  pkceChallenge,
  randomToken,
  verifyWalletSignature,
  xLinkConfig,
  isOAuthBrowserBindingValid,
} from "./x-link.ts";

test("wallet challenge binds domain, Privy user, chain, intent and random nonce", async () => {
  const wallet = Wallet.createRandom();
  const nonce = randomToken();
  const message = challengeMessage({
    domain: "terminal.example",
    userId: "did:privy:user",
    walletAddress: wallet.address,
    chainId: "4663",
    intent: "link_x",
    nonce,
  });
  const signature = await wallet.signMessage(message);
  assert.equal(verifyWalletSignature(message, signature, wallet.address), true);
  assert.equal(verifyWalletSignature(`${message} altered`, signature, wallet.address), false);
  assert.equal(verifyWalletSignature(message, signature, Wallet.createRandom().address), false);
  assert.notEqual(hashToken(randomToken()), hashToken(randomToken()));
});

test("X authorization uses PKCE S256, state and HTTPS redirect", () => {
  const verifier = randomToken();
  const url = new URL(buildXAuthorizeUrl({
    clientId: "client", redirectUri: "https://terminal.example/api/auth/x/callback",
    state: randomToken(), codeChallenge: pkceChallenge(verifier),
  }));
  assert.equal(url.hostname, "x.com");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("scope"), "users.read tweet.read offline.access");
  assert.equal(xLinkConfig({ X_CLIENT_ID: "client", X_REDIRECT_URI: "http://insecure/cb", X_LINK_DOMAIN: "terminal.example" }).configured, false);
});

test("missing X setup fails closed", () => {
  const config = xLinkConfig({});
  assert.equal(config.configured, false);
  assert.deepEqual(config.missing, ["X_CLIENT_ID", "X_REDIRECT_URI", "X_LINK_DOMAIN"]);
});

test("browser binding rejects forwarded links, missing/wrong cookies, replay and unlink generation races", () => {
  const state = randomToken();
  const cookie = randomToken();
  const record = {
    stateHash: hashToken(state),
    browserCookieHash: hashToken(cookie),
    generation: 3n,
    consumedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
  };
  assert.equal(isOAuthBrowserBindingValid(record, state, cookie, 3n), true);
  assert.equal(isOAuthBrowserBindingValid(record, state, randomToken(), 3n), false);
  assert.equal(isOAuthBrowserBindingValid(record, state, "", 3n), false);
  assert.equal(isOAuthBrowserBindingValid({ ...record, consumedAt: new Date() }, state, cookie, 3n), false);
  assert.equal(isOAuthBrowserBindingValid(record, state, cookie, 4n), false);
  assert.equal(isOAuthBrowserBindingValid({ ...record, expiresAt: new Date(Date.now() - 1) }, state, cookie, 3n), false);
});