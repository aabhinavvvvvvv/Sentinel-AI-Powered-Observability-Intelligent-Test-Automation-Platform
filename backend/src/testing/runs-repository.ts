/** SQL for test runs and their per-case results. */
import type { Database } from "../db.js";
import type { AssertionFailure } from "./assertions.js";

export type RunStatus = "queued" | "running" | "passed" | "failed" | "error";
export type RunOrder = "default" | "priority";

export interface TestRun {
  id: number;
  suite_id: number;
  triggered_by: "manual" | "scheduled";
  run_order: RunOrder;
  status: RunStatus;
  total: number;
  passed: number;
  failed: number;
  error_message: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

export interface CaseResult {
  passed: boolean;
  status_code: number | null;
  response_time_ms: number;
  error_type: string | null;
  error_message: string | null;
  failures: AssertionFailure[];
}

export async function createRun(
  db: Database,
  suiteId: number,
  triggeredBy: TestRun["triggered_by"],
  order: RunOrder = "default",
): Promise<TestRun> {
  const rows = await db.query<TestRun>(
    "INSERT INTO test_runs (suite_id, triggered_by, status, run_order) VALUES ($1, $2, 'queued', $3) RETURNING *",
    [suiteId, triggeredBy, order],
  );
  return rows[0]!;
}

/**
 * Claim a queued run: queued → running, in ONE statement. If two workers try at the
 * same moment, only one UPDATE matches "status = 'queued'"; the other gets null.
 * A run that already ran (or was deleted) also gives null, so a duplicate job does nothing.
 */
export async function startRun(db: Database, runId: number): Promise<TestRun | null> {
  const rows = await db.query<TestRun>(
    "UPDATE test_runs SET status = 'running', started_at = now() WHERE id = $1 AND status = 'queued' RETURNING *",
    [runId],
  );
  return rows[0] ?? null;
}

export async function finishRun(
  db: Database,
  runId: number,
  r: Pick<TestRun, "status" | "total" | "passed" | "failed" | "error_message">,
): Promise<TestRun> {
  const rows = await db.query<TestRun>(
    `UPDATE test_runs
     SET status = $2, total = $3, passed = $4, failed = $5, error_message = $6, finished_at = now()
     WHERE id = $1 RETURNING *`,
    [runId, r.status, r.total, r.passed, r.failed, r.error_message],
  );
  return rows[0]!;
}

export async function saveCaseResult(
  db: Database,
  runId: number,
  testCase: { id: number; name: string },
  r: CaseResult,
): Promise<void> {
  await db.query(
    `INSERT INTO test_case_results
       (run_id, case_id, case_name, passed, status_code, response_time_ms, error_type, error_message, failures)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      runId,
      testCase.id,
      testCase.name,
      r.passed,
      r.status_code,
      r.response_time_ms,
      r.error_type,
      r.error_message,
      JSON.stringify(r.failures), // JSONB: stringify, or pg would send the array as a Postgres array
    ],
  );
}

export async function listRuns(db: Database, suiteId: number, limit: number): Promise<TestRun[]> {
  return db.query<TestRun>("SELECT * FROM test_runs WHERE suite_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2", [
    suiteId,
    limit,
  ]);
}

export async function getRun(db: Database, suiteId: number, runId: number): Promise<TestRun | null> {
  const rows = await db.query<TestRun>("SELECT * FROM test_runs WHERE suite_id = $1 AND id = $2", [suiteId, runId]);
  return rows[0] ?? null;
}

export async function listCaseResults(db: Database, runId: number) {
  return db.query<CaseResult & { id: number; case_id: number | null; case_name: string }>(
    "SELECT * FROM test_case_results WHERE run_id = $1 ORDER BY id",
    [runId],
  );
}
