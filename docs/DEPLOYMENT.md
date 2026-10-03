# Deployment and operations

## Build

```bash
pnpm install --frozen-lockfile
pnpm run build
```

- API: `artifacts/api-server/dist/index.mjs` (bundled with esbuild). Start with `node --enable-source-maps dist/index.mjs`.
- Web: static files in `artifacts/credit-terminal/dist/public`. Build with `PORT` and `BASE_PATH` set; serve behind the same host as the API so `/api` resolves.

## Database

```bash
pnpm --filter @workspace/db run push
```

## Runtime checklist

1. All required variables from [CONFIGURATION.md](CONFIGURATION.md) are set.
2. `GET /api/healthz` returns `200`; `GET /api/protocol/status` reports the chain and contract state.
3. Payout wallets hold gas (ETH) and USDG for cashback and staking rewards.
4. The vault gateway address matches the signer (`LLMCreditVault.setGateway`).
5. Enable features only after their dependencies are ready: gateway, X bot polling and posting are all off by default.

## Operating notes

- Reconciliation runs every 2 minutes; burns and payouts retry automatically and are idempotent.
- Public Robinhood RPC nodes may prune state for finalized blocks. The server reads state at a fixed confirmation depth when the finalized block is unavailable.
- Rotate keys by redeploying with new values; rotate the vault operator with `setGateway`.
