/**
 * Runs whole suites against a tiny fake API on this computer, with the real
 * database, and checks the saved run + per-case results.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "../src/db.js";
import { createEndpoint } from "../src/endpoints/repository.js";
import { CreateEndpointSchema } from "../src/endpoints/schemas.js";
import { createCase, createSuite } from "../src/testing/repository.js";
import { createScheduledRun, runSuite, runTestCase } from "../src/testing/run-suite.js";
import { createRun, listCaseResults } from "../src/testing/runs-repository.js";
import { TestCaseSchema } from "../src/testing/schemas.js";
import { resetDb, silentLogger } from "./helpers.js";

const db = createDatabase(process.env.TEST_DATABASE_URL!, silentLogger);
const local = { allowPrivateAddresses: true }; // the fake API is on localhost

let server: Server;
let baseUrl: string;
let lastRequest: { method: string | undefined; headers: Record<string, unknown>; body: string } | undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      lastRequest = { method: req.method, headers: req.headers, body };
      if (req.url === "/users/1") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ user: { id: 1, name: "Ada" } }));
      }
      if (req.url === "/login") return res.writeHead(body.includes("wrong") ? 401 : 200).end();
      if (req.url === "/echo") return res.writeHead(201, { "content-type": "application/json" }).end(body);
      if (req.url === "/huge") return res.writeHead(200).end("x".repeat(2_000_000)); // 2 MB
      res.writeHead(404).end("not found");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(() => resetDb(db));
afterAll(async () => {
  server.closeAllConnections();
  server.close();
  await db.close();
});

const testCase = (extra: object) =>
  TestCaseSchema.parse({ name: "case", url: `${baseUrl}/users/1`, assertions: [{ type: "status_equals", value: 200 }], ...extra });

async function suiteWith(cases: object[]) {
  const endpoint = await createEndpoint(db, CreateEndpointSchema.parse({ name: "API", url: baseUrl }));
  const suite = await createSuite(db, endpoint.id, { name: "Suite", schedule_minutes: null });
  for (const c of cases) await createCase(db, suite.id, testCase(c));
  return createRun(db, suite.id, "manual");
}

describe("runSuite", () => {
  it("runs every case, saves results with reasons, and marks the run failed if any case failed", async () => {
    const run = await suiteWith([
      { name: "get user", assertions: [{ type: "json_path_equals", path: "user.name", value: "Ada" }] },
      { name: "wrong status", assertions: [{ type: "status_equals", value: 201 }] },
      { name: "missing page", url: `${baseUrl}/nope`, assertions: [{ type: "json_path_exists", path: "id" }] },
    ]);

    const finished = await runSuite(db, run.id, local);
    expect(finished).toMatchObject({ status: "failed", total: 3, passed: 1, failed: 2 });
    expect(finished?.finished_at).not.toBeNull();

    const results = await listCaseResults(db, run.id);
    expect(results.map((r) => [r.case_name, r.passed])).toEqual([
      ["get user", true],
      ["wrong status", false],
      ["missing page", false],
    ]);
    expect(results[1]!.failures[0]!.message).toBe("expected status 201, got 200");
    expect(results[2]!.failures[0]!.message).toBe("response body is not valid JSON");
  });

  it("marks the run passed when every case passes", async () => {
    const run = await suiteWith([{}, { name: "second" }]);
    expect(await runSuite(db, run.id, local)).toMatchObject({ status: "passed", total: 2, passed: 2, failed: 0 });
  });

  it("does nothing for a run that already ran (duplicate job)", async () => {
    const run = await suiteWith([{}]);
    await runSuite(db, run.id, local);
    expect(await runSuite(db, run.id, local)).toBeNull();
    expect(await listCaseResults(db, run.id)).toHaveLength(1); // not run twice
  });

  it("marks a run 'error' if the suite has no cases any more", async () => {
    const run = await suiteWith([]);
    expect(await runSuite(db, run.id, local)).toMatchObject({ status: "error", error_message: "suite has no test cases" });
  });

  it("a 'priority' run runs the riskiest case first, and still runs every case", async () => {
    const first = await suiteWith([{ name: "passes" }, { name: "fails", assertions: [{ type: "status_equals", value: 201 }] }]);
    await runSuite(db, first.id, local); // normal order
    expect((await listCaseResults(db, first.id)).map((r) => r.case_name)).toEqual(["passes", "fails"]);

    // "fails" failed last time, so it now goes first.
    const second = await createRun(db, first.suite_id, "manual", "priority");
    expect(await runSuite(db, second.id, local)).toMatchObject({ run_order: "priority", total: 2, passed: 1 });
    expect((await listCaseResults(db, second.id)).map((r) => r.case_name)).toEqual(["fails", "passes"]);
  });

  it("returns null for a run that doesn't exist", async () => {
    expect(await runSuite(db, 999, local)).toBeNull();
  });
});

describe("createScheduledRun (a suite's timer fired)", () => {
  it("creates a 'scheduled' run that runSuite can then run", async () => {
    const queued = await suiteWith([{}]); // also creates a manual run #1 we don't use
    const runId = await createScheduledRun(db, queued.suite_id);
    expect(runId).toBe(queued.id + 1);
    expect(await runSuite(db, runId!, local)).toMatchObject({ triggered_by: "scheduled", status: "passed" });
  });

  it("skips a suite with no cases, and a suite that no longer exists", async () => {
    const empty = await suiteWith([]);
    expect(await createScheduledRun(db, empty.suite_id)).toBeNull();
    expect(await createScheduledRun(db, 999)).toBeNull();
  });
});

describe("runTestCase", () => {
  it("sends the method, headers and body", async () => {
    const result = await runTestCase(
      testCase({
        method: "POST",
        url: `${baseUrl}/echo`,
        headers: { "Content-Type": "application/json", "X-Test": "yes" },
        body: '{"name":"Grace"}',
        assertions: [
          { type: "status_equals", value: 201 },
          { type: "json_path_equals", path: "name", value: "Grace" },
        ],
      }),
      local,
    );
    expect(result).toMatchObject({ passed: true, status_code: 201, failures: [] });
    expect(lastRequest).toMatchObject({ method: "POST", body: '{"name":"Grace"}' });
    expect(lastRequest?.headers["x-test"]).toBe("yes");
  });

  it("tests a negative path (wrong password → 401)", async () => {
    const result = await runTestCase(
      testCase({ method: "POST", url: `${baseUrl}/login`, body: "password=wrong", assertions: [{ type: "status_equals", value: 401 }] }),
      local,
    );
    expect(result.passed).toBe(true);
  });

  it("reads at most 1 MB of a huge response", async () => {
    const result = await runTestCase(
      testCase({ url: `${baseUrl}/huge`, assertions: [{ type: "json_path_exists", path: "a" }] }),
      local,
    );
    expect(result.failures[0]!.message).toMatch(/over 1 MB/);
  });

  it("records a request that never got an answer as failed, with the network reason", async () => {
    const result = await runTestCase(testCase({ url: "http://no-such-host.invalid/" }), local);
    expect(result).toMatchObject({ passed: false, status_code: null, error_type: "dns", failures: [] });
    expect(result.error_message).toMatch(/^request failed:/);
  });

  it("applies the SSRF guard to test requests too", async () => {
    const result = await runTestCase(testCase({ url: `${baseUrl}/users/1` })); // default: private blocked
    expect(result).toMatchObject({ passed: false, error_type: "blocked" });
  });
});
