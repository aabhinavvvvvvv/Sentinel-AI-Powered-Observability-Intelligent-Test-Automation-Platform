/**
 * GET /incidents — newest first.
 *   ?status=open|resolved   only open or only closed incidents
 *   ?endpoint_id=5          only this endpoint's incidents
 *   ?limit=100              how many (1–500, default 100)
 */
import { Router } from "express";
import { z } from "zod";
import type { Database } from "../db.js";
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
    if (!query.success) {
      res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid query parameters",
          details: query.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })),
        },
      });
      return;
    }
    res.json(await listIncidents(db, query.data));
  });

  return router;
}
