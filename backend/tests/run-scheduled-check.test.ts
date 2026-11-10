/**
 * Tests what the worker does for each job, using the test database and a
 * tiny fake website whose answers we control.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runScheduledCheck } from "../src/checks/run-scheduled-check.js";
import { createDatabase } from "../src/db.js";
import { createEndpoint } from "../src/endpoints/repository.js";
import { CreateEndpointSchema } from "../src/endpoints/schemas.js";
import { resetDb, silentLogger } from "./helpers.js";

const db = createDatabase(process.env.TEST_DATABASE_URL!, silentLogger);
const options = { retryDelayMs: 0, allowPrivateAddresses: true };

let server: Server;
let baseUrl: string;
let hits = 0; // how many times the fake site was visited
let failuresLeft = 0; // the fake site answers 500 this many times, then 200

beforeAll(async () => {
  server = createServer((_req, res) => {
    hits++;
    if (failuresLeft > 0) {
      failuresLeft--;
      return res.writeHead(500).end();
    }
    res.writeHead(200).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
beforeEach(async () => {
  hits = 0;
  failuresLeft = 0;
  await resetDb(db);
});
afterAll(async () => {
  server.closeAllConnections();
  server.close();
  await db.close();
});

const addEndpoint = (extra = {}) =>
  createEndpoint(db, CreateEndpointSchema.parse({ name: "Fake", url: baseUrl, ...extra }));

describe("runScheduledCheck", () => {
  it("checks the endpoint and saves the result", async () => {
    const endpoint = await addEndpoint();
    const outcome = await runScheduledCheck(db, endpoint.id, options);
    expect(outcome?.check).toMatchObject({ endpoint_id: endpoint.id, ok: true, status_code: 200 });
    expect(outcome?.incident).toBeNull();
    expect(await db.query("SELECT * FROM check_results")).toHaveLength(1);
  });

  it("retries a failed check and saves only the final result", async () => {
    const endpoint = await addEndpoint({ max_retries: 2 });
    failuresLeft = 1; // fails once, then works
    const outcome = await runScheduledCheck(db, endpoint.id, options);
    expect(outcome?.check.ok).toBe(true);
    expect(hits).toBe(2);
    expect(await db.query("SELECT * FROM check_results")).toHaveLength(1);
  });

  it("stops after max_retries and saves the failure", async () => {
    const endpoint = await addEndpoint({ max_retries: 2 });
    failuresLeft = 99; // always fails
    const outcome = await runScheduledCheck(db, endpoint.id, options);
    expect(outcome?.check).toMatchObject({ ok: false, error_type: "unexpected_status" });
    expect(hits).toBe(3); // 1 try + 2 retries
  });

  it("opens an incident after failure_threshold failures, and resolves it on recovery", async () => {
    const endpoint = await addEndpoint({ failure_threshold: 2 });
    failuresLeft = 99;
    expect((await runScheduledCheck(db, endpoint.id, options))?.incident).toBeNull(); // 1st failure
    expect((await runScheduledCheck(db, endpoint.id, options))?.incident?.type).toBe("opened"); // 2nd
    failuresLeft = 0;
    expect((await runScheduledCheck(db, endpoint.id, options))?.incident?.type).toBe("resolved");
  });

  it("does nothing for a paused endpoint", async () => {
    const endpoint = await addEndpoint({ paused: true });
    expect(await runScheduledCheck(db, endpoint.id, options)).toBeNull();
    expect(hits).toBe(0);
  });

  it("does nothing for an endpoint that was deleted", async () => {
    expect(await runScheduledCheck(db, 999, options)).toBeNull();
    expect(hits).toBe(0);
  });
});
