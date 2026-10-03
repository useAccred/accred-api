import { randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  CreateCustomerApiKeyBody,
  CreateCustomerApiKeyResponse,
  ListCustomerApiKeysResponse,
  CreateCustomerChatCompletionBody,
  CreateCustomerChatCompletionResponse,
  ListCustomerUsageResponse,
  ListCustomerModelsResponse,
  GetCustomerAccountingResponse,
  ReconcileCustomerRequestBody,
  ReconcileCustomerRequestResponse,
} from "@workspace/api-zod";
import { db, creditUsageLedger, platformApiKeys, verifiedWalletOwnerships } from "@workspace/db";
import { requirePrivySession } from "../lib/privy-auth";
import { hashPlatformKey, requirePlatformApiKey } from "../lib/platform-api-key";
import { reconcileCustomerLedger, runCustomerCompletion } from "../lib/customer-billing";
import { listCustomerModels, microcreditsToDecimal } from "../lib/customer-models";

const router: IRouter = Router();
const apiKeyPrefix = "ct_live_";

function exactMicrocredits(value: bigint): string {
  return microcreditsToDecimal(value);
}

async function runMeteredRoute(
  req: Request,
  res: Response,
  ownerUserId: string,
  apiKeyId: string,
): Promise<void> {
  const parsed = CreateCustomerChatCompletionBody.safeParse(req.body);
  const idempotencyKey = req.get("idempotency-key");
  if (!parsed.success || !idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    res.status(400).json({ error: "Valid request body and Idempotency-Key header are required." });
    return;
  }
  const result = await runCustomerCompletion({
    ownerUserId,
    apiKeyId,
    idempotencyKey,
    request: parsed.data,
  });
  if (result.statusCode !== 200) {
    res.status(result.statusCode).json({ error: result.error });
    return;
  }
  res.json(CreateCustomerChatCompletionResponse.parse(result.response));
}

router.get("/customer/api-keys", requirePrivySession, async (req, res): Promise<void> => {
  const ownerUserId = req.privySession!.userId;
  const rows = await db.select({
    id: platformApiKeys.id,
    name: platformApiKeys.name,
    prefix: platformApiKeys.keyPrefix,
    walletAddress: platformApiKeys.walletAddress,
    createdAt: platformApiKeys.createdAt,
    revokedAt: platformApiKeys.revokedAt,
  }).from(platformApiKeys).where(eq(platformApiKeys.ownerUserId, ownerUserId))
    .orderBy(desc(platformApiKeys.createdAt));
  res.json(ListCustomerApiKeysResponse.parse(rows.map((row) => ({
    ...row,
    revoked: Boolean(row.revokedAt),
  }))));
});

router.post("/customer/api-keys", requirePrivySession, async (req, res): Promise<void> => {
  const parsed = CreateCustomerApiKeyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [wallet] = await db.select({ walletAddress: verifiedWalletOwnerships.walletAddress })
    .from(verifiedWalletOwnerships).where(and(
      eq(verifiedWalletOwnerships.ownerUserId, req.privySession!.userId),
      eq(verifiedWalletOwnerships.chainId, "4663"),
      isNull(verifiedWalletOwnerships.revokedAt),
    )).limit(1);
  if (!wallet) {
    res.status(403).json({ error: "Verify a wallet on chain 4663 before creating a metered API key." });
    return;
  }
  const secret = `${apiKeyPrefix}${randomBytes(32).toString("base64url")}`;
  const row = {
    id: randomUUID(),
    ownerUserId: req.privySession!.userId,
    name: parsed.data.name.trim(),
    keyPrefix: secret.slice(0, 17),
    keyHash: hashPlatformKey(secret),
    walletAddress: wallet.walletAddress,
  };
  await db.insert(platformApiKeys).values(row);
  res.status(201).json(CreateCustomerApiKeyResponse.parse({
    id: row.id,
    name: row.name,
    prefix: row.keyPrefix,
    walletAddress: row.walletAddress,
    secret,
    createdAt: new Date().toISOString(),
    revoked: false,
  }));
});

router.delete("/customer/api-keys/:id", requirePrivySession, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const result = await db.update(platformApiKeys).set({ revokedAt: new Date() }).where(and(
    eq(platformApiKeys.id, id),
    eq(platformApiKeys.ownerUserId, req.privySession!.userId),
  )).returning({ id: platformApiKeys.id });
  if (!result.length) {
    res.status(404).json({ error: "Platform API key not found." });
    return;
  }
  res.status(204).end();
});

