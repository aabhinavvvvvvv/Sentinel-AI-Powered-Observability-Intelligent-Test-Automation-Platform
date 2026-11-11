/** Integration tests for /suites and their test cases (real app + test database). */
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { createDatabase } from "../src/db.js";
import { resetDb, silentLogger } from "./helpers.js";

const db = createDatabase(process.env.TEST_DATABASE_URL!, silentLogger);
const scheduler = { schedule: async () => {}, unschedule: async () => {} };
// Records which runs were handed to the worker (the real queue + runner are tested in run-suite.test.ts).
const testRuns = { enqueue: vi.fn(async () => {}), schedule: vi.fn(async () => {}), unschedule: vi.fn(async () => {}) };
const app = createApp({ db, scheduler, testRuns, logger: silentLogger, healthcheckDbTimeoutMs: 1000 });

beforeEach(async () => {
  vi.clearAllMocks();
  await resetDb(db);
});
afterAll(() => db.close());

const fieldsWithErrors = (res: request.Response) =>
  res.body.error.details.map((d: { field: string }) => d.field);

async function setup() {
  await request(app).post("/endpoints").send({ name: "Users API", url: "https://api.example.com" }); // id 1
  await request(app).post("/suites").send({ endpoint_id: 1, name: "Users" }); // suite id 1
}

const validCase = {
  name: "Get user 1",
  url: "https://api.example.com/users/1",
  assertions: [{ type: "status_equals", value: 200 }],
};
const addCase = (body: object, suite = 1) => request(app).post(`/suites/${suite}/cases`).send(body);

describe("suites", () => {
  it("creates a suite for an existing endpoint", async () => {
    await request(app).post("/endpoints").send({ name: "API", url: "https://api.example.com" });
    const res = await request(app).post("/suites").send({ endpoint_id: 1, name: "Users" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 1, endpoint_id: 1, name: "Users" });
  });

  it("rejects a suite for an endpoint that doesn't exist", async () => {
    const res = await request(app).post("/suites").send({ endpoint_id: 99, name: "Users" });
    expect(res.status).toBe(400);
    expect(fieldsWithErrors(res)).toEqual(["endpoint_id"]);
  });

  it("lists suites with their endpoint name and number of cases, filterable by endpoint", async () => {
    await setup();
    await addCase(validCase);
    await addCase(validCase);
    await request(app).post("/endpoints").send({ name: "Other", url: "https://other.example.com" }); // id 2
    await request(app).post("/suites").send({ endpoint_id: 2, name: "Other suite" });

    const all = (await request(app).get("/suites")).body;
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ name: "Users", endpoint_name: "Users API", case_count: 2 });
    expect((await request(app).get("/suites?endpoint_id=2")).body.map((s: { name: string }) => s.name)).toEqual([
      "Other suite",
    ]);
  });

  it("returns one suite with its cases", async () => {
    await setup();
    await addCase(validCase);
    const res = await request(app).get("/suites/1");
    expect(res.body.name).toBe("Users");
    expect(res.body.cases).toHaveLength(1);
  });

  it("renames and deletes a suite (deleting removes its cases)", async () => {
    await setup();
    await addCase(validCase);
    expect((await request(app).patch("/suites/1").send({ name: "Renamed" })).body.name).toBe("Renamed");
    expect((await request(app).delete("/suites/1")).status).toBe(204);
    expect((await request(app).get("/suites/1")).status).toBe(404);
    expect(await db.query("SELECT * FROM test_cases")).toEqual([]);
  });

  it("deleting the endpoint deletes its suites", async () => {
    await setup();
    await request(app).delete("/endpoints/1");
    expect((await request(app).get("/suites")).body).toEqual([]);
  });

  it("returns 404 for a suite that doesn't exist", async () => {
    expect((await request(app).get("/suites/99")).status).toBe(404);
    expect((await addCase(validCase, 99)).status).toBe(404);
  });
});

