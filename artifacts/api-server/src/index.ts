import app from "./app";
import { configureInternalCreditService } from "./lib/internal-env";
import { logger } from "./lib/logger";
import { startDexTokenRefresh } from "./lib/dex-tokens";
import { startXBotPoller } from "./lib/x-bot-poller";
import { reconcilePendingQuotes } from "./routes/credit";
import { rpcProvider } from "./lib/internal-router";

configureInternalCreditService();

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  startDexTokenRefresh(rpcProvider);
  startXBotPoller(port);
  setInterval(() => void reconcilePendingQuotes(), 120_000);
});
