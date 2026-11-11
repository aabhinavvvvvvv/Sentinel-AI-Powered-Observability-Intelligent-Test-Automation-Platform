/**
 * Process entry point: wire real dependencies together, start listening,
 * and shut down gracefully when asked to stop.
 */
import { createApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { createDatabase } from "./db.js";
import { createLogger } from "./logger.js";
import { createScheduler } from "./scheduler.js";
import { createTestRunQueue } from "./testing/run-queue.js";

const SHUTDOWN_GRACE_MS = 10_000;

function main(): void {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const db = createDatabase(config.DATABASE_URL, logger);
  const scheduler = createScheduler(config.REDIS_URL);
  const testRuns = createTestRunQueue(config.REDIS_URL);
  const app = createApp({
    db,
    scheduler,
    testRuns,
    logger,
    healthcheckDbTimeoutMs: config.HEALTHCHECK_DB_TIMEOUT_MS,
  });

  // In Express 5 this callback also runs when starting FAILS (e.g. the port is
  // already used by another program), with the error as its argument.
  const server = app.listen(config.PORT, (err) => {
    if (err) {
      logger.fatal({ err }, `could not start: ${err.message}`);
      process.exit(1);
    }
    logger.info({ port: config.PORT, env: config.NODE_ENV }, "sentinel backend listening");
  });

  // Graceful shutdown: SIGTERM is what Docker/Kubernetes send to stop a process;
  // SIGINT is Ctrl+C. Stop accepting new connections, let in-flight requests
  // finish, close the DB pool, then exit.
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");

    // Safety net: if something hangs, force-exit. `unref()` means this timer
    // alone won't keep the process alive if everything closes cleanly.
    setTimeout(() => {
      logger.error("graceful shutdown timed out; forcing exit");
      process.exit(1);
    }, SHUTDOWN_GRACE_MS).unref();

    server.close(() => {
      Promise.all([scheduler.close(), testRuns.close(), db.close()])
        .then(() => {
          logger.info("shutdown complete");
          process.exit(0);
        })
        .catch((err: unknown) => {
          logger.error({ err }, "error while closing connections");
          process.exit(1);
        });
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

try {
  main();
} catch (err) {
  // The logger may not exist yet (config failed), so use plain stderr.
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
}
