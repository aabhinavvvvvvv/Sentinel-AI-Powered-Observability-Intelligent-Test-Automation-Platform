/**
 * Integration tests: real Express app + real SQL + real Postgres (the test database).
 * Every test starts from an empty `endpoints` table.
 */
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { createDatabase } from "../src/db.js";
import { resetDb, silentLogger } from "./helpers.js";

const db = createDatabase(process.env.TEST_DATABASE_URL!, silentLogger);
// A fake scheduler that only records calls (the real one is tested in scheduler.test.ts).
const scheduler = { schedule: vi.fn(async () => {}), unschedule: vi.fn(async () => {}) };
const app = createApp({ db, scheduler, logger: silentLogger, healthcheckDbTimeoutMs: 1000 });

beforeEach(async () => {
  vi.clearAllMocks();
  await resetDb(db); // empty tables; the first endpoint in each test gets id 1
});
afterAll(async () => {
  await db.close();
});

const valid = { name: "Example API", url: "https://example.com/health" };
const create = (body: object) => request(app).post("/endpoints").send(body);
const fieldsWithErrors = (res: request.Response) =>
  res.body.error.details.map((d: { field: string }) => d.field);

describe("POST /endpoints", () => {
  it("creates an endpoint and fills in defaults", async () => {
    const res = await create(valid);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: 1,
      ...valid,
      method: "GET",
      interval_seconds: 60,
      timeout_ms: 5000,
      expected_status: 200,
      max_retries: 0,
      failure_threshold: 3,
      paused: false,
    });
    // Timestamps come back as ISO-8601 strings in UTC, e.g. "2026-11-11T13:00:00.000Z".
    expect(res.body.created_at).toMatch(/Z$/);
  });

  it.each([
    ["missing name", { url: valid.url }, "name"],
    ["blank name", { ...valid, name: "   " }, "name"],
    ["non-http URL", { ...valid, url: "ftp://example.com" }, "url"],
    ["text that is not a URL", { ...valid, url: "hello" }, "url"],
    ["interval below 30s", { ...valid, interval_seconds: 5 }, "interval_seconds"],
    ["number sent as a string", { ...valid, timeout_ms: "5000" }, "timeout_ms"],
    ["unsupported method", { ...valid, method: "DELETE" }, "method"],
  ])("rejects %s with 400", async (_label, body, field) => {
    const res = await create(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(fieldsWithErrors(res)).toContain(field);
  });

  it("rejects unknown fields so typos are not silently ignored", async () => {
    const res = await create({ ...valid, intervalSeconds: 120 });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("intervalSeconds");
  });

  it("rejects a request with no body", async () => {
    const res = await request(app).post("/endpoints");
    expect(res.status).toBe(400);
  });
});