router.get("/customer/usage", requirePrivySession, async (req, res): Promise<void> => {
  const rows = await db.select({
    id: creditUsageLedger.id,
    idempotencyKey: creditUsageLedger.idempotencyKey,
    status: creditUsageLedger.status,
    errorCode: creditUsageLedger.errorCode,
    model: creditUsageLedger.model,
    reservedCredits: creditUsageLedger.reservedCredits,
    chargedCredits: creditUsageLedger.chargedCredits,
    refundedCredits: creditUsageLedger.refundedCredits,
    reservedMicrocredits: creditUsageLedger.reservedMicrocredits,
    chargedMicrocredits: creditUsageLedger.chargedMicrocredits,
    refundedMicrocredits: creditUsageLedger.refundedMicrocredits,
    provider: creditUsageLedger.provider,
    providerCostUsd: creditUsageLedger.providerCostUsd,
    createdAt: creditUsageLedger.createdAt,
    completedAt: creditUsageLedger.completedAt,
  }).from(creditUsageLedger).where(eq(creditUsageLedger.ownerUserId, req.privySession!.userId))
    .orderBy(desc(creditUsageLedger.createdAt));
  res.json(ListCustomerUsageResponse.parse(rows.map((row) => ({
    ...row,
    reservedCredits: Number(row.reservedCredits),
    chargedCredits: Number(row.chargedCredits),
    refundedCredits: Number(row.refundedCredits),
    reservedCreditsExact: row.reservedMicrocredits > 0n ? exactMicrocredits(row.reservedMicrocredits) : String(row.reservedCredits),
    chargedCreditsExact: row.chargedMicrocredits > 0n ? exactMicrocredits(row.chargedMicrocredits) : String(row.chargedCredits),
    refundedCreditsExact: row.refundedMicrocredits > 0n ? exactMicrocredits(row.refundedMicrocredits) : String(row.refundedCredits),
    provider: row.provider ?? null,
    providerCostUsdExact: row.providerCostUsd,
  }))));
});

router.post("/customer/reconcile", requirePrivySession, async (req, res): Promise<void> => {
  const parsed = ReconcileCustomerRequestBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const ownerUserId = req.privySession!.userId;
  const result = await reconcileCustomerLedger(ownerUserId, parsed.data.ledgerId, {
    releaseUndispatchedReservation: true,
  });
  const [row] = await db.select({
    id: creditUsageLedger.id,
    status: creditUsageLedger.status,
    errorCode: creditUsageLedger.errorCode,
    reservedMicrocredits: creditUsageLedger.reservedMicrocredits,
    chargedMicrocredits: creditUsageLedger.chargedMicrocredits,
    refundedMicrocredits: creditUsageLedger.refundedMicrocredits,
    reservedCredits: creditUsageLedger.reservedCredits,
    chargedCredits: creditUsageLedger.chargedCredits,
    refundedCredits: creditUsageLedger.refundedCredits,
    completedAt: creditUsageLedger.completedAt,
  }).from(creditUsageLedger).where(and(
    eq(creditUsageLedger.id, parsed.data.ledgerId),
    eq(creditUsageLedger.ownerUserId, ownerUserId),
  )).limit(1);
  if (!row) {
    res.status(404).json({ error: "Customer request not found." });
    return;
  }
  const response = ReconcileCustomerRequestResponse.parse({
    ledgerId: row.id,
    status: row.status,
    errorCode: row.errorCode ?? result.errorCode,
    reservedCreditsExact: row.reservedMicrocredits > 0n ? exactMicrocredits(row.reservedMicrocredits) : String(row.reservedCredits),
    chargedCreditsExact: row.chargedMicrocredits > 0n ? exactMicrocredits(row.chargedMicrocredits) : String(row.chargedCredits),
    refundedCreditsExact: row.refundedMicrocredits > 0n ? exactMicrocredits(row.refundedMicrocredits) : String(row.refundedCredits),
    completedAt: row.completedAt?.toISOString() ?? null,
  });
  const terminal = row.status === "charged" || row.status === "released";
  res.status(terminal ? 200 : 202).json(response);
});

router.post("/customer/v1/chat/completions", requirePlatformApiKey, async (req, res): Promise<void> => {
  await runMeteredRoute(req, res, req.platformApiKey!.ownerUserId, req.platformApiKey!.id);
});

router.get("/customer/models", async (_req, res): Promise<void> => {
  try {
    const models = await listCustomerModels();
    res.json(ListCustomerModelsResponse.parse({
      models: models.map((model) => ({
        provider: model.provider,
        id: model.id,
        name: model.name,
        inputCostUsdPerMillion: model.inputCostUsdPerMillion,
        outputCostUsdPerMillion: model.outputCostUsdPerMillion,
        cachedInputCostUsdPerMillion: model.cachedInputCostUsdPerMillion,
        cacheWrite5mCostUsdPerMillion: model.cacheWrite5mCostUsdPerMillion,
        cacheWrite1hCostUsdPerMillion: model.cacheWrite1hCostUsdPerMillion,
        cacheReadCostUsdPerMillion: model.cacheReadCostUsdPerMillion,
        capabilities: model.capabilities,
        available: model.available,
        unavailableReason: model.unavailableReason,
        pricingSource: model.pricingSource,
        pricingVerifiedAt: model.pricingVerifiedAt,
        pricingExpiresAt: model.pricingExpiresAt,
        pricingType: model.pricingType,
        maxInputTokens: model.maxInputTokens,
        maxOutputTokens: model.maxOutputTokens,
      })),
    }));
  } catch {
    res.status(503).json({ error: "The live model catalogue is temporarily unavailable." });
  }
});

