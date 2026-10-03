import { Contract, formatUnits, parseUnits } from "ethers";
import { and, eq } from "drizzle-orm";
import { creditEconomyActivity, db } from "@workspace/db";
import { PROJECT_TOKEN_BURN_ADDRESS, projectToken } from "./dex-tokens";
import { rpcProvider } from "./internal-router";

export type CredStats = {
  symbol: string; address: string; burnAddress: string;
  priceUsd: number | null; priceChange24h: number | null; marketCapUsd: number | null;
  liquidityUsd: number | null; volume24hUsd: number | null; pairUrl: string | null;
  totalSupply: string; burned: string; burnedPercent: number; circulatingSupply: string;
  burnedViaAccred: string; accredBurns: number; updatedAt: string;
};

type DsPair = {
  chainId: string; url?: string; priceUsd?: string; baseToken: { address: string };
  liquidity?: { usd?: number }; volume?: { h24?: number }; priceChange?: { h24?: number };
};

let cache: { at: number; value: CredStats } | null = null;

/** Live $CRED numbers: DexScreener price of the deepest pair, on-chain supply and dead-address balance, and Accred's own burns. */
export async function credStats(): Promise<CredStats | null> {
  const own = projectToken();
  if (!own) return null;
  if (cache && Date.now() - cache.at < 30_000) return cache.value;
  const token = new Contract(own.address, [
    "function totalSupply() view returns (uint256)", "function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)",
  ], rpcProvider());
  const [supply, dead, decimals, pairs, burns] = await Promise.all([
    token.totalSupply!() as Promise<bigint>,
    token.balanceOf!(PROJECT_TOKEN_BURN_ADDRESS) as Promise<bigint>,
    token.decimals!().then(Number) as Promise<number>,
    fetch(`https://api.dexscreener.com/tokens/v1/robinhood/${own.address.toLowerCase()}`, { signal: AbortSignal.timeout(10_000) })
      .then((r) => (r.ok ? r.json() as Promise<DsPair[]> : [])).catch(() => [] as DsPair[]),
    db.select({ amount: creditEconomyActivity.amount }).from(creditEconomyActivity)
      .where(and(eq(creditEconomyActivity.kind, "burn"), eq(creditEconomyActivity.status, "completed"))),
  ]);
  const pair = pairs
    .filter((p) => p.chainId === "robinhood" && p.baseToken.address.toLowerCase() === own.address.toLowerCase() && Number(p.priceUsd) > 0)
    .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  const accred = burns.reduce((sum, row) => {
    try { return sum + parseUnits(row.amount, decimals); } catch { return sum; }
  }, 0n);
  const circulating = supply > dead ? supply - dead : 0n;
  const priceUsd = pair ? Number(pair.priceUsd) : null;
  const value: CredStats = {
    symbol: own.symbol, address: own.address, burnAddress: PROJECT_TOKEN_BURN_ADDRESS,
    priceUsd, priceChange24h: pair?.priceChange?.h24 ?? null,
    marketCapUsd: priceUsd === null ? null : priceUsd * Number(formatUnits(circulating, decimals)),
    liquidityUsd: pair?.liquidity?.usd ?? null, volume24hUsd: pair?.volume?.h24 ?? null, pairUrl: pair?.url ?? null,
    totalSupply: formatUnits(supply, decimals), burned: formatUnits(dead, decimals),
    burnedPercent: supply > 0n ? Number((dead * 1_000_000n) / supply) / 10_000 : 0,
    circulatingSupply: formatUnits(circulating, decimals),
    burnedViaAccred: formatUnits(accred, decimals), accredBurns: burns.length, updatedAt: new Date().toISOString(),
  };
  cache = { at: Date.now(), value };
  return value;
}
