import { check, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Durable at-most-once reply outbox. A row in `posting` with no acknowledged
 * X response is conservatively made `post_unknown`; it is never posted again.
 */
export const xBotMentions = pgTable("x_bot_mentions", {
  mentionId: text("mention_id").primaryKey(),
  canonicalAuthorId: text("canonical_author_id").notNull(),
  ownerUserId: text("owner_user_id"),
  intent: text("intent").notNull(),
  commandStatus: text("command_status").notNull(),
  replyStatus: text("reply_status").notNull().default("pending"),
  replyText: text("reply_text").notNull(),
  replyTweetId: text("reply_tweet_id"),
  postingStartedAt: timestamp("posting_started_at", { withTimezone: true }),
  errorCode: text("error_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("x_bot_command_status_check", sql`${table.commandStatus} IN ('resolved', 'rejected')`),
  check("x_bot_reply_status_check", sql`${table.replyStatus} IN ('pending', 'posting', 'posted', 'post_unknown', 'disabled')`),
  index("x_bot_reply_status_created_idx").on(table.replyStatus, table.createdAt),
  index("x_bot_owner_created_idx").on(table.ownerUserId, table.createdAt),
]);

export const insertXBotMentionSchema = createInsertSchema(xBotMentions).omit({
  createdAt: true,
  updatedAt: true,
});
export type InsertXBotMention = z.infer<typeof insertXBotMentionSchema>;
export type XBotMention = typeof xBotMentions.$inferSelect;
