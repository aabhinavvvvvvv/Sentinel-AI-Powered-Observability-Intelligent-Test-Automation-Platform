/**
 * Check a response against a test case's assertions.
 * Pure function: response in, list of failures out (empty list = all passed).
 * Every failure has a plain-English reason, e.g. "expected status 200, got 500".
 */
import { MAX_BODY_BYTES } from "../checks/http-client.js";
import type { Assertion } from "./schemas.js";

export interface AssertionFailure {
  assertion: Assertion;
  message: string;
}

export interface TestResponse {
  status: number;
  headers: Record<string, string>; // lower-case names
  body: string | null;
  body_truncated: boolean;
  response_time_ms: number;
}

type ParsedJson = { value: unknown } | { error: string };

export function evaluateAssertions(assertions: Assertion[], res: TestResponse): AssertionFailure[] {
  // Parse the JSON at most once, and only if a JSON assertion needs it.
  let json: ParsedJson | undefined;
  const getJson = () => (json ??= parseJson(res));

  const failures: AssertionFailure[] = [];
  for (const assertion of assertions) {
    const message = check(assertion, res, getJson);
    if (message !== null) failures.push({ assertion, message });
  }
  return failures;
}

/** null = passed; otherwise the reason it failed. */
function check(a: Assertion, res: TestResponse, getJson: () => ParsedJson): string | null {
  switch (a.type) {
    case "status_equals":
      return res.status === a.value ? null : `expected status ${a.value}, got ${res.status}`;

    case "response_time_below_ms":
      return res.response_time_ms < a.value ? null : `took ${res.response_time_ms} ms, limit is ${a.value} ms`;

    case "header_contains": {
      const actual = res.headers[a.name.toLowerCase()]; // header names are case-insensitive
      if (actual === undefined) return `header "${a.name}" is missing`;
      return actual.toLowerCase().includes(a.value.toLowerCase())
        ? null
        : `header "${a.name}" is "${short(actual)}", expected it to contain "${a.value}"`;
    }

    case "body_contains":
      if ((res.body ?? "").includes(a.value)) return null;
      return `body does not contain "${a.value}"` + (res.body_truncated ? ` (only the first ${MAX_BODY_BYTES / 1_000_000} MB was read)` : "");

    case "json_path_exists":
    case "json_path_equals": {
      const parsed = getJson();
      if ("error" in parsed) return parsed.error;
      const found = lookup(parsed.value, a.path);
      if (!found.exists) return `"${a.path}" not found in the JSON`;
      if (a.type === "json_path_exists") return null;
      return found.value === a.value
        ? null
        : `"${a.path}" is ${short(JSON.stringify(found.value))}, expected ${JSON.stringify(a.value)}`;
    }
  }
}

function parseJson(res: TestResponse): ParsedJson {
  if (res.body_truncated) return { error: "response is over 1 MB, so its JSON couldn't be read" };
  try {
    return { value: JSON.parse(res.body ?? "") };
  } catch {
    return { error: "response body is not valid JSON" };
  }
}

/** Walk a dot path: lookup({user: {tags: ["a"]}}, "user.tags.0") → { exists: true, value: "a" }. */
export function lookup(value: unknown, path: string): { exists: false } | { exists: true; value: unknown } {
  let current = value;
  for (const key of path.split(".")) {
    // Works for objects and arrays alike: an array's positions are its keys "0", "1", ...
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, key)) return { exists: false };
    current = (current as Record<string, unknown>)[key];
  }
  return { exists: true, value: current };
}

/** Keep messages readable: cut long values to 200 characters. */
function short(text: string): string {
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}
