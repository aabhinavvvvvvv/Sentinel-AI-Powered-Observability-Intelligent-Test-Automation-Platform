/**
 * Line chart of response time over time: P50 (normal speed) and P95 (slow cases).
 * Buckets with no checks are null, and the line breaks there (a gap = "no data").
 */
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { StatsRange, TimeseriesPoint } from "../api";
import { bucketLabel } from "../status";

// Series colours: slots 1 and 2 of the reference palette. Checked with the palette
// validator on our white card: colour-blind separation ΔE 24.7 (target ≥ 8), both ≥ 3:1 contrast.
const SERIES = [
  { key: "p50", name: "P50", color: "#2a78d6" },
  { key: "p95", name: "P95", color: "#eb6834" },
] as const;
// Text and grid use the page's text/border colours (from styles.css), never the series colours.
const TEXT = "#1d2330";
const MUTED = "#6b7280";
const GRID = "#e3e6eb";

export function LatencyChart({ points, range }: { points: TimeseriesPoint[]; range: StatsRange }) {
  const data = points.map((p) => ({ label: bucketLabel(p.time, range), p50: p.p50_ms, p95: p.p95_ms }));

  // Index of the last point that has a value, so the line's name can be written at its end.
  const lastIndex = (key: "p50" | "p95") => data.findLastIndex((d) => d[key] !== null);

  return (
    <ResponsiveContainer width="100%" height={260} initialDimension={{ width: 600, height: 260 }}>
      <LineChart data={data} margin={{ top: 8, right: 48, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis dataKey="label" tick={{ fill: MUTED, fontSize: 12 }} stroke={GRID} minTickGap={24} />
        <YAxis tick={{ fill: MUTED, fontSize: 12 }} stroke={GRID} width={64} tickFormatter={(v: number) => `${v} ms`} />
        <Tooltip
          formatter={(value) => (value === null || value === undefined ? "no data" : `${value} ms`)}
          itemStyle={{ color: TEXT }}
          labelStyle={{ color: MUTED }}
        />
        <Legend formatter={(value: string) => <span style={{ color: TEXT }}>{value}</span>} />
        {SERIES.map((s) => (
          <Line
            key={s.key}
            dataKey={s.key}
            name={s.name}
            stroke={s.color}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            connectNulls={false} // break the line where there's no data
            dot={{ r: 4, fill: s.color, stroke: "#ffffff", strokeWidth: 2 }} // visible even for a lone point
            activeDot={{ r: 6, stroke: "#ffffff", strokeWidth: 2 }}
            isAnimationActive={false} // no re-animation on every 10 s refresh
            label={(props: { index?: number; x?: number | string; y?: number | string }) =>
              props.index === lastIndex(s.key) ? (
                <text x={Number(props.x) + 10} y={Number(props.y) + 4} fill={TEXT} fontSize={12}>
                  {s.name}
                </text>
              ) : (
                <g />
              )
            }
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
