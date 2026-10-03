# HTTP API

Base path: `/api`. The machine-readable contract is [`lib/api-spec/openapi.yaml`](../lib/api-spec/openapi.yaml); request/response validators and the React client are generated from it (`pnpm --filter @workspace/api-spec run codegen`).

Authentication:

- **Session** — `Authorization: Bearer <Privy access token>`, verified server-side.
- **Platform key** — `X-Platform-API-Key: <key>` for the metered inference endpoint.
- **Internal** — HMAC service token; not exposed publicly.

## Health and protocol

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/healthz` | none | Liveness |
| GET | `/protocol/status` | none | Chain, contract and feature status |
| GET | `/protocol/activity` | none | Recent protocol activity |
| GET | `/protocol/economics` | none | Aggregate economics |
| GET | `/market/stock-tokens` | none | Listed stock tokens |

## Authentication and linking

| Method | Path | Description |
| --- | --- | --- |
| GET | `/auth/me` | Verified session identity |
| GET | `/auth/wallets` | Verified wallets of the owner |
| POST | `/auth/wallet/challenge` | Create an EVM ownership challenge |
| POST | `/auth/wallet/verify` | Verify the signed challenge |
| POST | `/auth/wallet/remove` | Remove the verified wallet |
| POST | `/auth/solana/challenge`, `/auth/solana/verify` | Solana ownership proof |
| GET | `/auth/x/account` | Linked X account |
| POST | `/auth/x/privy-link` | Link the X account from the session |
| GET | `/auth/x/link`, `/auth/x/callback` | OAuth link flow |

## Credit

| Method | Path | Description |
| --- | --- | --- |
| GET | `/credit/config` | Public configuration (addresses, token, supported assets) |
| GET | `/credit/availability` | Asset availability |
| GET | `/credit/asset-logos` | Asset logos |
| GET | `/credit/stats`, `/credit/cred-stats`, `/credit/cashback-total` | Public statistics |
| GET | `/credit/account`, `/credit/holdings`, `/credit/activity` | Owner account, holdings and history |
| POST | `/credit/quote` | Lock a swap/buy quote |
| POST | `/credit/quote/:quoteId/funds` | Attach funding details |
| POST | `/credit/confirm` | Confirm a deposit by transaction hash |
| POST | `/credit/reconcile` | Re-check a pending quote |
| POST | `/credit/solana-deposit` | Open a Solana deposit session |
| GET | `/credit/solana-deposit/:id` | Session status |
| POST | `/credit/solana-deposit/:id/cancel` | Cancel a session |
| GET | `/credit/solana-price` | Solana asset price |

## Staking

| Method | Path | Description |
| --- | --- | --- |
| GET | `/credit/staking/capacity` | Remaining reward capacity |
| GET | `/credit/staking/:id/reward` | Reward status for a stake |
| POST | `/credit/staking/:id/reward` | Trigger the reward payout after claim (idempotent) |

## Customer (metered) API

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/customer/models` | none | Model catalogue with exact rates |
| POST | `/customer/v1/chat/completions` | platform key | Metered chat completion |
| POST | `/customer/playground` | session | Same engine for the in-app playground |
| GET/POST | `/customer/api-keys` | session | List / create keys |
| DELETE | `/customer/api-keys/:id` | session | Revoke a key |
| GET | `/customer/usage`, `/customer/accounting` | session | Owner receipts |
| POST | `/customer/reconcile` | session | Re-check a ledger entry |

Example:

```bash
curl https://<host>/api/customer/v1/chat/completions \
  -H "X-Platform-API-Key: $ACCRED_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"model":"<id from /customer/models>","messages":[{"role":"user","content":"Hello"}],"maxOutputTokens":512}'
```

Details, billing guarantees and limits: [CUSTOMER_API.md](CUSTOMER_API.md).

## X bot

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/x-bot/status` | none | Whether the bot is configured |
| POST | `/x-bot/commands` | service token | Process one mention by ID |

## Errors

Errors are JSON `{ "error": "<message>" }`. `401` missing/invalid session, `409` idempotency conflict, `429` rate limited, `503` a required dependency is not configured (the server fails closed).
