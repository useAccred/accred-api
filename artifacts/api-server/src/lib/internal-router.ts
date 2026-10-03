import { Interface, Wallet, formatUnits, keccak256, parseUnits, toUtf8Bytes, JsonRpcProvider, Contract } from "ethers";
import { creditConfiguration } from "./credit-config";
import { findCreditAsset, type CreditAsset } from "./credit-assets";
import { haircutBps, oraclePrice } from "./credit-pricing";
import { PROJECT_TOKEN_BONUS_BPS, dexQuote, geckoToken, isProjectToken, projectToken } from "./dex-tokens";
import { SOLANA_MEMO_PROGRAM, SOLANA_SYSTEM_PROGRAM, SOLANA_TOKEN_PROGRAM } from "./credit-solana";

// Quote router for the Accred credit contracts. Credits are priced 1:1 against USD value (100 credits = $1)
// with no markup; only assets with a verifiable USD price source are quoted.

const QUOTE_TTL_SECONDS = 240;
const ZERO = "0x0000000000000000000000000000000000000000";
const SOLANA_ASSETS = {
  SOL: { mint: "native", decimals: 9 },
  USDC: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 },
  USDT: { mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6 },
} as const;

const UNISWAP_FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const UNISWAP_QUOTER_V2 = "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7";
const FEE_TIERS = [100, 500, 3000, 10000];
const quoterAbi = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
];
const factoryAbi = ["function getPool(address,address,uint24) view returns (address)"];

const erc20 = new Interface([
  "function approve(address spender,uint256 amount) returns (bool)",
  "function transfer(address to,uint256 amount) returns (bool)",
]);
const purchase = new Interface([
  "function settle((uint256 chainId,address inputToken,address creditToken,address user,uint256 inputAmount,uint256 creditAmount,uint256 minCredits,uint256 deadline,uint256 nonce) q,bytes signature)",
]);

export class RouterError extends Error {
  constructor(message: string, readonly status = 422) { super(message); }
}

export function signerWallet(): Wallet {
  const key = process.env.CASHBACK_PRIVATE_KEY;
  if (!key) throw new RouterError("settlement_signer_not_configured", 503);
  return new Wallet(key);
}

export function rpcProvider(): JsonRpcProvider {
  return new JsonRpcProvider(process.env.ROBINHOOD_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com", 4663, { staticNetwork: true });
}

// ---- Solana helpers -------------------------------------------------------------------------
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function decodeBase58(text: string): Buffer {
  let value = 0n;
  for (const ch of text) {
    const digit = B58.indexOf(ch);
    if (digit < 0) throw new RouterError("invalid_base58");
    value = value * 58n + BigInt(digit);
  }
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const body = value === 0n ? Buffer.alloc(0) : Buffer.from(hex, "hex");
  const zeros = text.length - text.replace(/^1+/, "").length;
  return Buffer.concat([Buffer.alloc(zeros), body]);
}
export function encodeBase58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let out = "";
  while (value > 0n) { out = B58[Number(value % 58n)] + out; value /= 58n; }
  for (const byte of bytes) { if (byte === 0) out = `1${out}`; else break; }
  return out;
}
const shortVec = (n: number) => Buffer.from([n]); // all lengths here are < 128

async function solanaRpc<T>(method: string, params: unknown[]): Promise<T> {
  const url = process.env.SOLANA_MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new RouterError(`solana_rpc_http_${response.status}`, 502);
  const body = await response.json() as { result?: T; error?: { message?: string } };
  if (body.error || body.result === undefined) throw new RouterError(`solana_rpc_error:${body.error?.message ?? "empty"}`, 502);
  return body.result;
}
export { solanaRpc };

export async function solUsdMicros(): Promise<bigint> {
  const response = await fetch("https://api.coinbase.com/v2/prices/SOL-USD/spot", { signal: AbortSignal.timeout(6_000) });
  if (!response.ok) throw new RouterError("sol_price_unavailable", 503);
  const body = await response.json() as { data?: { amount?: string } };
  const amount = body.data?.amount;
  if (!amount || !/^\d+(\.\d+)?$/.test(amount) || Number(amount) < 1 || Number(amount) > 10_000) throw new RouterError("sol_price_out_of_range", 503);
  return parseUnits(Number(amount).toFixed(6), 6);
}

