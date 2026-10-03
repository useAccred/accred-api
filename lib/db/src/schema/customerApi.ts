import { bigint, check, index, text, timestamp, uniqueIndex, pgTable } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const platformApiKeys = pgTable("platform_api_keys", {
  id: text("id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull(),
  name: text("name").notNull(),
  keyPrefix: text("key_prefix").notNull(),
  keyHash: text("key_hash").notNull(),
  // Snapshot of the verified wallet selected when the key was created. Never
  // remap a key to a later wallet after a relink.
  walletAddress: text("wallet_address"),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("platform_api_keys_hash_idx").on(table.keyHash),
  index("platform_api_keys_owner_idx").on(table.ownerUserId),
]);

// Legacy table retained for non-destructive migration. Gateway code never reads
// or writes it; active accounting is split below.
export const verifiedCreditBalances = pgTable("verified_credit_balances", {
  ownerUserId: text("owner_user_id").primaryKey(),
  walletAddress: text("wallet_address").notNull(),
  confirmedCredits: bigint("confirmed_credits", { mode: "bigint" }).notNull(),
  consumedCredits: bigint("consumed_credits", { mode: "bigint" }).notNull().default(sql`0`),
  reservedCredits: bigint("reserved_credits", { mode: "bigint" }).notNull().default(sql`0`),
  indexedAt: timestamp("indexed_at", { withTimezone: true }).notNull(),
  chainId: text("chain_id").notNull(),
  creditContract: text("credit_contract").notNull(),
  indexerSource: text("indexer_source").notNull(),
  finalityStatus: text("finality_status").notNull(),
  indexedBlock: bigint("indexed_block", { mode: "bigint" }).notNull(),
});

// Indexer-owned snapshot. It must never contain gateway reservation counters.
export const indexedVaultCreditSnapshots = pgTable("indexed_vault_credit_snapshots", {
  ownerUserId: text("owner_user_id").primaryKey(),
  walletAddress: text("wallet_address").notNull(),
  vaultAddress: text("vault_address").notNull(),
  confirmedCredits: bigint("confirmed_credits", { mode: "bigint" }).notNull(),
  indexedAt: timestamp("indexed_at", { withTimezone: true }).notNull(),
  chainId: text("chain_id").notNull(),
  creditContract: text("credit_contract").notNull(),
  indexerSource: text("indexer_source").notNull(),
  finalityStatus: text("finality_status").notNull(),
  indexedBlock: bigint("indexed_block", { mode: "bigint" }).notNull(),
}, (table) => [
  check("indexed_vault_confirmed_nonnegative", sql`${table.confirmedCredits} >= 0`),
]);

// Gateway-owned counters. The indexer has no reason or permission to write this table.
export const gatewayCreditCounters = pgTable("gateway_credit_counters", {
  ownerUserId: text("owner_user_id").primaryKey(),
  reservedCredits: bigint("reserved_credits", { mode: "bigint" }).notNull().default(sql`0`),
  consumedCredits: bigint("consumed_credits", { mode: "bigint" }).notNull().default(sql`0`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("gateway_reserved_nonnegative", sql`${table.reservedCredits} >= 0`),
  check("gateway_consumed_nonnegative", sql`${table.consumedCredits} >= 0`),
]);

export const creditUsageLedger = pgTable("credit_usage_ledger", {
  id: text("id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull(),
  apiKeyId: text("api_key_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  status: text("status").notNull(), // reserving | reserved | charged | reconciling | released
  model: text("model").notNull(),
  reservedCredits: bigint("reserved_credits", { mode: "bigint" }).notNull(),
  chargedCredits: bigint("charged_credits", { mode: "bigint" }).notNull().default(sql`0`),
  refundedCredits: bigint("refunded_credits", { mode: "bigint" }).notNull().default(sql`0`),
  // Metered gateway values are stored as 10^-6 service credits. Legacy whole
  // credit columns above remain for old readers and are never used to settle.
  reservedMicrocredits: bigint("reserved_microcredits", { mode: "bigint" }).notNull().default(sql`0`),
  chargedMicrocredits: bigint("charged_microcredits", { mode: "bigint" }).notNull().default(sql`0`),
  refundedMicrocredits: bigint("refunded_microcredits", { mode: "bigint" }).notNull().default(sql`0`),
  requestFingerprint: text("request_fingerprint"),
  vaultRequestId: text("vault_request_id"),
  walletAddress: text("wallet_address"),
  reserveTxHash: text("reserve_tx_hash"),
  settleTxHash: text("settle_tx_hash"),
  releaseTxHash: text("release_tx_hash"),
  workflowVersion: text("workflow_version"),
  providerDispatchStartedAt: timestamp("provider_dispatch_started_at", { withTimezone: true }),
  providerDispatchState: text("provider_dispatch_state"),
  providerDispatchToken: text("provider_dispatch_token"),
  providerDispatchLeaseUntil: timestamp("provider_dispatch_lease_until", { withTimezone: true }),
  provider: text("provider"),
  inputUsdPerMillion: text("input_usd_per_million"),
  outputUsdPerMillion: text("output_usd_per_million"),
  cachedInputUsdPerMillion: text("cached_input_usd_per_million"),
  cacheWrite5mUsdPerMillion: text("cache_write_5m_usd_per_million"),
  cacheWrite1hUsdPerMillion: text("cache_write_1h_usd_per_million"),
  cacheReadUsdPerMillion: text("cache_read_usd_per_million"),
  cachedInputTokens: bigint("cached_input_tokens", { mode: "bigint" }),
  cacheReadInputTokens: bigint("cache_read_input_tokens", { mode: "bigint" }),
  cacheWrite5mTokens: bigint("cache_write_5m_tokens", { mode: "bigint" }),
  cacheWrite1hTokens: bigint("cache_write_1h_tokens", { mode: "bigint" }),
  thoughtsTokens: bigint("thoughts_tokens", { mode: "bigint" }),
  providerCostUsd: text("provider_cost_usd"),
  availableCreditsAfter: text("available_credits_after"),
  pricingSource: text("pricing_source"),
  pricingVerifiedAt: timestamp("pricing_verified_at", { withTimezone: true }),
  pricingExpiresAt: timestamp("pricing_expires_at", { withTimezone: true }),
  providerRequestId: text("provider_request_id"),
  responseContent: text("response_content"),
  inputTokens: bigint("input_tokens", { mode: "bigint" }),
  outputTokens: bigint("output_tokens", { mode: "bigint" }),
  errorCode: text("error_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("credit_usage_owner_idempotency_idx").on(table.ownerUserId, table.idempotencyKey),
  index("credit_usage_owner_created_idx").on(table.ownerUserId, table.createdAt),
]);

export const deviceHeartbeats = pgTable("device_heartbeats", {
  deviceId: text("device_id").primaryKey(),
  lastAuthenticatedAt: timestamp("last_authenticated_at", { withTimezone: true }).notNull(),
  paired: text("paired").notNull().default("false"),
  readiness: text("readiness").notNull().default("offline"),
  lastStage: text("last_stage"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const deviceRequestNonces = pgTable("device_request_nonces", {
  deviceId: text("device_id").notNull(),
  nonce: text("nonce").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
}, (table) => [
  uniqueIndex("device_request_nonce_idx").on(table.deviceId, table.nonce),
]);

export const deviceTelemetry = pgTable("device_telemetry", {
  id: text("id").primaryKey(),
  deviceId: text("device_id").notNull(),
  stage: text("stage").notNull(),
  detail: text("detail"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("device_telemetry_device_time_idx").on(table.deviceId, table.receivedAt),
]);

export const walletOwnershipChallenges = pgTable("wallet_ownership_challenges", {
  id: text("id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull(),
  walletAddress: text("wallet_address").notNull(),
  chainId: text("chain_id").notNull(),
  intent: text("intent").notNull(),
  nonceHash: text("nonce_hash").notNull(),
  message: text("message").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("wallet_challenge_nonce_hash_idx").on(table.nonceHash),
  index("wallet_challenge_owner_idx").on(table.ownerUserId),
]);

export const verifiedWalletOwnerships = pgTable("verified_wallet_ownerships", {
  id: text("id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull(),
  walletAddress: text("wallet_address").notNull(),
  chainId: text("chain_id").notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("verified_wallet_owner_chain_idx").on(table.ownerUserId, table.chainId),
  uniqueIndex("verified_wallet_address_chain_idx").on(table.walletAddress, table.chainId),
]);

export const xOauthLinkStates = pgTable("x_oauth_link_states", {
  stateHash: text("state_hash").primaryKey(),
  ownerUserId: text("owner_user_id").notNull(),
  walletOwnershipId: text("wallet_ownership_id").notNull(),
  codeVerifier: text("code_verifier").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  browserCookieHash: text("browser_cookie_hash").notNull(),
  generation: bigint("generation", { mode: "bigint" }).notNull().default(sql`0`),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const xLinkOwnerGenerations = pgTable("x_link_owner_generations", {
  ownerUserId: text("owner_user_id").primaryKey(),
  generation: bigint("generation", { mode: "bigint" }).notNull().default(sql`0`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const verifiedXAccounts = pgTable("verified_x_accounts", {
  id: text("id").primaryKey(),
  xAccountId: text("x_account_id").notNull(),
  xUsername: text("x_username"),
  ownerUserId: text("owner_user_id").notNull(),
  walletOwnershipId: text("wallet_ownership_id").notNull(),
  linkedAt: timestamp("linked_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("verified_x_account_id_idx").on(table.xAccountId).where(sql`${table.revokedAt} IS NULL`),
  uniqueIndex("verified_x_owner_idx").on(table.ownerUserId).where(sql`${table.revokedAt} IS NULL`),
]);