describe("GET /endpoints and /endpoints/:id", () => {
  it("lists endpoints in creation order", async () => {
    await create({ ...valid, name: "A" });
    await create({ ...valid, name: "B" });
    const res = await request(app).get("/endpoints");
    expect(res.status).toBe(200);
    expect(res.body.map((e: { name: string }) => e.name)).toEqual(["A", "B"]);
  });

  it("returns one endpoint by id", async () => {
    await create(valid);
    const res = await request(app).get("/endpoints/1");
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Example API");
  });

  it("returns 404 for an id that does not exist", async () => {
    const res = await request(app).get("/endpoints/999");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it.each(["abc", "0", "-1", "1.5", "99999999999"])("returns 400 for invalid id %s", async (id) => {
    const res = await request(app).get(`/endpoints/${id}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_ID");
  });
});

describe("PATCH /endpoints/:id", () => {
  it("changes only the fields that were sent", async () => {
    const created = (await create({ ...valid, interval_seconds: 120 })).body;
    const res = await request(app).patch("/endpoints/1").send({ name: "Renamed" });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Renamed");
    // Regression guard: a PATCH must not reset other fields to their defaults.
    expect(res.body.interval_seconds).toBe(120);
    expect(new Date(res.body.updated_at) > new Date(created.updated_at)).toBe(true);
  });

  it("pauses and resumes an endpoint", async () => {
    await create(valid);
    expect((await request(app).patch("/endpoints/1").send({ paused: true })).body.paused).toBe(true);
    expect((await request(app).patch("/endpoints/1").send({ paused: false })).body.paused).toBe(false);
  });

  it("rejects an empty update", async () => {
    await create(valid);
    const res = await request(app).patch("/endpoints/1").send({});
    expect(res.status).toBe(400);
  });

  it("rejects invalid values", async () => {
    await create(valid);
    const res = await request(app).patch("/endpoints/1").send({ timeout_ms: 999_999 });
    expect(res.status).toBe(400);
    expect(fieldsWithErrors(res)).toContain("timeout_ms");
  });

  it("returns 404 for an id that does not exist", async () => {
    const res = await request(app).patch("/endpoints/999").send({ name: "x" });
    expect(res.status).toBe(404);
  });
});

// A localhost URL is blocked instantly by the SSRF guard, so these tests need no internet.
const blockedSite = { ...valid, url: "http://localhost:5432/" };

describe("scheduling (timers are kept in sync with the API)", () => {
  it("creating an endpoint starts its timer", async () => {
    await create(valid);
    expect(scheduler.schedule).toHaveBeenCalledWith(expect.objectContaining({ id: 1, paused: false }));
  });

  it("updating an endpoint updates its timer (e.g. pausing it)", async () => {
    await create(valid);
    await request(app).patch("/endpoints/1").send({ paused: true });
    expect(scheduler.schedule).toHaveBeenLastCalledWith(expect.objectContaining({ id: 1, paused: true }));
  });

  it("deleting an endpoint stops its timer", async () => {
    await create(valid);
    await request(app).delete("/endpoints/1");
    expect(scheduler.unschedule).toHaveBeenCalledWith(1);
  });

  it("invalid requests don't touch timers", async () => {
    await create({ url: "nope" });
    await request(app).patch("/endpoints/999").send({ name: "x" });
    await request(app).delete("/endpoints/999");
    expect(scheduler.schedule).not.toHaveBeenCalled();
    expect(scheduler.unschedule).not.toHaveBeenCalled();
  });
});

describe("POST /endpoints/:id/check", () => {
  it("checks the endpoint, saves the result, and returns it", async () => {
    await create(blockedSite);
    const res = await request(app).post("/endpoints/1/check");
    expect(res.status).toBe(200); // our API worked, even though the check failed
    expect(res.body).toMatchObject({ id: 1, endpoint_id: 1, ok: false, error_type: "blocked" });
  });

  it("returns 404 for an id that does not exist", async () => {
    expect((await request(app).post("/endpoints/999/check")).status).toBe(404);
  });
});

describe("GET /endpoints/:id/checks", () => {
  it("returns the saved history, newest first", async () => {
    await create(blockedSite);
    await request(app).post("/endpoints/1/check");
    await request(app).post("/endpoints/1/check");

    const res = await request(app).get("/endpoints/1/checks");
    expect(res.status).toBe(200);
    expect(res.body.map((r: { id: number }) => r.id)).toEqual([2, 1]);
  });

  it("only returns results for the requested endpoint", async () => {
    await create(blockedSite);
    await create(blockedSite);
    await request(app).post("/endpoints/1/check");
    const res = await request(app).get("/endpoints/2/checks");
    expect(res.body).toEqual([]);
  });

  it("respects ?limit=", async () => {
    await create(blockedSite);
    for (let i = 0; i < 3; i++) await request(app).post("/endpoints/1/check");
    const res = await request(app).get("/endpoints/1/checks?limit=2");
    expect(res.body).toHaveLength(2);
  });

  it.each(["0", "501", "abc"])("rejects ?limit=%s with 400", async (limit) => {
    await create(blockedSite);
    expect((await request(app).get(`/endpoints/1/checks?limit=${limit}`)).status).toBe(400);
  });

  it("returns 404 for an endpoint that does not exist", async () => {
    expect((await request(app).get("/endpoints/999/checks")).status).toBe(404);
  });

  it("deletes an endpoint's history when the endpoint is deleted", async () => {
    await create(blockedSite);
    await request(app).post("/endpoints/1/check");
    await request(app).delete("/endpoints/1");
    const rows = await db.query("SELECT * FROM check_results");
    expect(rows).toEqual([]);
  });
});

describe("DELETE /endpoints/:id", () => {
  it("deletes an endpoint, after which it is gone", async () => {
    await create(valid);
    expect((await request(app).delete("/endpoints/1")).status).toBe(204);
    expect((await request(app).get("/endpoints/1")).status).toBe(404);
  });

  it("returns 404 for an id that does not exist", async () => {
    expect((await request(app).delete("/endpoints/999")).status).toBe(404);
  });
});
