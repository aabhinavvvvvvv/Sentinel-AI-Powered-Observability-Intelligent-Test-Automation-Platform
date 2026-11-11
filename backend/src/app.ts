/**
 * Builds (but does NOT start) the Express application.
 *
 * Keeping "build the app" separate from "listen on a port" (server.ts) lets
 * tests create the app with fake dependencies and send it requests in memory.
 * This is called dependency injection: the app receives what it needs instead
 * of creating it internally.
 */
import express, { type Express } from "express";
import { pinoHttp } from "pino-http";
import type { Database } from "./db.js";
import { endpointsRouter, type EndpointScheduler } from "./endpoints/routes.js";
import { incidentsRouter } from "./incidents/routes.js";
import type { Logger } from "./logger.js";
import { errorHandler, notFound } from "./middleware/errors.js";
import { healthRouter } from "./routes/health.js";
import { suitesRouter, type SuiteRunner } from "./testing/routes.js";

export interface AppDeps {
  db: Database;
  scheduler: EndpointScheduler;
  testRuns: SuiteRunner;
  logger: Logger;
  healthcheckDbTimeoutMs: number;
}

export function createApp({ db, scheduler, testRuns, logger, healthcheckDbTimeoutMs }: AppDeps): Express {
  const app = express();

  // Don't advertise "X-Powered-By: Express" (free information for attackers).
  app.disable("x-powered-by");

  // Middleware runs in the order it is registered, for every request:
  app.use(pinoHttp({ logger })); // 1. log each request/response with timing
  app.use(express.json({ limit: "100kb" })); // 2. parse JSON bodies, reject huge ones

  // 3. routes
  app.use(healthRouter({ db, logger, dbTimeoutMs: healthcheckDbTimeoutMs }));
  app.use("/endpoints", endpointsRouter(db, scheduler));
  app.use("/incidents", incidentsRouter(db));
  app.use("/suites", suitesRouter(db, testRuns));

  app.use(notFound); // 4. nothing matched → 404
  app.use(errorHandler(logger)); // 5. anything threw → JSON error

  return app;
}
