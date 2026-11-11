/**
 * Everything the page needs from the backend, in one place.
 * These types mirror the backend's JSON. Timestamps arrive as text (ISO, UTC).
 */

export interface Endpoint {
  id: number;
  name: string;
  url: string;
  method: "GET" | "HEAD";
  interval_seconds: number;
  timeout_ms: number;
  expected_status: number;
  max_retries: number;
  failure_threshold: number;
  paused: boolean;
  created_at: string;
  updated_at: string;
}

export interface EndpointWithStatus extends Endpoint {
  last_check: {
    ok: boolean;
    status_code: number | null;
    response_time_ms: number;
    error_type: string | null;
    checked_at: string;
  } | null;
  open_incident: { id: number; started_at: string; error_type: string; error_message: string | null } | null;
}

export interface Incident {
  id: number;
  endpoint_id: number;
  endpoint_name: string;
  started_at: string;
  resolved_at: string | null;
  error_type: string;
  error_message: string | null;
}

export interface CheckResult {
  id: number;
  endpoint_id: number;
  ok: boolean;
  status_code: number | null;
  response_time_ms: number;
  error_type: string | null;
  error_message: string | null;
  checked_at: string;
}

export type StatsRange = "24h" | "7d" | "30d";

/** GET /endpoints/:id/stats. Exact definitions are in the README ("Metric definitions"). */
export interface EndpointStats {
  window: StatsRange;
  from: string;
  to: string;
  checks_total: number;
  checks_ok: number;
  uptime_percent: number | null;
  response_time_ms: { p50: number | null; p95: number | null; p99: number | null };
  failures_by_type: { error_type: string; count: number }[];
}

export interface TimeseriesPoint {
  time: string; // start of the bucket (UTC)
  checks_total: number; // 0 = no data (a gap)
  checks_ok: number;
  uptime_percent: number | null;
  p50_ms: number | null;
  p95_ms: number | null;
}

// ----- API testing -----

export type RunStatus = "queued" | "running" | "passed" | "failed" | "error";

export interface TestSuite {
  id: number;
  endpoint_id: number;
  name: string;
  schedule_minutes: number | null; // null = manual only
  created_at: string;
  updated_at: string;
}

export interface TestSuiteListItem extends TestSuite {
  endpoint_name: string;
  case_count: number;
  last_run: { id: number; status: RunStatus; passed: number; failed: number; created_at: string } | null;
}

export interface TestCase {
  id: number;
  suite_id: number;
  name: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
  timeout_ms: number;
  assertions: { type: string; [key: string]: unknown }[];
}

export interface TestRun {
  id: number;
  suite_id: number;
  triggered_by: "manual" | "scheduled";
  status: RunStatus;
  total: number;
  passed: number;
  failed: number;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface TestCaseResult {
  id: number;
  case_id: number | null;
  case_name: string;
  passed: boolean;
  status_code: number | null;
  response_time_ms: number;
  error_type: string | null;
  error_message: string | null;
  failures: { assertion: { type: string }; message: string }[];
}

export interface NewEndpoint {
  name: string;
  url: string;
  interval_seconds?: number;
}

/** An error from the API: the HTTP status (e.g. 404) and per-field details when validation failed. */
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public details: { field: string; message: string }[] = [],
  ) {
    super(message);
  }
}

/** Call the backend through Vite's "/api" forwarding. Throws ApiError on any 4xx/5xx. */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, { ...init, headers: { "Content-Type": "application/json" } });
  if (res.status === 204) return undefined as T; // e.g. DELETE: success, no body
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(body?.error?.message ?? `Request failed (HTTP ${res.status})`, res.status, body?.error?.details);
  }
  return body as T;
}

export const api = {
  listEndpoints: () => request<EndpointWithStatus[]>("/endpoints"),
  createEndpoint: (input: NewEndpoint) =>
    request<Endpoint>("/endpoints", { method: "POST", body: JSON.stringify(input) }),
  setPaused: (id: number, paused: boolean) =>
    request<Endpoint>(`/endpoints/${id}`, { method: "PATCH", body: JSON.stringify({ paused }) }),
  deleteEndpoint: (id: number) => request<void>(`/endpoints/${id}`, { method: "DELETE" }),
  listOpenIncidents: () => request<Incident[]>("/incidents?status=open"),

  // Detail page
  getEndpoint: (id: number) => request<Endpoint>(`/endpoints/${id}`),
  listChecks: (id: number, limit = 50) => request<CheckResult[]>(`/endpoints/${id}/checks?limit=${limit}`),
  listIncidentsFor: (id: number) => request<Incident[]>(`/incidents?endpoint_id=${id}`),
  checkNow: (id: number) => request<CheckResult>(`/endpoints/${id}/check`, { method: "POST" }),

  // Analytics
  getStats: (id: number, range: StatsRange) => request<EndpointStats>(`/endpoints/${id}/stats?window=${range}`),
  getTimeseries: (id: number, range: StatsRange) =>
    request<{ window: StatsRange; bucket: string; points: TimeseriesPoint[] }>(
      `/endpoints/${id}/timeseries?window=${range}`,
    ),

  // API testing
  listSuites: () => request<TestSuiteListItem[]>("/suites"),
  createSuite: (input: { endpoint_id: number; name: string; schedule_minutes: number | null }) =>
    request<TestSuite>("/suites", { method: "POST", body: JSON.stringify(input) }),
  getSuite: (id: number) => request<TestSuite & { cases: TestCase[] }>(`/suites/${id}`),
  updateSuite: (id: number, changes: { name?: string; schedule_minutes?: number | null }) =>
    request<TestSuite>(`/suites/${id}`, { method: "PATCH", body: JSON.stringify(changes) }),
  deleteSuite: (id: number) => request<void>(`/suites/${id}`, { method: "DELETE" }),
  /** `json` is the test case exactly as the user typed it; the backend validates it. */
  addCase: (suiteId: number, json: string) =>
    request<TestCase>(`/suites/${suiteId}/cases`, { method: "POST", body: json }),
  deleteCase: (suiteId: number, caseId: number) =>
    request<void>(`/suites/${suiteId}/cases/${caseId}`, { method: "DELETE" }),
  runSuite: (suiteId: number) => request<TestRun>(`/suites/${suiteId}/runs`, { method: "POST" }),
  listRuns: (suiteId: number) => request<TestRun[]>(`/suites/${suiteId}/runs?limit=20`),
  getRun: (suiteId: number, runId: number) =>
    request<TestRun & { results: TestCaseResult[] }>(`/suites/${suiteId}/runs/${runId}`),
};
