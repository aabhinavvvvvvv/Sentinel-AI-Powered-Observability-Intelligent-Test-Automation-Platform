/**
 * Anomalies: ask the Python analytics service about each endpoint, save what it finds.
 *
 *   worker (hourly) → POST {ANALYTICS_URL}/analyze/:id → findings JSON → check shape → INSERT anomalies
 *
 * Python only reads the database; Node is the only writer (one owner for the data).
 */
import { z } from "zod";
import type { Database } from "../db.js";
import { listEndpoints } from "../endpoints/repository.js";

// The CONTRACT between the two services: exactly what Python must send back.
// Checked on every call, so a change on the Python side can't silently save garbage.
const FindingSchema = z.object({
  time: z.string(), // start of the unusual hour (ISO, UTC)
  metric: z.string(),
  value: z.number(),
  baseline: z.number(),
  score: z.number(),
  severity: z.enum(["warning", "critical"]),
  explanation: z.string(),
});
const AnalysisSchema = z.object({
  endpoint_id: z.number().int(),
  method: z.string(),
  hours_scored: z.number().int(),
  findings: z.array(FindingSchema),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

export interface Anomaly {
  id: number;
  endpoint_id: number;
  metric: string;
  bucket_start: Date;
  value: number;
  baseline: number;
  score: number;
  severity: "warning" | "critical";
  explanation: string;
  method: string;
  created_at: Date;
}

/**
 * Ask the Python service to analyse one endpoint.
 * Plain fetch is fine here: ANALYTICS_URL is our own service from config, not a user-supplied URL.
 */
export async function requestAnalysis(analyticsUrl: string, endpointId: number): Promise<Analysis> {
  const res = await fetch(`${analyticsUrl}/analyze/${endpointId}`, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`analytics service answered HTTP ${res.status}`);
  return AnalysisSchema.parse(await res.json()); // throws if the answer breaks the contract
}

/** Save findings; ones we already have are skipped (UNIQUE + ON CONFLICT DO NOTHING). Returns how many were new. */
export async function saveFindings(db: Database, analysis: Analysis): Promise<number> {
  let added = 0;
  for (const f of analysis.findings) {
    const rows = await db.query(
      `INSERT INTO anomalies (endpoint_id, metric, bucket_start, value, baseline, score, severity, explanation, method)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (endpoint_id, metric, bucket_start, method) DO NOTHING
       RETURNING id`,
      [analysis.endpoint_id, f.metric, f.time, f.value, f.baseline, f.score, f.severity, f.explanation, analysis.method],
    );
    added += rows.length;
  }
  return added;
}

export async function listAnomalies(db: Database, endpointId: number, limit: number): Promise<Anomaly[]> {
  return db.query<Anomaly>(
    "SELECT * FROM anomalies WHERE endpoint_id = $1 ORDER BY bucket_start DESC, id DESC LIMIT $2",
    [endpointId, limit],
  );
}

/**
 * The hourly job: analyse every active (not paused) endpoint, one at a time.
 * One endpoint failing (or the Python service being down) is recorded and the rest continue.
 */
export async function analyzeAll(db: Database, analyticsUrl: string) {
  const endpoints = (await listEndpoints(db)).filter((e) => !e.paused);
  let newAnomalies = 0;
  const errors: { endpointId: number; message: string }[] = [];

  for (const endpoint of endpoints) {
    try {
      newAnomalies += await saveFindings(db, await requestAnalysis(analyticsUrl, endpoint.id));
    } catch (err) {
      errors.push({ endpointId: endpoint.id, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { endpoints: endpoints.length, newAnomalies, errors };
}
