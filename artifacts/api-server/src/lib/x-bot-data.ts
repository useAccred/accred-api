import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { creditConfiguration } from "./credit-config";
import { getRobinhoodCreditAccount } from "./credit-chain";
import type { XBotIntent } from "./x-bot-policy";

type VerifiedOwner = { ownerUserId: string; walletAddress: string; xUsername?: string | null };

const num = (v: unknown) => Number(v ?? 0) || 0;
/** Plain number, at most `max` decimals, no trailing zeros, thousands separators. */
function fmt(value: string | number, max = 4): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return String(value);
  return n.toLocaleString("en-US", { maximumFractionDigits: max });
}
const short = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;

async function accountState(owner: VerifiedOwner) {
  return getRobinhoodCreditAccount(creditConfiguration(), owner.walletAddress);
}

/**
 * Builds the reply text for a command using only server-owned records or
 * finalized chain reads. Throws when live data cannot be read.
 */
export async function buildXBotReply(owner: VerifiedOwner | null, intent: XBotIntent): Promise<string> {
  if (intent === "stats") {
    const [q] = (await db.execute(sql`
      select coalesce(sum(net_usd_micros::numeric), 0) as micros, count(*) as n
      from credit_economy_quotes where status = 'completed' and mode in ('swap', 'buy')`)).rows;
    const [cb] = (await db.execute(sql`
      select coalesce(sum(amount_usdg::numeric), 0) as usdg from credit_economy_cashbacks where status = 'paid'`)).rows;
    const [used] = (await db.execute(sql`
      select coalesce(sum(charged_microcredits), 0) as micro from credit_usage_ledger where status = 'charged'`)).rows;
    return [
      "Accred platform stats",
      `Volume: $${fmt(num(q?.micros) / 1e6, 2)} (${fmt(num(q?.n), 0)} swaps/buys)`,
      `Cashback paid: ${fmt(num(cb?.usdg), 2)} USDG`,
      `Credits used: ${fmt(num(used?.micro) / 1e6, 2)}`,
      "accred.sh",
    ].join("\n");
  }
  if (!owner) throw new Error("owner required");
  const id = owner.ownerUserId;

  if (intent === "balance") {
    const a = await accountState(owner);
    return [
      "Your Accred credits",
      `Available: ${fmt(a.availableCredits)}`,
      `Deposited: ${fmt(a.depositedCredits)}`,
      `Reserved: ${fmt(a.reservedCredits)}`,
      "accred.sh/app",
    ].join("\n");
  }
  if (intent === "usage") {
    const [u] = (await db.execute(sql`
      select count(*) as n, coalesce(sum(charged_microcredits), 0) as micro,
             coalesce(sum(charged_microcredits) filter (where created_at > now() - interval '24 hours'), 0) as micro24,
             count(*) filter (where created_at > now() - interval '24 hours') as n24
      from credit_usage_ledger where owner_user_id = ${id} and status = 'charged'`)).rows;
    const [top] = (await db.execute(sql`
      select model from credit_usage_ledger where owner_user_id = ${id} and status = 'charged'
      group by model order by count(*) desc limit 1`)).rows;
    const lines = [
      "Your API usage",
      `Requests: ${fmt(num(u?.n), 0)} | Credits used: ${fmt(num(u?.micro) / 1e6)}`,
      `Last 24h: ${fmt(num(u?.n24), 0)} requests | ${fmt(num(u?.micro24) / 1e6)} credits`,
    ];
    if (top?.model) lines.push(`Top model: ${String(top.model).slice(0, 40)}`);
    lines.push("accred.sh/app");
    return lines.join("\n");
  }
  if (intent === "cashback") {
    const [c] = (await db.execute(sql`
      select coalesce(sum(amount_usdg::numeric) filter (where status = 'paid'), 0) as paid,
             count(*) filter (where status = 'paid') as paid_n,
             coalesce(sum(amount_usdg::numeric) filter (where status in ('reserved', 'pending')), 0) as pending
      from credit_economy_cashbacks where owner_user_id = ${id}`)).rows;
    const lines = [
      "Your Accred cashback",
      `Paid: ${fmt(num(c?.paid), 2)} USDG (${fmt(num(c?.paid_n), 0)} payouts)`,
    ];
    if (num(c?.pending) > 0) lines.push(`Pending: ${fmt(num(c?.pending), 2)} USDG`);
    lines.push("10% USDG back on every swap", "accred.sh/app");
    return lines.join("\n");
  }
  if (intent === "swaps") {
    const [s] = (await db.execute(sql`
      select count(*) as n, coalesce(sum(net_usd_micros::numeric), 0) as micros, max(created_at) as last
      from credit_economy_quotes where owner_user_id = ${id} and status = 'completed' and mode in ('swap', 'buy')`)).rows;
    const last = s?.last ? new Date(String(s.last)).toISOString().slice(0, 10) : null;
    return [
      "Your swap history",
      `Completed: ${fmt(num(s?.n), 0)}`,
      `Total volume: $${fmt(num(s?.micros) / 1e6, 2)}`,
      last ? `Last swap: ${last}` : "No swaps yet",
      "accred.sh/app",
    ].join("\n");
  }
  if (intent === "keys") {
    const [k] = (await db.execute(sql`
      select count(*) filter (where revoked_at is null) as active, count(*) as total
      from platform_api_keys where owner_user_id = ${id}`)).rows;
    return [
      "Your API keys",
      `Active: ${fmt(num(k?.active), 0)} | Revoked: ${fmt(num(k?.total) - num(k?.active), 0)}`,
      "Manage keys at accred.sh/app",
    ].join("\n");
  }
  if (intent === "status") {
    const a = await accountState(owner);
    const [k] = (await db.execute(sql`
      select count(*) filter (where revoked_at is null) as active from platform_api_keys where owner_user_id = ${id}`)).rows;
    return [
      "Your Accred account",
      `Wallet: ${short(owner.walletAddress)}${owner.xUsername ? ` <> @${owner.xUsername}` : ""}`,
      `Available credits: ${fmt(a.availableCredits)}`,
      `Active API keys: ${fmt(num(k?.active), 0)}`,
      "accred.sh/app",
    ].join("\n");
  }
  throw new Error("unsupported intent");
}
