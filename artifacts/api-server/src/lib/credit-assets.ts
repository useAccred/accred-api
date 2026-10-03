import type { CreditChain } from "./credit-policy";
import { isEvmAddress, isSolanaAddress, type CreditConfiguration } from "./credit-config";

import { dexTokens } from "./dex-tokens";

export type CreditAsset = { symbol: string; chain: CreditChain; address: string; decimals: number; dex?: boolean };

export const SOLANA_MAINNET_ASSETS: Readonly<Record<string, CreditAsset>> = {
  SOL: { symbol: "SOL", chain: "solana", address: "native", decimals: 9 },
  USDC: { symbol: "USDC", chain: "solana", address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 },
  USDT: { symbol: "USDT", chain: "solana", address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6 },
};

/** Supported Robinhood stock tokens; every other registry stock entry is ignored. */
const ROBINHOOD_STOCK_SYMBOLS = new Set(("AAPL AMC AMD AMZN CRCL DELL DJT GLXY GME GOOGL IBM INTC META MSFT MSTR NFLX NVDA PENG PLTR QCOM RBLX SNDK SPCX SPY TSLA TSM TTWO WULF WYFI").split(" "));

export function assetRegistry(config: CreditConfiguration): CreditAsset[] {
  const assets = Object.values(SOLANA_MAINNET_ASSETS);
  const raw = process.env.CREDIT_ASSET_REGISTRY;
  if (raw) {
    let entries: unknown;
    try { entries = JSON.parse(raw); } catch { return assets; }
    if (Array.isArray(entries)) {
      for (const item of entries) {
        if (!item || typeof item !== "object") continue;
        const entry = item as Partial<CreditAsset>;
        if (typeof entry.symbol !== "string" || (entry.chain !== "robinhood" && entry.chain !== "solana") ||
            typeof entry.address !== "string" || !Number.isInteger(entry.decimals) ||
            (entry.decimals as number) < 0 || (entry.decimals as number) > 18) continue;
        const canonical = entry.chain === "solana" ? SOLANA_MAINNET_ASSETS[entry.symbol.toUpperCase()] : undefined;
        if (canonical && canonical.address !== entry.address) continue;
        if (entry.chain === "robinhood" && (!isEvmAddress(entry.address) || /^0x0{40}$/i.test(entry.address))) continue;
        if (entry.chain === "solana" && entry.address !== "native" &&
            (!isSolanaAddress(entry.address) || entry.address === "11111111111111111111111111111111")) continue;
        if (entry.chain === "robinhood" && !ROBINHOOD_STOCK_SYMBOLS.has(entry.symbol.toUpperCase()) &&
            !["USDG", "ETH"].includes(entry.symbol.toUpperCase())) continue; // only the supported stock-token list
        assets.push({ symbol: entry.symbol.toUpperCase(), chain: entry.chain, address: entry.address, decimals: entry.decimals as number });
      }
    }
  }
  if (config.addresses.usdgAddress) {
    const usdg = assets.find((asset) => asset.chain === "robinhood" && asset.symbol === "USDG");
    if (!usdg) {
      const decimalsText = process.env.CREDIT_USDG_DECIMALS?.trim();
      const decimals = decimalsText ? Number(decimalsText) : Number.NaN;
      if (Number.isInteger(decimals) && decimals >= 0 && decimals <= 18) {
        assets.push({ symbol: "USDG", chain: "robinhood", address: config.addresses.usdgAddress, decimals });
      }
    } else if (usdg.address.toLowerCase() !== config.addresses.usdgAddress.toLowerCase()) {
      return assets.filter((asset) => !(asset.chain === "robinhood" && asset.symbol === "USDG"));
    }
  }
  // Native ETH on Robinhood Chain: accepted for swaps (direct transfer to the treasury) and payable on redeem.
  if (!assets.some((asset) => asset.chain === "robinhood" && asset.symbol === "ETH")) {
    assets.push({ symbol: "ETH", chain: "robinhood", address: "native", decimals: 18 });
  }
  // Top WETH-paired Robinhood Chain tokens (DexScreener-priced); never override a registered symbol or address.
  for (const token of dexTokens()) {
    if (assets.some((x) => x.chain === "robinhood" && (x.symbol === token.symbol || x.address.toLowerCase() === token.address.toLowerCase()))) continue;
    assets.push({ symbol: token.symbol, chain: "robinhood", address: token.address, decimals: token.decimals, dex: true });
  }
  return assets;
}

export function findCreditAsset(config: CreditConfiguration, chain: CreditChain, symbol: string): CreditAsset | undefined {
  return assetRegistry(config).find((asset) => asset.chain === chain && asset.symbol.toUpperCase() === symbol.trim().toUpperCase());
}

export function isDirectBuyAsset(chain: CreditChain, symbol: string): boolean {
  const normalized = symbol.trim().toUpperCase();
  return (chain === "robinhood" && normalized === "USDG") ||
    (chain === "solana" && ["SOL", "USDC", "USDT"].includes(normalized));
}