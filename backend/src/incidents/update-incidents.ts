/**
 * The incident rule, run after every saved check:
 *
 *   check OK     + incident open      → close it ("resolved")
 *   check failed + no incident open   → if the last N checks ALL failed, open one ("opened")
 *   anything else                     → nothing changes
 *
 * N is the endpoint's failure_threshold.
 */
import type { SavedCheckResult } from "../checks/repository.js";
import type { Database } from "../db.js";
import type { Endpoint } from "../endpoints/schemas.js";
import { getOpenIncident, openIncident, resolveIncident, type Incident } from "./repository.js";

/** What changed, so the caller can log it (and, later, send an email). */
export type IncidentChange = { type: "opened" | "resolved"; incident: Incident } | null;

export async function updateIncidents(
  db: Database,
  endpoint: Pick<Endpoint, "id" | "failure_threshold">,
  check: SavedCheckResult,
): Promise<IncidentChange> {
  const open = await getOpenIncident(db, endpoint.id);

  if (check.ok) {
    if (!open) return null; // healthy and nothing to close
    return { type: "resolved", incident: await resolveIncident(db, open.id, check.checked_at) };
  }

  if (open) return null; // still down; the incident is already open

  // Look at the newest N checks (this one included). All failed? Then it's an incident.
  const recent = await db.query<SavedCheckResult>(
    "SELECT * FROM check_results WHERE endpoint_id = $1 ORDER BY checked_at DESC, id DESC LIMIT $2",
    [endpoint.id, endpoint.failure_threshold],
  );
  if (recent.length < endpoint.failure_threshold || recent.some((r) => r.ok)) return null;

  // The incident started at the FIRST failure of the streak (the oldest of the N).
  const first = recent[recent.length - 1]!;
  const incident = await openIncident(db, {
    endpoint_id: endpoint.id,
    started_at: first.checked_at,
    error_type: first.error_type ?? "unknown",
    error_message: first.error_message,
  });
  return incident ? { type: "opened", incident } : null;
}
