/**
 * Tests the incident rule by feeding it made-up check results
 * ("failed at minute 1, failed at minute 2, ...") and the GET /incidents API.
 */
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { saveCheckResult } from "../src/checks/repository.js";
import { createDatabase } from "../src/db.js";
import { createEndpoint } from "../src/endpoints/repository.js";
import { CreateEndpointSchema, type Endpoint } from "../src/endpoints/schemas.js";
import { updateIncidents } from "../src/incidents/update-incidents.js";
import { resetDb, silentLogger } from "./helpers.js";

const db = createDatabase(process.env.TEST_DATABASE_URL!, silentLogger);
const scheduler = { schedule: async () => {}, unschedule: async () => {} };
const testRuns = { enqueue: async () => {}, schedule: async () => {}, unschedule: async () => {} };
const app = createApp({ db, scheduler, testRuns, logger: silentLogger, healthcheckDbTimeoutMs: 1000 });

beforeEach(() => resetDb(db));
afterAll(() => db.close());

const minute = (n: number) => new Date(Date.UTC(2026, 0, 1, 10, n)); // 10:00 + n minutes

const addEndpoint = (extra = {}) =>
  createEndpoint(db, CreateEndpointSchema.parse({ name: "API", url: "https://example.com", ...extra }));

/** Save one check result at the given minute and run the incident rule on it. */
async function record(endpoint: Endpoint, ok: boolean, at: number) {
  const check = await saveCheckResult(db, endpoint.id, {
    ok,
    status_code: ok ? 200 : null,
    response_time_ms: 100,
    error_type: ok ? null : "timeout",
    error_message: ok ? null : `timed out at minute ${at}`,
    checked_at: minute(at),
  });
  return updateIncidents(db, endpoint, check);
}

const allIncidents = () => db.query<{ resolved_at: Date | null }>("SELECT * FROM incidents ORDER BY id");

describe("incident rule (failure_threshold = 3)", () => {
  it("does not open an incident for fewer than 3 failures in a row", async () => {
    const e = await addEndpoint();
    expect(await record(e, false, 1)).toBeNull();
    expect(await record(e, false, 2)).toBeNull();
    expect(await allIncidents()).toHaveLength(0);
  });

  it("opens an incident on the 3rd failure, starting at the FIRST failure", async () => {
    const e = await addEndpoint();
    await record(e, false, 1);
    await record(e, false, 2);
    const change = await record(e, false, 3);

    expect(change?.type).toBe("opened");
    expect(change?.incident).toMatchObject({
      started_at: minute(1), // when the trouble began, not when we noticed
      resolved_at: null,
      error_type: "timeout",
      error_message: "timed out at minute 1",
    });
  });

  it("keeps a single incident open while failures continue", async () => {
    const e = await addEndpoint();
    for (let m = 1; m <= 6; m++) await record(e, false, m);
    expect(await allIncidents()).toHaveLength(1);
  });

  it("resolves the incident at the first successful check", async () => {
    const e = await addEndpoint();
    for (let m = 1; m <= 3; m++) await record(e, false, m);
    const change = await record(e, true, 4);

    expect(change?.type).toBe("resolved");
    expect(change?.incident.resolved_at).toEqual(minute(4));
  });

  it("a success in between resets the streak", async () => {
    const e = await addEndpoint();
    await record(e, false, 1);
    await record(e, false, 2);
    await record(e, true, 3); // recovered
    await record(e, false, 4);
    await record(e, false, 5);
    expect(await allIncidents()).toHaveLength(0);
  });

  it("can open a new incident after the previous one was resolved", async () => {
    const e = await addEndpoint();
    for (let m = 1; m <= 3; m++) await record(e, false, m);
    await record(e, true, 4);
    for (let m = 5; m <= 7; m++) await record(e, false, m);
    const incidents = await allIncidents();
    expect(incidents).toHaveLength(2);
    expect(incidents[0]!.resolved_at).not.toBeNull();
    expect(incidents[1]!.resolved_at).toBeNull();
  });

  it("success with no open incident changes nothing", async () => {
    const e = await addEndpoint();
    expect(await record(e, true, 1)).toBeNull();
  });

  it("respects a custom threshold (1 = open on the first failure)", async () => {
    const e = await addEndpoint({ failure_threshold: 1 });
    expect((await record(e, false, 1))?.type).toBe("opened");
  });

  it("the database refuses a second open incident for the same endpoint", async () => {
    const e = await addEndpoint();
    const insert = () =>
      db.query("INSERT INTO incidents (endpoint_id, started_at, error_type) VALUES ($1, now(), 'x')", [e.id]);
    await insert();
    await expect(insert()).rejects.toThrow(/incidents_one_open_per_endpoint/);
  });
});

describe("GET /incidents", () => {
  async function setup() {
    const a = await addEndpoint({ name: "A", failure_threshold: 1 });
    const b = await addEndpoint({ name: "B", failure_threshold: 1 });
    await record(a, false, 1); // A: incident opened at minute 1...
    await record(a, true, 2); //  ...and resolved at minute 2
    await record(b, false, 3); // B: incident opened at minute 3, still open
  }

  it("lists all incidents newest first, with the endpoint name", async () => {
    await setup();
    const res = await request(app).get("/incidents");
    expect(res.status).toBe(200);
    expect(res.body.map((i: { endpoint_name: string }) => i.endpoint_name)).toEqual(["B", "A"]);
  });

  it("filters by status", async () => {
    await setup();
    const open = await request(app).get("/incidents?status=open");
    const resolved = await request(app).get("/incidents?status=resolved");
    expect(open.body.map((i: { endpoint_name: string }) => i.endpoint_name)).toEqual(["B"]);
    expect(resolved.body.map((i: { endpoint_name: string }) => i.endpoint_name)).toEqual(["A"]);
  });

  it("filters by endpoint", async () => {
    await setup();
    const res = await request(app).get("/incidents?endpoint_id=1");
    expect(res.body).toHaveLength(1);
    expect(res.body[0].endpoint_id).toBe(1);
  });

  it.each(["status=closed", "endpoint_id=abc", "limit=0"])("rejects ?%s with 400", async (query) => {
    expect((await request(app).get(`/incidents?${query}`)).status).toBe(400);
  });
});
