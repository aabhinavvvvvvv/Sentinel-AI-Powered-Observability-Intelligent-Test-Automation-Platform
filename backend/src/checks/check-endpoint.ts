/**
 * Visit one endpoint once and report what happened:
 * up or down, status code, how long it took, and why it failed (if it did).
 *
 * This function never throws. Every failure becomes a normal result,
 * because "the website is down" is information we want to record, not a bug.
 */
import { isIP } from "node:net";
import { Agent, fetch } from "undici";
import type { Endpoint } from "../endpoints/schemas.js";
import { isBlockedAddress, safeLookup } from "./ssrf-guard.js";

export type CheckErrorType =
  | "blocked" // inside address, refused by the SSRF guard
  | "timeout" // no answer in time
  | "dns" // the website name doesn't exist
  | "connection_refused" // the computer exists but nothing is listening
  | "tls" // HTTPS certificate problem
  | "unexpected_status" // it answered, but with the wrong status code
  | "network"; // any other network problem

export interface CheckResult {
  ok: boolean;
  status_code: number | null; // null if we never got an answer
  response_time_ms: number;
  error_type: CheckErrorType | null;
  error_message: string | null;
  checked_at: Date;
}

export type CheckTarget = Pick<Endpoint, "url" | "method" | "timeout_ms" | "expected_status">;

// An Agent is the part that opens connections. The safe one checks every
// address with safeLookup; the open one doesn't (only for tests on localhost).
const safeAgent = new Agent({ connect: { lookup: safeLookup } });
const openAgent = new Agent();

export async function checkEndpoint(
  endpoint: CheckTarget,
  options: { allowPrivateAddresses?: boolean } = {},
): Promise<CheckResult> {
  const allowPrivate = options.allowPrivateAddresses ?? false;
  const checkedAt = new Date();
  const start = performance.now();
  const elapsedMs = () => Math.round(performance.now() - start);

  // If the URL contains an IP directly (http://127.0.0.1), there's no DNS lookup,
  // so safeLookup never runs. Check that case here.
  const host = new URL(endpoint.url).hostname.replace(/^\[|\]$/g, ""); // "[::1]" → "::1"
  if (!allowPrivate && isIP(host) && isBlockedAddress(host)) {
    return failed("blocked", `${host} is a private/internal address`, elapsedMs(), checkedAt);
  }

  try {
    const response = await fetch(endpoint.url, {
      method: endpoint.method,
      redirect: "manual", // don't follow redirects: one could lead to an inside address
      signal: AbortSignal.timeout(endpoint.timeout_ms), // give up after timeout_ms
      dispatcher: allowPrivate ? openAgent : safeAgent,
      headers: { "user-agent": "Sentinel-Monitor/0.1" },
    });
    const responseTimeMs = elapsedMs(); // time until the website started answering
    await response.body?.cancel(); // we don't need the page content; free the connection

    const ok = response.status === endpoint.expected_status;
    return {
      ok,
      status_code: response.status,
      response_time_ms: responseTimeMs,
      error_type: ok ? null : "unexpected_status",
      error_message: ok ? null : `Expected status ${endpoint.expected_status}, got ${response.status}`,
      checked_at: checkedAt,
    };
  } catch (err) {
    const [type, message] = describeError(err);
    return failed(type, message, elapsedMs(), checkedAt);
  }
}

function failed(type: CheckErrorType, message: string, ms: number, at: Date): CheckResult {
  return { ok: false, status_code: null, response_time_ms: ms, error_type: type, error_message: message, checked_at: at };
}

/** Turn a thrown error into one of our error types plus a readable message. */
function describeError(err: unknown): [CheckErrorType, string] {
  if (err instanceof Error && err.name === "TimeoutError") {
    return ["timeout", "No response before the timeout"];
  }
  // fetch() throws a generic "fetch failed" error; the real reason is in `cause`.
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  const code = cause?.code ?? "";
  const message = cause?.message ?? String(err);

  if (code === "SSRF_BLOCKED") return ["blocked", message];
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return ["dns", message];
  if (code === "ECONNREFUSED") return ["connection_refused", message];
  if (/CERT|TLS|SSL/.test(code)) return ["tls", message];
  return ["network", message || "Unknown network error"];
}
