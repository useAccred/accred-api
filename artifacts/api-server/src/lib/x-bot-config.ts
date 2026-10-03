import { createHmac } from "node:crypto";

export type XBotConfiguration = {
  bearerToken?: string;
  serviceToken?: string;
  userAccessToken?: string;
  apiKey?: string;
  apiSecret?: string;
  accessTokenSecret?: string;
  userId?: string;
  dashboardUrl?: string;
  postingEnabled: boolean;
  missing: string[];
  configured: boolean;
};

export function xBotConfig(env = process.env): XBotConfiguration {
  const bearerToken = env.X_API_BEARER_TOKEN?.trim() || undefined;
  // Internal poller -> route token. Derived from SESSION_SECRET unless explicitly set, so no extra secret is needed.
  const session = env.SESSION_SECRET?.trim();
  const serviceToken = env.X_BOT_SERVICE_TOKEN?.trim() ||
    (session ? createHmac("sha256", session).update("x-bot-service-token").digest("hex") : undefined);
  const userAccessToken = env.X_ACCESS_TOKEN?.trim() || undefined;
  const apiKey = env.X_API_KEY?.trim() || undefined;
  const apiSecret = env.X_API_SECRET?.trim() || undefined;
  const accessTokenSecret = env.X_ACCESS_TOKEN_SECRET?.trim() || undefined;
  const userId = env.X_USER_ID?.trim() || undefined;
  const rawDashboardUrl = env.X_DASHBOARD_URL?.trim();
  let dashboardUrl: string | undefined;
  try {
    const parsedUrl = rawDashboardUrl ? new URL(rawDashboardUrl) : undefined;
    if (
      parsedUrl?.protocol === "https:" &&
      !parsedUrl.username &&
      !parsedUrl.password &&
      !parsedUrl.search &&
      !parsedUrl.hash &&
      rawDashboardUrl!.length <= 200
    ) {
      dashboardUrl = parsedUrl.toString().replace(/\/$/, "");
    }
  } catch {
    // Invalid user-facing handoff URLs are reported through the missing list.
  }
  const postingEnabled = env.X_BOT_POSTING_ENABLED === "true";
  const missing = [
    !bearerToken && "X_API_BEARER_TOKEN",
    !serviceToken && "X_BOT_SERVICE_TOKEN",
    !userId && "X_USER_ID",
    !dashboardUrl && (rawDashboardUrl ? "X_DASHBOARD_URL(HTTPS_PATH_ONLY_MAX_200)" : "X_DASHBOARD_URL"),
    postingEnabled && !apiKey && "X_API_KEY",
    postingEnabled && !apiSecret && "X_API_SECRET",
    postingEnabled && !userAccessToken && "X_ACCESS_TOKEN",
    postingEnabled && !accessTokenSecret && "X_ACCESS_TOKEN_SECRET",
  ].filter((name): name is string => Boolean(name));
  return {
    bearerToken,
    serviceToken,
    userAccessToken,
    apiKey,
    apiSecret,
    accessTokenSecret,
    userId,
    dashboardUrl,
    postingEnabled,
    missing,
    configured: missing.length === 0,
  };
}