async function tokenAccount(owner: string, mint: string, requireBalance: bigint): Promise<string> {
  const result = await solanaRpc<{ value: Array<{ pubkey: string; account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }> }>(
    "getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed", commitment: "finalized" }]);
  const sorted = result.value
    .map((entry) => ({ key: entry.pubkey, amount: BigInt(entry.account.data.parsed.info.tokenAmount.amount) }))
    .sort((a, b) => (a.amount > b.amount ? -1 : 1));
  const match = sorted.find((entry) => entry.amount >= requireBalance);
  if (!match) throw new RouterError(requireBalance > 0n ? "insufficient_solana_token_balance" : "treasury_token_account_missing");
  return match.key;
}

function u64(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; }

function buildSolanaTransaction(args: {
  payer: string;
  recentBlockhash: string;
  instructions: Array<{ program: string; accounts: string[]; data: Buffer }>;
  writable: Set<string>;
}): Buffer {
  const keys: string[] = [args.payer];
  const readonlyUnsigned: string[] = [];
  const writableUnsigned: string[] = [];
  for (const instruction of args.instructions) {
    for (const account of [...instruction.accounts, instruction.program]) {
      if (account === args.payer || keys.includes(account) || writableUnsigned.includes(account) || readonlyUnsigned.includes(account)) continue;
      (args.writable.has(account) ? writableUnsigned : readonlyUnsigned).push(account);
    }
  }
  const ordered = [...keys, ...writableUnsigned, ...readonlyUnsigned];
  const index = (account: string) => ordered.indexOf(account);
  const parts: Buffer[] = [
    shortVec(1), Buffer.alloc(64), // one empty signature slot for the wallet
    Buffer.from([1, 0, readonlyUnsigned.length]),
    shortVec(ordered.length), ...ordered.map(decodeBase58),
    decodeBase58(args.recentBlockhash),
    shortVec(args.instructions.length),
  ];
  for (const instruction of args.instructions) {
    parts.push(
      Buffer.from([index(instruction.program)]),
      shortVec(instruction.accounts.length), Buffer.from(instruction.accounts.map(index)),
      shortVec(instruction.data.length), instruction.data,
    );
  }
  return Buffer.concat(parts);
}

// ---- Quote request/response -----------------------------------------------------------------
type QuoteRequest = {
  mode: string; chain: string; asset: string; assetAddress: string; amount: string;
  sender: string; recipient: string; configuredDestination: string; configuredPaymentDestination: string;
  reference: string; redeemQuoteId?: string; redeemActionId?: string; purchaseNonce?: string;
};

