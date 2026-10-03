import { Contract, getAddress, isAddress } from "ethers";
import { logger } from "./logger";
import { creditConfiguration } from "./credit-config";
import curated from "./crypto-token-list.json";

// Curated Robinhood Chain crypto tokens traded against WETH. Price is the live DexScreener quote of each token's
// deepest WETH pair (min $25k liquidity); pairs against other tokens are ignored.

export const ROBINHOOD_WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const UA = "Mozilla/5.0 (compatible; AccredPricing/1.0)";

export type DexToken = { symbol: string; address: string; decimals: number };
export type DexQuote = {
  /** Quote-token units (scaled 1e18) paid for one whole token. */
  priceNativeWei: bigint; liquidityUsd: number; pairAddress: string;
  /** "eth" for WETH / native-ETH pairs, "usdg" for USDG pairs. */
  quoteKind: "eth" | "usdg"; quoteAddress: string; quoteDecimals: number; imageUrl: string | null;
};

let tokens: DexToken[] = [];
let refreshing: Promise<void> | null = null;
let rpc: (() => import("ethers").JsonRpcProvider) | null = null;

/** The platform's own token (set once it is launched): PROJECT_TOKEN_ADDRESS, optional PROJECT_TOKEN_SYMBOL. Earns bonus credit. */
export function projectToken(): { symbol: string; address: string } | null {
  const address = process.env.PROJECT_TOKEN_ADDRESS?.trim();
  if (!address || !isAddress(address)) return null;
  return { symbol: (process.env.PROJECT_TOKEN_SYMBOL?.trim() || "ACCRED").toUpperCase(), address: getAddress(address) };
}
export const PROJECT_TOKEN_BONUS_BPS = 1000n;
/** $CRED paid for credit lands in the treasury wallet, which burns it to this address right after the credit and cashback are paid. */
export const PROJECT_TOKEN_BURN_ADDRESS = "0x000000000000000000000000000000000000dEaD";
export function isProjectToken(tokenAddress: string): boolean {
  const own = projectToken();
  return Boolean(own) && tokenAddress.toLowerCase() === own!.address.toLowerCase();
}

export const dexTokens = (): readonly DexToken[] => tokens;

async function json(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`http_${response.status}`);
  return response.json();
}

/** "0.000348" -> wei-scaled bigint without float rounding. */
function decimalToWei(text: string): bigint | null {
  const match = /^(\d+)(?:\.(\d{1,40}))?$/.exec(text.trim());
  if (!match) return null;
  const frac = (match[2] ?? "").slice(0, 18).padEnd(18, "0");
  return BigInt(match[1]!) * 10n ** 18n + BigInt(frac);
}

type DsPair = {
  chainId: string; pairAddress: string; priceNative: string;
  baseToken: { address: string; symbol: string }; quoteToken: { address: string };
  liquidity?: { usd?: number }; info?: { imageUrl?: string };
};

const NATIVE_QUOTE = "0x0000000000000000000000000000000000000000";

/** Live DexScreener quote: the deepest pair of the token against WETH, native ETH or USDG . */
const quoteCache = new Map<string, { at: number; value: DexQuote | null }>();
export async function dexQuote(address: string): Promise<DexQuote | null> {
  const key = address.toLowerCase();
  const hit = quoteCache.get(key);
  if (hit && Date.now() - hit.at < 15_000) return hit.value;
  let value: DexQuote | null = null;
  try {
    const usdg = creditConfiguration().addresses.usdgAddress?.toLowerCase();
    const pairs = await json(`https://api.dexscreener.com/tokens/v1/robinhood/${key}`) as DsPair[];
    const kindOf = (q: string): "eth" | "usdg" | null =>
      q === ROBINHOOD_WETH || q === NATIVE_QUOTE ? "eth" : usdg && q === usdg ? "usdg" : null;
    const best = pairs
      .filter((p) => p.chainId === "robinhood" && p.baseToken.address.toLowerCase() === key &&
        kindOf(p.quoteToken.address.toLowerCase()))
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    const wei = best ? decimalToWei(best.priceNative) : null;
    if (best && wei && wei > 0n) {
      const kind = kindOf(best.quoteToken.address.toLowerCase())!;
      value = {
        priceNativeWei: wei, liquidityUsd: best.liquidity!.usd!, pairAddress: best.pairAddress, quoteKind: kind,
        quoteAddress: kind === "eth" ? ROBINHOOD_WETH : usdg!, quoteDecimals: kind === "eth" ? 18 : 6,
        imageUrl: best.info?.imageUrl ?? null,
      };
    }
  } catch { value = null; }
  quoteCache.set(key, { at: Date.now(), value });
  return value;
}

/** Independent second feed (GeckoTerminal) used to confirm the DexScreener price: USD price and logo. */
const geckoCache = new Map<string, { at: number; value: { priceUsd: number; imageUrl: string | null } | null }>();
export async function geckoToken(address: string): Promise<{ priceUsd: number; imageUrl: string | null } | null> {
  const key = address.toLowerCase();
  const hit = geckoCache.get(key);
  if (hit && Date.now() - hit.at < (hit.value ? 60_000 : 15_000)) return hit.value;
  let value: { priceUsd: number; imageUrl: string | null } | null = null;
  try {
    const body = await json(`https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/${key}`) as
      { data?: { attributes?: { price_usd?: string | null; image_url?: string | null } } };
    const price = Number(body.data?.attributes?.price_usd);
    if (Number.isFinite(price) && price > 0) value = { priceUsd: price, imageUrl: body.data?.attributes?.image_url && body.data.attributes.image_url !== "missing.png" ? body.data.attributes.image_url : null };
  } catch { value = hit?.value ?? null; }
  geckoCache.set(key, { at: Date.now(), value });
  return value;
}

/** Curated crypto tokens (owner-verified contracts). Decimals are read from the token contract itself. */
async function loadCurated(): Promise<DexToken[]> {
  const out: DexToken[] = [];
  const seen = new Set<string>();
  const entries = [...(curated as Array<{ symbol: string; address: string }>)];
  const project = projectToken();
  if (project) entries.push(project);
  for (const entry of entries) {
    const symbol = entry.symbol.trim().toUpperCase();
    if (!/^[A-Z0-9]{2,12}$/.test(symbol) || !isAddress(entry.address) || seen.has(symbol)) continue;
    try {
      const decimals = Number(await new Contract(entry.address, ["function decimals() view returns (uint8)"], rpc!()).decimals!());
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) continue;
      out.push({ symbol, address: getAddress(entry.address), decimals });
      seen.add(symbol);
    } catch { logger.warn({ symbol }, "Curated token skipped: not a readable ERC20"); }
  }
  return out;
}

export function refreshDexTokens(): Promise<void> {
  refreshing ??= loadCurated().then((list) => {
    tokens = list;
    logger.info({ count: list.length }, "Curated crypto tokens loaded");
  }).catch((err) => logger.warn({ err }, "Curated token load failed")).finally(() => { refreshing = null; });
  return refreshing;
}

export function startDexTokenRefresh(provider: () => import("ethers").JsonRpcProvider): void {
  rpc = provider;
  void refreshDexTokens();
}
