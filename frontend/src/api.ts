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
};
