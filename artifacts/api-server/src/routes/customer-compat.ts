import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import { db, platformApiKeys } from "@workspace/db";
import { hashPlatformKey } from "../lib/platform-api-key";
import { runCustomerCompletion } from "../lib/customer-billing";
import { listCustomerModels, resolveCustomerModel } from "../lib/customer-models";
import {
  anthropicMessage,
  anthropicStreamFrames,
  anthropicStreamStart,
  clampMaxOutputTokens,
  compatErrorBody,
  compatKeepalive,
  compatStreamError,
  estimateInputTokens,
  openAiCompletion,
  openAiStreamFrames,
  parseAnthropicRequest,
  parseOpenAiRequest,
  type CompatFlavor,
} from "../lib/customer-compat";

// OpenAI- and Anthropic-compatible entry points for editors and SDKs that
// cannot send X-Platform-API-Key or Idempotency-Key. They translate the wire
// format only: every request still runs through runCustomerCompletion, so
// reservation, settlement, rate limits and budgets are identical to the native
// /customer/v1/chat/completions route, which is left unchanged.

const router: IRouter = Router();
const KEEPALIVE_MS = 10_000;

function presentedKey(req: Request): string | undefined {
  const bearer = req.get("authorization")?.match(/^Bearer\s+([^\s]+)$/i)?.[1];
  return bearer ?? req.get("x-api-key") ?? req.get("x-platform-api-key") ?? undefined;
}

function requireCompatApiKey(flavor: CompatFlavor) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const secret = presentedKey(req);
    if (!secret || secret.length < 24 || secret.length > 256) {
      res.status(401).json(compatErrorBody(flavor, 401, "A platform API key is required."));
      return;
    }
    try {
      const [key] = await db.select({
        id: platformApiKeys.id,
        ownerUserId: platformApiKeys.ownerUserId,
        walletAddress: platformApiKeys.walletAddress,
      }).from(platformApiKeys).where(and(
        eq(platformApiKeys.keyHash, hashPlatformKey(secret)),
        isNull(platformApiKeys.revokedAt),
      )).limit(1);
      if (!key) {
        res.status(401).json(compatErrorBody(flavor, 401, "The platform API key is invalid or revoked."));
        return;
      }
      req.platformApiKey = key;
      next();
    } catch (error) {
      req.log.error({ error }, "Platform API key lookup failed");
      res.status(503).json(compatErrorBody(flavor, 503, "The platform API key service is unavailable."));
    }
  };
}

async function runCompatRoute(req: Request, res: Response, flavor: CompatFlavor): Promise<void> {
  const parsed = flavor === "anthropic" ? parseAnthropicRequest(req.body) : parseOpenAiRequest(req.body);
  if ("error" in parsed) {
    res.status(400).json(compatErrorBody(flavor, 400, parsed.error));
    return;
  }
  const { request } = parsed;
  // An unknown model is reported by the metered engine; only the clamp needs it here.
  const model = await resolveCustomerModel(request.model).catch(() => undefined);
  const maxOutputTokens = clampMaxOutputTokens(request.requestedMaxOutputTokens, model?.maxOutputTokens ?? 8192);
  const suppliedKey = req.get("idempotency-key");
  const idempotencyKey = suppliedKey && suppliedKey.length >= 8 && suppliedKey.length <= 128
    ? suppliedKey
    : randomUUID();
  const id = flavor === "anthropic" ? `msg_${randomUUID()}` : `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  let keepalive: NodeJS.Timeout | undefined;
  if (request.stream) {
    // Reservation waits for chain finality before the provider is called, so
    // open the stream now and keep it alive rather than risk a client timeout.
    res.status(200).set({
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.flushHeaders();
    if (flavor === "anthropic") res.write(anthropicStreamStart(id, request.model));
    keepalive = setInterval(() => {
      if (!res.writableEnded) res.write(compatKeepalive(flavor));
    }, KEEPALIVE_MS);
    res.on("close", () => clearInterval(keepalive));
  }

  let result: Awaited<ReturnType<typeof runCustomerCompletion>>;
  try {
    result = await runCustomerCompletion({
      ownerUserId: req.platformApiKey!.ownerUserId,
      apiKeyId: req.platformApiKey!.id,
      idempotencyKey,
      request: { model: request.model, messages: request.messages, maxOutputTokens },
    });
  } catch (error) {
    req.log.error({ error }, "Compatible customer completion failed");
    result = { statusCode: 503, error: "The metered completion could not be processed." };
  } finally {
    clearInterval(keepalive);
  }

  if (request.stream) {
    const frames = result.statusCode !== 200
      ? [compatStreamError(flavor, result.statusCode, result.error)]
      : flavor === "anthropic"
        ? anthropicStreamFrames(result.response)
        : openAiStreamFrames(result.response, id, created, request.model, request.includeStreamUsage);
    for (const frame of frames) res.write(frame);
    res.end();
    return;
  }
  if (result.statusCode !== 200) {
    res.status(result.statusCode).json(compatErrorBody(flavor, result.statusCode, result.error));
    return;
  }
  res.json(flavor === "anthropic"
    ? anthropicMessage(result.response, id, request.model)
    : openAiCompletion(result.response, id, created, request.model));
}

router.post("/customer/openai/v1/chat/completions", requireCompatApiKey("openai"), async (req, res): Promise<void> => {
  await runCompatRoute(req, res, "openai");
});

router.get("/customer/openai/v1/models", requireCompatApiKey("openai"), async (_req, res): Promise<void> => {
  try {
    const models = (await listCustomerModels())
      .filter((model) => model.available && model.capabilities.includes("text-generation"));
    const created = Math.floor(Date.now() / 1000);
    res.json({
      object: "list",
      data: models.map((model) => ({
        // Bare IDs are only resolvable when unique across providers.
        id: models.filter((other) => other.id === model.id).length === 1 ? model.id : `${model.provider}/${model.id}`,
        object: "model",
        created,
        owned_by: model.provider,
      })),
    });
  } catch {
    res.status(503).json(compatErrorBody("openai", 503, "The live model catalogue is temporarily unavailable."));
  }
});

router.post("/customer/anthropic/v1/messages", requireCompatApiKey("anthropic"), async (req, res): Promise<void> => {
  await runCompatRoute(req, res, "anthropic");
});

router.post("/customer/anthropic/v1/messages/count_tokens", requireCompatApiKey("anthropic"), async (req, res): Promise<void> => {
  const parsed = parseAnthropicRequest(req.body);
  if ("error" in parsed) {
    res.status(400).json(compatErrorBody("anthropic", 400, parsed.error));
    return;
  }
  res.json({ input_tokens: estimateInputTokens(parsed.request.messages) });
});

export default router;
