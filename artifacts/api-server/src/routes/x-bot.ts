import { and, eq, isNull } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  db,
  verifiedWalletOwnerships,
  verifiedXAccounts,
  xBotMentions,
} from "@workspace/db";
import { requirePrivySession } from "../lib/privy-auth";
import { hasValidXBotServiceAuthorization } from "../lib/x-bot-auth";
import { xBotConfig } from "../lib/x-bot-config";
import { buildXBotReply } from "../lib/x-bot-data";
import {
  HELP_REPLY,
  NOT_LINKED_REPLY,
  PERSONAL_INTENTS,
  REJECTED_REPLY,
  UNAVAILABLE_REPLY,
  isStaleXBotPost,
  parseXBotIntent,
} from "../lib/x-bot-policy";
import {
  checkXBotConnectivity,
  fetchCanonicalXTweet,
  postXBotReply,
  XBotApiError,
} from "../lib/x-bot-x-api";

const router: IRouter = Router();

function commandResult(row: {
  mentionId: string;
  intent: string;
  commandStatus: string;
  replyStatus: string;
  replyTweetId: string | null;
}) {
  return {
    mentionId: row.mentionId,
    intent: row.intent,
    commandStatus: row.commandStatus,
    replyStatus: row.replyStatus,
    replyTweetId: row.replyTweetId,
  };
}

async function findMention(mentionId: string) {
  const [row] = await db.select().from(xBotMentions)
    .where(eq(xBotMentions.mentionId, mentionId)).limit(1);
  return row;
}

async function handleStoredMention(
  mention: NonNullable<Awaited<ReturnType<typeof findMention>>>,
  config: ReturnType<typeof xBotConfig>,
) {
  if (mention.intent === "ignore") return commandResult(mention);
  if (mention.replyStatus === "posted" || mention.replyStatus === "post_unknown") {
    return commandResult(mention);
  }
  if (mention.replyStatus === "posting") {
    if (!isStaleXBotPost("posting", mention.postingStartedAt)) {
      return commandResult(mention);
    }
    const [recovered] = await db.update(xBotMentions).set({
      replyStatus: "post_unknown",
      errorCode: "post_outcome_unknown",
      updatedAt: new Date(),
    }).where(and(
      eq(xBotMentions.mentionId, mention.mentionId),
      eq(xBotMentions.replyStatus, "posting"),
      mention.postingStartedAt
        ? eq(xBotMentions.postingStartedAt, mention.postingStartedAt)
        : isNull(xBotMentions.postingStartedAt),
    )).returning();
    return commandResult(recovered ?? await findMention(mention.mentionId) ?? mention);
  }

  if (!config.postingEnabled) {
    if (mention.replyStatus === "disabled") return commandResult(mention);
    const [disabled] = await db.update(xBotMentions).set({
      replyStatus: "disabled",
      updatedAt: new Date(),
    }).where(and(
      eq(xBotMentions.mentionId, mention.mentionId),
      eq(xBotMentions.replyStatus, "pending"),
    )).returning();
    return commandResult(disabled ?? await findMention(mention.mentionId) ?? mention);
  }

  if (!config.userAccessToken || !config.apiKey || !config.apiSecret || !config.accessTokenSecret) {
    throw new Error("X_ACCESS_TOKEN is required when X_BOT_POSTING_ENABLED=true");
  }
  if (mention.replyStatus === "disabled") {
    await db.update(xBotMentions).set({
      replyStatus: "pending",
      updatedAt: new Date(),
    }).where(and(
      eq(xBotMentions.mentionId, mention.mentionId),
      eq(xBotMentions.replyStatus, "disabled"),
    ));
    mention = (await findMention(mention.mentionId)) ?? mention;
  }

  const postingStartedAt = new Date();
  const [claimed] = await db.update(xBotMentions).set({
    replyStatus: "posting",
    postingStartedAt,
    errorCode: null,
    updatedAt: postingStartedAt,
  }).where(and(
    eq(xBotMentions.mentionId, mention.mentionId),
    eq(xBotMentions.replyStatus, "pending"),
  )).returning();
  if (!claimed) {
    return commandResult(await findMention(mention.mentionId) ?? mention);
  }

  let replyTweetId: string;
  try {
    replyTweetId = await postXBotReply(mention.mentionId, mention.replyText, config);
  } catch {
    const [unknown] = await db.update(xBotMentions).set({
      replyStatus: "post_unknown",
      errorCode: "post_outcome_unknown",
      updatedAt: new Date(),
    }).where(and(
      eq(xBotMentions.mentionId, mention.mentionId),
      eq(xBotMentions.replyStatus, "posting"),
    )).returning();
    return commandResult(unknown ?? await findMention(mention.mentionId) ?? mention);
  }

  const [posted] = await db.update(xBotMentions).set({
    replyStatus: "posted",
    replyTweetId,
    errorCode: null,
    updatedAt: new Date(),
  }).where(and(
    eq(xBotMentions.mentionId, mention.mentionId),
    eq(xBotMentions.replyStatus, "posting"),
  )).returning();
  return commandResult(posted ?? await findMention(mention.mentionId) ?? mention);
}

