/**
 * Send one HTTP request safely. Used by health checks AND API tests.
 *
 * Safety built in:
 *   - SSRF guard: never connects to private/internal addresses (see ssrf-guard.ts)
 *   - hard timeout (timeout_ms) covering the whole request, body included
 *   - redirects are not followed (a redirect could point at an internal address)
 *   - the response body is read only if asked, and at most 1 MB of it
 *
 * Never throws: network problems come back as { ok: false, error_type, error_message }.
 */
import { isIP } from "node:net";
import { Agent, fetch, type Response } from "undici";
import { isBlockedAddress, safeLookup } from "./ssrf-guard.js";

export type NetworkErrorType =
  | "blocked" // inside address, refused by the SSRF guard
  | "timeout" // no answer in time
  | "dns" // the website name doesn't exist
  | "connection_refused" // the computer exists but nothing is listening
  | "connection_reset" // the server hung up in the middle of the conversation
  | "tls" // HTTPS certificate problem
  | "network"; // any other network problem

export const MAX_BODY_BYTES = 1_000_000;

export interface HttpRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string | null;
  timeout_ms: number;
  readBody?: boolean; // health checks don't need the body; API tests do
}

export type HttpResponse =
  | {
      ok: true;
      status: number;
      headers: Record<string, string>; // names lower-cased, e.g. "content-type"
      body: string | null; // null when readBody is false
      body_truncated: boolean; // true if the body was over MAX_BODY_BYTES and got cut off
      response_time_ms: number; // time until the response started (headers arrived)
    }
  | { ok: false; error_type: NetworkErrorType; error_message: string; response_time_ms: number };

// An Agent is the part that opens connections. The safe one checks every
// address with safeLookup; the open one doesn't (only for tests on localhost).
const safeAgent = new Agent({ connect: { lookup: safeLookup } });
const openAgent = new Agent();

export async function sendRequest(
  req: HttpRequest,
  { allowPrivateAddresses = false }: { allowPrivateAddresses?: boolean } = {},
): Promise<HttpResponse> {
  const start = performance.now();
  const elapsedMs = () => Math.round(performance.now() - start);
  const failed = (error_type: NetworkErrorType, error_message: string): HttpResponse => ({
    ok: false,
    error_type,
    error_message,
    response_time_ms: elapsedMs(),
  });

  // If the URL contains an IP directly (http://127.0.0.1), there's no DNS lookup,
  // so safeLookup never runs. Check that case here.
  const host = new URL(req.url).hostname.replace(/^\[|\]$/g, ""); // "[::1]" → "::1"
  if (!allowPrivateAddresses && isIP(host) && isBlockedAddress(host)) {
    return failed("blocked", `${host} is a private/internal address`);
  }

  try {
    const response = await fetch(req.url, {
      method: req.method,
      headers: { "user-agent": "Sentinel-Monitor/0.1", ...req.headers },
      body: req.body ?? null, // null = no body
      redirect: "manual",
      signal: AbortSignal.timeout(req.timeout_ms),
      dispatcher: allowPrivateAddresses ? openAgent : safeAgent,
    });
    const responseTimeMs = elapsedMs();
    const headers = Object.fromEntries(response.headers);

    let body: string | null = null;
    let truncated = false;
    if (req.readBody) {
      ({ body, truncated } = await readLimited(response));
    } else {
      await response.body?.cancel(); // we don't need the content; free the connection
    }
    return { ok: true, status: response.status, headers, body, body_truncated: truncated, response_time_ms: responseTimeMs };
  } catch (err) {
    return failed(...describeError(err));
  }
}

/** Read the body, but stop after MAX_BODY_BYTES so a huge response can't fill our memory. */
async function readLimited(response: Response): Promise<{ body: string; truncated: boolean }> {
  if (!response.body) return { body: "", truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return { body: Buffer.concat(chunks).subarray(0, MAX_BODY_BYTES).toString("utf8"), truncated: true };
    }
  }
  return { body: Buffer.concat(chunks).toString("utf8"), truncated: false };
}

/** Turn a thrown error into one of our error types plus a readable message. */
function describeError(err: unknown): [NetworkErrorType, string] {
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
  if (code === "ECONNRESET") return ["connection_reset", message];
  if (/CERT|TLS|SSL/.test(code)) return ["tls", message];
  return ["network", message || "Unknown network error"];
}
