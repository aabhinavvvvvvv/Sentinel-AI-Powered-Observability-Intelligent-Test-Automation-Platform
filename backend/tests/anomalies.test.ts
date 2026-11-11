/**
 * Tests the Node side of anomaly detection against a FAKE Python service:
 * the contract check, saving without duplicates, skipping paused endpoints, and the API route.
 * (The real Python logic is tested with pytest in analytics/.)
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { analyzeAll } from "../src/analytics/anomalies.js";
import { createApp } from "../src/app.js";
import { createDatabase } from "../src/db.js";
import { createEndpoint } from "../src/endpoints/repository.js";
import { CreateEndpointSchema } from "../src/endpoints/schemas.js";
import { resetDb, silentLogger } from "./helpers.js";

const db = createDatabase(process.env.TEST_DATABASE_URL!, silentLogger);
const scheduler = { schedule: async () => {}, unschedule: async () => {} };
const testRuns = { enqueue: async () => {}, schedule: async () => {}, unschedule: async () => {} };
const app = createApp({ db, scheduler, testRuns, logger: silentLogger, healthcheckDbTimeoutMs: 1000 });

const finding = (time: string, value: number, method = "robust_z_v1") => ({
  time,
  metric: "P50 response time",
  value,
  baseline: 240,
  score: 445.2,
  severity: "critical",
  explanation: `P50 response time was ${value} ms ... This is a statistical signal, not a diagnosis.`,
  method,
});

let fakePython: Server;
let fakeUrl: string;
let calledFor: string[] = [];

beforeAll(async () => {
  // Endpoint 1: a good answer. Endpoint 2: the service errors. Endpoint 3: an answer that breaks the contract.
  fakePython = createServer((req, res) => {
    const id = req.url!.split("/").pop()!;
    calledFor.push(id);
    if (id === "2") return res.writeHead(500).end("boom");
    const body =
      id === "3"
        ? { endpoint_id: 3, findings: "not a list" }
        : {
            endpoint_id: Number(id),
            hours_scored: 20,
            findings:
              id === "4" // endpoint 4: two detectors flag the SAME hour
                ? [
                    finding("2026-01-02T06:00:00+00:00", 900, "robust_z_v1"),
                    finding("2026-01-02T06:00:00+00:00", 900, "isolation_forest_v2"),
                  ]
                : [finding("2026-01-02T06:00:00+00:00", 900), finding("2026-01-02T09:00:00+00:00", 700)],
          };
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => fakePython.listen(0, "127.0.0.1", resolve));
  fakeUrl = `http://127.0.0.1:${(fakePython.address() as AddressInfo).port}`;
});
beforeEach(async () => {
  calledFor = [];
  await resetDb(db);
});
afterAll(async () => {
  fakePython.close();
  await db.close();
});

const addEndpoint = (extra = {}) =>
  createEndpoint(db, CreateEndpointSchema.parse({ name: "API", url: "https://example.com", ...extra }));

describe("analyzeAll", () => {
  it("saves findings, and running again doesn't create duplicates", async () => {
    await addEndpoint(); // id 1
    expect(await analyzeAll(db, fakeUrl)).toEqual({ endpoints: 1, newAnomalies: 2, errors: [] });
    expect(await analyzeAll(db, fakeUrl)).toEqual({ endpoints: 1, newAnomalies: 0, errors: [] }); // same hours again

    const rows = await db.query("SELECT * FROM anomalies ORDER BY bucket_start");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ endpoint_id: 1, value: 900, baseline: 240, severity: "critical", method: "robust_z_v1" });
  });

  it("records failures per endpoint and carries on with the others", async () => {
    await addEndpoint(); // 1: ok
    await addEndpoint(); // 2: service error
    await addEndpoint(); // 3: broken contract
    const summary = await analyzeAll(db, fakeUrl);

    expect(summary.newAnomalies).toBe(2); // endpoint 1 still saved
    expect(summary.errors.map((e) => e.endpointId)).toEqual([2, 3]);
    expect(summary.errors[0]!.message).toBe("analytics service answered HTTP 500");
    expect(await db.query("SELECT * FROM anomalies WHERE endpoint_id = 3")).toEqual([]); // nothing saved from a bad answer
  });

  it("keeps one finding per detector when several flag the same hour (shadow mode)", async () => {
    for (let i = 0; i < 4; i++) await addEndpoint({ paused: i !== 3 }); // only endpoint 4 is active
    expect((await analyzeAll(db, fakeUrl)).newAnomalies).toBe(2);
    const methods = await db.query<{ method: string }>("SELECT method FROM anomalies ORDER BY method");
    expect(methods.map((m) => m.method)).toEqual(["isolation_forest_v2", "robust_z_v1"]);
  });

  it("skips paused endpoints", async () => {
    await addEndpoint({ paused: true });
    expect(await analyzeAll(db, fakeUrl)).toEqual({ endpoints: 0, newAnomalies: 0, errors: [] });
    expect(calledFor).toEqual([]);
  });

  it("reports every endpoint as an error when the service is down", async () => {
    await addEndpoint();
    const summary = await analyzeAll(db, "http://127.0.0.1:9"); // nothing listens there
    expect(summary.errors).toHaveLength(1);
  });
});

describe("GET /endpoints/:id/anomalies", () => {
  it("lists an endpoint's anomalies, newest hour first", async () => {
    await addEndpoint();
    await analyzeAll(db, fakeUrl);
    const res = await request(app).get("/endpoints/1/anomalies");
    expect(res.status).toBe(200);
    expect(res.body.map((a: { value: number }) => a.value)).toEqual([700, 900]);
    expect(res.body[0].explanation).toMatch(/not a diagnosis/);
  });

  it("returns 404 for an unknown endpoint", async () => {
    expect((await request(app).get("/endpoints/999/anomalies")).status).toBe(404);
  });
});