router.get("/x-bot/status", requirePrivySession, async (req, res): Promise<void> => {
  const config = xBotConfig();
  try {
    const [account] = await db.select({
      xUsername: verifiedXAccounts.xUsername,
    }).from(verifiedXAccounts).innerJoin(
      verifiedWalletOwnerships,
      and(
        eq(verifiedWalletOwnerships.id, verifiedXAccounts.walletOwnershipId),
        eq(verifiedWalletOwnerships.ownerUserId, verifiedXAccounts.ownerUserId),
        isNull(verifiedWalletOwnerships.revokedAt),
      ),
    ).where(and(
      eq(verifiedXAccounts.ownerUserId, req.privySession!.userId),
      isNull(verifiedXAccounts.revokedAt),
    )).limit(1);

    const connectivity = await checkXBotConnectivity(config);
    res.json({
      connectivity,
      configured: config.configured,
      linked: Boolean(account),
      xUsername: account?.xUsername ?? null,
      postingEnabled: config.postingEnabled,
      missingConfiguration: config.missing,
    });
  } catch (error) {
    req.log.error({ error }, "X bot status unavailable");
    res.status(503).json({ error: "X bot status is temporarily unavailable." });
  }
});

router.post("/x-bot/commands", async (req, res): Promise<void> => {
  const config = xBotConfig();
  if (!config.serviceToken) {
    res.status(503).json({
      error: "Internal X bot service authentication is not configured.",
      missing: ["X_BOT_SERVICE_TOKEN"],
    });
    return;
  }
  if (!hasValidXBotServiceAuthorization(req.get("authorization"), config.serviceToken)) {
    res.status(401).json({ error: "A valid X bot service Bearer token is required." });
    return;
  }
  if (!config.configured) {
    res.status(503).json({
      error: "X bot processing is not configured.",
      missing: config.missing,
    });
    return;
  }

  const body = req.body as unknown;
  if (
    typeof body !== "object" || body === null || Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    typeof (body as { mentionId?: unknown }).mentionId !== "string" ||
    !/^\d{1,30}$/.test((body as { mentionId: string }).mentionId)
  ) {
    res.status(400).json({ error: "Request body must contain only a numeric mentionId." });
    return;
  }
  const mentionId = (body as { mentionId: string }).mentionId;

  try {
    // Tweet author/text from the worker are never accepted as authority.
    const canonical = await fetchCanonicalXTweet(mentionId, config);
    let mention = await findMention(mentionId);
    if (mention && mention.canonicalAuthorId !== canonical.authorId) {
      res.status(409).json({ error: "Canonical X author does not match the stored mention." });
      return;
    }

    if (!mention) {
      const isSelf = canonical.authorId === config.userId;
      const intent = isSelf ? "ignore" : parseXBotIntent(canonical.text, process.env.X_BOT_USERNAME || "useAccred");
      const [account] = intent === "ignore" ? [] : await db.select({
        ownerUserId: verifiedXAccounts.ownerUserId,
        walletAddress: verifiedWalletOwnerships.walletAddress,
        xUsername: verifiedXAccounts.xUsername,
      }).from(verifiedXAccounts).innerJoin(
        verifiedWalletOwnerships,
        and(
          eq(verifiedWalletOwnerships.id, verifiedXAccounts.walletOwnershipId),
          eq(verifiedWalletOwnerships.ownerUserId, verifiedXAccounts.ownerUserId),
          isNull(verifiedWalletOwnerships.revokedAt),
        ),
      ).where(and(
        eq(verifiedXAccounts.xAccountId, canonical.authorId),
        isNull(verifiedXAccounts.revokedAt),
      )).limit(1);

      let replyText = "";
      if (intent === "help") replyText = HELP_REPLY;
      else if (intent === "rejected") replyText = REJECTED_REPLY;
      else if (intent !== "ignore") {
        if ((PERSONAL_INTENTS as readonly string[]).includes(intent) && !account) {
          replyText = NOT_LINKED_REPLY;
        } else {
          try {
            replyText = await buildXBotReply(account ?? null, intent);
          } catch (error) {
            req.log.warn({ intent, error: error instanceof Error ? error.message : String(error) }, "X bot data unavailable");
            replyText = UNAVAILABLE_REPLY;
          }
        }
      }
      await db.insert(xBotMentions).values({
        mentionId,
        canonicalAuthorId: canonical.authorId,
        ownerUserId: account?.ownerUserId ?? null,
        intent,
        commandStatus: intent === "rejected" || intent === "ignore" ? "rejected" : "resolved",
        replyStatus: intent === "ignore" ? "disabled" : "pending",
        replyText,
      }).onConflictDoNothing();
      mention = await findMention(mentionId);
      if (!mention) throw new Error("Could not persist X bot mention state.");
      if (mention.canonicalAuthorId !== canonical.authorId) {
        res.status(409).json({ error: "Canonical X author does not match the stored mention." });
        return;
      }
    }

    const result = await handleStoredMention(mention, config);
    res.json(result);
  } catch (error) {
    if (error instanceof XBotApiError && error.statusCode === 404) {
      res.status(404).json({ error: "Canonical X tweet was not found." });
      return;
    }
    if (error instanceof XBotApiError && error.statusCode === 401) {
      res.status(503).json({ error: "X API rejected its bearer credential; verify X_API_BEARER_TOKEN." });
      return;
    }
    if (error instanceof XBotApiError && error.statusCode === 403) {
      res.status(503).json({ error: "X API access is denied; verify X API v2 read access for the configured app." });
      return;
    }
    if (error instanceof Error && error.message.includes("X_ACCESS_TOKEN")) {
      res.status(503).json({ error: `${error.message}.` });
      return;
    }
    req.log.error({ error }, "X bot command processing failed");
    res.status(503).json({ error: "X bot command processing is temporarily unavailable." });
  }
});

export default router;