/** Draws the incident evidence page with a fake backend and checks what the user sees. */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncidentDetail } from "./IncidentDetail";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const report = {
  incident: {
    id: 48,
    endpoint_id: 23,
    endpoint_name: "test website",
    url: "https://example.com/",
    started_at: "2026-11-11T18:03:06Z",
    resolved_at: "2026-11-11T18:04:36Z",
    error_type: "timeout",
    error_message: "No response before the timeout",
  },
  window: { from: "2026-11-11T18:03:06Z", to: "2026-11-11T18:04:36Z", open: false, minutes: 1.5 },
  failed_checks: { total: 3, by_type: [{ error_type: "timeout", count: 3 }] },
  response_time_ms: { p50_hour_before: 250, p50_week_before: 254 },
  similar: { days: 7, count: 41, median_minutes: 2, flapping: true },
  failing_tests: [{ suite_id: 1, run_id: 9, case_name: "GET /users", message: "expected status 200, got 504", at: "2026-11-11T18:04:00Z" }],
  suggestions: ["Check whether the server is overloaded.", "This keeps coming back in short bursts (flapping)."],
};

function show(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));
  render(
    <MemoryRouter initialEntries={["/incidents/48"]}>
      <Routes>
        <Route path="/incidents/:id" element={<IncidentDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("IncidentDetail", () => {
  it("shows the evidence, the flapping badge, failing tests and labelled suggestions", async () => {
    show(200, report);
    expect(await screen.findByText("Incident #48")).toBeTruthy();
    expect(screen.getByText("RESOLVED")).toBeTruthy();
    expect(screen.getByText(/3 failed checks in this window: timeout × 3/)).toBeTruthy();
    expect(screen.getByText(/250 ms in the hour before, vs 254 ms over the week before/)).toBeTruthy();
    expect(screen.getByText("FLAPPING")).toBeTruthy();
    expect(screen.getByRole("link", { name: "GET /users" }).getAttribute("href")).toBe("/suites/1/runs/9");
    expect(screen.getByText(/not a diagnosis/)).toBeTruthy();
    expect(screen.getByText("Check whether the server is overloaded.")).toBeTruthy();
  });

  it("shows the error when the incident doesn't exist", async () => {
    show(404, { error: { message: "Incident 48 not found" } });
    expect(await screen.findByText("Incident 48 not found")).toBeTruthy();
  });
});
