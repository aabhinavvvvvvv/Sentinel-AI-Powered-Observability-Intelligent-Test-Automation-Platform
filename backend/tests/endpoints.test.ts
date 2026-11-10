/**
 * Integration tests: real Express app + real SQL + real Postgres (the test database).
 * Every test starts from an empty `endpoints` table.
 */
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createDatabase } from "../src/db.js";
import { silentLogger } from "./helpers.js";

const db = createDatabase(process.env.TEST_DATABASE_URL!, silentLogger);
const app = createApp({ db, logger: silentLogger, healthcheckDbTimeoutMs: 1000 });

beforeEach(async () => {
  // RESTART IDENTITY resets ids, so the first endpoint in each test has id 1.
  await db.query("TRUNCATE endpoints RESTART IDENTITY");
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
