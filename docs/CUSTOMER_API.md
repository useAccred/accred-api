# Customer API

The customer API supports owner-scoped platform keys, an authenticated Playground route, a public model catalogue, and owner-scoped usage/accounting receipts. Both inference routes use the same billing engine:

- `POST /api/customer/v1/chat/completions` authenticates with `X-Platform-API-Key`.
- `POST /api/customer/playground` authenticates with the owner's verified Privy Bearer session.
- Both require an `Idempotency-Key` header (8–128 characters) and the same request body: `{ "model": "<catalogue model id>", "messages": [{ "role": "user", "content": "..." }], "maxOutputTokens": 1024 }`.
- An idempotency key is bound to a SHA-256 fingerprint of the normalized request and the authenticated owner. Reusing it for different input returns `409`; a confirmed charged replay returns the saved response.
- `GET /api/customer/models` is public and returns `{ "models": [...] }`. Entries include provider, exact provider model ID, current configured/live input and output USD rates per million tokens, capabilities, availability, and an unavailable reason. Aggregator prices come from its public live model catalogue. OpenAI, Anthropic, and Gemini models have no enabled price until exact operator-managed costs are supplied; no guessed or zero rates are inserted. The cost config must be maintained against current provider pricing. It is not a claim of an enterprise discount.
- `GET /api/customer/usage` and `GET /api/customer/accounting` require the verified Privy Bearer session and only return records for that owner. Exact decimal strings are the source of truth. Cashback is `null` unless there is an authoritative confirmed cashback receipt source.

Successful completion responses preserve `id`, `model`, `content`, and token usage, and add `creditsChargedExact`, `providerCostUsdExact`, `creditUnit: "service_credit"`, and `cashbackUsdExact`. `creditsCharged` remains a numeric compatibility field; clients requiring exact values must display `creditsChargedExact`.

## Credit units and on-chain safety

- One service credit is one cent at provider cost: **100 service credits = $1**.
- Internal amounts use integer **microcredits** (one microcredit = 10⁻⁶ service credit). PostgreSQL bigint ledger values explicitly store microcredits; token base units are never stored in PostgreSQL bigint columns.
- The vault token has 18 decimals. One service credit maps to 10¹⁸ vault base units, so one microcredit maps to 10¹² base units and $1 maps to 100 × 10¹⁸ base units. Conversion and pricing arithmetic use `bigint` rational math and round a positive charge upward to the next microcredit; fractional token usage is not truncated to zero.
- Before any provider call, the configured signer must submit and confirm `LLMCreditVault.reserve(account, requestId, amount)` for the verified wallet tied to the API key owner's identity, and the reservation must be included in a finalized block. Reservation availability is read directly from the vault; legacy indexer snapshots and gateway counters are not subtracted from on-chain net balances.
- Reserve, settle, and release outcomes are verified against the request-specific reservation mapping, exact request-indexed vault events, and finalized transaction receipts. Settlement also requires an exact vault-to-zero-address ERC-20 burn event. Account-wide snapshots are display information only; they never prove an operation succeeded.
- Provider dispatch time, vault transaction hashes, and exact provider usage/cost are durably recorded. A request with a recorded dispatch is never sent upstream again. An unknown provider outcome is released only after the request's hold is proven, and any uncertain provider cost is absorbed by the platform rather than charged to the customer.
- `POST /api/customer/reconcile` accepts an owner-scoped ledger ID, rechecks exact finalized chain evidence, and returns `200` for terminal states or `202` while evidence remains pending. It never redispatches inference. The Playground's recent-usage rows expose a per-request reconcile action.
- An API key is created with an immutable snapshot of its owner's verified chain-4663 wallet. A later wallet relink does not remap the key; inference is rejected until a new key is created for the new wallet. Existing keys without that snapshot cannot make metered requests.
- Signer transactions are serialized across API-server processes with a database advisory lock and locally with an ethers nonce manager. Each request has a globally unique bytes32 vault request ID.
- Gateway activation also requires positive `CUSTOMER_DAILY_BUDGET_CREDITS`, `CUSTOMER_USER_RPM`, and `CUSTOMER_KEY_RPM` settings. The server applies daily budget accounting in microcredits and serialized owner/key request limits before reserving funds. Model requests are bounded to 8,192 UTF-8 bytes of serialized messages and at most 8,192 output tokens.
- Gateway writes require explicit enablement and a configured Robinhood Mainnet (chain ID **4663**) RPC, vault, and authorized signer. The server fails closed with `503` if any setting is absent or the network differs.