describe("suite schedules (timers kept in sync with the API)", () => {
  it("a new suite has no schedule by default, but its timer state is still applied", async () => {
    await setup();
    expect((await request(app).get("/suites/1")).body.schedule_minutes).toBeNull();
    expect(testRuns.schedule).toHaveBeenCalledWith(expect.objectContaining({ id: 1, schedule_minutes: null }));
  });

  it("creating with a schedule starts its timer", async () => {
    await request(app).post("/endpoints").send({ name: "API", url: "https://api.example.com" });
    const res = await request(app).post("/suites").send({ endpoint_id: 1, name: "Hourly", schedule_minutes: 60 });
    expect(res.body.schedule_minutes).toBe(60);
    expect(testRuns.schedule).toHaveBeenCalledWith(expect.objectContaining({ id: 1, schedule_minutes: 60 }));
  });

  it("PATCH changes the schedule and keeps the name (and vice versa)", async () => {
    await setup();
    const scheduled = await request(app).patch("/suites/1").send({ schedule_minutes: 15 });
    expect(scheduled.body).toMatchObject({ name: "Users", schedule_minutes: 15 });
    expect(testRuns.schedule).toHaveBeenLastCalledWith(expect.objectContaining({ schedule_minutes: 15 }));

    const renamed = await request(app).patch("/suites/1").send({ name: "Users v2" });
    expect(renamed.body).toMatchObject({ name: "Users v2", schedule_minutes: 15 });

    const manual = await request(app).patch("/suites/1").send({ schedule_minutes: null });
    expect(manual.body.schedule_minutes).toBeNull();
  });

  it.each([[3], [2000], ["60"]])("rejects schedule_minutes %s", async (value) => {
    await setup();
    expect((await request(app).patch("/suites/1").send({ schedule_minutes: value })).status).toBe(400);
  });

  it("deleting a suite stops its timer", async () => {
    await setup();
    await request(app).delete("/suites/1");
    expect(testRuns.unschedule).toHaveBeenCalledWith(1);
  });

  it("the list shows each suite's newest run", async () => {
    await setup();
    await addCase(validCase);
    await request(app).post("/suites/1/runs");
    await request(app).post("/suites/1/runs");
    const [suite] = (await request(app).get("/suites")).body;
    expect(suite.last_run).toMatchObject({ id: 2, status: "queued" });
  });
});

describe("test cases", () => {
  it("creates a case with defaults, and assertions come back exactly as sent", async () => {
    await setup();
    const res = await addCase(validCase);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      suite_id: 1,
      method: "GET",
      headers: {},
      body: null,
      timeout_ms: 5000,
      assertions: [{ type: "status_equals", value: 200 }], // a real JSON array, not a Postgres array
    });
  });

  it("accepts every assertion type", async () => {
    await setup();
    const assertions = [
      { type: "status_equals", value: 201 },
      { type: "response_time_below_ms", value: 500 },
      { type: "header_contains", name: "content-type", value: "json" },
      { type: "body_contains", value: "created" },
      { type: "json_path_exists", path: "user.id" },
      { type: "json_path_equals", path: "items.0.name", value: "Ada" },
    ];
    const res = await addCase({
      ...validCase,
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: '{"name":"Ada"}',
      assertions,
    });
    expect(res.status).toBe(201);
    expect(res.body.assertions).toEqual(assertions);
    expect(res.body.headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer test" });
  });

  it.each([
    ["no assertions", { ...validCase, assertions: [] }, "assertions"],
    ["unknown assertion type", { ...validCase, assertions: [{ type: "run_code", value: "x" }] }, "assertions.0.type"],
    ["assertion with a wrong value", { ...validCase, assertions: [{ type: "status_equals", value: 999 }] }, "assertions.0.value"],
    ["bad JSON path", { ...validCase, assertions: [{ type: "json_path_exists", path: "user..id" }] }, "assertions.0.path"],
    ["GET with a body", { ...validCase, body: "hello" }, "body"],
    ["forbidden header", { ...validCase, headers: { Host: "evil.example.com" } }, "headers"],
    ["non-http URL", { ...validCase, url: "file:///etc/passwd" }, "url"],
    ["unknown field", { ...validCase, script: "rm -rf /" }, ""],
  ])("rejects %s", async (_label, body, field) => {
    await setup();
    const res = await addCase(body);
    expect(res.status).toBe(400);
    expect(fieldsWithErrors(res)).toContain(field);
  });

  it("PATCH changes only what was sent", async () => {
    await setup();
    await addCase({ ...validCase, timeout_ms: 9000 });
    const res = await request(app).patch("/suites/1/cases/1").send({ name: "Renamed" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: "Renamed", timeout_ms: 9000, assertions: validCase.assertions });
  });

  it("PATCH still applies cross-field rules after merging (body + GET)", async () => {
    await setup();
    await addCase({ ...validCase, method: "POST", body: "{}" });
    const res = await request(app).patch("/suites/1/cases/1").send({ method: "GET" }); // body is still "{}"
    expect(res.status).toBe(400);
    expect(fieldsWithErrors(res)).toContain("body");
  });

  it("PATCH rejects an empty change and invalid values", async () => {
    await setup();
    await addCase(validCase);
    expect((await request(app).patch("/suites/1/cases/1").send({})).status).toBe(400);
    expect((await request(app).patch("/suites/1/cases/1").send({ assertions: [] })).status).toBe(400);
  });

  it("keeps old run results when a case is deleted (case_id becomes null)", async () => {
    await setup();
    await addCase(validCase);
    await request(app).post("/suites/1/runs");
    await db.query(
      `INSERT INTO test_case_results (run_id, case_id, case_name, passed, response_time_ms, failures)
       VALUES (1, 1, 'Get user 1', true, 100, '[]')`,
    );
    await request(app).delete("/suites/1/cases/1");
    const [result] = (await request(app).get("/suites/1/runs/1")).body.results;
    expect(result).toMatchObject({ case_id: null, case_name: "Get user 1" });
  });

  it("deletes a case; cases are only reachable through their own suite", async () => {
    await setup();
    await addCase(validCase);
    await request(app).post("/suites").send({ endpoint_id: 1, name: "Other" }); // suite 2
    expect((await request(app).delete("/suites/2/cases/1")).status).toBe(404); // wrong suite
    expect((await request(app).patch("/suites/2/cases/1").send({ name: "x" })).status).toBe(404);
    expect((await request(app).delete("/suites/1/cases/1")).status).toBe(204);
    expect((await request(app).get("/suites/1")).body.cases).toEqual([]);
  });
});

