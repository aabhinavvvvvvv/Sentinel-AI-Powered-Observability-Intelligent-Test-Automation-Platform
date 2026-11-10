/** SQL for the `incidents` table. */
import type { Database } from "../db.js";

export interface Incident {
  id: number;
  endpoint_id: number;
  started_at: Date;
  resolved_at: Date | null; // null = still open
  error_type: string;
  error_message: string | null;
}

export async function getOpenIncident(db: Database, endpointId: number): Promise<Incident | null> {
  const rows = await db.query<Incident>(
    "SELECT * FROM incidents WHERE endpoint_id = $1 AND resolved_at IS NULL",
    [endpointId],
  );
  return rows[0] ?? null;
}

/**
 * Open an incident. Returns null if one is already open for this endpoint:
 * the unique index refuses a second one, and ON CONFLICT DO NOTHING turns
 * that refusal into "insert nothing" instead of an error.
 */
export async function openIncident(
  db: Database,
  i: Pick<Incident, "endpoint_id" | "started_at" | "error_type" | "error_message">,
): Promise<Incident | null> {
  const rows = await db.query<Incident>(
    `INSERT INTO incidents (endpoint_id, started_at, error_type, error_message)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint_id) WHERE resolved_at IS NULL DO NOTHING
     RETURNING *`,
    [i.endpoint_id, i.started_at, i.error_type, i.error_message],
  );
  return rows[0] ?? null;
}

export async function resolveIncident(db: Database, id: number, resolvedAt: Date): Promise<Incident> {
  const rows = await db.query<Incident>(
    "UPDATE incidents SET resolved_at = $2 WHERE id = $1 RETURNING *",
    [id, resolvedAt],
  );
  return rows[0]!;
}

export interface IncidentFilter {
  status?: "open" | "resolved" | undefined;
  endpoint_id?: number | undefined;
  limit: number;
}

/** Newest first, with the endpoint's name included for convenience. */
export async function listIncidents(
  db: Database,
  filter: IncidentFilter,
): Promise<(Incident & { endpoint_name: string })[]> {
  // Build the WHERE part from whichever filters were given.
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter.status === "open") conditions.push("i.resolved_at IS NULL");
  if (filter.status === "resolved") conditions.push("i.resolved_at IS NOT NULL");
  if (filter.endpoint_id !== undefined) {
    params.push(filter.endpoint_id);
    conditions.push(`i.endpoint_id = $${params.length}`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(filter.limit);

  return db.query(
    `SELECT i.*, e.name AS endpoint_name
     FROM incidents i JOIN endpoints e ON e.id = i.endpoint_id
     ${where}
     ORDER BY i.started_at DESC, i.id DESC
     LIMIT $${params.length}`,
    params,
  );
}
