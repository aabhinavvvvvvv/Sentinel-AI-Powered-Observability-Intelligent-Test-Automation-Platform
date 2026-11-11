/** Pure tests: response in, failures (with reasons) out. No network, no database. */
import { describe, expect, it } from "vitest";
import { evaluateAssertions, lookup, type TestResponse } from "../src/testing/assertions.js";
import type { Assertion } from "../src/testing/schemas.js";

const response = (extra: Partial<TestResponse> = {}): TestResponse => ({
  status: 200,
  headers: { "content-type": "application/json; charset=utf-8" },
  body: JSON.stringify({ user: { id: 1, email: "ada@example.com", tags: ["admin"], manager: null } }),
  body_truncated: false,
  response_time_ms: 120,
  ...extra,
});

/** The failure message for one assertion, or null if it passed. */
const run = (a: Assertion, res = response()) => evaluateAssertions([a], res)[0]?.message ?? null;

describe("each assertion type: pass and fail (with a clear reason)", () => {
  it.each<[string, Assertion, string | null]>([
    ["status ok", { type: "status_equals", value: 200 }, null],
    ["status wrong", { type: "status_equals", value: 201 }, "expected status 201, got 200"],
    ["fast enough", { type: "response_time_below_ms", value: 500 }, null],
    ["too slow", { type: "response_time_below_ms", value: 100 }, "took 120 ms, limit is 100 ms"],
    ["header ok (names and values ignore case)", { type: "header_contains", name: "Content-Type", value: "JSON" }, null],
    ["header missing", { type: "header_contains", name: "x-api-version", value: "2" }, 'header "x-api-version" is missing'],
    [
      "header wrong",
      { type: "header_contains", name: "content-type", value: "xml" },
      'header "content-type" is "application/json; charset=utf-8", expected it to contain "xml"',
    ],
    ["body contains", { type: "body_contains", value: "ada@example.com" }, null],
    ["body doesn't contain", { type: "body_contains", value: "grace" }, 'body does not contain "grace"'],
    ["path exists", { type: "json_path_exists", path: "user.email" }, null],
    ["path exists (array position)", { type: "json_path_exists", path: "user.tags.0" }, null],
    ["path exists even when its value is null", { type: "json_path_exists", path: "user.manager" }, null],
    ["path missing", { type: "json_path_exists", path: "user.phone" }, '"user.phone" not found in the JSON'],
    ["path equals", { type: "json_path_equals", path: "user.id", value: 1 }, null],
    ["path equals (array)", { type: "json_path_equals", path: "user.tags.0", value: "admin" }, null],
    ["path wrong value", { type: "json_path_equals", path: "user.id", value: 2 }, '"user.id" is 1, expected 2'],
    ["type matters: 1 is not '1'", { type: "json_path_equals", path: "user.id", value: "1" }, '"user.id" is 1, expected "1"'],
  ])("%s", (_label, assertion, expected) => {
    expect(run(assertion)).toBe(expected);
  });
});

describe("JSON problems", () => {
  it("reports a body that isn't JSON", () => {
    expect(run({ type: "json_path_exists", path: "a" }, response({ body: "<html>" }))).toBe(
      "response body is not valid JSON",
    );
  });

  it("reports a body that was cut off at 1 MB", () => {
    expect(run({ type: "json_path_exists", path: "a" }, response({ body_truncated: true }))).toMatch(/over 1 MB/);
    expect(run({ type: "body_contains", value: "zzz" }, response({ body_truncated: true }))).toMatch(/first 1 MB/);
  });
});

it("returns every failure, not just the first", () => {
  const failures = evaluateAssertions(
    [
      { type: "status_equals", value: 500 },
      { type: "body_contains", value: "ada" },
      { type: "json_path_exists", path: "nope" },
    ],
    response(),
  );
  expect(failures.map((f) => f.assertion.type)).toEqual(["status_equals", "json_path_exists"]);
});

describe("lookup", () => {
  it("doesn't find keys through strings or numbers", () => {
    expect(lookup({ a: "text" }, "a.length")).toEqual({ exists: false });
    expect(lookup({ a: 5 }, "a.b")).toEqual({ exists: false });
  });
});
