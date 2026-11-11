/**
 * Incident report: the EVIDENCE for one incident, gathered from data Sentinel already stores.
 *
 * Every number is a measured fact, counted from check_results / incidents / test results.
 * The suggestions are a fixed checklist per failure category: ideas to check, NOT a diagnosis.
 */
import type { Database } from "../db.js";
import type { Incident } from "./repository.js";

// "Flapping" = the same failure keeps coming back in short bursts.
// Rule: at least 3 similar incidents in the previous 7 days, lasting a median of 10 minutes or less.
export const SIMILAR_WINDOW_DAYS = 7;
export const FLAPPING_MIN_INCIDENTS = 3;
export const FLAPPING_MAX_MEDIAN_MINUTES = 10;

const SUGGESTIONS: Record<string, string[]> = {
  timeout: [
    "Check whether the server is overloaded or waiting on something slow (database, another API).",
    "Compare the endpoint's normal P95 response time with its timeout: a tight limit causes false timeouts.",
  ],
  dns: ["Check the domain's DNS records and that the domain registration hasn't expired."],
  tls: ["Check the certificate's expiry date and that it covers this exact host name."],
  connection_refused: ["Check that the service is running and listening on this port."],
  connection_reset: [
    "Check server and proxy logs for crashes or restarts around the start time.",
    "A load balancer, firewall or connection limit may be dropping connections.",
  ],
  redirect: ["The URL now redirects (the message says where). If that's intended, register the final URL instead."],
  client_error: ["The server rejected the request: check the URL path, authentication and request details."],
  server_error: [
    "Check the server's error logs around the start time.",
    "Check for a deploy or configuration change just before the start time.",
  ],
  blocked: ["The address is private/internal. Sentinel refuses it on purpose (SSRF protection)."],
};
const GENERIC = ["Open the URL yourself and compare with what Sentinel saw.", "Check the server's logs around the start time."];
const FLAPPING_SUGGESTION =
  "This keeps coming back in short bursts (flapping): look at the pattern across incidents, not just this one.";

export interface IncidentReport {
  incident: Incident & { endpoint_name: string; url: string };
  window: { from: Date; to: Date; open: boolean; minutes: number }; // open incidents end at "now"
  failed_checks: { total: number; by_type: { error_type: string; count: number }[] };
  // Median of SUCCESSFUL checks before the start: was it already getting slow?
  response_time_ms: { p50_hour_before: number | null; p50_week_before: number | null };
  similar: { days: number; count: number; median_minutes: number | null; flapping: boolean };
  failing_tests: { suite_id: number; run_id: number; case_name: string; message: string | null; at: Date }[];
  suggestions: string[];
}

export async function getIncidentReport(db: Database, id: number): Promise<IncidentReport | null> {
  const [row] = await db.query<Incident & { endpoint_name: string; url: string; until: Date }>(
    `SELECT i.*, e.name AS endpoint_name, e.url, coalesce(i.resolved_at, now()) AS until
     FROM incidents i JOIN endpoints e ON e.id = i.endpoint_id
     WHERE i.id = $1`,
    [id],
  );
  if (!row) return null;
  const { until, ...incident } = row;
  const from = incident.started_at;
  const params = [incident.endpoint_id, from, until];

  // What happened: failed checks inside the incident window, per category.
  const byType = await db.query<{ error_type: string; count: number }>(
    `SELECT error_type, count(*)::int AS count
     FROM check_results
     WHERE endpoint_id = $1 AND NOT ok AND checked_at BETWEEN $2 AND $3
     GROUP BY error_type
     ORDER BY count DESC, error_type`,
    params,
  );

  // Was it already slow? Median response time of OK checks in the hour / the week before the start.
  const [before] = await db.query<{ hour: number | null; week: number | null }>(
    `SELECT
       percentile_disc(0.5) WITHIN GROUP (ORDER BY response_time_ms)
         FILTER (WHERE checked_at >= $2::timestamptz - interval '1 hour') AS hour,
       percentile_disc(0.5) WITHIN GROUP (ORDER BY response_time_ms) AS week
     FROM check_results
     WHERE endpoint_id = $1 AND ok AND checked_at < $2 AND checked_at >= $2::timestamptz - interval '7 days'`,
    [incident.endpoint_id, from],
  );

  // Has it happened before? Earlier, finished incidents: same endpoint, same category, previous 7 days.
  const [similar] = await db.query<{ count: number; median_minutes: number | null }>(
    `SELECT count(*)::int AS count,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM resolved_at - started_at)::float8 / 60)
              AS median_minutes
     FROM incidents
     WHERE endpoint_id = $1 AND error_type = $2 AND id <> $3 AND resolved_at IS NOT NULL
       AND started_at < $4 AND started_at >= $4::timestamptz - make_interval(days => $5)`,
    [incident.endpoint_id, incident.error_type, incident.id, from, SIMILAR_WINDOW_DAYS],
  );
  const s = similar!;
  const flapping =
    s.count >= FLAPPING_MIN_INCIDENTS && s.median_minutes !== null && s.median_minutes <= FLAPPING_MAX_MEDIAN_MINUTES;

  // Which API tests for this endpoint failed while the incident was going on (first 20).
  const failingTests = await db.query<IncidentReport["failing_tests"][number]>(
    `SELECT t.suite_id, r.run_id, r.case_name, coalesce(r.failures -> 0 ->> 'message', r.error_message) AS message, r.created_at AS at
     FROM test_case_results r
     JOIN test_runs t ON t.id = r.run_id
     JOIN test_suites s ON s.id = t.suite_id
     WHERE s.endpoint_id = $1 AND NOT r.passed AND r.created_at BETWEEN $2 AND $3
     ORDER BY r.created_at, r.id
     LIMIT 20`,
    params,
  );

  return {
    incident,
    window: { from, to: until, open: incident.resolved_at === null, minutes: roundTo1(minutesBetween(from, until)) },
    failed_checks: { total: byType.reduce((sum, t) => sum + t.count, 0), by_type: byType },
    response_time_ms: { p50_hour_before: before!.hour, p50_week_before: before!.week },
    similar: {
      days: SIMILAR_WINDOW_DAYS,
      count: s.count,
      median_minutes: s.median_minutes === null ? null : roundTo1(s.median_minutes),
      flapping,
    },
    failing_tests: failingTests,
    suggestions: [...(SUGGESTIONS[incident.error_type] ?? GENERIC), ...(flapping ? [FLAPPING_SUGGESTION] : [])],
  };
}

const minutesBetween = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 60_000;
const roundTo1 = (n: number) => Math.round(n * 10) / 10;
