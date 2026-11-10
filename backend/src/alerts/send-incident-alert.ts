/** What the worker does for each alert job: look up the incident, write the email, send it. */
import type { Database } from "../db.js";
import type { AlertJob } from "./alert-queue.js";
import { incidentEmail, type IncidentWithEndpoint } from "./incident-email.js";
import type { Mailer } from "./mailer.js";

/** Returns true if an email was sent, false if the incident no longer exists. Throws if sending fails (→ BullMQ retries). */
export async function sendIncidentAlert(
  db: Database,
  mailer: Mailer,
  recipients: string[],
  job: AlertJob,
): Promise<boolean> {
  const rows = await db.query<IncidentWithEndpoint>(
    `SELECT i.*, e.name AS endpoint_name, e.url AS endpoint_url
     FROM incidents i JOIN endpoints e ON e.id = i.endpoint_id
     WHERE i.id = $1`,
    [job.incidentId],
  );
  const incident = rows[0];
  if (!incident) return false; // the endpoint (and its incidents) were deleted meanwhile

  await mailer.send({ to: recipients, ...incidentEmail(job.kind, incident) });
  return true;
}
