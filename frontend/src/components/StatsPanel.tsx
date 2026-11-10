/**
 * "Performance" section of the detail page: a 24h / 7d / 30d switch, number cards,
 * the latency chart, and the same chart data as a table.
 */
import { useCallback, useState } from "react";
import { api, type StatsRange } from "../api";
import { bucketLabel } from "../status";
import { usePolling } from "../usePolling";
import { LatencyChart } from "./LatencyChart";

const RANGES: { value: StatsRange; label: string }[] = [
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
];

const ms = (value: number | null) => (value === null ? "—" : `${value} ms`);

export function StatsPanel({ endpointId }: { endpointId: number }) {
  const [range, setRange] = useState<StatsRange>("24h");

  const load = useCallback(async () => {
    const [stats, series] = await Promise.all([
      api.getStats(endpointId, range),
      api.getTimeseries(endpointId, range),
    ]);
    return { stats, series };
  }, [endpointId, range]);
  const { data, error } = usePolling(load);

  // After switching range, ignore the old range's data until the new one arrives.
  const current = data && data.stats.window === range ? data : null;

  return (
    <section>
      <div className="toolbar">
        <h2>Performance</h2>
        {RANGES.map((r) => (
          <button key={r.value} className={r.value === range ? "active" : ""} onClick={() => setRange(r.value)}>
            {r.label}
          </button>
        ))}
      </div>

      {error && <p className="error">{error}</p>}
      {!current && !error && <p className="muted">Loading…</p>}

      {current && (
        <>
          <div className="cards">
            <div className="card">
              <div className="card-label">Uptime</div>
              <div className="card-value">
                {current.stats.uptime_percent === null ? "—" : `${current.stats.uptime_percent}%`}
              </div>
              <div className="muted small">
                {current.stats.checks_total === 0
                  ? "no checks in this period"
                  : `${current.stats.checks_ok} of ${current.stats.checks_total} checks passed`}
              </div>
            </div>
            <div className="card">
              <div className="card-label">P50</div>
              <div className="card-value">{ms(current.stats.response_time_ms.p50)}</div>
              <div className="muted small">half of checks were faster</div>
            </div>
            <div className="card">
              <div className="card-label">P95</div>
              <div className="card-value">{ms(current.stats.response_time_ms.p95)}</div>
              <div className="muted small">95% were faster</div>
            </div>
            <div className="card">
              <div className="card-label">P99</div>
              <div className="card-value">{ms(current.stats.response_time_ms.p99)}</div>
              <div className="muted small">99% were faster</div>
            </div>
            <div className="card">
              <div className="card-label">Failures</div>
              {current.stats.failures_by_type.length === 0 ? (
                <div className="card-value">0</div>
              ) : (
                current.stats.failures_by_type.map((f) => (
                  <div key={f.error_type}>
                    {f.error_type} × {f.count}
                  </div>
                ))
              )}
            </div>
          </div>

          <h3>Response time over time</h3>
          <LatencyChart points={current.series.points} range={range} />

          {/* Every chart value is also readable here, without hovering. */}
          <details>
            <summary>Show chart data as a table</summary>
            <table>
              <thead>
                <tr>
                  <th>From ({current.series.bucket})</th>
                  <th>Checks</th>
                  <th>Uptime</th>
                  <th>P50</th>
                  <th>P95</th>
                </tr>
              </thead>
              <tbody>
                {current.series.points.map((p) => (
                  <tr key={p.time}>
                    <td>{bucketLabel(p.time, range)}</td>
                    <td>{p.checks_total === 0 ? "no data" : p.checks_total}</td>
                    <td>{p.uptime_percent === null ? "—" : `${p.uptime_percent}%`}</td>
                    <td>{ms(p.p50_ms)}</td>
                    <td>{ms(p.p95_ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>

          <p className="muted small">
            Uptime = passed checks ÷ all checks in this period. Speeds use successful checks only. Gaps in the chart
            mean no checks ran (e.g. paused), not "up".
          </p>
        </>
      )}
    </section>
  );
}
