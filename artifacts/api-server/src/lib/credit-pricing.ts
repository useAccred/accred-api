// Live USD price oracle for swap and redeem. No hardcoded prices: every value comes from a public market feed.
// Stocks/ETFs: Nasdaq official real-time quote API (primary) cross-checked with Yahoo chart API (must agree within 2%). ETH: Coinbase cross-checked with CoinGecko (must agree within 2%).

export class PriceUnavailable extends Error {
  constructor(message = "price_unavailable") { super(message); }
}

export type OraclePrice = {
  /** USD price of one whole token, scaled by 1e6. */
  micros: bigint;
  /** True when the primary market is not in its regular session or the last print is stale. */
  offHours: boolean;
};

const UA = "Mozilla/5.0 (compatible; AccredPricing/1.0)";
const TTL_MS = 15_000;
const cache = new Map<string, { at: number; value: OraclePrice | null }>();

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(6_000) });
  if (!response.ok) throw new PriceUnavailable(`price_feed_http_${response.status}`);
  return response.json();
}

const toMicros = (value: number): bigint => BigInt(Math.round(value * 1_000_000));

async function ethPrice(): Promise<OraclePrice> {
  const [coinbase, gecko] = await Promise.all([
    getJson("https://api.coinbase.com/v2/prices/ETH-USD/spot").then((b) => Number((b as { data?: { amount?: string } }).data?.amount)),
    getJson("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd").then((b) => Number((b as { ethereum?: { usd?: number } }).ethereum?.usd)),
  ]);
  if (!Number.isFinite(coinbase) || !Number.isFinite(gecko) || coinbase <= 0 || gecko <= 0) throw new PriceUnavailable("eth_price_invalid");
  if (Math.abs(coinbase - gecko) / Math.min(coinbase, gecko) > 0.02) throw new PriceUnavailable("eth_price_sources_disagree");
  return { micros: toMicros(Math.min(coinbase, gecko)), offHours: false };
}

type YahooChart = {
  chart?: { result?: Array<{
    meta?: { currency?: string; symbol?: string; instrumentType?: string; regularMarketPrice?: number; currentTradingPeriod?: { regular?: { start?: number; end?: number } } };
    timestamp?: number[];
    indicators?: { quote?: Array<{ close?: Array<number | null> }> };
  }> };
};

async function stockPrice(symbol: string): Promise<OraclePrice> {
  if (!/^[A-Z.\-]{1,8}$/.test(symbol)) throw new PriceUnavailable("symbol_invalid");
  const body = await getJson(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=5m&includePrePost=true`,
  ) as YahooChart;
  const result = body.chart?.result?.[0];
  const meta = result?.meta;
  if (!result || !meta || meta.symbol?.toUpperCase() !== symbol || meta.currency !== "USD") throw new PriceUnavailable("symbol_not_priced");
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  const stamps = result.timestamp ?? [];
  let price = Number.NaN;
  let at = 0;
  for (let i = closes.length - 1; i >= 0; i--) {
    const c = closes[i];
    if (typeof c === "number" && c > 0 && stamps[i]) { price = c; at = stamps[i]! * 1000; break; }
  }
  if (!Number.isFinite(price) && typeof meta.regularMarketPrice === "number") price = meta.regularMarketPrice;
  if (!Number.isFinite(price) || price <= 0) throw new PriceUnavailable("symbol_not_priced");
  const now = Date.now();
  const regular = meta.currentTradingPeriod?.regular;
  const inRegular = regular?.start !== undefined && regular.end !== undefined &&
    now >= regular.start * 1000 && now <= regular.end * 1000;
  const fresh = at > 0 && now - at <= 15 * 60_000;
  return { micros: toMicros(price), offHours: !(inRegular && fresh) };
}

type NasdaqInfo = { data?: { marketStatus?: string; primaryData?: { lastSalePrice?: string; isRealTime?: boolean } } | null };

/** Nasdaq's own quote feed (exchange-published, real time). Tries the stock class, then ETF. */
async function nasdaqPrice(symbol: string): Promise<OraclePrice> {
  if (!/^[A-Z.\-]{1,8}$/.test(symbol)) throw new PriceUnavailable("symbol_invalid");
  for (const assetClass of ["stocks", "etf"]) {
    try {
      const body = await getJson(`https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/info?assetclass=${assetClass}`) as NasdaqInfo;
      const price = Number((body.data?.primaryData?.lastSalePrice ?? "").replace(/[$,]/g, ""));
      if (Number.isFinite(price) && price > 0 && body.data?.primaryData?.isRealTime) {
        return { micros: toMicros(price), offHours: body.data.marketStatus !== "Open" };
      }
    } catch { /* try next class */ }
  }
  throw new PriceUnavailable("symbol_not_priced");
}

/** Two independent feeds: both must agree within 2% (lower used). A single live feed is accepted if the other is down. */
async function crossCheckedStockPrice(symbol: string): Promise<OraclePrice> {
  const [nasdaq, yahoo] = await Promise.allSettled([nasdaqPrice(symbol), stockPrice(symbol)]);
  const a = nasdaq.status === "fulfilled" ? nasdaq.value : null;
  const b = yahoo.status === "fulfilled" ? yahoo.value : null;
  if (a && b) {
    const lo = a.micros < b.micros ? a.micros : b.micros;
    const hi = a.micros < b.micros ? b.micros : a.micros;
    if ((hi - lo) * 100n > lo * 2n) throw new PriceUnavailable("stock_price_sources_disagree");
    return { micros: lo, offHours: a.offHours || b.offHours };
  }
  const only = a ?? b;
  if (!only) throw new PriceUnavailable("symbol_not_priced");
  return only;
}

/** Live oracle price for a Robinhood-chain asset symbol; null when no reliable price exists. */
export async function oraclePrice(symbol: string): Promise<OraclePrice | null> {
  const key = symbol.toUpperCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let value: OraclePrice | null = null;
  try { value = key === "ETH" ? await ethPrice() : await crossCheckedStockPrice(key); } catch { value = null; }
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Spread kept on both swap and redeem to cover price movement while a transaction finalizes. */
export function haircutBps(price: OraclePrice): bigint {
  return price.offHours ? 200n : 50n;
}