## Provider and capability coverage

A static allowlist defines the supported OpenAI, Anthropic, and Gemini models. Chat-compatible OpenAI models use Chat Completions; Codex models use the OpenAI Responses API through the same reserve/settle engine. Aggregator model IDs are taken only from its live public catalogue and are routed only to the configured the aggregator integration; caller input is never used as a URL or endpoint.

Image generation, audio generation/transcription, and Jev typed decisions are listed as unsupported/unavailable until metered handlers and exact pricing are implemented. They cannot bypass reservation by being sent to the chat endpoint.

## Configuration

Provider credentials are server-side environment values; customer requests do not supply provider credentials:

- OpenAI: `AI_INTEGRATIONS_OPENAI_BASE_URL`, `AI_INTEGRATIONS_OPENAI_API_KEY`
- Anthropic: `AI_INTEGRATIONS_ANTHROPIC_BASE_URL`, `AI_INTEGRATIONS_ANTHROPIC_API_KEY`
- Gemini: `AI_INTEGRATIONS_GEMINI_BASE_URL`, `AI_INTEGRATIONS_GEMINI_API_KEY`
- the aggregator: `AI_INTEGRATIONS_OPENROUTER_BASE_URL`, `AI_INTEGRATIONS_OPENROUTER_API_KEY`

Exact OpenAI, Anthropic, or Gemini costs are configured by model key such as `openai/gpt-5.6-terra` using `CUSTOMER_MODEL_COSTS_JSON`:

```json
{
  "openai/gpt-5.6-terra": {
    "inputUsdPerMillion": "operator-confirmed exact decimal",
    "outputUsdPerMillion": "operator-confirmed exact decimal"
  }
}
```

The example values above are explanatory text, **not valid prices**. Do not configure model availability until exact current cost values are verified against the provider's current authoritative pricing and reconciled to the actual service cost basis. No example or fallback rate is enabled.

Gateway environment values:

- `CUSTOMER_GATEWAY_ENABLED=true` (or `CREDIT_GATEWAY_ENABLED=true`)
- `CUSTOMER_GATEWAY_RPC_URL` (or `ROBINHOOD_RPC_URL`)
- `CUSTOMER_GATEWAY_CHAIN_ID=4663` (or `CREDIT_CHAIN_ID=4663`)
- `CUSTOMER_GATEWAY_VAULT_ADDRESS` (or `CREDIT_VAULT_ADDRESS`)
- `CUSTOMER_GATEWAY_VAULT_DEPLOYMENT_BLOCK` — verified deployment block for bounded request-event recovery
- `CREDIT_TOKEN_ADDRESS` — the exact ERC-20 token used for vault settlement burn verification
- `CUSTOMER_GATEWAY_SIGNER_PRIVATE_KEY` — a private signer authorized by the deployed vault
- `CUSTOMER_DAILY_BUDGET_CREDITS` — positive daily cap in service credits
- `CUSTOMER_USER_RPM` — per-owner requests per rolling minute, integer 1–1000
- `CUSTOMER_KEY_RPM` — per-key requests per rolling minute, integer 1–1000

Only the vault address and RPC aliases are shared with the finance API. Credentials are never returned by the model route or written to customer responses/logs. Do not enable the gateway until the deployed contract's `deposited(address)`, `reserved(address)`, `available(address)`, `reserve`, `settle`, and `release` semantics match the balance invariants above.