describe("runs (API side)", () => {
  it("'Run now' saves a queued run, hands it to the worker, and answers 202", async () => {
    await setup();
    await addCase(validCase);
    const res = await request(app).post("/suites/1/runs");
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ id: 1, suite_id: 1, status: "queued", triggered_by: "manual" });
    expect(testRuns.enqueue).toHaveBeenCalledWith(1);
  });

  it("'Run now' can ask for the suggested order; the default is the normal order", async () => {
    await setup();
    await addCase(validCase);
    expect((await request(app).post("/suites/1/runs")).body.run_order).toBe("default");
    expect((await request(app).post("/suites/1/runs").send({ order: "priority" })).body.run_order).toBe("priority");

    const bad = await request(app).post("/suites/1/runs").send({ order: "fastest" });
    expect(bad.status).toBe(400);
    expect(fieldsWithErrors(bad)).toEqual(["order"]);
  });

  it("refuses to run a suite with no test cases", async () => {
    await setup();
    const res = await request(app).post("/suites/1/runs");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("NO_TEST_CASES");
    expect(testRuns.enqueue).not.toHaveBeenCalled();
  });

  it("lists runs newest first, and shows one run with its results", async () => {
    await setup();
    await addCase(validCase);
    await request(app).post("/suites/1/runs");
    await request(app).post("/suites/1/runs");
    expect((await request(app).get("/suites/1/runs")).body.map((r: { id: number }) => r.id)).toEqual([2, 1]);

    const run = (await request(app).get("/suites/1/runs/1")).body;
    expect(run).toMatchObject({ id: 1, status: "queued", results: [] });
  });

  it("returns 404 for unknown suites and runs (and runs of another suite)", async () => {
    await setup();
    await addCase(validCase);
    await request(app).post("/suites/1/runs");
    await request(app).post("/suites").send({ endpoint_id: 1, name: "Other" }); // suite 2
    expect((await request(app).post("/suites/99/runs")).status).toBe(404);
    expect((await request(app).get("/suites/1/runs/99")).status).toBe(404);
    expect((await request(app).get("/suites/2/runs/1")).status).toBe(404);
  });
});