export async function quote(request: QuoteRequest): Promise<Record<string, unknown>> {
  const config = creditConfiguration();
  const { creditTokenAddress, purchaseAddress, treasuryAddress, usdgAddress } = config.addresses;
  const asset = request.asset.toUpperCase();
  const expiresAt = new Date(Date.now() + QUOTE_TTL_SECONDS * 1000);
  const deadline = BigInt(Math.floor(expiresAt.getTime() / 1000));
  const signer = signerWallet();

  if (request.chain === "solana") return solanaQuote(request, asset, expiresAt, config.addresses.solanaTreasuryAddress);
  if (request.chain !== "robinhood" || !creditTokenAddress) throw new RouterError("unsupported_chain");

  if (request.mode === "buy" || request.mode === "swap") {
    // The only Robinhood asset with a verifiable USD price is USDG ($1, six decimals). Other tokens need a price source.
    if (request.mode === "swap") return swapQuote(request, expiresAt);
    if (asset !== "USDG" || !usdgAddress || !purchaseAddress || !treasuryAddress) throw new RouterError("no_verified_price_source_for_asset");
    const units = parseUnits(request.amount, 6);
    if (units <= 0n) throw new RouterError("amount_too_small");
    const netUsdMicros = units;
    if (netUsdMicros < MIN_USD_MICROS) throw new RouterError("amount_too_small");
    const credits = netUsdMicros * 100n * 10n ** 12n;
    const q = {
      chainId: 4663n, inputToken: usdgAddress, creditToken: creditTokenAddress, user: request.recipient,
      inputAmount: units, creditAmount: credits, minCredits: credits, deadline, nonce: BigInt(request.purchaseNonce ?? "0"),
    };
    const signature = await signer.signTypedData(
      { name: "Accred", version: "1", chainId: 4663, verifyingContract: purchaseAddress },
      { Quote: [
        { name: "chainId", type: "uint256" }, { name: "inputToken", type: "address" }, { name: "creditToken", type: "address" },
        { name: "user", type: "address" }, { name: "inputAmount", type: "uint256" }, { name: "creditAmount", type: "uint256" },
        { name: "minCredits", type: "uint256" }, { name: "deadline", type: "uint256" }, { name: "nonce", type: "uint256" },
      ] },
      q,
    );
    const data = purchase.encodeFunctionData("settle", [q, signature]);
    return {
      executable: true, id: `rh-buy-${keccak256(toUtf8Bytes(request.reference)).slice(2, 18)}`, expiresAt: expiresAt.toISOString(),
      transaction: { to: purchaseAddress, data, value: "0" },
      expectedTo: purchaseAddress, expectedValue: "0", expectedCalldata: data,
      inputToken: usdgAddress, inputAmount: request.amount, outputToken: creditTokenAddress,
      outputAmount: formatUnits(credits, 18), netUsdMicros: netUsdMicros.toString(),
      expectedTransfers: [{ tokenAddress: usdgAddress, from: request.sender, to: treasuryAddress, amount: units.toString() }],
      approvals: [{
        chainId: 4663, tokenAddress: usdgAddress, spender: purchaseAddress, amount: units.toString(),
        transaction: { to: usdgAddress, data: erc20.encodeFunctionData("approve", [purchaseAddress, units]), value: "0" },
      }],
      route: { provider: "Accred", name: "Direct USDG purchase", feeBps: 0 },
    };
  }

  if (request.mode === "redeem") {
    // Credits go wallet-to-wallet to the treasury; the treasury pays the same token (or ETH) directly at the live price.
    if (!treasuryAddress || !usdgAddress) throw new RouterError("redemption_not_configured");
    const out = findCreditAsset(config, "robinhood", asset);
    // $CRED is never paid out: the treasury burns every $CRED it receives.
    if (!out || isProjectToken(out.address)) throw new RouterError("asset_not_redeemable");
    const creditUnits = parseUnits(request.amount, 18);
    if (creditUnits <= 0n || creditUnits % 10n ** 14n !== 0n) throw new RouterError("redeem_amount_must_be_whole_usdg_micros");
    const usdMicros = creditUnits / 10n ** 14n; // 100 credits = $1
    if (usdMicros < MIN_USD_MICROS) throw new RouterError("amount_too_small");
    if (usdMicros > MAX_USD_MICROS) throw new RouterError("amount_above_limit");
    const payout = await redeemPayoutUnits(out, usdMicros);
    if (payout <= 0n) throw new RouterError("amount_too_small");
    if ((await treasuryAvailable(out)) < payout) throw new RouterError("low_liquidity", 503);
    const data = erc20.encodeFunctionData("transfer", [treasuryAddress, creditUnits]);
    return {
      executable: true, id: `rh-redeem-${keccak256(toUtf8Bytes(request.reference)).slice(2, 18)}`, expiresAt: expiresAt.toISOString(),
      transaction: { to: creditTokenAddress, data, value: "0" },
      expectedTo: creditTokenAddress, expectedValue: "0", expectedCalldata: data,
      inputToken: creditTokenAddress, inputAmount: request.amount, outputToken: out.address,
      outputAmount: formatUnits(payout, out.decimals), netUsdMicros: usdMicros.toString(),
      expectedTransfers: [{ tokenAddress: creditTokenAddress, from: request.sender, to: treasuryAddress, amount: creditUnits.toString() }],
      approvals: [],
      route: { provider: "Accred", name: `Credit redemption to ${out.symbol}`, feeBps: 0,
        redeemPayout: { minOut: payout.toString() } },
    };
  }
  throw new RouterError("unsupported_mode");
}

