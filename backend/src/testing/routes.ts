/**
 * REST API for test suites and their test cases, mounted at /suites:
 *   POST   /suites                         create {endpoint_id, name, schedule_minutes?} → 201 | 400
 *   GET    /suites?endpoint_id=N           list suites (with case_count, last_run) → 200 | 400
 *   GET    /suites/:id                     one suite + its cases                  → 200 | 400 | 404
 *   PATCH  /suites/:id                     change {name?, schedule_minutes?}      → 200 | 400 | 404
 *   DELETE /suites/:id                     delete (and its cases)                 → 204 | 400 | 404
 *   POST   /suites/:id/cases               add a test case                        → 201 | 400 | 404
 *   PATCH  /suites/:id/cases/:caseId       change some fields of a case           → 200 | 400 | 404
 *   DELETE /suites/:id/cases/:caseId       delete a case                          → 204 | 400 | 404
 *   POST   /suites/:id/runs                run now {order?: default|priority}     → 202 | 400 | 404
 *   GET    /suites/:id/runs?limit=50       run history, newest first              → 200 | 400 | 404
 *   GET    /suites/:id/runs/:runId         one run + its per-case results         → 200 | 400 | 404
 *   GET    /suites/:id/priority            cases ranked by risk, with reasons     → 200 | 400 | 404
 */
import { Router } from "express";
import { z } from "zod";
import type { Database } from "../db.js";
import { getEndpoint } from "../endpoints/repository.js";
import { parseId, sendInvalidId, sendNotFound, sendValidationError } from "../http.js";
import { rankCases } from "./priority.js";
import * as repo from "./repository.js";
import type { TestRunQueue } from "./run-queue.js";
import * as runsRepo from "./runs-repository.js";
import { CreateSuiteSchema, SuiteSettingsSchema, TestCaseSchema, type TestCase } from "./schemas.js";

const LimitSchema = z.coerce.number().int().min(1).max(500).default(50);

// POST /suites/:id/runs body (optional): which order to run the cases in. Every case runs either way.
const RunOptionsSchema = z.strictObject({ order: z.enum(["default", "priority"]).default("default") });

const ListQuerySchema =z.object({ endpoint_id: z.coerce.number().int().positive().max(2_147_483_647).optional() });

// A PATCH body: any object with at least one field (the full case is validated after merging).
const ChangesSchema = z
  .record(z.string(), z.unknown())
  .refine((o) => Object.keys(o).length > 0, "Provide at least one field to update");

/** The editable fields of a stored case (drops id, suite_id, timestamps). */
const editableFields = ({ name, method, url, headers, body, timeout_ms, assertions }: TestCase) => ({
  name,
  method,
  url,
  headers,
  body,
  timeout_ms,
  assertions,
});

export type SuiteRunner = Pick<TestRunQueue, "enqueue" | "schedule" | "unschedule">;

