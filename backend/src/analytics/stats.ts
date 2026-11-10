/**
 * Statistics for one endpoint over a time window (last 24h, 7d, or 30d).
 *
 * Definitions (shown to users, so they must be exact):
 *   uptime %       = passed checks / all checks in the window × 100
 *                    (paused time and gaps have no checks, so they count as neither up nor down)
 *   P50/P95/P99    = response times of SUCCESSFUL checks only, sorted; the value 50%/95%/99% of
 *                    the way along. percentile_disc picks a real measured value (no blending).
 *   failures       = failed checks in the window, grouped by error type
 */
import { z } from "zod";
import type { Database } from "../db.js";

export const WindowSchema = z.enum(["24h", "7d", "30d"]).default("24h");
export type StatsWindow = z.infer<typeof WindowSchema>;

/** Our window names → Postgres interval text. */
export const WINDOW_INTERVAL: Record<StatsWindow, string> = {
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
};

/** How big each chart bucket is, per window. */
export const BUCKET_INTERVAL: Record<StatsWindow, string> = {
  "24h": "1 hour",
  "7d": "6 hours",
  "30d": "1 day",
};

export interface EndpointStats {
  window: StatsWindow;
  from: Date;
  to: Date;
  checks_total: number;
  checks_ok: number;
  uptime_percent: number | null; // null when there were no checks
  response_time_ms: { p50: number | null; p95: number | null; p99: number | null };
  failures_by_type: { error_type: string; count: number }[];
}

export async function getEndpointStats(db: Database, endpointId: number, window: StatsWindow): Promise<EndpointStats> {
  const interval = WINDOW_INTERVAL[window];

  // One pass over the window's checks. `::int` turns Postgres's big-integer counts into
  // normal numbers (otherwise the pg driver returns them as strings).
  const [summary] = await db.query<{
    from: Date;
    to: Date;
    checks_total: number;
    checks_ok: number;
    p50: number | null;
    p95: number | null;
    p99: number | null;
  }>(
    `SELECT
       now() - $2::interval AS "from",
       now()                AS "to",
       count(*)::int                    AS checks_total,
       count(*) FILTER (WHERE ok)::int  AS checks_ok,
       percentile_disc(0.50) WITHIN GROUP (ORDER BY response_time_ms) FILTER (WHERE ok) AS p50,
       percentile_disc(0.95) WITHIN GROUP (ORDER BY response_time_ms) FILTER (WHERE ok) AS p95,
       percentile_disc(0.99) WITHIN GROUP (ORDER BY response_time_ms) FILTER (WHERE ok) AS p99
     FROM check_results
     WHERE endpoint_id = $1 AND checked_at > now() - $2::interval`,
    [endpointId, interval],
  );

  const failures = await db.query<{ error_type: string; count: number }>(
    `SELECT error_type, count(*)::int AS count
     FROM check_results
     WHERE endpoint_id = $1 AND checked_at > now() - $2::interval AND NOT ok
     GROUP BY error_type
     ORDER BY count DESC, error_type`,
    [endpointId, interval],
  );

  const s = summary!;
  return {
    window,
    from: s.from,
    to: s.to,
    checks_total: s.checks_total,
    checks_ok: s.checks_ok,
    uptime_percent: percent(s.checks_ok, s.checks_total),
    response_time_ms: { p50: s.p50, p95: s.p95, p99: s.p99 },
    failures_by_type: failures,
  };
}

/** ok / total as a percentage with 2 decimals (99.3055… → 99.31), or null when total is 0. */
function percent(ok: number, total: number): number | null {
  return total === 0 ? null : Math.round((ok / total) * 10_000) / 100;
}

export interface TimeseriesPoint {
  time: Date; // start of the bucket (UTC)
  checks_total: number; // 0 = no data for this bucket (a gap, not "up")
  checks_ok: number;
  uptime_percent: number | null;
  p50_ms: number | null; // successful checks only
  p95_ms: number | null;
}

/**
 * The same numbers per bucket (hour / 6 hours / day), for charts.
 * Buckets are aligned to UTC (e.g. 14:00–15:00 UTC). The first and last buckets are
 * partial, because the window rarely starts exactly on a bucket boundary.
 */
export async function getEndpointTimeseries(
  db: Database,
  endpointId: number,
  window: StatsWindow,
): Promise<{ window: StatsWindow; bucket: string; points: TimeseriesPoint[] }> {
  const rows = await db.query<Omit<TimeseriesPoint, "uptime_percent">>(
    `WITH
       -- Every bucket start in the window, even empty ones (so gaps stay visible).
       -- date_bin rounds a time DOWN to its bucket, e.g. 14:37 → 14:00 for 1-hour buckets.
       buckets AS (
         SELECT generate_series(
           date_bin($3::interval, now() - $2::interval, TIMESTAMPTZ '2000-01-01'),
           date_bin($3::interval, now(),                TIMESTAMPTZ '2000-01-01'),
           $3::interval) AS time
       ),
       -- The numbers for buckets that have checks.
       per_bucket AS (
         SELECT date_bin($3::interval, checked_at, TIMESTAMPTZ '2000-01-01') AS time,
                count(*)::int                   AS checks_total,
                count(*) FILTER (WHERE ok)::int AS checks_ok,
                percentile_disc(0.50) WITHIN GROUP (ORDER BY response_time_ms) FILTER (WHERE ok) AS p50_ms,
                percentile_disc(0.95) WITHIN GROUP (ORDER BY response_time_ms) FILTER (WHERE ok) AS p95_ms
         FROM check_results
         WHERE endpoint_id = $1 AND checked_at > now() - $2::interval
         GROUP BY 1
       )
     -- LEFT JOIN keeps every bucket; empty ones get 0 checks and nulls.
     SELECT b.time,
            coalesce(p.checks_total, 0) AS checks_total,
            coalesce(p.checks_ok, 0)    AS checks_ok,
            p.p50_ms,
            p.p95_ms
     FROM buckets b LEFT JOIN per_bucket p USING (time)
     ORDER BY b.time`,
    [endpointId, WINDOW_INTERVAL[window], BUCKET_INTERVAL[window]],
  );

  return {
    window,
    bucket: BUCKET_INTERVAL[window],
    points: rows.map((r) => ({ ...r, uptime_percent: percent(r.checks_ok, r.checks_total) })),
  };
}
