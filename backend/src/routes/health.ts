/**
 * GET /healthz — "is this backend able to do its job right now?"
 *
 * Polled by humans, Docker/Kubernetes, load balancers, and later by Sentinel
 * itself ("monitoring the monitor"). It must be fast and must never hang,
 * so the database check has a hard timeout.
 */
import { Router } from "express";
import type { Database } from "../db.js";
import type { Logger } from "../logger.js";

export interface HealthDeps {
  db: Pick<Database, "ping">; // we only need ping(); asking for less makes faking easier
  logger: Logger;
  dbTimeoutMs: number;
}

export function healthRouter({ db, logger, dbTimeoutMs }: HealthDeps): Router {
  const router = Router();

  router.get("/healthz", async (_req, res) => {
    // Health results must always be fresh; forbid caches/proxies from storing them.
    res.set("Cache-Control", "no-store");
    try {
      await db.ping(dbTimeoutMs);
      res.status(200).json({ status: "ok", checks: { database: "ok" } });
    } catch (err) {
      // A dependency is down: report it with 503 instead of crashing or returning 500.
      logger.warn({ err }, "health check failed: database unreachable");
      res.status(503).json({ status: "error", checks: { database: "error" } });
    }
  });

  return router;
}
