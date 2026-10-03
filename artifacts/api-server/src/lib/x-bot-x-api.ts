import { createHmac, randomBytes } from "node:crypto";
import type { XBotConfiguration } from "./x-bot-config";

const X_API = "https://api.x.com/2";

export class XBotApiError extends Error {
  readonly statusCode?: number;

  constructor(
    message: string,
    statusCode?: number,
  ) {
    super(message);
    this.name = "XBotApiError";
    this.statusCode = statusCode;
  }
}

async function readPayload(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function fetchCanonicalXTweet(
  mentionId: string,
  config: XBotConfiguration,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string; authorId: string; text: string }> {
  if (!/^\d{1,30}$/.test(mentionId)) throw new XBotApiError("Invalid X tweet ID.", 400);
  if (!config.bearerToken) {
    throw new XBotApiError("X API is not configured; set X_API_BEARER_TOKEN.", 503);
  }
  const query = new URLSearchParams({ "tweet.fields": "author_id,text,created_at" });
  const response = await fetchImpl(`${X_API}/tweets/${encodeURIComponent(mentionId)}?${query}`, {
    headers: { authorization: `Bearer ${config.bearerToken}` },
  });
  const payload = await readPayload(response);
  const data = payload.data as { id?: unknown; author_id?: unknown; text?: unknown } | undefined;
  if (!response.ok) {
    throw new XBotApiError(
      response.status === 404 ? "Canonical X tweet was not found." : "Could not verify canonical X tweet.",
      response.status,
    );
  }
  if (data?.id !== mentionId || typeof data.author_id !== "string" || typeof data.text !== "string") {
    throw new XBotApiError("Canonical X tweet response was incomplete.", 502);
  }
  return { id: data.id, authorId: data.author_id, text: data.text };
}

export async function checkXBotConnectivity(
  config: XBotConfiguration,
  fetchImpl: typeof fetch = fetch,
): Promise<"connected" | "unavailable" | "not_configured"> {
  if (!config.bearerToken || !config.userId) return "not_configured";
  try {
    const response = await fetchImpl(
      `${X_API}/users/${encodeURIComponent(config.userId)}?user.fields=id`,
      { headers: { authorization: `Bearer ${config.bearerToken}` } },
    );
    if (!response.ok) return "unavailable";
    const payload = await readPayload(response);
    return (payload.data as { id?: unknown } | undefined)?.id === config.userId
      ? "connected"
      : "unavailable";
  } catch {
    return "unavailable";
  }
}

/** OAuth 1.0a (HMAC-SHA1) header. Access tokens never expire, so no refresh is needed. JSON bodies are not part of the signature. */
function oauth1Header(method: string, url: string, c: XBotConfiguration): string {
  const enc = (v: string) => encodeURIComponent(v).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  const params: Record<string, string> = {
    oauth_consumer_key: c.apiKey!,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: c.userAccessToken!,
    oauth_version: "1.0",
  };
  const paramString = Object.keys(params).sort().map((k) => `${enc(k)}=${enc(params[k])}`).join("&");
  const base = [method, enc(url), enc(paramString)].join("&");
  params.oauth_signature = createHmac("sha1", `${enc(c.apiSecret!)}&${enc(c.accessTokenSecret!)}`).update(base).digest("base64");
  return "OAuth " + Object.keys(params).sort().map((k) => `${enc(k)}="${enc(params[k])}"`).join(", ");
}

export async function postXBotReply(
  inReplyToTweetId: string,
  text: string,
  config: XBotConfiguration,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!config.postingEnabled) throw new XBotApiError("X posting is disabled.", 503);
  if (!config.userAccessToken || !config.apiKey || !config.apiSecret || !config.accessTokenSecret) {
    throw new XBotApiError("X reply posting is not configured; set X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET.", 503);
  }
  if (!/^\d{1,30}$/.test(inReplyToTweetId) || !text.trim() || text.length > 280) {
    throw new XBotApiError("Invalid X reply payload.", 400);
  }
  const response = await fetchImpl(`${X_API}/tweets`, {
    method: "POST",
    headers: {
      authorization: oauth1Header("POST", `${X_API}/tweets`, config),
      "content-type": "application/json",
    },
    body: JSON.stringify({ text, reply: { in_reply_to_tweet_id: inReplyToTweetId } }),
  });
  const payload = await readPayload(response);
  const id = (payload.data as { id?: unknown } | undefined)?.id;
  if (!response.ok) {
    throw new XBotApiError("X reply outcome could not be safely confirmed.", response.status);
  }
  if (typeof id !== "string" || !/^\d{1,30}$/.test(id)) {
    throw new XBotApiError("X reply outcome could not be safely confirmed.", response.status);
  }
  return id;
}