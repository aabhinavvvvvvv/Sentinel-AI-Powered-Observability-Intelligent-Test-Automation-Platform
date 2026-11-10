/** SQL for the `check_results` table (the history of every check). */
import type { Database } from "../db.js";
import type { CheckResult } from "./check-endpoint.js";

/** A saved check: the result plus its row id and which endpoint it belongs to. */
export interface SavedCheckResult extends CheckResult {
  id: number;
  endpoint_id: number;
}

export async function saveCheckResult(
  db: Database,
  endpointId: number,
  r: CheckResult,
): Promise<SavedCheckResult> {
  const rows = await db.query<SavedCheckResult>(
    `INSERT INTO check_results
       (endpoint_id, ok, status_code, response_time_ms, error_type, error_message, checked_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [endpointId, r.ok, r.status_code, r.response_time_ms, r.error_type, r.error_message, r.checked_at],
  );
  return rows[0]!;
}

/** The newest `limit` results for one endpoint, newest first. */
export async function listCheckResults(
  db: Database,
  endpointId: number,
  limit: number,
): Promise<SavedCheckResult[]> {
  return db.query<SavedCheckResult>(
    "SELECT * FROM check_results WHERE endpoint_id = $1 ORDER BY checked_at DESC, id DESC LIMIT $2",
    [endpointId, limit],
  );
}
