/** SQL for test suites and test cases. */
import type { Database } from "../db.js";
import type { NewTestCase, SuiteSettings, TestCase, TestSuite } from "./schemas.js";

// ----- suites -----

export async function createSuite(
  db: Database,
  endpointId: number,
  { name, schedule_minutes }: SuiteSettings,
): Promise<TestSuite> {
  const rows = await db.query<TestSuite>(
    "INSERT INTO test_suites (endpoint_id, name, schedule_minutes) VALUES ($1, $2, $3) RETURNING *",
    [endpointId, name, schedule_minutes],
  );
  return rows[0]!;
}

/** All suites (optionally for one endpoint), each with its case count and newest run (or null). */
export async function listSuites(db: Database, endpointId?: number) {
  return db.query<
    TestSuite & {
      case_count: number;
      endpoint_name: string;
      last_run: { id: number; status: string; passed: number; failed: number; created_at: string } | null;
    }
  >(
    `SELECT s.*, e.name AS endpoint_name,
            (SELECT count(*)::int FROM test_cases c WHERE c.suite_id = s.id) AS case_count,
            (SELECT row_to_json(r) FROM (
               SELECT id, status, passed, failed, created_at FROM test_runs
               WHERE suite_id = s.id ORDER BY created_at DESC, id DESC LIMIT 1) r) AS last_run
     FROM test_suites s JOIN endpoints e ON e.id = s.endpoint_id
     WHERE $1::int IS NULL OR s.endpoint_id = $1
     ORDER BY s.id`,
    [endpointId ?? null],
  );
}

export async function getSuite(db: Database, id: number): Promise<TestSuite | null> {
  const rows = await db.query<TestSuite>("SELECT * FROM test_suites WHERE id = $1", [id]);
  return rows[0] ?? null;
}

export async function updateSuite(db: Database, id: number, { name, schedule_minutes }: SuiteSettings): Promise<TestSuite> {
  const rows = await db.query<TestSuite>(
    "UPDATE test_suites SET name = $2, schedule_minutes = $3, updated_at = now() WHERE id = $1 RETURNING *",
    [id, name, schedule_minutes],
  );
  return rows[0]!;
}

export async function deleteSuite(db: Database, id: number): Promise<boolean> {
  return (await db.query("DELETE FROM test_suites WHERE id = $1 RETURNING id", [id])).length > 0;
}

// ----- cases -----

// IMPORTANT: JSONB values are passed through JSON.stringify. The pg driver would turn a
// JavaScript ARRAY (our assertions) into a Postgres array, not JSON, and the insert would fail.
const caseValues = (c: NewTestCase) => [
  c.name,
  c.method,
  c.url,
  JSON.stringify(c.headers),
  c.body,
  c.timeout_ms,
  JSON.stringify(c.assertions),
];

export async function listCases(db: Database, suiteId: number): Promise<TestCase[]> {
  return db.query<TestCase>("SELECT * FROM test_cases WHERE suite_id = $1 ORDER BY id", [suiteId]);
}

export async function getCase(db: Database, suiteId: number, caseId: number): Promise<TestCase | null> {
  const rows = await db.query<TestCase>("SELECT * FROM test_cases WHERE suite_id = $1 AND id = $2", [
    suiteId,
    caseId,
  ]);
  return rows[0] ?? null;
}

export async function createCase(db: Database, suiteId: number, c: NewTestCase): Promise<TestCase> {
  const rows = await db.query<TestCase>(
    `INSERT INTO test_cases (suite_id, name, method, url, headers, body, timeout_ms, assertions)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [suiteId, ...caseValues(c)],
  );
  return rows[0]!;
}

/** Replace all of a case's fields (the route merges the changes and validates the full case first). */
export async function updateCase(db: Database, caseId: number, c: NewTestCase): Promise<TestCase> {
  const rows = await db.query<TestCase>(
    `UPDATE test_cases
     SET name = $2, method = $3, url = $4, headers = $5, body = $6, timeout_ms = $7, assertions = $8,
         updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [caseId, ...caseValues(c)],
  );
  return rows[0]!;
}

export async function deleteCase(db: Database, suiteId: number, caseId: number): Promise<boolean> {
  const rows = await db.query("DELETE FROM test_cases WHERE suite_id = $1 AND id = $2 RETURNING id", [
    suiteId,
    caseId,
  ]);
  return rows.length > 0;
}
