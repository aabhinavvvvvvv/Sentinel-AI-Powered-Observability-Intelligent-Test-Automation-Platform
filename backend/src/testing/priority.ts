/**
 * Test prioritisation: which test cases should run FIRST, and why.
 *
 * Each case earns points for simple, named reasons (an "explainable score").
 * Points are NOT probabilities: 70 does not mean "70% likely to fail".
 * This only suggests an ORDER. Every case still runs.
 */
import type { Database } from "../db.js";

export const HISTORY_RUNS = 10; // look at each case's last 10 results
export const POINTS = { new_or_edited: 30, failed_last_run: 40, recent_failures_max: 30 };
const ALWAYS_FAILS_MIN_RUNS = 5;

/** What we know about one case from its history. */
export interface CaseSignals {
  recent: boolean[]; // its latest results, newest first (true = passed); empty = never run
  edited: boolean; // changed after its last result
}

export interface Score {
  score: number;
  reasons: string[]; // one line per reason, with its points
  warning: string | null;
}

/** The scoring rule. A plain function (no database), so it is easy to test and to replay on old history. */
export function scoreCase({ recent, edited }: CaseSignals): Score {
  let score = 0;
  const reasons: string[] = [];
  const add = (points: number, reason: string) => {
    score += points;
    reasons.push(`${reason} (+${points})`);
  };

  // New or edited: we have no evidence this version works.
  if (recent.length === 0) add(POINTS.new_or_edited, "Never run yet");
  else if (edited) add(POINTS.new_or_edited, "Edited since its last run");

  // Recent failures: a test that failed lately is likely to fail again.
  if (recent[0] === false) add(POINTS.failed_last_run, "Failed in the last run");
  const fails = recent.filter((passed) => !passed).length;
  if (fails > 0) {
    add(Math.round((POINTS.recent_failures_max * fails) / recent.length), `Failed ${fails} of its last ${recent.length} runs`);
  }

  // A test that ALWAYS fails is more likely a broken test than a broken API. Say so, don't hide it.
  const warning =
    recent.length >= ALWAYS_FAILS_MIN_RUNS && fails === recent.length
      ? `Failed all of its last ${recent.length} runs: the test itself may be wrong, not the API.`
      : null;

  return { score, reasons, warning };
}

export interface RankedCase extends Score {
  case_id: number;
  name: string;
  position: number; // its place in the normal run order (1 = first)
}

export interface SuitePriority {
  suite_id: number;
  // Same for every case in the suite (a suite tests one endpoint), so it can't change the
  // order. Shown as a note instead: "the endpoint is in trouble, a good time to run this".
  endpoint: { open_incident: boolean; failed_checks_last_hour: number };
  cases: RankedCase[]; // highest score first; ties keep the normal order
}

/** Rank a suite's cases using only history from before `at` (default: now). null = no such suite. */
export async function rankCases(db: Database, suiteId: number, at = new Date()): Promise<SuitePriority | null> {
  const [suite] = await db.query<{ endpoint_id: number }>("SELECT endpoint_id FROM test_suites WHERE id = $1", [suiteId]);
  if (!suite) return null;

  // Same order as a normal run (repository.listCases).
  const cases = await db.query<{ id: number; name: string; updated_at: Date }>(
    "SELECT id, name, updated_at FROM test_cases WHERE suite_id = $1 ORDER BY id",
    [suiteId],
  );

  // Each case's last HISTORY_RUNS results before `at`, newest first.
  // row_number() numbers each case's results 1, 2, 3... from the newest.
  const results = await db.query<{ case_id: number; passed: boolean; created_at: Date }>(
    `SELECT case_id, passed, created_at FROM (
       SELECT r.case_id, r.passed, r.created_at,
              row_number() OVER (PARTITION BY r.case_id ORDER BY r.created_at DESC, r.id DESC) AS n
       FROM test_case_results r JOIN test_cases c ON c.id = r.case_id
       WHERE c.suite_id = $1 AND r.created_at < $2
     ) latest
     WHERE n <= $3
     ORDER BY case_id, n`,
    [suiteId, at, HISTORY_RUNS],
  );

  const [endpoint] = await db.query<SuitePriority["endpoint"]>(
    `SELECT
       exists(SELECT 1 FROM incidents
              WHERE endpoint_id = $1 AND started_at <= $2 AND (resolved_at IS NULL OR resolved_at > $2)) AS open_incident,
       (SELECT count(*)::int FROM check_results
        WHERE endpoint_id = $1 AND NOT ok AND checked_at > $2::timestamptz - interval '1 hour' AND checked_at <= $2)
         AS failed_checks_last_hour`,
    [suite.endpoint_id, at],
  );

  const ranked = cases.map((c, i) => {
    const mine = results.filter((r) => r.case_id === c.id);
    const lastRun = mine[0]?.created_at;
    const score = scoreCase({ recent: mine.map((r) => r.passed), edited: lastRun !== undefined && c.updated_at > lastRun });
    return { case_id: c.id, name: c.name, position: i + 1, ...score };
  });
  ranked.sort((a, b) => b.score - a.score); // sort is stable: ties keep the normal order

  return { suite_id: suiteId, endpoint: endpoint!, cases: ranked };
}
