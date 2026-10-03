import { createHmac } from "node:crypto";

/** Shared bearer secret between the credit API and its own router/settlement endpoints, derived from SESSION_SECRET. */
export function internalToken(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is required for the internal credit service");
  return createHmac("sha256", secret).update("accred-internal-credit-service").digest("hex");
}

/** Points the credit API at its own endpoints unless an external router or signer is configured explicitly. */
export function configureInternalCreditService(): void {
  const host = process.env.APP_DOMAIN?.trim();
  if (!host || !process.env.SESSION_SECRET || !process.env.CASHBACK_PRIVATE_KEY) return;
  const token = internalToken();
  process.env.CREDIT_ROUTER_ALLOWED_HOSTS ??= host;
  process.env.CREDIT_SETTLEMENT_ALLOWED_HOSTS ??= host;
  process.env.CREDIT_ROUTER_QUOTE_URL ??= `https://${host}/api/internal/credit/quote`;
  process.env.CREDIT_SETTLEMENT_SERVICE_URL ??= `https://${host}/api/internal/credit/settlement`;
  process.env.CREDIT_ROUTER_AUTH_TOKEN ??= token;
  process.env.CREDIT_SETTLEMENT_SERVICE_TOKEN ??= token;
}
