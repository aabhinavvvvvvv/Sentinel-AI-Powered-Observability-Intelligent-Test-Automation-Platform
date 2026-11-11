/** Draws the API-testing pages with a fake backend (fake `fetch`) and checks what the user sees and sends. */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunDetail } from "./RunDetail";
import { SuiteDetail } from "./SuiteDetail";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const run = {
  id: 7,
  suite_id: 1,
  triggered_by: "manual",
  run_order: "default",
  status: "failed",
  total: 2,
  passed: 1,
  failed: 1,
  error_message: null,
  created_at: "2026-11-10T21:00:00Z",
  started_at: "2026-11-10T21:00:00Z",
  finished_at: "2026-11-10T21:00:02Z",
};

/** Fake backend: first matching "METHOD path-prefix" wins. Returns the mock to inspect calls. */
function fakeBackend(routes: Record<string, [number, unknown]>) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    const match = Object.entries(routes).find(([prefix]) => key.startsWith(prefix));
    const [status, body] = match ? match[1] : [404, { error: { message: "not found" } }];
    return new Response(status === 204 ? null : JSON.stringify(body), { status });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/suites/:id" element={<SuiteDetail />} />
        <Route path="/suites/:id/runs/:runId" element={<RunDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("RunDetail", () => {
  it("shows each case's result and the reasons it failed", async () => {
    fakeBackend({
      "GET /api/suites/1/runs/7": [
        200,
        {
          ...run,
          run_order: "priority",
          results: [
            { id: 1, case_id: 1, case_name: "Get user 1", passed: true, status_code: 200, response_time_ms: 120, error_type: null, error_message: null, failures: [] },
            {
              id: 2,
              case_id: null,
              case_name: "Wrong id",
              passed: false,
              status_code: 200,
              response_time_ms: 90,
              error_type: null,
              error_message: null,
              failures: [{ assertion: { type: "json_path_equals" }, message: '"id" is 1, expected 2' }],
            },
          ],
        },
      ],
    });
    renderAt("/suites/1/runs/7");

    expect(await screen.findByText("1 of 2 test cases passed")).toBeTruthy();
    expect(screen.getByText("FAILED")).toBeTruthy();
    expect(screen.getByText('↳ "id" is 1, expected 2')).toBeTruthy();
    expect(screen.getByText(/test case deleted since/)).toBeTruthy();
    expect(screen.getByText(/suggested order \(riskiest first\)/)).toBeTruthy();
  });
});

describe("SuiteDetail", () => {
  const suite = { id: 1, endpoint_id: 1, name: "Users", schedule_minutes: 60, created_at: "", updated_at: "" };
  const testCase = {
    id: 3,
    suite_id: 1,
    name: "Get user 1",
    method: "GET",
    url: "https://api.example.com/users/1",
    headers: {},
    body: null,
    timeout_ms: 5000,
    assertions: [{ type: "status_equals", value: 200 }],
  };

  const noPriority = { suite_id: 1, endpoint: { open_incident: false, failed_checks_last_hour: 0 }, cases: [] };

  it("shows the schedule, cases and run history, and 'Run now' starts a run", async () => {
    const fetchMock = fakeBackend({
      "GET /api/suites/1/priority": [200, noPriority],
      "GET /api/suites/1/runs": [200, [run]],
      "GET /api/suites/1": [200, { ...suite, cases: [testCase] }],
      "POST /api/suites/1/runs": [202, { ...run, id: 8, status: "queued" }],
    });
    renderAt("/suites/1");

    expect(await screen.findByRole("heading", { name: "Users" })).toBeTruthy();
    expect(screen.getAllByText("Every 1 h").length).toBeGreaterThan(0);
    expect(screen.getByText("Get user 1")).toBeTruthy();
    expect(screen.getByText("1 of 2")).toBeTruthy(); // run history row

    const runBodies = () =>
      fetchMock.mock.calls.filter(([url, init]) => url === "/api/suites/1/runs" && init?.method === "POST").map(([, init]) => init?.body);
    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    await vi.waitFor(() => expect(runBodies()).toEqual(['{"order":"default"}']));
    fireEvent.click(screen.getByRole("button", { name: "Run in suggested order" }));
    await vi.waitFor(() => expect(runBodies()).toEqual(['{"order":"default"}', '{"order":"priority"}']));
  });

  it("shows the suggested order with reasons, warnings and endpoint trouble", async () => {
    fakeBackend({
      "GET /api/suites/1/priority": [
        200,
        {
          suite_id: 1,
          endpoint: { open_incident: true, failed_checks_last_hour: 2 },
          cases: [
            { case_id: 4, name: "Always fails", position: 2, score: 70, reasons: ["Failed in the last run (+40)"], warning: "Failed all of its last 5 runs: the test itself may be wrong, not the API." },
            { case_id: 3, name: "Get user 1", position: 1, score: 0, reasons: [], warning: null },
          ],
        },
      ],
      "GET /api/suites/1/runs": [200, []],
      "GET /api/suites/1": [200, { ...suite, cases: [testCase] }],
    });
    renderAt("/suites/1");

    expect(await screen.findByRole("heading", { name: "Suggested order" })).toBeTruthy();
    expect(screen.getByText(/points, not probabilities/)).toBeTruthy();
    expect(screen.getByText(/endpoint is in trouble right now/).textContent).toMatch(/open incident.*2 failed health checks/);
    expect(screen.getByText("Failed in the last run (+40)")).toBeTruthy();
    expect(screen.getByText(/test itself may be wrong/)).toBeTruthy();
    expect(screen.getByText("(normally 2)")).toBeTruthy(); // it moved up from 2nd to 1st
    expect(screen.getByText("No recent failures")).toBeTruthy();
  });

  it("shows the backend's reasons when a pasted test case is invalid", async () => {
    fakeBackend({
      "GET /api/suites/1/priority": [200, noPriority],
      "GET /api/suites/1/runs": [200, []],
      "GET /api/suites/1": [200, { ...suite, cases: [] }],
      "POST /api/suites/1/cases": [
        400,
        { error: { code: "VALIDATION_ERROR", message: "x", details: [{ field: "assertions.0.type", message: "Invalid input" }] } },
      ],
    });
    renderAt("/suites/1");
    await screen.findByRole("heading", { name: "Users" });
    expect(screen.getByRole("button", { name: "Run now" })).toHaveProperty("disabled", true); // no cases yet

    fireEvent.change(screen.getByLabelText("Test case JSON"), { target: { value: '{"name":"x"}' } });
    fireEvent.click(screen.getByRole("button", { name: "Add test case" }));
    expect((await screen.findByRole("alert")).textContent).toBe("assertions.0.type: Invalid input");
  });
});
