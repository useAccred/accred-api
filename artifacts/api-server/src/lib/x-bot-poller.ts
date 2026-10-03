import { desc } from "drizzle-orm";
import { db, xBotMentions } from "@workspace/db";
import { logger } from "./logger";
import { xBotConfig } from "./x-bot-config";

const X_API = "https://api.x.com/2";
const INTERVAL_MS = 60_000;

type MentionsPage = { data?: { id: string }[]; meta?: { newest_id?: string }; };

async function fetchMentions(userId: string, bearer: string, sinceId?: string): Promise<MentionsPage> {
  const query = new URLSearchParams({ max_results: "20" });
  if (sinceId) query.set("since_id", sinceId);
  const response = await fetch(`${X_API}/users/${encodeURIComponent(userId)}/mentions?${query}`, {
    headers: { authorization: `Bearer ${bearer}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`X mentions request failed (${response.status})`);
  return await response.json() as MentionsPage;
}

/** The mentions timeline can lag or skip replies, so recent search is read as a second source. */
async function fetchSearch(handle: string, bearer: string, sinceId?: string): Promise<MentionsPage> {
  const query = new URLSearchParams({ query: `@${handle} -from:${handle}`, max_results: "20" });
  if (sinceId) query.set("since_id", sinceId);
  const response = await fetch(`${X_API}/tweets/search/recent?${query}`, {
    headers: { authorization: `Bearer ${bearer}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`X search request failed (${response.status})`);
  return await response.json() as MentionsPage;
}

async function newestStoredId(): Promise<string | undefined> {
  const rows = await db.select({ id: xBotMentions.mentionId }).from(xBotMentions).orderBy(desc(xBotMentions.createdAt)).limit(50);
  return rows.map((r) => r.id).sort((a, b) => (BigInt(a) > BigInt(b) ? -1 : 1))[0];
}

/**
 * Polls X for new mentions of the bot account and feeds each one to the
 * authenticated /x-bot/commands handler. History from before the first run is
 * skipped so old posts never receive replies.
 */
export function startXBotPoller(port: number) {
  if (process.env.X_BOT_POLLING_ENABLED !== "true") return;
  let cursor: string | undefined;
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const config = xBotConfig();
      if (!config.configured || !config.postingEnabled || !config.bearerToken || !config.userId || !config.serviceToken) return;
      if (!cursor) {
        cursor = await newestStoredId();
        if (!cursor) {
          const first = await fetchMentions(config.userId, config.bearerToken);
          cursor = first.meta?.newest_id;
          if (!cursor) return; // no mentions yet; try again next tick
          logger.info("X bot poller initialised; skipping earlier mentions");
          return;
        }
      }
      const page = await fetchMentions(config.userId, config.bearerToken, cursor);
      const found = new Set((page.data ?? []).map((m) => m.id));
      try {
        const extra = await fetchSearch(process.env.X_BOT_USERNAME || "useAccred", config.bearerToken, cursor);
        for (const m of extra.data ?? []) found.add(m.id);
      } catch (error) {
        logger.warn({ error: error instanceof Error ? error.message : String(error) }, "X bot search poll failed");
      }
      const ids = [...found].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
      for (const id of ids) {
        const res = await fetch(`http://127.0.0.1:${port}/api/x-bot/commands`, {
          method: "POST",
          headers: { authorization: `Bearer ${config.serviceToken}`, "content-type": "application/json" },
          body: JSON.stringify({ mentionId: id }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) { logger.warn({ status: res.status }, "X bot command rejected"); break; }
        cursor = id;
      }
    } catch (error) {
      logger.warn({ error: error instanceof Error ? error.message : String(error) }, "X bot poll failed");
    } finally {
      running = false;
    }
  };
  setInterval(() => void tick(), INTERVAL_MS);
  void tick();
  logger.info("X bot poller started");
}