async function solanaQuote(request: QuoteRequest, asset: string, expiresAt: Date, treasury: string | null) {
  const spec = SOLANA_ASSETS[asset as keyof typeof SOLANA_ASSETS];
  if (!spec || request.mode !== "buy") throw new RouterError("solana_supports_direct_SOL_USDC_USDT_buys_only");
  if (!treasury) throw new RouterError("solana_treasury_not_configured", 503);
  const units = parseUnits(request.amount, spec.decimals);
  if (units <= 0n) throw new RouterError("amount_too_small");
  let netUsdMicros: bigint;
  if (asset === "SOL") netUsdMicros = (units * (await solUsdMicros())) / 10n ** 9n;
  else netUsdMicros = units; // USDC and USDT are six-decimal dollar stablecoins
  if (netUsdMicros < MIN_USD_MICROS) throw new RouterError("amount_too_small");
  const credits = netUsdMicros * 100n * 10n ** 12n;
  const blockhash = (await solanaRpc<{ value: { blockhash: string } }>("getLatestBlockhash", [{ commitment: "finalized" }])).value.blockhash;
  const memo = { program: SOLANA_MEMO_PROGRAM, accounts: [] as string[], data: Buffer.from(request.reference, "utf8") };
  let transfer: { program: string; accounts: string[]; data: Buffer };
  let expected: Record<string, unknown>;
  const writable = new Set<string>();
  if (spec.mint === "native") {
    transfer = { program: SOLANA_SYSTEM_PROGRAM, accounts: [request.sender, treasury], data: Buffer.concat([Buffer.from([2, 0, 0, 0]), u64(units)]) };
    writable.add(treasury);
    expected = { tokenAddress: "native", from: request.sender, to: treasury, amount: units.toString() };
  } else {
    const [source, destination] = await Promise.all([tokenAccount(request.sender, spec.mint, units), tokenAccount(treasury, spec.mint, 0n)]);
    transfer = {
      program: SOLANA_TOKEN_PROGRAM, accounts: [source, spec.mint, destination, request.sender],
      data: Buffer.concat([Buffer.from([12]), u64(units), Buffer.from([spec.decimals])]),
    };
    writable.add(source); writable.add(destination);
    expected = {
      tokenAddress: spec.mint, from: request.sender, to: treasury, amount: units.toString(),
      sourceAccount: source, destinationAccount: destination, tokenDecimals: spec.decimals,
    };
  }
  const serialized = buildSolanaTransaction({ payer: request.sender, recentBlockhash: blockhash, instructions: [transfer, memo], writable }).toString("base64");
  return {
    executable: true, id: `sol-buy-${keccak256(toUtf8Bytes(request.reference)).slice(2, 18)}`, expiresAt: expiresAt.toISOString(),
    transaction: { to: transfer.program, serialized }, expectedTo: transfer.program, expectedValue: "0",
    inputToken: request.assetAddress, inputAmount: request.amount, outputAmount: formatUnits(credits, 18),
    netUsdMicros: netUsdMicros.toString(), expectedTransfers: [expected],
    route: { provider: "Accred", name: `Direct ${asset} purchase`, feeBps: 0 },
  };
}

/** Best Uniswap v3 fee tier (highest quoted output) for an exact-input single hop. */
export async function bestUniswapPool(tokenIn: string, tokenOut: string, amountIn: bigint): Promise<{ fee: number; pool: string; out: bigint } | null> {
  const provider = rpcProvider();
  const quoter = new Contract(UNISWAP_QUOTER_V2, quoterAbi, provider);
  const factory = new Contract(UNISWAP_FACTORY, factoryAbi, provider);
  const results = await Promise.all(FEE_TIERS.map(async (fee) => {
    try {
      const pool = await factory.getPool!(tokenIn, tokenOut, fee) as string;
      if (pool === ZERO) return null;
      const [out] = await quoter.quoteExactInputSingle!.staticCall({ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0 }) as [bigint];
      return out > 0n ? { fee, pool, out } : null;
    } catch { return null; }
  }));
  return results.reduce<{ fee: number; pool: string; out: bigint } | null>((a, b) => (b && (!a || b.out > a.out) ? b : a), null);
}

const MIN_USD_MICROS = 1_000_000n; // $1
const MAX_USD_MICROS = 5_000_000_000n; // $5,000 per transaction
const MAX_DEVIATION_BPS = 500n; // oracle and on-chain pool must agree within 5%
const ETH_GAS_RESERVE = 3_000_000_000_000_000n; // 0.003 ETH kept in the treasury for gas

const pow10 = (n: number) => 10n ** BigInt(n);

/** Stocks/ETFs: Nasdaq + Yahoo cross-checked oracle price. ETH: Coinbase + CoinGecko. */
async function checkedPrice(asset: CreditAsset): Promise<{ micros: bigint; haircut: bigint }> {
  const price = await oraclePrice(asset.symbol);
  if (!price) throw new RouterError("low_liquidity", 503);
  return { micros: price.micros, haircut: haircutBps(price) };
}

