# Configuration

Set variables in the process environment. Never commit values. `*` marks secrets.

## Core

| Variable | Description |
| --- | --- |
| `PORT` | HTTP port |
| `NODE_ENV` | `development` or `production` |
| `LOG_LEVEL` | pino level |
| `DATABASE_URL`* | PostgreSQL connection string |
| `SESSION_SECRET`* | Derives internal HMAC tokens |
| `APP_DOMAIN` | Public host, used for internal router/settlement URLs |
| `BASE_PATH` | (web build) path prefix |
| `VITE_PRIVY_APP_ID` | (web build) public Privy app ID |

## Authentication

| Variable | Description |
| --- | --- |
| `PRIVY_APP_ID` | Privy app ID |
| `PRIVY_APP_SECRET`* | Privy server secret |
| `PRIVY_VERIFICATION_KEY`* | Optional manual JWT verification key |

## Chain and credit

| Variable | Description |
| --- | --- |
| `ROBINHOOD_RPC_URL`* | Robinhood Chain RPC |
| `CREDIT_CHAIN_ID` | Must be `4663` |
| `CREDIT_TOKEN_ADDRESS`, `CREDIT_VAULT_ADDRESS` | Deployed contracts |
| `CREDIT_USDG_DECIMALS` | USDG decimals |
| `CREDIT_CONFIRMATION_BLOCKS` | Confirmation depth |
| `CREDIT_ASSET_REGISTRY` | JSON registry of swappable assets |
| `CREDIT_ROUTER_SUPPORTS_SWAPS` | Enable swaps |
| `CREDIT_ROUTER_QUOTE_URL`, `CREDIT_ROUTER_AUTH_TOKEN`, `CREDIT_ROUTER_ALLOWED_HOSTS` | External router (defaults to built-in) |
| `CREDIT_SETTLEMENT_SERVICE_URL`, `CREDIT_SETTLEMENT_SERVICE_TOKEN`, `CREDIT_SETTLEMENT_ALLOWED_HOSTS` | External settlement (defaults to built-in) |
| `CREDIT_RPC_ALLOWED_HOSTS` | Allowed RPC hosts |
| `CREDIT_APPROVED_EXECUTOR_ADDRESSES` | Approved executors |
| `TREASURY_PRIVATE_KEY`* | Protocol wallet key |
| `CASHBACK_PRIVATE_KEY`* | Quote signer / gateway operator key |
| `CASHBACK_PAYOUT_PRIVATE_KEY`* | Cashback and staking-reward payout key |
| `PROJECT_TOKEN_ADDRESS`, `PROJECT_TOKEN_SYMBOL` | Optional project token |

## Solana

| Variable | Description |
| --- | --- |
| `SOLANA_MAINNET_RPC_URL`* | Solana RPC |
| `SOLANA_TREASURY_ADDRESS` | Receiving address |
| `CREDIT_SOLANA_SETTLEMENT_ADDRESS`, `CREDIT_SOLANA_EXECUTOR_PROGRAMS` | Settlement config |
| `CREDIT_MAX_SOLANA_PRIORITY_FEE_MICROLAMPORTS` | Fee cap |

## Customer gateway

| Variable | Description |
| --- | --- |
| `CUSTOMER_GATEWAY_ENABLED` | Enable metered inference |
| `CUSTOMER_GATEWAY_RPC_URL`, `CUSTOMER_GATEWAY_CHAIN_ID` | Chain access |
| `CUSTOMER_GATEWAY_VAULT_ADDRESS`, `CUSTOMER_GATEWAY_VAULT_DEPLOYMENT_BLOCK` | Vault |
| `CUSTOMER_GATEWAY_SIGNER_PRIVATE_KEY`* | Vault gateway signer |
| `CUSTOMER_DAILY_BUDGET_CREDITS`, `CUSTOMER_USER_RPM`, `CUSTOMER_KEY_RPM` | Budget and rate limits |
| `CUSTOMER_MODEL_COSTS_JSON` | Exact per-model provider rates |
| `AI_INTEGRATIONS_{OPENAI,ANTHROPIC,GEMINI,OPENROUTER}_{BASE_URL,API_KEY}`* | Upstream provider endpoints and keys |

See [CUSTOMER_API.md](CUSTOMER_API.md) for the full rules.

## X bot

| Variable | Description |
| --- | --- |
| `X_BOT_POLLING_ENABLED`, `X_BOT_POSTING_ENABLED` | Feature switches |
| `X_BOT_USERNAME` | Bot handle |
| `X_USER_ID` | Bot account ID |
| `X_DASHBOARD_URL` | HTTPS app URL used in replies |
| `X_API_BEARER_TOKEN`* | Read access |
| `X_API_KEY`*, `X_API_SECRET`*, `X_ACCESS_TOKEN`*, `X_ACCESS_TOKEN_SECRET`* | Reply posting (OAuth 1.0a) |
| `X_CLIENT_ID`, `X_CLIENT_SECRET`*, `X_LINK_DOMAIN` | OAuth account linking |
| `X_BOT_SERVICE_TOKEN`* | Optional; derived from `SESSION_SECRET` when absent |
