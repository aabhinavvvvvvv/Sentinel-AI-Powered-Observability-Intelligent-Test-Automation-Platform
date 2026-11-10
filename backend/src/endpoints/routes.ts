/**
 * REST API for monitored endpoints, mounted at /endpoints:
 *   POST   /endpoints       create            → 201 | 400
 *   GET    /endpoints       list all          → 200
 *   GET    /endpoints/:id   get one           → 200 | 400 | 404
 *   PATCH  /endpoints/:id   update some fields → 200 | 400 | 404  (also used to pause/resume)
 *   DELETE /endpoints/:id   delete            → 204 | 400 | 404
 */
import { Router, type Response } from "express";
import type { ZodError } from "zod";
import type { Database } from "../db.js";
import * as repo from "./repository.js";
import { CreateEndpointSchema, UpdateEndpointSchema } from "./schemas.js";

export function endpointsRouter(db: Database): Router {
  const router = Router();

  router.post("/", async (req, res) => {
    const parsed = CreateEndpointSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);
    res.status(201).json(await repo.createEndpoint(db, parsed.data));
  });

  router.get("/", async (_req, res) => {
    res.json(await repo.listEndpoints(db));
  });

  router.get("/:id", async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return sendInvalidId(res);
    const endpoint = await repo.getEndpoint(db, id);
    if (!endpoint) return sendNotFound(res, id);
    res.json(endpoint);
  });

  router.patch("/:id", async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return sendInvalidId(res);
    const parsed = UpdateEndpointSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);
    const endpoint = await repo.updateEndpoint(db, id, parsed.data);
    if (!endpoint) return sendNotFound(res, id);
    res.json(endpoint);
  });

  router.delete("/:id", async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return sendInvalidId(res);
    if (!(await repo.deleteEndpoint(db, id))) return sendNotFound(res, id);
    res.status(204).end(); // 204 No Content: success, nothing to send back
  });

  return router;
}

/** "42" → 42. Anything else (e.g. "abc", "0", "-1", "1.5", too big for INTEGER) → null. */
function parseId(raw: string): number | null {
  if (!/^[1-9]\d{0,9}$/.test(raw)) return null;
  const id = Number(raw);
  return id <= 2_147_483_647 ? id : null; // Postgres INTEGER maximum
}

function sendValidationError(res: Response, error: ZodError): void {
  res.status(400).json({
    error: {
      code: "VALIDATION_ERROR",
      message: "Request body is invalid",
      details: error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message })),
    },
  });
}

function sendInvalidId(res: Response): void {
  res.status(400).json({ error: { code: "INVALID_ID", message: "id must be a positive integer" } });
}

function sendNotFound(res: Response, id: number): void {
  res.status(404).json({ error: { code: "NOT_FOUND", message: `Endpoint ${id} not found` } });
}
