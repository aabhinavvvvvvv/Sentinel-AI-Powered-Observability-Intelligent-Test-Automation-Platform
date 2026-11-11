/**
 * Replay: would the suggested order have found failures sooner in past runs?
 *
 * For each past run we rebuild two orders for the cases it ran:
 *   normal    = by case id (what "Run now" does)
 *   suggested = by priority score, computed ONLY from the runs before it (no peeking ahead)
 * and measure how early that run's failures come in each order.
 *
 * Limitation: old edits aren't recorded, so "edited since its last run" can't be replayed.
 */
import type { Database } from "../db.js";
import { HISTORY_RUNS, scoreCase } from "./priority.js";

/** One past run: which cases ran and whether each passed. Runs are listed oldest first. */
export interface PastRun {
  run_id: number;
  results: { case_id: number; passed: boolean }[];
}

/**
 * APFD (Average Percentage of Faults Detected): how early the failures come in `order`.
 * With n tests and m failures at positions p1..pm (1 = first):
 *   APFD = 1 - (p1 + ... + pm) / (n × m) + 1 / (2n)
 * Closer to 1 = failures found earlier. null when nothing failed (nothing to find).
 */
export function apfd(order: number[], failed: Set<number>): number | null {
  if (failed.size === 0) return null;
  const n = order.length;
  const positions = order.flatMap((id, i) => (failed.has(id) ? [i + 1] : []));
  return 1 - positions.reduce((a, b) => a + b, 0) / (n * failed.size) + 1 / (2 * n);
}

/** The suggested order for `caseIds` (sorted by id), using only `earlier` runs. Same rule as priority.ts. */
export function suggestedOrder(earlier: PastRun[], caseIds: number[]): number[] {
  const scoreOf = (id: number) => {
    const recent: boolean[] = []; // newest first, at most HISTORY_RUNS
    for (let k = earlier.length - 1; k >= 0 && recent.length < HISTORY_RUNS; k--) {
      const result = earlier[k]!.results.find((r) => r.case_id === id);
      if (result) recent.push(result.passed);
    }
    return scoreCase({ recent, edited: false }).score;
  };
  const scores = new Map(caseIds.map((id) => [id, scoreOf(id)] as const));
  return [...caseIds].sort((a, b) => scores.get(b)! - scores.get(a)!); // stable: ties keep id order
}

export interface OrderStats {
  apfd: number; // mean over runs that had a failure
  first_failure: number; // mean position of the first failing test (1 = the very first test)
}

export interface ReplayResult {
  runs: number;
  runs_with_failures: number; // only these can be scored
  normal: OrderStats | null;
  suggested: OrderStats | null;
  per_run: { run_id: number; normal: number[]; suggested: number[]; failed: number[] }[];
}

export function replay(runs: PastRun[]): ReplayResult {
  const perRun = runs.map((run, k) => {
    const ids = run.results.map((r) => r.case_id).sort((a, b) => a - b);
    return {
      run_id: run.run_id,
      normal: ids,
      suggested: suggestedOrder(runs.slice(0, k), ids), // only runs BEFORE this one
      failed: run.results.filter((r) => !r.passed).map((r) => r.case_id),
    };
  });

  const scored = perRun.filter((r) => r.failed.length > 0);
  const stats = (pick: (r: (typeof perRun)[number]) => number[]): OrderStats | null => {
    if (scored.length === 0) return null;
    return {
      apfd: mean(scored.map((r) => apfd(pick(r), new Set(r.failed))!)),
      first_failure: mean(scored.map((r) => pick(r).findIndex((id) => r.failed.includes(id)) + 1)),
    };
  };

  return {
    runs: runs.length,
    runs_with_failures: scored.length,
    normal: stats((r) => r.normal),
    suggested: stats((r) => r.suggested),
    per_run: perRun,
  };
}

/** A suite's finished runs from the database, oldest first. Results of deleted cases are left out. */
export async function loadHistory(db: Database, suiteId: number): Promise<PastRun[]> {
  const rows = await db.query<{ run_id: number; case_id: number; passed: boolean }>(
    `SELECT r.run_id, r.case_id, r.passed
     FROM test_case_results r JOIN test_runs t ON t.id = r.run_id
     WHERE t.suite_id = $1 AND t.status IN ('passed', 'failed') AND r.case_id IS NOT NULL
     ORDER BY t.created_at, t.id, r.id`,
    [suiteId],
  );
  const runs: PastRun[] = [];
  for (const row of rows) {
    if (runs.at(-1)?.run_id !== row.run_id) runs.push({ run_id: row.run_id, results: [] });
    runs.at(-1)!.results.push({ case_id: row.case_id, passed: row.passed });
  }
  return runs;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
