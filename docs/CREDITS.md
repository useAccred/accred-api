# Credit economics and flows

## Units

- **100 credits = $1** of provider cost. Backend arithmetic uses integer microcredits (1 credit = 1,000,000 microcredits).
- The on-chain token has 18 decimals; 1 credit = 10¹⁸ base units.
- Model usage is billed at provider cost with no markup.

## Pricing oracle

No price is hardcoded. A quote exists only when independent sources agree.

| Asset class | Sources | Agreement rule |
| --- | --- | --- |
| Stocks / ETFs | Nasdaq real-time quote, Yahoo chart | within 2% |
| ETH | Coinbase spot, CoinGecko | within 2% |
| Listed crypto | DexScreener price, on-chain Uniswap v3 pool at trade size | within 5% (lower value used) |

A small haircut applies to every swap (0.5%, 2% outside regular market hours). If a price cannot be established the asset is shown as unavailable.

## Swap

1. `POST /api/credit/quote` locks a price and returns the deposit address and exact amount.
2. The user transfers the asset to the protocol wallet.
3. `POST /api/credit/confirm` verifies the receipt, issues credit to the verified wallet, then pays cashback.

Redeem is the reverse for supported assets: credit is returned and the same asset is paid wallet to wallet at the live price, subject to available reserves.

## Buy

Direct purchase with USDG on Robinhood Chain, or SOL / USDC / USDT on Solana. Solana payments use a unique exact-amount session so a manual transfer is attributed to the right wallet.

## Cashback

- Flat **10% in USDG** on every swap, paid from a dedicated payout wallet to the connected wallet.
- Payouts are idempotent per economic action and recorded in `settlement_operations`.

## $CRED

The project token can be swapped like any listed asset. Swaps receive a 10% credit bonus. After credit is issued the received tokens are sent to the dead address, and the user receives the burn transaction link. Credit cannot be redeemed into $CRED.

## Staking

Lock credit for 3, 7 or 30 days for a fixed USDG reward (see [CONTRACTS.md](https://github.com/useAccred/accred/blob/main/docs/CONTRACTS.md#staking-terms)). Principal is returned by `claim`; the reward is paid after the claim and is idempotent per stake.

## Metered API

See [CUSTOMER_API.md](CUSTOMER_API.md).