const DEX_HAIRCUT_BPS = 300n; // wider spread for volatile, thinner tokens

/**
 * Crypto token USD price per whole token (scaled 1e18): DexScreener price of the token's deepest WETH/ETH/USDG pair,
 * confirmed by GeckoTerminal when it answers (must agree within 5%). Pool depth does not matter, only the correct price.
 * Returns the lower and the higher of the available prices (lower for swap-in, higher for redeem payout).
 */
async function dexUsdPrice(asset: CreditAsset): Promise<{ low: bigint; high: bigint }> {
  const [quote, eth] = await Promise.all([dexQuote(asset.address), oraclePrice("ETH")]);
  if (!quote || (quote.quoteKind === "eth" && !eth)) throw new RouterError("low_liquidity", 503);
  const quoteUsd = quote.quoteKind === "eth" ? eth!.micros : 1_000_000n;
  const dex = (quote.priceNativeWei * quoteUsd) / 1_000_000n;
  if (dex <= 0n) throw new RouterError("low_liquidity", 503);
  const gecko = await geckoToken(asset.address);
  if (!gecko) return { low: dex, high: dex };
  const other = BigInt(Math.round(gecko.priceUsd * 1e9)) * 1_000_000_000n;
  const gap = dex > other ? dex - other : other - dex;
  if ((gap * 10_000n) / dex > MAX_DEVIATION_BPS) throw new RouterError("low_liquidity", 503);
  return dex < other ? { low: dex, high: other } : { low: other, high: dex };
}

async function dexSwapUsdMicros(asset: CreditAsset, amountIn: bigint): Promise<bigint> {
  if (amountIn <= 0n) throw new RouterError("low_liquidity", 503);
  const { low } = await dexUsdPrice(asset);
  const value = (amountIn * low) / (pow10(asset.decimals) * 1_000_000_000_000n);
  const net = (value * (10_000n - DEX_HAIRCUT_BPS)) / 10_000n;
  const own = projectToken();
  // The platform's own token earns 10% extra credit.
  return own && own.address.toLowerCase() === asset.address.toLowerCase() ? (net * (10_000n + PROJECT_TOKEN_BONUS_BPS)) / 10_000n : net;
}

/** Credit-able USD value (micros) of an exact input amount: lower of oracle and pool, minus the spread. */
/** Market USD value (micros) of a token amount, without any swap spread. Used for display only. */
export async function assetUsdValueMicros(asset: CreditAsset, amount: bigint): Promise<bigint> {
  if (amount <= 0n) return 0n;
  const { usdgAddress } = creditConfiguration().addresses;
  if (usdgAddress && asset.address.toLowerCase() === usdgAddress.toLowerCase()) return (amount * 1_000_000n) / pow10(asset.decimals);
  if (asset.dex) {
    const { low } = await dexUsdPrice(asset);
    return (amount * low) / (pow10(asset.decimals) * 1_000_000_000_000n);
  }
  const price = await checkedPrice(asset);
  return (amount * price.micros) / pow10(asset.decimals);
}

export async function swapInputUsdMicros(asset: CreditAsset, amountIn: bigint): Promise<bigint> {
  if (asset.dex) return dexSwapUsdMicros(asset, amountIn);
  const price = await checkedPrice(asset);
  const oracleUsd = (amountIn * price.micros) / pow10(asset.decimals);
  if (oracleUsd <= 0n) throw new RouterError("low_liquidity", 503);
  return (oracleUsd * (10_000n - price.haircut)) / 10_000n;
}

/** Token units paid out for a redemption worth usdMicros: fewer tokens of the oracle and pool estimates, minus the spread. */
async function redeemPayoutUnits(out: CreditAsset, usdMicros: bigint): Promise<bigint> {
  const { usdgAddress } = creditConfiguration().addresses;
  if (usdgAddress && out.address.toLowerCase() === usdgAddress.toLowerCase()) return usdMicros;
  if (out.dex) {
    const { high } = await dexUsdPrice(out);
    const net = (usdMicros * (10_000n - DEX_HAIRCUT_BPS)) / 10_000n;
    return (net * pow10(out.decimals) * 1_000_000_000_000n) / high;
  }
  const price = await checkedPrice(out);
  const net = (usdMicros * (10_000n - price.haircut)) / 10_000n;
  return (net * pow10(out.decimals)) / price.micros;
}

