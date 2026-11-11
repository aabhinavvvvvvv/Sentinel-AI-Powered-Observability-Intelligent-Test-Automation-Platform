/**
 * Visit one endpoint once and report what happened:
 * up or down, status code, how long it took, and why it failed (if it did).
 *
 * This function never throws. Every failure becomes a normal result,
 * because "the website is down" is information we want to record, not a bug.
 * The safe request itself (SSRF guard, timeout, no redirects) lives in http-client.ts.
 */
import type { Endpoint } from "../endpoints/schemas.js";
import { sendRequest, type NetworkErrorType } from "./http-client.js";

// It answered, but with the wrong status. The status number says what kind of answer it was.
export type StatusErrorType =
  | "redirect" // 3xx: "go to another address"
  | "client_error" // 4xx: the server says OUR request is wrong (404 not found, 401 not allowed)
  | "server_error" // 5xx: the server itself broke
  | "unexpected_status"; // anything else, e.g. 200 when the check expects 404

export type CheckErrorType = NetworkErrorType | StatusErrorType;

export function statusErrorType(status: number): StatusErrorType {
  if (status >= 300 && status < 400) return "redirect";
  if (status >= 400 && status < 500) return "client_error";
  if (status >= 500 && status < 600) return "server_error";
  return "unexpected_status";
}

export interface CheckResult {
  ok: boolean;
  status_code: number | null; // null if we never got an answer
  response_time_ms: number;
  error_type: CheckErrorType | null;
  error_message: string | null;
  checked_at: Date;
}

export type CheckTarget = Pick<Endpoint, "url" | "method" | "timeout_ms" | "expected_status">;

export async function checkEndpoint(
  endpoint: CheckTarget,
  options: { allowPrivateAddresses?: boolean } = {},
): Promise<CheckResult> {
  const checkedAt = new Date();
  const res = await sendRequest({ url: endpoint.url, method: endpoint.method, timeout_ms: endpoint.timeout_ms }, options);

  if (!res.ok) {
    return {
      ok: false,
      status_code: null,
      response_time_ms: res.response_time_ms,
      error_type: res.error_type,
      error_message: res.error_message,
      checked_at: checkedAt,
    };
  }
  const ok = res.status === endpoint.expected_status;
  // For a redirect, say where it points: that's usually the fix ("register the www. address").
  const target = res.headers.location ? ` → ${res.headers.location}` : "";
  return {
    ok,
    status_code: res.status,
    response_time_ms: res.response_time_ms,
    error_type: ok ? null : statusErrorType(res.status),
    error_message: ok ? null : `Expected status ${endpoint.expected_status}, got ${res.status}${target}`,
    checked_at: checkedAt,
  };
}