router.post("/customer/playground", requirePrivySession, async (req, res): Promise<void> => {
  await runMeteredRoute(
    req,
    res,
    req.privySession!.userId,
    `playground:${req.privySession!.userId}`,
  );
});

router.get("/customer/accounting", requirePrivySession, async (req, res): Promise<void> => {
  const rows = await db.select({
    id: creditUsageLedger.id,
    idempotencyKey: creditUsageLedger.idempotencyKey,
    model: creditUsageLedger.model,
    provider: creditUsageLedger.provider,
    status: creditUsageLedger.status,
    errorCode: creditUsageLedger.errorCode,
    createdAt: creditUsageLedger.createdAt,
    completedAt: creditUsageLedger.completedAt,
    inputTokens: creditUsageLedger.inputTokens,
    outputTokens: creditUsageLedger.outputTokens,
    cachedInputTokens: creditUsageLedger.cachedInputTokens,
    cacheReadInputTokens: creditUsageLedger.cacheReadInputTokens,
    cacheWrite5mTokens: creditUsageLedger.cacheWrite5mTokens,
    cacheWrite1hTokens: creditUsageLedger.cacheWrite1hTokens,
    thoughtsTokens: creditUsageLedger.thoughtsTokens,
    providerCostUsd: creditUsageLedger.providerCostUsd,
    reservedCredits: creditUsageLedger.reservedCredits,
    chargedCredits: creditUsageLedger.chargedCredits,
    refundedCredits: creditUsageLedger.refundedCredits,
    reservedMicrocredits: creditUsageLedger.reservedMicrocredits,
    chargedMicrocredits: creditUsageLedger.chargedMicrocredits,
    refundedMicrocredits: creditUsageLedger.refundedMicrocredits,
    inputUsdPerMillion: creditUsageLedger.inputUsdPerMillion,
    outputUsdPerMillion: creditUsageLedger.outputUsdPerMillion,
    cachedInputUsdPerMillion: creditUsageLedger.cachedInputUsdPerMillion,
    cacheWrite5mUsdPerMillion: creditUsageLedger.cacheWrite5mUsdPerMillion,
    cacheWrite1hUsdPerMillion: creditUsageLedger.cacheWrite1hUsdPerMillion,
    cacheReadUsdPerMillion: creditUsageLedger.cacheReadUsdPerMillion,
    pricingSource: creditUsageLedger.pricingSource,
    pricingVerifiedAt: creditUsageLedger.pricingVerifiedAt,
    pricingExpiresAt: creditUsageLedger.pricingExpiresAt,
  }).from(creditUsageLedger)
    .where(eq(creditUsageLedger.ownerUserId, req.privySession!.userId))
    .orderBy(desc(creditUsageLedger.createdAt));

  res.json(GetCustomerAccountingResponse.parse({
    receipts: rows.map((row) => ({
      id: row.id,
      idempotencyKey: row.idempotencyKey,
      model: row.model,
      provider: row.provider,
      status: row.status,
      errorCode: row.errorCode,
      createdAt: row.createdAt,
      completedAt: row.completedAt,
      inputTokens: row.inputTokens === null ? null : Number(row.inputTokens),
      outputTokens: row.outputTokens === null ? null : Number(row.outputTokens),
      cachedInputTokens: row.cachedInputTokens === null ? null : Number(row.cachedInputTokens),
      cacheReadInputTokens: row.cacheReadInputTokens === null ? null : Number(row.cacheReadInputTokens),
      cacheWrite5mTokens: row.cacheWrite5mTokens === null ? null : Number(row.cacheWrite5mTokens),
      cacheWrite1hTokens: row.cacheWrite1hTokens === null ? null : Number(row.cacheWrite1hTokens),
      thoughtsTokens: row.thoughtsTokens === null ? null : Number(row.thoughtsTokens),
      providerCostUsdExact: row.providerCostUsd,
      reservedCreditsExact: row.reservedMicrocredits > 0n ? exactMicrocredits(row.reservedMicrocredits) : String(row.reservedCredits),
      chargedCreditsExact: row.chargedMicrocredits > 0n ? exactMicrocredits(row.chargedMicrocredits) : String(row.chargedCredits),
      refundedCreditsExact: row.refundedMicrocredits > 0n ? exactMicrocredits(row.refundedMicrocredits) : String(row.refundedCredits),
      inputCostUsdPerMillion: row.inputUsdPerMillion,
      outputCostUsdPerMillion: row.outputUsdPerMillion,
      cachedInputCostUsdPerMillion: row.cachedInputUsdPerMillion,
      cacheWrite5mCostUsdPerMillion: row.cacheWrite5mUsdPerMillion,
      cacheWrite1hCostUsdPerMillion: row.cacheWrite1hUsdPerMillion,
      cacheReadCostUsdPerMillion: row.cacheReadUsdPerMillion,
      pricingSource: row.pricingSource,
      pricingVerifiedAt: row.pricingVerifiedAt,
      pricingExpiresAt: row.pricingExpiresAt,
    })),
    // No confirmed cashback ledger is presently connected to this API.
    cashback: null,
  }));
});

export default router;