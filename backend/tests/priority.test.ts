/**
 * Test prioritisation, fed with hand-made history so every score is known in advance.
 */
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createDatabase } from "../src/db.js";
import { createEndpoint } from "../src/endpoints/repository.js";
import { CreateEndpointSchema } from "../src/endpoints/schemas.js";
import { rankCases, scoreCase } from "../src/testing/priority.js";
import { createCase, createSuite } from "../src/testing/repository.js";
import { TestCaseSchema } from "../src/testing/schemas.js";
import { resetDb, silentLogger } from "./helpers.js";

const db = createDatabase(process.env.TEST_DATABASE_URL!, silentLogger);
const scheduler = { schedule: async () => {}, unschedule: async () => {} };
const testRuns = { enqueue: async () => {}, schedule: async () => {}, unschedule: async () => {} };
const app = createApp({ db, scheduler, testRuns, logger: silentLogger, healthcheckDbTimeoutMs: 1000 });

beforeEach(() => resetDb(db));
afterAll(() => db.close());

const day = (d: number) => new Date(Date.UTC(2026, 0, d, 12));

async function addSuite() {
  const e = await createEndpoint(db, CreateEndpointSchema.parse({ name: "API", url: "https://example.com" }));
  const suite = await createSuite(db, e.id, { name: "Suite", schedule_minutes: null });
  return { endpointId: e.id, suiteId: suite.id };
}

async function addCase(suiteId: number, name: string): Promise<number> {
  const c = await createCase(
    db,
    suiteId,
    TestCaseSchema.parse({ name, url: "https://example.com", assertions: [{ type: "status_equals", value: 200 }] }),
  );
  // Pretend it was written long ago, before any of the history below.
  await db.query("UPDATE test_cases SET created_at = $2, updated_at = $2 WHERE id = $1", [c.id, day(1)]);
  return c.id;
}

/** One past result for a case (each in its own run, to keep the helper small). */
async function addResult(suiteId: number, caseId: number, passed: boolean, time: Date) {
  const [run] = await db.query<{ id: number }>(
    "INSERT INTO test_runs (suite_id, triggered_by, status) VALUES ($1, 'manual', $2) RETURNING id",
    [suiteId, passed ? "passed" : "failed"],
  );
  await db.query(
    `INSERT INTO test_case_results (run_id, case_id, case_name, passed, response_time_ms, failures, created_at)
     VALUES ($1, $2, 'x', $3, 100, '[]', $4)`,
    [run!.id, caseId, passed, time],
  );
}

describe("scoreCase (the rule itself)", () => {
  it("gives no points to a case that keeps passing", () => {
    expect(scoreCase({ recent: [true, true, true], edited: false })).toEqual({ score: 0, reasons: [], warning: null });
  });

  it("adds up named reasons", () => {
    expect(scoreCase({ recent: [false, true, true], edited: true })).toEqual({
      score: 80, // 30 + 40 + round(30 × 1/3)
      reasons: ["Edited since its last run (+30)", "Failed in the last run (+40)", "Failed 1 of its last 3 runs (+10)"],
      warning: null,
    });
  });

  it("warns when a case fails every time (at least 5 runs)", () => {
    expect(scoreCase({ recent: [false, false, false, false], edited: false }).warning).toBeNull();
    expect(scoreCase({ recent: [false, false, false, false, false], edited: false }).warning).toMatch(/test itself may be wrong/);
  });
});

describe("GET /suites/:id/priority", () => {
  it("ranks the cases by score, with reasons, and reports endpoint trouble", async () => {
    const { endpointId, suiteId } = await addSuite();
    const passes = await addCase(suiteId, "Always passes"); // position 1
    const failedLast = await addCase(suiteId, "Failed last time"); // 2
    await addCase(suiteId, "Brand new"); // 3, never run
    const alwaysFails = await addCase(suiteId, "Always fails"); // 4
    const edited = await addCase(suiteId, "Edited"); // 5

    for (const d of [2, 3, 4]) {
      await addResult(suiteId, passes, true, day(d));
      await addResult(suiteId, failedLast, d !== 4, day(d)); // fails only on the newest run
      await addResult(suiteId, edited, true, day(d));
    }
    for (const d of [2, 3, 4, 5, 6]) await addResult(suiteId, alwaysFails, false, day(d));
    await db.query("UPDATE test_cases SET updated_at = $2 WHERE id = $1", [edited, day(5)]); // edited after its last run

    // Endpoint trouble now: an open incident and 2 failed checks in the last hour (older/OK checks don't count).
    await db.query("INSERT INTO incidents (endpoint_id, started_at, error_type) VALUES ($1, now() - interval '10 minutes', 'timeout')", [endpointId]);
    for (const [ok, ago] of [[false, "5 minutes"], [false, "6 minutes"], [false, "2 hours"], [true, "1 minute"]] as const) {
      await db.query(
        `INSERT INTO check_results (endpoint_id, ok, response_time_ms, checked_at) VALUES ($1, $2, 100, now() - $3::interval)`,
        [endpointId, ok, ago],
      );
    }

    const res = await request(app).get(`/suites/${suiteId}/priority`);
    expect(res.status).toBe(200);
    expect(res.body.endpoint).toEqual({ open_incident: true, failed_checks_last_hour: 2 });
    // "Brand new" and "Edited" tie at 30: they keep their normal order (3 before 5).
    expect(res.body.cases.map((c: { name: string; score: number; position: number }) => [c.name, c.score, c.position])).toEqual([
      ["Always fails", 70, 4],
      ["Failed last time", 50, 2],
      ["Brand new", 30, 3],
      ["Edited", 30, 5],
      ["Always passes", 0, 1],
    ]);
    expect(res.body.cases[0].warning).toMatch(/test itself may be wrong/);
    expect(res.body.cases[1].reasons).toEqual(["Failed in the last run (+40)", "Failed 1 of its last 3 runs (+10)"]);
    expect(res.body.cases[2].reasons).toEqual(["Never run yet (+30)"]);
  });

  it("returns 404 for an unknown suite and 400 for a bad id", async () => {
    expect((await request(app).get("/suites/999/priority")).status).toBe(404);
    expect((await request(app).get("/suites/abc/priority")).status).toBe(400);
  });
});

describe("rankCases history window", () => {
  it("uses only results from before `at`, and only the last 10", async () => {
    const { suiteId } = await addSuite();
    const id = await addCase(suiteId, "Case");
    await addResult(suiteId, id, false, day(2)); // old failures: pushed out by the 10 newer results
    await addResult(suiteId, id, false, day(3));
    for (let d = 4; d <= 13; d++) await addResult(suiteId, id, true, day(d));
    await addResult(suiteId, id, false, day(20)); // a later failure

    // As seen on day 15: the last 10 results all passed, and day 20 is still in the future.
    const before = await rankCases(db, suiteId, day(15));
    expect(before!.cases[0]).toMatchObject({ score: 0, reasons: [] });
    expect(before!.endpoint).toEqual({ open_incident: false, failed_checks_last_hour: 0 });

    // As seen on day 25: the day-20 failure is now the newest result.
    const after = await rankCases(db, suiteId, day(25));
    expect(after!.cases[0]).toMatchObject({ score: 43, reasons: ["Failed in the last run (+40)", "Failed 1 of its last 10 runs (+3)"] });
  });
});
