/**
 * REST API for monitored endpoints, mounted at /endpoints:
 *   POST   /endpoints       create            → 201 | 400
 *   GET    /endpoints       list all          → 200
 *   GET    /endpoints/:id   get one           → 200 | 400 | 404
 *   PATCH  /endpoints/:id   update some fields → 200 | 400 | 404  (also used to pause/resume)
 *   DELETE /endpoints/:id   delete            → 204 | 400 | 404
 *   POST   /endpoints/:id/check  check it now and save the result → 200 | 400 | 404
 *   GET    /endpoints/:id/checks  check history, newest first      → 200 | 400 | 404
 *   GET    /endpoints/:id/stats   uptime + P50/P95/P99 over a window → 200 | 400 | 404
 *   GET    /endpoints/:id/timeseries  the same per hour/6h/day, for charts → 200 | 400 | 404
 *   GET    /endpoints/:id/anomalies   unusual hours found by the analytics service → 200 | 400 | 404
 */
import { Router } from "express";
import { z } from "zod";
import { listAnomalies } from "../analytics/anomalies.js";
import { getEndpointStats, getEndpointTimeseries, WindowSchema } from "../analytics/stats.js";
import { checkEndpoint } from "../checks/check-endpoint.js";
import { listCheckResults, saveCheckResult } from "../checks/repository.js";
import type { Database } from "../db.js";
import { parseId, sendInvalidId, sendNotFound, sendValidationError } from "../http.js";
import type { Scheduler } from "../scheduler.js";
import * as repo from "./repository.js";
import { CreateEndpointSchema, UpdateEndpointSchema } from "./schemas.js";

export type EndpointScheduler = Pick<Scheduler, "schedule" | "unschedule">;

export function endpointsRouter(db: Database, scheduler: EndpointScheduler): Router {
  const router = Router();

  router.post("/", async (req, res) => {
    const parsed = CreateEndpointSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);
    const endpoint = await repo.createEndpoint(db, parsed.data);
    await scheduler.schedule(endpoint); // start its timer (unless created paused)
    res.status(201).json(endpoint);
  });

  // Each endpoint also includes `last_check` and `open_incident` (null if none), for the dashboard.
  router.get("/", async (_req, res) => {
    res.json(await repo.listEndpointsWithStatus(db));
  });

  router.get("/:id", async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return sendInvalidId(res);
    const endpoint = await repo.getEndpoint(db, id);
    if (!endpoint) return sendNotFound(res, "Endpoint", id);
    res.json(endpoint);
  });

  router.patch("/:id", async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return sendInvalidId(res);
    const parsed = UpdateEndpointSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);
    const endpoint = await repo.updateEndpoint(db, id, parsed.data);
    if (!endpoint) return sendNotFound(res, "Endpoint", id);
    await scheduler.schedule(endpoint); // new interval, or paused → timer removed
    res.json(endpoint);
  });

  // "Check now": visit the endpoint once, save the result, and return it.
  // We reply 200 even if the website is down: OUR request worked, and the result says "down".
  // Incidents and alerts are decided only by the worker; it sees this result on its next check.
  router.post("/:id/check", async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return sendInvalidId(res);
    const endpoint = await repo.getEndpoint(db, id);
    if (!endpoint) return sendNotFound(res, "Endpoint", id);
    res.json(await saveCheckResult(db, id, await checkEndpoint(endpoint)));
  });

  // History: the newest check results for this endpoint. ?limit=N (1–500, default 50).
  router.get("/:id/checks", async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return sendInvalidId(res);
    const limit = LimitSchema.safeParse(req.query.limit);
    if (!limit.success) return sendValidationError(res, limit.error);
    if (!(await repo.getEndpoint(db, id))) return sendNotFound(res, "Endpoint", id);
    res.json(await listCheckResults(db, id, limit.data));
  });

  // Stats over a time window: uptime %, P50/P95/P99, failures by type. ?window=24h|7d|30d
  router.get("/:id/stats", async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return sendInvalidId(res);
    const window = WindowSchema.safeParse(req.query.window);
    if (!window.success) return sendValidationError(res, window.error);
    if (!(await repo.getEndpoint(db, id))) return sendNotFound(res, "Endpoint", id);
    res.json(await getEndpointStats(db, id, window.data));
  });

  // The same numbers per time bucket, for charts. ?window=24h|7d|30d
  router.get("/:id/timeseries", async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return sendInvalidId(res);
    const window = WindowSchema.safeParse(req.query.window);
    if (!window.success) return sendValidationError(res, window.error);
    if (!(await repo.getEndpoint(db, id))) return sendNotFound(res, "Endpoint", id);
    res.json(await getEndpointTimeseries(db, id, window.data));
  });

  // Unusual behaviour found by the analytics service, newest first. ?limit=N (1–500, default 50)
  router.get("/:id/anomalies", async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return sendInvalidId(res);
    const limit = LimitSchema.safeParse(req.query.limit);
    if (!limit.success) return sendValidationError(res, limit.error);
    if (!(await repo.getEndpoint(db, id))) return sendNotFound(res, "Endpoint", id);
    res.json(await listAnomalies(db, id, limit.data));
  });

  router.delete("/:id", async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return sendInvalidId(res);
    if (!(await repo.deleteEndpoint(db, id))) return sendNotFound(res, "Endpoint", id);
    await scheduler.unschedule(id); // stop its timer
    res.status(204).end(); // 204 No Content: success, nothing to send back
  });

  return router;
}

// ?limit= arrives as text (or is missing), so convert it to a number and check the range.
const LimitSchema = z.coerce.number().int().min(1).max(500).default(50);
