import { isAddress } from "ethers";

const RH_MAINNET_RPC = "https://rpc.mainnet.chain.robinhood.com";
const SOLANA_MAINNET_RPC = "https://api.mainnet-beta.solana.com";
const RH_EXPLORER = "https://robin.etherscan.io";
const SOLANA_EXPLORER = "https://explorer.solana.com";

function readAddress(name: string): string | null {
  const value = process.env[name]?.trim();
  return value && isAddress(value) && !/^0x0{40}$/i.test(value) ? value : null;
}

function trustedHttpsUrl(value: string | undefined, allowedHosts: string[]): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password ||
        !allowedHosts.includes(parsed.hostname.toLowerCase()) ||
        parsed.hostname === "localhost" || parsed.hostname.endsWith(".localhost") ||
        parsed.hostname.endsWith(".local") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(parsed.hostname)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function allowedHosts(env: string | undefined): string[] {
  return (env ?? "").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
}

function usdgDecimals(address: string | null): number | null {
  if (!address) return null;
  const configuredDecimalText = process.env.CREDIT_USDG_DECIMALS?.trim();
  const configuredDecimals = configuredDecimalText ? Number(configuredDecimalText) : Number.NaN;
  if (Number.isInteger(configuredDecimals) && configuredDecimals >= 0 && configuredDecimals <= 18) return configuredDecimals;
  try {
    const entries = JSON.parse(process.env.CREDIT_ASSET_REGISTRY ?? "[]");
    const entry = Array.isArray(entries) ? entries.find((item) =>
      item && typeof item === "object" &&
      item.chain === "robinhood" &&
      typeof item.symbol === "string" && item.symbol.toUpperCase() === "USDG" &&
      typeof item.address === "string" && item.address.toLowerCase() === address.toLowerCase() &&
      Number.isInteger(item.decimals) && item.decimals >= 0 && item.decimals <= 18,
    ) : undefined;
    return entry?.decimals ?? null;
  } catch {
    return null;
  }
}

