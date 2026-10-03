# @workspace/db

Drizzle ORM schema and PostgreSQL client. Requires `DATABASE_URL`.

| Schema file | Tables |
| --- | --- |
| `creditEconomy.ts` | quotes, activity, cashbacks, reserves, Solana deposit sessions, verified balances |
| `customerApi.ts` | platform API keys, usage ledger, wallet/X ownership |
| `settlementOps.ts` | idempotent outbound operations |
| `xBot.ts` | X bot mentions |

```bash
pnpm --filter @workspace/db run push
```
