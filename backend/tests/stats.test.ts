/**
 * Tests GET /endpoints/:id/stats with made-up check data where we KNOW the right answer.
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

const addEndpoint = () =>
  createEndpoint(db, CreateEndpointSchema.parse({ name: "API", url: "https://example.com" }));

/** Insert `count` identical checks, `hoursAgo` hours in the past, in one SQL statement. */
async function addChecks(
  endpointId: number,
  { count, ms, ok = true, errorType = null, hoursAgo = 1 }: {
    count: number;
    ms: number;
    ok?: boolean;
    errorType?: string | null;
    hoursAgo?: number;
  },
) {
  await db.query(
    `INSERT INTO check_results (endpoint_id, ok, status_code, response_time_ms, error_type, checked_at)
     SELECT $1, $2, $3, $4, $5, now() - make_interval(hours => $6)
     FROM generate_series(1, $7)`,
    [endpointId, ok, ok ? 200 : null, ms, errorType, hoursAgo, count],
  );
}

const stats = (id: number, window = "24h") => request(app).get(`/endpoints/${id}/stats?window=${window}`);

describe("GET /endpoints/:id/stats", () => {
  it("the 90/10 example: average would lie, percentiles don't", async () => {
    const e = await addEndpoint();
    await addChecks(e.id, { count: 90, ms: 200 });
    await addChecks(e.id, { count: 10, ms: 3000 });

    const res = await stats(e.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      window: "24h",
      checks_total: 100,
      checks_ok: 100,
      uptime_percent: 100,
      response_time_ms: { p50: 200, p95: 3000, p99: 3000 },
      failures_by_type: [],
    });
  });

  it("uptime counts failures; speed uses only successful checks", async () => {
    const e = await addEndpoint();
    await addChecks(e.id, { count: 7, ms: 100 });
    await addChecks(e.id, { count: 2, ms: 5000, ok: false, errorType: "timeout" });
    await addChecks(e.id, { count: 1, ms: 30, ok: false, errorType: "dns" });

    const res = await stats(e.id);
    expect(res.body.checks_total).toBe(10);
    expect(res.body.uptime_percent).toBe(70);
    // The 5000 ms timeouts must NOT show up as "slow responses".
    expect(res.body.response_time_ms).toEqual({ p50: 100, p95: 100, p99: 100 });
    expect(res.body.failures_by_type).toEqual([
      { error_type: "timeout", count: 2 },
      { error_type: "dns", count: 1 },
    ]);
  });

  it("rounds uptime to 2 decimals", async () => {
    const e = await addEndpoint();
    await addChecks(e.id, { count: 2, ms: 100 });
    await addChecks(e.id, { count: 1, ms: 100, ok: false, errorType: "timeout" });
    expect((await stats(e.id)).body.uptime_percent).toBe(66.67);
  });

  it("only counts checks inside the window", async () => {
    const e = await addEndpoint();
    await addChecks(e.id, { count: 3, ms: 100, hoursAgo: 1 }); // inside 24h
    await addChecks(e.id, { count: 5, ms: 100, hoursAgo: 48 }); // 2 days ago: only in 7d and 30d
    await addChecks(e.id, { count: 4, ms: 100, hoursAgo: 24 * 10 }); // 10 days ago: only in 30d

    expect((await stats(e.id, "24h")).body.checks_total).toBe(3);
    expect((await stats(e.id, "7d")).body.checks_total).toBe(8);
    expect((await stats(e.id, "30d")).body.checks_total).toBe(12);
  });

  it("returns the exact period it covered", async () => {
    const e = await addEndpoint();
    const { from, to } = (await stats(e.id, "7d")).body;
    const hours = (new Date(to).getTime() - new Date(from).getTime()) / 3_600_000;
    expect(hours).toBe(24 * 7);
  });

  it("only counts this endpoint's checks", async () => {
    const a = await addEndpoint();
    const b = await addEndpoint();
    await addChecks(a.id, { count: 5, ms: 100 });
    expect((await stats(b.id)).body.checks_total).toBe(0);
  });

  it("with no checks: zeros and nulls, not made-up numbers", async () => {
    const e = await addEndpoint();
    expect((await stats(e.id)).body).toMatchObject({
      checks_total: 0,
      uptime_percent: null,
      response_time_ms: { p50: null, p95: null, p99: null },
    });
  });

  it("defaults to 24h", async () => {
    const e = await addEndpoint();
    expect((await request(app).get(`/endpoints/${e.id}/stats`)).body.window).toBe("24h");
  });

  it("rejects an unknown window with 400", async () => {
    const e = await addEndpoint();
    expect((await stats(e.id, "1y")).status).toBe(400);
  });

  it("returns 404 for an endpoint that does not exist", async () => {
    expect((await stats(999)).status).toBe(404);
  });
});

const timeseries = (id: number, window = "24h") => request(app).get(`/endpoints/${id}/timeseries?window=${window}`);

describe("GET /endpoints/:id/timeseries", () => {
  it.each([
    ["24h", "1 hour", 25],
    ["7d", "6 hours", 29],
    ["30d", "1 day", 31],
  ])("%s: one point per %s, including the two partial ends (%i points)", async (window, bucket, points) => {
    const e = await addEndpoint();
    const res = await timeseries(e.id, window);
    expect(res.status).toBe(200);
    expect(res.body.bucket).toBe(bucket);
    expect(res.body.points).toHaveLength(points);
  });

  it("puts checks in the right bucket and computes its numbers", async () => {
    const e = await addEndpoint();
    // All of these are at the same moment (2 hours ago), so they share one bucket.
    await addChecks(e.id, { count: 18, ms: 200, hoursAgo: 2 });
    await addChecks(e.id, { count: 1, ms: 900, hoursAgo: 2 });
    await addChecks(e.id, { count: 1, ms: 5000, ok: false, errorType: "timeout", hoursAgo: 2 });

    const points = (await timeseries(e.id)).body.points;
    const withData = points.filter((p: { checks_total: number }) => p.checks_total > 0);
    expect(withData).toHaveLength(1);
    expect(withData[0]).toMatchObject({
      checks_total: 20,
      checks_ok: 19,
      uptime_percent: 95,
      p50_ms: 200,
      p95_ms: 900, // the slowest successful check; the 5000 ms timeout is excluded
    });
    // Its bucket starts on a whole hour (UTC).
    expect(new Date(withData[0].time).getUTCMinutes()).toBe(0);
  });

  it("keeps empty buckets as gaps: 0 checks and nulls, not 100%", async () => {
    const e = await addEndpoint();
    const point = (await timeseries(e.id)).body.points[0];
    expect(point).toMatchObject({ checks_total: 0, uptime_percent: null, p50_ms: null, p95_ms: null });
  });

  it("returns points oldest first", async () => {
    const e = await addEndpoint();
    const times = (await timeseries(e.id)).body.points.map((p: { time: string }) => new Date(p.time).getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("rejects an unknown window with 400, and unknown endpoints with 404", async () => {
    const e = await addEndpoint();
    expect((await timeseries(e.id, "1y")).status).toBe(400);
    expect((await timeseries(999)).status).toBe(404);
  });
});
