/** Draws the stats panel with a fake backend and checks the cards, the range switch, and the table. */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StatsPanel } from "./StatsPanel";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const stats = (window: string) => ({
  window,
  from: "2026-11-10T00:00:00Z",
  to: "2026-11-11T00:00:00Z",
  checks_total: 38,
  checks_ok: 32,
  uptime_percent: 84.21,
  response_time_ms: { p50: 285, p95: 341, p99: 351 },
  failures_by_type: [{ error_type: "timeout", count: 6 }],
});
const series = (window: string) => ({
  window,
  bucket: "1 hour",
  points: [
    { time: "2026-11-10T20:00:00Z", checks_total: 0, checks_ok: 0, uptime_percent: null, p50_ms: null, p95_ms: null },
    { time: "2026-11-10T21:00:00Z", checks_total: 27, checks_ok: 25, uptime_percent: 92.59, p50_ms: 263, p95_ms: 341 },
  ],
});

function setup() {
  // jsdom (the fake browser) has no ResizeObserver; the chart only needs it to exist.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const fetchMock = vi.fn(async (url: string) => {
    const window = new URL(url, "http://x").searchParams.get("window")!;
    const body = url.includes("/timeseries") ? series(window) : stats(window);
    return new Response(JSON.stringify(body), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<StatsPanel endpointId={23} />);
  return fetchMock;
}

describe("StatsPanel", () => {
  it("shows uptime with what it counted, the percentiles, and failures", async () => {
    setup();
    expect(await screen.findByText("84.21%")).toBeTruthy();
    expect(screen.getByText("32 of 38 checks passed")).toBeTruthy();
    expect(screen.getByText("285 ms")).toBeTruthy();
    expect(screen.getAllByText("341 ms").length).toBeGreaterThan(0); // P95 card (+ table)
    expect(screen.getByText("351 ms")).toBeTruthy();
    expect(screen.getByText("timeout × 6")).toBeTruthy();
  });

  it("asks for 24h first, then the chosen range", async () => {
    const fetchMock = setup();
    await screen.findByText("84.21%");
    expect(fetchMock.mock.calls.map((c) => c[0])).toContain("/api/endpoints/23/stats?window=24h");

    fireEvent.click(screen.getByRole("button", { name: "7 days" }));
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.map((c) => c[0])).toContain("/api/endpoints/23/timeseries?window=7d"),
    );
  });

  it("the table shows empty buckets as 'no data', not as up", async () => {
    setup();
    await screen.findByText("84.21%");
    expect(screen.getByText("no data")).toBeTruthy();
    expect(screen.getByText("92.59%")).toBeTruthy();
  });
});
