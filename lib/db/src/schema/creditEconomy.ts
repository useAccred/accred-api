import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Durable quote and reconciliation records. Amounts are text decimal strings on
 * purpose: financial token quantities must never pass through JS floating point.
 */
export const creditEconomyQuotes = pgTable("credit_economy_quotes", {
  id: text("id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull(),
  walletOwnershipId: text("wallet_ownership_id").notNull(),
  sourceWalletOwnershipId: text("source_wallet_ownership_id").notNull(),
  walletAddress: text("wallet_address").notNull(),
  sourceWalletAddress: text("source_wallet_address").notNull(),
  mode: text("mode").notNull(),
  chain: text("chain").notNull(),
  asset: text("asset").notNull(),
  amount: text("amount").notNull(),
  inputToken: text("input_token").notNull(),
  outputToken: text("output_token").notNull(),
  inputAmount: text("input_amount").notNull(),
  outputAmount: text("output_amount").notNull(),
  netUsdMicros: text("net_usd_micros").notNull(),
  expectedTo: text("expected_to").notNull(),
  expectedValue: text("expected_value").notNull(),
  expectedCalldata: text("expected_calldata"),
  expectedToken: text("expected_token"),
  expectedRecipient: text("expected_recipient"),
  expectedTokenAmount: text("expected_token_amount"),
  expectedTransfers: jsonb("expected_transfers").notNull().default([]),
  transaction: jsonb("transaction").notNull(),
  approvals: jsonb("approvals").notNull().default([]),
  route: jsonb("route").notNull(),
  status: text("status").notNull().default("quoted"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  txHash: text("tx_hash"),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("credit_economy_quotes_owner_created_idx").on(table.ownerUserId, table.createdAt),
  uniqueIndex("credit_economy_quotes_chain_tx_idx").on(table.chain, table.txHash),
]);

export const creditEconomyActivity = pgTable("credit_economy_activity", {
  id: text("id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull(),
  quoteId: text("quote_id").notNull(),
  kind: text("kind").notNull(),
  chain: text("chain").notNull(),
  asset: text("asset").notNull(),
  amount: text("amount").notNull(),
  status: text("status").notNull(),
  txHash: text("tx_hash"),
  detail: text("detail"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("credit_economy_activity_owner_created_idx").on(table.ownerUserId, table.createdAt),
  uniqueIndex("credit_economy_activity_quote_kind_idx").on(table.quoteId, table.kind),
]);

export const creditEconomyCashbacks = pgTable("credit_economy_cashbacks", {
  id: text("id").primaryKey(),
  quoteId: text("quote_id").notNull(),
  ownerUserId: text("owner_user_id").notNull(),
  recipientAddress: text("recipient_address").notNull(),
  amountUsdg: text("amount_usdg").notNull(),
  percentBps: integer("percent_bps").notNull(),
  status: text("status").notNull().default("reserved"),
  payoutTxHash: text("payout_tx_hash"),
  attemptCount: integer("attempt_count").notNull().default(0),
  lastErrorCode: text("last_error_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("credit_economy_cashback_quote_idx").on(table.quoteId),
  uniqueIndex("credit_economy_cashback_tx_idx").on(table.payoutTxHash),
  index("credit_economy_cashback_owner_created_idx").on(table.ownerUserId, table.createdAt),
]);

export const creditEconomyReserves = pgTable("credit_economy_reserves", {
  fundingKey: text("funding_key").primaryKey(),
  reservedAmount: text("reserved_amount").notNull().default("0"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
/**
 * Manual Solana deposits: the user sends funds from any Solana wallet to the treasury.
 * Each session has a unique exact amount so the incoming transfer can be attributed
 * without a Solana wallet login. Credit is minted to the user's verified Robinhood wallet.
 */
export const solanaDepositSessions = pgTable("solana_deposit_sessions", {
  id: text("id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull(),
  recipientAddress: text("recipient_address").notNull(),
  asset: text("asset").notNull(),
  mint: text("mint").notNull(),
  decimals: integer("decimals").notNull(),
  expectedUnits: text("expected_units").notNull(),
  netUsdMicros: text("net_usd_micros").notNull(),
  priceUsdMicros: text("price_usd_micros"),
  status: text("status").notNull().default("awaiting"),
  error: text("error"),
  paymentSignature: text("payment_signature"),
  paymentSlot: text("payment_slot"),
  settlementTxHash: text("settlement_tx_hash"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("solana_deposit_sessions_owner_idx").on(table.ownerUserId, table.createdAt),
  uniqueIndex("solana_deposit_sessions_signature_idx").on(table.paymentSignature),
]);
