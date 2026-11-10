/**
 * All SQL for the `endpoints` table lives here, so routes never write SQL.
 *
 * Values are ALWAYS passed as $1, $2... parameters, never glued into the SQL string.
 * The database then treats them strictly as data, which prevents SQL injection.
 */
import type { Database } from "../db.js";
import type { Endpoint, EndpointChanges, NewEndpoint } from "./schemas.js";

export async function createEndpoint(db: Database, e: NewEndpoint): Promise<Endpoint> {
  const rows = await db.query<Endpoint>(
    `INSERT INTO endpoints
       (name, url, method, interval_seconds, timeout_ms, expected_status, max_retries, failure_threshold, paused)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      e.name,
      e.url,
      e.method,
      e.interval_seconds,
      e.timeout_ms,
      e.expected_status,
      e.max_retries,
      e.failure_threshold,
      e.paused,
    ],
  );
  return rows[0]!; // INSERT ... RETURNING always returns exactly one row
}

export async function listEndpoints(db: Database): Promise<Endpoint[]> {
  return db.query<Endpoint>("SELECT * FROM endpoints ORDER BY id");
}

export async function getEndpoint(db: Database, id: number): Promise<Endpoint | null> {
  const rows = await db.query<Endpoint>("SELECT * FROM endpoints WHERE id = $1", [id]);
  return rows[0] ?? null;
}

/** Update only the given fields. Returns null if no endpoint has this id. */
export async function updateEndpoint(
  db: Database,
  id: number,
  changes: EndpointChanges,
): Promise<Endpoint | null> {
  // e.g. { name: "A", paused: true } → "name = $2, paused = $3" with values ["A", true].
  // Putting column NAMES into the SQL is safe only because UpdateEndpointSchema
  // already rejected any key that is not a known column.
  const entries = Object.entries(changes);
  const setClause = entries.map(([column], i) => `${column} = $${i + 2}`).join(", ");
  const rows = await db.query<Endpoint>(
    `UPDATE endpoints SET ${setClause}, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, ...entries.map(([, value]) => value)],
  );
  return rows[0] ?? null;
}

/** Returns true if a row was deleted, false if no endpoint has this id. */
export async function deleteEndpoint(db: Database, id: number): Promise<boolean> {
  const rows = await db.query("DELETE FROM endpoints WHERE id = $1 RETURNING id", [id]);
  return rows.length > 0;
}