/** Spendable treasury balance of an asset (native ETH keeps a gas reserve). */
export async function treasuryAvailable(asset: CreditAsset): Promise<bigint> {
  const { treasuryAddress } = creditConfiguration().addresses;
  if (!treasuryAddress) return 0n;
  const provider = rpcProvider();
  if (asset.address === "native") {
    const balance = await provider.getBalance(treasuryAddress);
    return balance > ETH_GAS_RESERVE ? balance - ETH_GAS_RESERVE : 0n;
  }
  return await new Contract(asset.address, ["function balanceOf(address) view returns (uint256)"], provider).balanceOf!(treasuryAddress) as bigint;
}

/** Token balance of an arbitrary wallet (native ETH supported). */
export async function walletTokenBalance(asset: CreditAsset, wallet: string): Promise<bigint> {
  const provider = rpcProvider();
  if (asset.address === "native") return provider.getBalance(wallet);
  return await new Contract(asset.address, ["function balanceOf(address) view returns (uint256)"], provider).balanceOf!(wallet) as bigint;
}

/** Whether a swap/redeem is currently possible for an asset, without exposing any balance. */
export async function assetAvailability(asset: CreditAsset): Promise<{ swap: boolean; redeem: boolean }> {
  const { usdgAddress } = creditConfiguration().addresses;
  const isUsdg = Boolean(usdgAddress) && asset.address.toLowerCase() === usdgAddress!.toLowerCase();
  // Swap-in is available whenever a correct price can be fetched; redeem additionally needs the treasury to hold the token.
  let swap = false;
  if (!isUsdg) {
    try { await swapInputUsdMicros(asset, pow10(asset.decimals)); swap = true; } catch { swap = false; }
  }
  let redeem = false;
  if (!isProjectToken(asset.address)) try {
    const needed = await redeemPayoutUnits(asset, 1_000_000n);
    redeem = needed > 0n && (await treasuryAvailable(asset)) >= needed;
  } catch { redeem = false; }
  return { swap, redeem };
}

/** Direct deposit: the wallet sends the asset straight to the treasury (ERC20 transfer or native ETH value). */
async function swapQuote(request: QuoteRequest, expiresAt: Date): Promise<Record<string, unknown>> {
  const config = creditConfiguration();
  const { treasuryAddress, usdgAddress, creditTokenAddress } = config.addresses;
  const input = findCreditAsset(config, "robinhood", request.asset);
  if (!input || !treasuryAddress || !usdgAddress || !creditTokenAddress || input.address.toLowerCase() === usdgAddress.toLowerCase()) {
    throw new RouterError("asset_not_swappable");
  }
  const amountIn = parseUnits(request.amount, input.decimals);
  if (amountIn <= 0n) throw new RouterError("amount_too_small");
  const netUsdMicros = await swapInputUsdMicros(input, amountIn);
  // The $1 minimum applies to the market value the user typed in, not to the value left after the swap spread; 3% tolerance covers price movement between the app and the quote.
  if ((await assetUsdValueMicros(input, amountIn)) < (MIN_USD_MICROS * 97n) / 100n || netUsdMicros <= 0n) throw new RouterError("amount_too_small");
  if (netUsdMicros > MAX_USD_MICROS) throw new RouterError("amount_above_limit");
  const credits = netUsdMicros * 100n * 10n ** 12n;
  const native = input.address === "native";
  // Every deposit goes to the treasury wallet; $CRED is burned from there once the credit and cashback are paid.
  const recipient = treasuryAddress;
  const data = native ? "0x" : erc20.encodeFunctionData("transfer", [recipient, amountIn]);
  const to = native ? treasuryAddress : input.address;
  const value = native ? amountIn.toString() : "0";
  return {
    executable: true, id: `rh-swap-${keccak256(toUtf8Bytes(request.reference)).slice(2, 18)}`, expiresAt: expiresAt.toISOString(),
    transaction: { to, data, value },
    expectedTo: to, expectedValue: value, expectedCalldata: data,
    inputToken: input.address, inputAmount: request.amount, outputToken: creditTokenAddress,
    outputAmount: formatUnits(credits, 18), netUsdMicros: netUsdMicros.toString(),
    expectedTransfers: [{ tokenAddress: input.address, from: request.sender, to: recipient, amount: amountIn.toString() }],
    approvals: [],
    route: { provider: "Accred", name: `Direct ${input.symbol} deposit`, feeBps: 0 },
  };
}