export function creditConfiguration() {
  const robinhoodRpc = trustedHttpsUrl(
    process.env.ROBINHOOD_RPC_URL ?? RH_MAINNET_RPC,
    ["rpc.mainnet.chain.robinhood.com", "robinhood-mainnet.g.alchemy.com", ...allowedHosts(process.env.CREDIT_RPC_ALLOWED_HOSTS)],
  );
  const solanaRpc = trustedHttpsUrl(
    process.env.SOLANA_MAINNET_RPC_URL ?? SOLANA_MAINNET_RPC,
    ["api.mainnet-beta.solana.com", ...allowedHosts(process.env.CREDIT_RPC_ALLOWED_HOSTS)],
  );
  const creditTokenAddress = readAddress("CREDIT_TOKEN_ADDRESS");
  const vaultAddress = readAddress("CREDIT_VAULT_ADDRESS");
  const purchaseAddress = readAddress("CREDIT_PURCHASE_ADDRESS");
  const redeemAddress = readAddress("CREDIT_REDEEM_ADDRESS");
  const treasuryAddress = readAddress("CREDIT_TREASURY_ADDRESS");
  const cashbackAddress = readAddress("CREDIT_CASHBACK_ADDRESS");
  const usdgAddress = readAddress("CREDIT_USDG_ADDRESS");
  const stakingAddress = readAddress("CREDIT_STAKING_ADDRESS");
  const configuredSolanaTreasury = process.env.SOLANA_TREASURY_ADDRESS?.trim();
  const solanaTreasuryAddress = configuredSolanaTreasury && isSolanaAddress(configuredSolanaTreasury) &&
    configuredSolanaTreasury !== "11111111111111111111111111111111" ? configuredSolanaTreasury : null;
  const routerHosts = allowedHosts(process.env.CREDIT_ROUTER_ALLOWED_HOSTS);
  const routerQuoteUrl = trustedHttpsUrl(process.env.CREDIT_ROUTER_QUOTE_URL, routerHosts);
  const solanaExecutorPrograms = (process.env.CREDIT_SOLANA_EXECUTOR_PROGRAMS ?? "")
    .split(",").map((entry) => entry.trim()).filter((entry) => isSolanaAddress(entry));
  const settlementServiceUrl = trustedHttpsUrl(
    process.env.CREDIT_SETTLEMENT_SERVICE_URL,
    allowedHosts(process.env.CREDIT_SETTLEMENT_ALLOWED_HOSTS),
  );
  const settlementSignerAddress = readAddress("CREDIT_SETTLEMENT_SIGNER_ADDRESS");
  const settlementConfigured = Boolean(settlementServiceUrl && process.env.CREDIT_SETTLEMENT_SERVICE_TOKEN && settlementSignerAddress);
  const settlementEnabled = settlementConfigured && Boolean(robinhoodRpc && creditTokenAddress && vaultAddress);
  const usdgDecimalsValue = usdgDecimals(usdgAddress);
  const usdgAssetEnabled = usdgDecimalsValue !== null;
  const missing = [
    !creditTokenAddress && "CREDIT_TOKEN_ADDRESS",
    !vaultAddress && "CREDIT_VAULT_ADDRESS",
    !purchaseAddress && "CREDIT_PURCHASE_ADDRESS (deployed atomic direct-buy contract)",
    !treasuryAddress && "CREDIT_TREASURY_ADDRESS",
    !redeemAddress && "CREDIT_REDEEM_ADDRESS",
    !usdgAddress && "CREDIT_USDG_ADDRESS",
    usdgAddress && !usdgAssetEnabled && "CREDIT_USDG_DECIMALS or matching USDG entry in CREDIT_ASSET_REGISTRY",
    usdgAddress && usdgAssetEnabled && usdgDecimalsValue !== 6 && "USDG metadata with exactly 6 decimals for atomic redemption",
  ].filter((entry): entry is string => Boolean(entry));

  const accountEnabled = Boolean(robinhoodRpc && creditTokenAddress && vaultAddress);
  const swapsEnabled = Boolean(process.env.CREDIT_ROUTER_SUPPORTS_SWAPS === "true" && routerQuoteUrl && creditTokenAddress && vaultAddress && treasuryAddress && settlementEnabled);
  const solanaBuysEnabled = Boolean(routerQuoteUrl && creditTokenAddress && vaultAddress && solanaTreasuryAddress && solanaRpc && settlementEnabled);
  const solanaSwapsEnabled = Boolean(solanaBuysEnabled && solanaExecutorPrograms.length);
  const redemptionEnabled = Boolean(routerQuoteUrl && robinhoodRpc && creditTokenAddress && treasuryAddress && usdgAddress && usdgDecimalsValue === 6);
  const cashbackEnabled = Boolean(cashbackAddress && usdgAddress && usdgAssetEnabled && settlementEnabled);
  const cashbackMissing = [
    !cashbackAddress && "CREDIT_CASHBACK_ADDRESS",
    !usdgAddress && "CREDIT_USDG_ADDRESS",
    usdgAddress && !usdgAssetEnabled && "USDG token decimal metadata",
    !settlementEnabled && "secure settlement signer service and Robinhood mainnet RPC",
  ].filter((entry): entry is string => Boolean(entry));
  const config = {
    network: "Robinhood Chain Mainnet",
    chainId: 4663,
    rpcUrl: RH_MAINNET_RPC,
    explorerUrl: RH_EXPLORER,
    creditTokenAddress,
    vaultAddress,
    purchaseAddress,
      redeemAddress,
    treasuryAddress,
    cashbackAddress,
    usdgAddress,
    stakingAddress,
    solanaTreasuryAddress,
    creditsPerUsd: 100,
    capabilities: {
      account: { enabled: accountEnabled, reason: accountEnabled ? null : "Configure valid CREDIT_TOKEN_ADDRESS and CREDIT_VAULT_ADDRESS plus a trusted Robinhood mainnet RPC." },
      buy: { enabled: Boolean(routerQuoteUrl && purchaseAddress && treasuryAddress && robinhoodRpc && creditTokenAddress && usdgAssetEnabled), reason: routerQuoteUrl && purchaseAddress && treasuryAddress && robinhoodRpc && creditTokenAddress && usdgAssetEnabled ? null : "Configure the trusted executable quote router, deployed Robinhood purchase contract and treasury, credit token, USDG token metadata, and Robinhood mainnet RPC." },
      solanaBuy: { enabled: solanaBuysEnabled, reason: solanaBuysEnabled ? null : "Configure Solana mainnet RPC/treasury, trusted executable quote router, credit contracts, and secure settlement signer service." },
      solanaSwaps: { enabled: solanaSwapsEnabled, reason: solanaSwapsEnabled ? null : "Configure a trusted Solana mainnet executor program allowlist plus all Solana purchase and settlement prerequisites." },
      swap: { enabled: swapsEnabled, reason: swapsEnabled ? null : "Configure a trusted executable router quote endpoint, credit contracts, and treasury." },
      redeem: { enabled: redemptionEnabled, reason: redemptionEnabled ? null : "Configure the treasury address, USDG token metadata, and trusted executable quote router on Robinhood Chain mainnet." },
      cashback: { enabled: cashbackEnabled, reason: cashbackEnabled ? null : `Configure ${cashbackMissing.join(", ")} for finalized USDG cashback payouts.` },
      solana: { enabled: Boolean(solanaRpc && solanaTreasuryAddress), reason: solanaRpc && solanaTreasuryAddress ? null : "Configure a trusted Solana mainnet RPC and valid SOLANA_TREASURY_ADDRESS." },
      settlement: { enabled: settlementEnabled, reason: settlementEnabled ? null : "Configure an allowlisted HTTPS settlement signer service, its service token, and public CREDIT_SETTLEMENT_SIGNER_ADDRESS; local signing keys are never read." },
    },
    missing,
  };
  return {
    ...config,
    addresses: { creditTokenAddress, vaultAddress, purchaseAddress, redeemAddress, treasuryAddress, cashbackAddress, usdgAddress, stakingAddress, solanaTreasuryAddress },
    robinhoodRpcUrl: robinhoodRpc,
    solanaRpcUrl: solanaRpc,
    routerQuoteUrl,
    routerHosts,
    solanaExecutorPrograms,
    settlementServiceUrl,
    settlementSignerAddress,
    settlementEnabled,
  };
}

export type CreditConfiguration = ReturnType<typeof creditConfiguration>;

export function isEvmAddress(value: unknown): value is string {
  return typeof value === "string" && isAddress(value);
}

export function isSolanaAddress(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let decoded = 0n;
  for (const character of value) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) return false;
    decoded = decoded * 58n + BigInt(digit);
  }
  const decodedBytes = decoded === 0n ? 0 : Math.ceil(decoded.toString(2).length / 8);
  const leadingZeroBytes = value.match(/^1*/)?.[0].length ?? 0;
  return decodedBytes + leadingZeroBytes === 32;
}

export function publicRpcUrl(url: string | null, fallback: string): string {
  if (!url) return fallback;
  const parsed = new URL(url);
  // Do not publish RPC provider API keys embedded in URL paths or query strings.
  const publicHosts = new Set(["rpc.mainnet.chain.robinhood.com", "api.mainnet-beta.solana.com"]);
  // A keyed provider URL is never exposed; browsers and wallets use the public endpoint instead.
  return publicHosts.has(parsed.hostname.toLowerCase()) && parsed.pathname === "/" ? `${parsed.origin}/` : fallback;
}