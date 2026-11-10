/**
 * What the worker does for each timer job: check one endpoint, save the result,
 * and open/close an incident if needed.
 */
import { setTimeout as sleep } from "node:timers/promises";
import type { Database } from "../db.js";
import { getEndpoint } from "../endpoints/repository.js";
import { updateIncidents, type IncidentChange } from "../incidents/update-incidents.js";
import { checkEndpoint } from "./check-endpoint.js";
import { saveCheckResult, type SavedCheckResult } from "./repository.js";

export interface RunOptions {
  retryDelayMs?: number; // wait between retries (tests use 0)
  allowPrivateAddresses?: boolean; // tests only
}

/** Returns what happened, or null if the endpoint was deleted or paused meanwhile. */
export async function runScheduledCheck(
  db: Database,
  endpointId: number,
  { retryDelayMs = 1000, allowPrivateAddresses = false }: RunOptions = {},
): Promise<{ check: SavedCheckResult; incident: IncidentChange } | null> {
  // Always read the latest settings from the database, never from the job:
  // the user may have changed the URL or timeout since the timer was created.
  const endpoint = await getEndpoint(db, endpointId);
  if (!endpoint || endpoint.paused) return null;

  // Retries: if a check fails, try again up to max_retries times before
  // recording a failure. One bad moment shouldn't count as "down".
  let result = await checkEndpoint(endpoint, { allowPrivateAddresses });
  for (let retry = 1; retry <= endpoint.max_retries && !result.ok; retry++) {
    await sleep(retryDelayMs);
    result = await checkEndpoint(endpoint, { allowPrivateAddresses });
  }
  const check = await saveCheckResult(db, endpoint.id, result);
  const incident = await updateIncidents(db, endpoint, check);
  return { check, incident };
}
