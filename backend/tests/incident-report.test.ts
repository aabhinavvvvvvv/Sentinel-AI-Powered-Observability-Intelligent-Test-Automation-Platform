/**
 * GET /incidents/:id/report, fed with hand-made history so every number in the report is known in advance.
 */
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createDatabase } from "../src/db.js";
import { createEndpoint } from "../src/endpoints/repository.js";
import { CreateEndpointSchema } from "../src/endpoints/schemas.js";
import { resetDb, silentLogger } from "./helpers.js";

const db = createDatabase(process.env.TEST_DATABASE_URL!, silentLogger);
const scheduler = { schedule: async () => {}, unschedule: async () => {} };
const testRuns = { enqueue: async () => {}, schedule: async () => {}, unschedule: async () => {} };
const app = createApp({ db, scheduler, testRuns, logger: silentLogger, healthcheckDbTimeoutMs: 1000 });

beforeEach(() => resetDb(db));
afterAll(() => db.close());

const at = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 0, day, hour, minute));

async function addCheck(endpointId: number, time: Date, ok: boolean, ms: number, errorType: string | null = null) {
  await db.query(
    `INSERT INTO check_results (endpoint_id, ok, status_code, response_time_ms, error_type, checked_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [endpointId, ok, ok ? 200 : null, ms, errorType, time],
  );
}

async function addIncident(endpointId: number, type: string, start: Date, end: Date | null): Promise<number> {
  const [row] = await db.query<{ id: number }>(
    "INSERT INTO incidents (endpoint_id, started_at, resolved_at, error_type) VALUES ($1, $2, $3, $4) RETURNING id",
    [endpointId, start, end, type],
  );
  return row!.id;
}

async function addTestResult(endpointId: number, name: string, passed: boolean, time: Date) {
  const [suite] = await db.query<{ id: number }>(
    "INSERT INTO test_suites (endpoint_id, name) VALUES ($1, 'Suite') RETURNING id",
    [endpointId],
  );
  const [run] = await db.query<{ id: number }>(
    "INSERT INTO test_runs (suite_id, triggered_by, status) VALUES ($1, 'manual', 'failed') RETURNING id",
    [suite!.id],
  );
  const failures = passed ? [] : [{ assertion: { type: "status_equals", value: 200 }, message: "expected status 200, got 504" }];
  await db.query(
    `INSERT INTO test_case_results (run_id, case_name, passed, response_time_ms, failures, created_at)
     VALUES ($1, $2, $3, 100, $4, $5)`,
    [run!.id, name, passed, JSON.stringify(failures), time],
  );
}

const addEndpoint = () => createEndpoint(db, CreateEndpointSchema.parse({ name: "API", url: "https://example.com" }));

describe("GET /incidents/:id/report", () => {
  it("collects the evidence for an incident", async () => {
    const e = await addEndpoint();
    // The incident: day 10, 10:00 → 10:05.
    const id = await addIncident(e.id, "timeout", at(10, 10), at(10, 10, 5));

    // Before: normal 100 ms earlier in the week, 400 ms in the hour before the start.
    for (let i = 0; i < 5; i++) await addCheck(e.id, at(5, 12, i), true, 100);
    for (const m of [30, 40, 50]) await addCheck(e.id, at(10, 9, m), true, 400);
    // During: 2 timeouts + 1 server error. After: one more failure that must NOT count.
    await addCheck(e.id, at(10, 10, 0), false, 5000, "timeout");
    await addCheck(e.id, at(10, 10, 1), false, 5000, "timeout");
    await addCheck(e.id, at(10, 10, 2), false, 80, "server_error");
    await addCheck(e.id, at(10, 10, 30), false, 5000, "timeout");

    // History: 3 short timeout incidents in the previous 7 days → flapping.
    // Not counted: a different category, and one from 8 days earlier.
    for (const day of [8, 9, 9]) await addIncident(e.id, "timeout", at(day, 3 + day), at(day, 3 + day, 2));
    await addIncident(e.id, "dns", at(9, 1), at(9, 1, 2));
    await addIncident(e.id, "timeout", at(2, 1), at(2, 1, 2));

    // Tests: one failed during the incident (counted), one passed, one failed later (not counted).
    await addTestResult(e.id, "GET /users", false, at(10, 10, 3));
    await addTestResult(e.id, "GET /health", true, at(10, 10, 3));
    await addTestResult(e.id, "GET /orders", false, at(10, 11));

    const res = await request(app).get(`/incidents/${id}/report`);
    expect(res.status).toBe(200);
    const r = res.body;
    expect(r.incident).toMatchObject({ id, endpoint_name: "API", url: "https://example.com", error_type: "timeout" });
    expect(r.window).toMatchObject({ open: false, minutes: 5 });
    expect(r.failed_checks).toEqual({
      total: 3,
      by_type: [
        { error_type: "timeout", count: 2 },
        { error_type: "server_error", count: 1 },
      ],
    });
    expect(r.response_time_ms).toEqual({ p50_hour_before: 400, p50_week_before: 100 });
    expect(r.similar).toEqual({ days: 7, count: 3, median_minutes: 2, flapping: true });
    expect(r.failing_tests).toHaveLength(1);
    expect(r.failing_tests[0]).toMatchObject({ case_name: "GET /users", message: "expected status 200, got 504" });
    expect(r.suggestions[0]).toMatch(/overloaded/); // the timeout checklist...
    expect(r.suggestions.at(-1)).toMatch(/flapping/); // ...plus the flapping note
  });

  it("works with no history at all, and an open incident ends at 'now'", async () => {
    const e = await addEndpoint();
    const id = await addIncident(e.id, "server_error", new Date(Date.now() - 10 * 60_000), null);
    const r = (await request(app).get(`/incidents/${id}/report`)).body;
    expect(r.window.open).toBe(true);
    expect(r.window.minutes).toBeGreaterThanOrEqual(10);
    expect(r.failed_checks).toEqual({ total: 0, by_type: [] });
    expect(r.response_time_ms).toEqual({ p50_hour_before: null, p50_week_before: null });
    expect(r.similar).toEqual({ days: 7, count: 0, median_minutes: null, flapping: false });
    expect(r.failing_tests).toEqual([]);
    expect(r.suggestions.some((s: string) => /flapping/.test(s))).toBe(false);
  });

  it("is not flapping when past incidents were long", async () => {
    const e = await addEndpoint();
    for (const day of [6, 7, 8]) await addIncident(e.id, "timeout", at(day, 1), at(day, 2)); // 60 min each
    const id = await addIncident(e.id, "timeout", at(10, 10), at(10, 11));
    const r = (await request(app).get(`/incidents/${id}/report`)).body;
    expect(r.similar).toEqual({ days: 7, count: 3, median_minutes: 60, flapping: false });
  });

  it("returns 404 for an unknown incident and 400 for a bad id", async () => {
    expect((await request(app).get("/incidents/999/report")).status).toBe(404);
    expect((await request(app).get("/incidents/abc/report")).status).toBe(400);
  });
});
