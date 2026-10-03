# @workspace/api-server

Express 5 API for Accred: authentication, credit engine, price oracle, router and settlement, customer gateway, staking rewards and the X assistant.

## Structure

```text
src/
├── index.ts                 Entry: config, server, background jobs
├── app.ts                   Express app, middleware, routes under /api
├── routes/                  HTTP handlers (auth, credit, customer, staking, protocol, internal, x-bot, …)
└── lib/
    ├── credit-*.ts          Config, chain access, pricing, policy, router, settlement, Solana
    ├── cashback-policy.ts   Cashback eligibility
    ├── customer-*.ts        Gateway, billing, models, provider adapters, policies
    ├── platform-api-key.ts  Key issuing and verification
    ├── privy-auth.ts        Session verification
    ├── staking-rewards.ts   USDG reward payout and capacity
    ├── x-bot-*.ts           Config, poller, X API client, command policy
    └── *.test.mjs           Unit tests
skills/                      Assistant policy for X replies
```

## Scripts

| Command | Description |
| --- | --- |
| `pnpm run dev` | Build and start |
| `pnpm run build` | Bundle to `dist/` |
| `pnpm run typecheck` | Type check |

Configuration: [../../docs/CONFIGURATION.md](../../docs/CONFIGURATION.md). Endpoints: [../../docs/API.md](../../docs/API.md).

## Tests

```bash
node --import tsx --test "src/lib/*.test.mjs"
```
