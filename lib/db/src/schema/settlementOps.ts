import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** One row per settlement-service operation; the key makes payouts and mints idempotent across restarts. */
export const settlementOperationsTable = pgTable("settlement_operations", {
  idempotencyKey: text("idempotency_key").primaryKey(),
  operation: text("operation").notNull(),
  status: text("status").notNull(),
  txHash: text("tx_hash"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
