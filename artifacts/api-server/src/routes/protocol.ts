import { stakingCapacity } from "../lib/staking-rewards";
import { Router, type IRouter } from "express";
import { creditConfiguration } from "../lib/credit-config";
import { isCustomerGatewayConfigured } from "../lib/customer-gateway";
import {
  GetProtocolActivityResponse,
  GetProtocolEconomicsResponse,
  GetProtocolStatusResponse,
  ListStockTokensQueryParams,
  ListStockTokensResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

type RobinhoodAsset = {
  tokenSymbol: string;
  tokenName: string;
  tokenDecimals: number;
  status: string;
  logoUrl?: string;
  tradingCapabilities?: Record<string, { whole?: string; fractional?: string }>;
  deployments?: Array<{ chainId: number; contractAddress: string }>;
};

let stockCache: { data: RobinhoodAsset[]; expiresAt: number } | undefined;

async function getStockAssets(): Promise<RobinhoodAsset[]> {
  if (stockCache && stockCache.expiresAt > Date.now()) return stockCache.data;
  const response = await fetch("https://api.robinhood.com/rhj/assets", {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Robinhood asset API returned ${response.status}`);
  const body: unknown = await response.json();
  if (
    !body ||
    typeof body !== "object" ||
    !("assets" in body) ||
    !Array.isArray(body.assets)
  ) throw new Error("Robinhood asset API returned invalid data");
  stockCache = { data: body.assets as RobinhoodAsset[], expiresAt: Date.now() + 60_000 };
  return stockCache.data;
}

async function stakingStatus(config: ReturnType<typeof creditConfiguration>) {
  const staking = config.addresses.stakingAddress;
  const usdg = config.addresses.usdgAddress;
  if (!staking || !usdg) return unavailable("Staking contract is not configured.");
  try {
    return (await stakingCapacity()) > 0n
      ? { enabled: true, reason: null }
      : unavailable("The staking reward wallet has no unreserved USDG.");
  } catch {
    return unavailable("Staking reward pool could not be read from Robinhood Chain.");
  }
}

const ok = <T extends { enabled: boolean; reason: string | null }>(c: T) => ({ ...c, reason: c.reason ?? "Available" });
const unavailable = (reason: string) => ({ enabled: false, reason });

router.get("/protocol/status", async (_req, res) => {
  const config = creditConfiguration();
  res.json(GetProtocolStatusResponse.parse({
    network: "Robinhood Chain Mainnet",
    chainId: 4663,
    checkedAt: new Date().toISOString(),
    credits: {
      enabled: config.capabilities.buy.enabled,
      reason: config.capabilities.buy.reason ?? "Available",
    },
    trading: {
      enabled: config.capabilities.swap.enabled && config.capabilities.settlement.enabled,
      reason: (config.capabilities.settlement.enabled ? config.capabilities.swap.reason : config.capabilities.settlement.reason) ?? "Available",
    },
    staking: ok(await stakingStatus(config)),
    cashback: ok(config.capabilities.cashback),
    customerApi: {
      enabled: isCustomerGatewayConfigured(),
      reason: isCustomerGatewayConfigured() ? "Configured gateway; each request still requires verified pricing and confirmed onchain reservation." : "Configure the deployed credit vault, authorized gateway signer, and verified model prices.",
    },
    xBot: unavailable("X bot availability is checked through the authenticated /x-bot/status endpoint."),
    x402: unavailable("No compatible facilitator or settlement integration is configured."),
  }));
});

router.get("/protocol/economics", (_req, res) => {
  res.json(GetProtocolEconomicsResponse.parse({
    creditsPerUsdOfService: 100,
    projectTokenBonusPercent: 10,
    stakeTerms: [
      { days: 3, termPercent: 3.5 },
      { days: 7, termPercent: 5 },
      { days: 30, termPercent: 9.99 },
    ],
    cashbackPercent: 10,
    cashbackHourlyCapUsdg: 10,
    cashbackCooldownMinutes: 60,
    cashbackEligibleEvents: ["swap"],
    cashbackExcludedPatterns: ["self_transfer", "same_funds_round_trip", "repeated_deposit_withdraw", "duplicate_economic_action"],
    xMentionsEligible: false,
    rewardsActive: false,
  }));
});

router.get("/protocol/activity", (_req, res) => {
  // No actual confirmed protocol events exist until contracts and indexing are connected.
  res.json(GetProtocolActivityResponse.parse([]));
});

router.get("/market/stock-tokens", async (req, res): Promise<void> => {
  const parsed = ListStockTokensQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const assets = await getStockAssets();
    const search = parsed.data.search?.trim().toLowerCase() ?? "";
    const result = assets
      .filter((asset) => asset.deployments?.some((entry) =>
        entry.chainId === 4663 && /^0x[a-fA-F0-9]{40}$/.test(entry.contractAddress),
      ))
      .filter((asset) =>
        !search ||
        asset.tokenSymbol.toLowerCase().includes(search) ||
        asset.tokenName.toLowerCase().includes(search),
      )
      .sort((a, b) => {
        if (a.tokenSymbol === "NVDA") return -1;
        if (b.tokenSymbol === "NVDA") return 1;
        return a.tokenSymbol.localeCompare(b.tokenSymbol);
      })
      .slice(0, parsed.data.limit ?? 12)
      .map((asset) => ({
        symbol: asset.tokenSymbol,
        name: asset.tokenName,
        address: asset.deployments!.find((entry) => entry.chainId === 4663)!.contractAddress,
        decimals: asset.tokenDecimals,
        status: asset.status,
        tradingSession: Object.entries(asset.tradingCapabilities ?? {})
          .filter(([, state]) => state.whole === "TRADING_STATUS_TRADABLE" || state.fractional === "TRADING_STATUS_TRADABLE")
          .map(([session]) => session)
          .join(", ") || "unavailable",
        logoUrl: asset.logoUrl ?? "",
      }));
    res.json(ListStockTokensResponse.parse(result));
  } catch (error) {
    req.log.error({ error }, "Could not fetch verified Stock Token metadata");
    res.status(502).json({ error: "Robinhood asset metadata is temporarily unavailable." });
  }
});

export default router;