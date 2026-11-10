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

/** A fake backend: answers depending on which address is requested. */
function fakeBackend(routes: Record<string, [number, unknown]>) {
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
  it("shows settings, a summary, recent checks, and incidents", async () => {
    fakeBackend({
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
    // 2 of 3 passed; average counts only successful checks: (300 + 100) / 2 = 200
    expect(screen.getByText("2 of the last 3 checks passed (67%)")).toBeTruthy();
    expect(screen.getByText(/average response 200 ms/)).toBeTruthy();
    expect(screen.getAllByText("OK")).toHaveLength(2);
    expect(screen.getAllByText("FAIL")).toHaveLength(1);
    expect(screen.getByText("2m 30s")).toBeTruthy(); // incident duration
  });

  it("shows the API's message when the website doesn't exist", async () => {
    fakeBackend({ "/api/endpoints/999": [404, { error: { code: "NOT_FOUND", message: "Endpoint 999 not found" } }] });
    renderAt("/endpoints/999");
    expect(await screen.findByText("Endpoint 999 not found")).toBeTruthy();
    expect(screen.getByRole("link", { name: "← All websites" })).toBeTruthy();
  });
});
