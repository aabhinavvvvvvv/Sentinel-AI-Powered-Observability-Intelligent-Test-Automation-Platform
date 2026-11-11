/** What the worker does for each test-run job: run every case in the suite and save the results. */
import { sendRequest } from "../checks/http-client.js";
import type { Database } from "../db.js";
import { evaluateAssertions } from "./assertions.js";
import { getSuite, listCases } from "./repository.js";
import { createRun, finishRun, saveCaseResult, startRun, type CaseResult, type TestRun } from "./runs-repository.js";
import type { NewTestCase } from "./schemas.js";

type Options = { allowPrivateAddresses?: boolean }; // tests only

/** Returns the finished run, or null if this run was already taken/finished/deleted (duplicate job). */
export async function runSuite(db: Database, runId: number, options: Options = {}): Promise<TestRun | null> {
  const run = await startRun(db, runId); // queued → running (only one worker can win this)
  if (!run) return null;

  try {
    const cases = await listCases(db, run.suite_id);
    if (cases.length === 0) {
      return await finishRun(db, runId, { status: "error", total: 0, passed: 0, failed: 0, error_message: "suite has no test cases" });
    }

    let passed = 0;
    // One case at a time: gentle on the API being tested, and results stay in order.
    for (const testCase of cases) {
      const result = await runTestCase(testCase, options);
      await saveCaseResult(db, runId, testCase, result);
      if (result.passed) passed++;
    }
    return await finishRun(db, runId, {
      status: passed === cases.length ? "passed" : "failed",
      total: cases.length,
      passed,
      failed: cases.length - passed,
      error_message: null,
    });
  } catch (err) {
    // Our own code or the database broke mid-run: record it, so the run doesn't stay "running" forever.
    await finishRun(db, runId, { status: "error", total: 0, passed: 0, failed: 0, error_message: String(err) });
    throw err;
  }
}

/**
 * A suite's timer fired: create a "scheduled" run and return its id.
 * Returns null (skip) if the suite was deleted meanwhile or has no test cases.
 */
export async function createScheduledRun(db: Database, suiteId: number): Promise<number | null> {
  if (!(await getSuite(db, suiteId))) return null;
  if ((await listCases(db, suiteId)).length === 0) return null;
  return (await createRun(db, suiteId, "scheduled")).id;
}

/** Send one test case's request and check its assertions. Never throws. */
export async function runTestCase(c: NewTestCase, options: Options = {}): Promise<CaseResult> {
  const res = await sendRequest(
    { url: c.url, method: c.method, headers: c.headers, body: c.body, timeout_ms: c.timeout_ms, readBody: c.method !== "HEAD" },
    options,
  );
  if (!res.ok) {
    // No response at all, so assertions can't be checked.
    return {
      passed: false,
      status_code: null,
      response_time_ms: res.response_time_ms,
      error_type: res.error_type,
      error_message: `request failed: ${res.error_message}`,
      failures: [],
    };
  }
  const failures = evaluateAssertions(c.assertions, res);
  return {
    passed: failures.length === 0,
    status_code: res.status,
    response_time_ms: res.response_time_ms,
    error_type: null,
    error_message: null,
    failures,
  };
}
