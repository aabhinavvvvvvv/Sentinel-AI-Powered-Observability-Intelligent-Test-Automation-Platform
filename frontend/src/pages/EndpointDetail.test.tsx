/** Draws the detail page with a fake backend (fake `fetch`) and checks what the user sees. */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EndpointDetail } from "./EndpointDetail";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const endpoint = {
  id: 23,
  name: "Portfolio",
  url: "https://www.example.com/",
  method: "GET",
  interval_seconds: 30,
  timeout_ms: 5000,
  expected_status: 200,
  max_retries: 0,
  failure_threshold: 3,
  paused: false,
};
const check = (id: number, ok: boolean, ms: number) => ({
  id,
  endpoint_id: 23,
  ok,
  status_code: ok ? 200 : 307,
  response_time_ms: ms,
  error_type: ok ? null : "unexpected_status",
  error_message: ok ? null : "Expected status 200, got 307",
  checked_at: "2026-11-10T21:00:00Z",
});

/** A fake backend: answers depending on which address is requested (first matching prefix wins). */
function fakeBackend(routes: Record<string, [number, unknown]>) {
  // jsdom has no ResizeObserver; the chart only needs it to exist.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const match = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
      const [status, body] = match ? match[1] : [404, { error: { message: "not found" } }];
      return new Response(JSON.stringify(body), { status });
    }),
  );
}

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/endpoints/:id" element={<EndpointDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("EndpointDetail", () => {
  it("shows settings, performance, recent checks, and incidents", async () => {
    fakeBackend({
      "/api/endpoints/23/stats": [
        200,
        {
          window: "24h",
          checks_total: 3,
          checks_ok: 2,
          uptime_percent: 66.67,
          response_time_ms: { p50: 100, p95: 300, p99: 300 },
          failures_by_type: [{ error_type: "unexpected_status", count: 1 }],
        },
      ],
      "/api/endpoints/23/timeseries": [200, { window: "24h", bucket: "1 hour", points: [] }],
      "/api/endpoints/23/anomalies": [
        200,
        [
          {
            id: 1,
            endpoint_id: 23,
            metric: "P50 response time",
            bucket_start: "2026-11-10T20:00:00Z",
            value: 900,
            baseline: 240,
            score: 445.2,
            severity: "critical",
            explanation: "P50 response time was 900 ms ... This is a statistical signal, not a diagnosis.",
            method: "robust_z_v1",
          },
          {
            id: 2,
            endpoint_id: 23,
            metric: "P50 response time",
            bucket_start: "2026-11-10T21:00:00Z",
            value: 330,
            baseline: 250,
            score: 1.32,
            severity: "warning",
            explanation: "Isolation Forest (machine learning, shadow mode) flagged this hour ...",
            method: "isolation_forest_v2",
          },
        ],
      ],
      "/api/endpoints/23/checks": [200, [check(3, true, 300), check(2, true, 100), check(1, false, 50)]],
      "/api/endpoints/23": [200, endpoint],
      "/api/incidents": [
        200,
        [
          {
            id: 1,
            endpoint_id: 23,
            endpoint_name: "Portfolio",
            started_at: "2026-11-10T20:00:00Z",
            resolved_at: "2026-11-10T20:02:30Z",
            error_type: "unexpected_status",
            error_message: "Expected status 200, got 307",
          },
        ],
      ],
    });
    renderAt("/endpoints/23");

    expect(await screen.findByRole("heading", { name: "Portfolio" })).toBeTruthy();
    expect(screen.getByText("UP")).toBeTruthy(); // newest check passed, no open incident
    expect(await screen.findByText("66.67%")).toBeTruthy(); // performance panel loaded
    expect(screen.getByText("2 of 3 checks passed")).toBeTruthy();
    expect(screen.getAllByText("OK")).toHaveLength(2);
    expect(screen.getAllByText("FAIL")).toHaveLength(1);
    expect(screen.getByText("2m 30s")).toBeTruthy(); // incident duration
    // Anomaly: measured value vs normal, and labelled as a signal, not a diagnosis.
    expect(screen.getByText(/900 ms vs normal 240 ms/)).toBeTruthy();
    expect(screen.getByText(/statistical signal, not a diagnosis/)).toBeTruthy();
    // Each finding says who found it; only the shadow (still-being-evaluated) one has the SHADOW tag.
    expect(screen.getByText(/Found by: Statistics · previous 24 h/)).toBeTruthy();
    expect(screen.getByText(/Found by: Machine learning · Isolation Forest/)).toBeTruthy();
    // Count only the SHADOW tags (<span>), not the word in the explanation sentence (<strong>).
    expect(screen.getAllByText("SHADOW", { selector: "span" })).toHaveLength(1);
  });

  it("shows the API's message when the website doesn't exist", async () => {
    fakeBackend({ "/api/endpoints/999": [404, { error: { code: "NOT_FOUND", message: "Endpoint 999 not found" } }] });
    renderAt("/endpoints/999");
    expect(await screen.findByText("Endpoint 999 not found")).toBeTruthy();
    expect(screen.getByRole("link", { name: "← All websites" })).toBeTruthy();
  });
});
