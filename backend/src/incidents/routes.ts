/**
 * GET /incidents — newest first.
 *   ?status=open|resolved   only open or only closed incidents
 *   ?endpoint_id=5          only this endpoint's incidents
 *   ?limit=100              how many (1–500, default 100)
 * GET /incidents/:id/report — evidence for one incident.
 */
import { Router } from "express";
import { z } from "zod";
import type { Database } from "../db.js";
import { parseId, sendInvalidId, sendNotFound, sendValidationError } from "../http.js";
import { getIncidentReport } from "./report.js";
import { listIncidents } from "./repository.js";

const QuerySchema = z.object({
  status: z.enum(["open", "resolved"]).optional(),
  endpoint_id: z.coerce.number().int().positive().max(2_147_483_647).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export function incidentsRouter(db: Database): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    const query = QuerySchema.safeParse(req.query);
    if (!query.success) return sendValidationError(res, query.error);
    res.json(await listIncidents(db, query.data));
  });

  // GET /incidents/:id/report — the evidence for one incident (see report.ts).
  router.get("/:id/report", async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return sendInvalidId(res);
    const report = await getIncidentReport(db, id);
    if (!report) return sendNotFound(res, "Incident", id);
    res.json(report);
  });

  return router;
}
