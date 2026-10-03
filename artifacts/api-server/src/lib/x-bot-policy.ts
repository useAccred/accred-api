export type XBotIntent =
  | "balance" | "usage" | "cashback" | "swaps" | "keys" | "status" | "stats" | "help"
  | "rejected" | "ignore";
export type XBotReplyStatus = "pending" | "posting" | "posted" | "post_unknown" | "disabled";

/** Commands that read one user's data, so the X account must be linked. */
export const PERSONAL_INTENTS: readonly XBotIntent[] = ["balance", "usage", "cashback", "swaps", "keys", "status"];

const ALIASES: Record<string, XBotIntent> = {
  balance: "balance", credits: "balance", bal: "balance",
  usage: "usage", spent: "usage",
  cashback: "cashback", rewards: "cashback",
  swaps: "swaps", swap_history: "swaps", history: "swaps", activity: "swaps",
  keys: "keys", apikeys: "keys", api: "keys",
  status: "status", account: "status", me: "status",
  stats: "stats", platform: "stats",
  help: "help", commands: "help",
};
const DANGEROUS_ACTION = /^(?:buy|purchase|sell|send|swap|trade|transfer|withdraw|execute|redeem|stake)$/i;

/**
 * Only a tweet whose word right after the bot handle is a known command gets a
 * reply. Anything else (chat, replies to our posts, unknown words) is ignored.
 * Execution-shaped words get a read-only rejection.
 */
export function parseXBotIntent(text: string, botUsername = "useAccred"): XBotIntent {
  const handle = botUsername.replace(/^@/, "").replace(/[^A-Za-z0-9_]/g, "");
  const match = new RegExp(`@${handle}\\b[\\s,:-]*[/!]?([A-Za-z_]+)`, "i").exec(text);
  if (!match) return "ignore";
  const word = match[1].toLowerCase();
  if (DANGEROUS_ACTION.test(word)) return "rejected";
  return ALIASES[word] ?? "ignore";
}

export const NOT_LINKED_REPLY =
  "You have not linked your wallet with your X account. Go to accred.sh and link your account.";
export const UNAVAILABLE_REPLY = "Live data is unavailable right now. Please try again in a few minutes.";
export const HELP_REPLY = [
  "Accred commands (read-only):",
  "balance - your credits",
  "usage - API usage",
  "cashback - cashback earned",
  "swaps - swap history",
  "keys - API keys",
  "status - account summary",
  "stats - platform totals",
  "Example: @useAccred balance",
].join("\n");
export const REJECTED_REPLY =
  "This bot is read-only. It cannot buy, sell, send or swap. Send @useAccred help to see commands. Trade at accred.sh";

export function isTerminalXBotReplyStatus(status: XBotReplyStatus): boolean {
  return status === "posted" || status === "post_unknown";
}

export function isStaleXBotPost(status: XBotReplyStatus, startedAt: Date | null, nowMs = Date.now()): boolean {
  return status === "posting" && (!startedAt || nowMs - startedAt.getTime() >= 5 * 60_000);
}