export function suitesRouter(db: Database, testRuns: SuiteRunner): Router {
  const router = Router();

  router.post("/", async (req, res) => {
    const parsed = CreateSuiteSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);
    if (!(await getEndpoint(db, parsed.data.endpoint_id))) {
      res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Request body is invalid",
          details: [{ field: "endpoint_id", message: `endpoint ${parsed.data.endpoint_id} does not exist` }],
        },
      });
      return;
    }
    const suite = await repo.createSuite(db, parsed.data.endpoint_id, parsed.data);
    await testRuns.schedule(suite); // start its timer if it has a schedule
    res.status(201).json(suite);
  });

  router.get("/", async (req, res) => {
    const query = ListQuerySchema.safeParse(req.query);
    if (!query.success) return sendValidationError(res, query.error);
    res.json(await repo.listSuites(db, query.data.endpoint_id));
  });

  router.get("/:id", async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return sendInvalidId(res);
    const suite = await repo.getSuite(db, id);
    if (!suite) return sendNotFound(res, "Suite", id);
    res.json({ ...suite, cases: await repo.listCases(db, id) });
  });

  // PATCH {name?, schedule_minutes?}: merge into the stored suite, validate, save, update its timer.
  router.patch("/:id", async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return sendInvalidId(res);
    const existing = await repo.getSuite(db, id);
    if (!existing) return sendNotFound(res, "Suite", id);
    const changes = ChangesSchema.safeParse(req.body);
    if (!changes.success) return sendValidationError(res, changes.error);
    const parsed = SuiteSettingsSchema.safeParse({
      name: existing.name,
      schedule_minutes: existing.schedule_minutes,
      ...changes.data,
    });
    if (!parsed.success) return sendValidationError(res, parsed.error);
    const suite = await repo.updateSuite(db, id, parsed.data);
    await testRuns.schedule(suite); // new interval, or null → timer removed
    res.json(suite);
  });

  router.delete("/:id", async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return sendInvalidId(res);
    if (!(await repo.deleteSuite(db, id))) return sendNotFound(res, "Suite", id);
    await testRuns.unschedule(id); // stop its timer
    res.status(204).end();
  });

  router.post("/:id/cases", async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return sendInvalidId(res);
    if (!(await repo.getSuite(db, id))) return sendNotFound(res, "Suite", id);
    const parsed = TestCaseSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);
    res.status(201).json(await repo.createCase(db, id, parsed.data));
  });

  // PATCH: merge the changes into the stored case, then validate the WHOLE result with the
  // same rules as creating one. One set of rules, and cross-field checks (e.g. "GET can't have
  // a body") still work when only one of the two fields changes.
  router.patch("/:id/cases/:caseId", async (req, res) => {
    const id = parseId(req.params.id);
    const caseId = parseId(req.params.caseId);
    if (id === null || caseId === null) return sendInvalidId(res);
    const existing = await repo.getCase(db, id, caseId);
    if (!existing) return sendNotFound(res, "Test case", caseId);
    const changes = ChangesSchema.safeParse(req.body);
    if (!changes.success) return sendValidationError(res, changes.error);
    const parsed = TestCaseSchema.safeParse({ ...editableFields(existing), ...changes.data });
    if (!parsed.success) return sendValidationError(res, parsed.error);
    res.json(await repo.updateCase(db, caseId, parsed.data));
  });

  router.delete("/:id/cases/:caseId", async (req, res) => {
    const id = parseId(req.params.id);
    const caseId = parseId(req.params.caseId);
    if (id === null || caseId === null) return sendInvalidId(res);
    if (!(await repo.deleteCase(db, id, caseId))) return sendNotFound(res, "Test case", caseId);
    res.status(204).end();
  });

  // ----- runs -----

  // "Run now": save a queued run, hand it to the worker, and answer straight away.
  // 202 Accepted = "got it, the work happens in the background". Poll GET .../runs/:runId for the result.
  router.post("/:id/runs", async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return sendInvalidId(res);
    if (!(await repo.getSuite(db, id))) return sendNotFound(res, "Suite", id);
    const options = RunOptionsSchema.safeParse(req.body ?? {}); // no body = {} = default order
    if (!options.success) return sendValidationError(res, options.error);
    if ((await repo.listCases(db, id)).length === 0) {
      res.status(400).json({ error: { code: "NO_TEST_CASES", message: "Add at least one test case before running the suite" } });
      return;
    }
    const run = await runsRepo.createRun(db, id, "manual", options.data.order);
    await testRuns.enqueue(run.id);
    res.status(202).json(run);
  });

  router.get("/:id/runs", async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return sendInvalidId(res);
    const limit = LimitSchema.safeParse(req.query.limit);
    if (!limit.success) return sendValidationError(res, limit.error);
    if (!(await repo.getSuite(db, id))) return sendNotFound(res, "Suite", id);
    res.json(await runsRepo.listRuns(db, id, limit.data));
  });

  router.get("/:id/runs/:runId", async (req, res) => {
    const id = parseId(req.params.id);
    const runId = parseId(req.params.runId);
    if (id === null || runId === null) return sendInvalidId(res);
    const run = await runsRepo.getRun(db, id, runId);
    if (!run) return sendNotFound(res, "Run", runId);
    res.json({ ...run, results: await runsRepo.listCaseResults(db, runId) });
  });

  // Which cases should run first, and why (priority.ts).
  router.get("/:id/priority", async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return sendInvalidId(res);
    const priority = await rankCases(db, id);
    if (!priority) return sendNotFound(res, "Suite", id);
    res.json(priority);
  });

  return router;
}
