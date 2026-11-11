/**
 * Small pure helpers: turn backend data into what the page shows.
 * No React here, so they're easy to test.
 */
import type { EndpointWithStatus } from "./api";

export type Status = "up" | "down" | "failing" | "paused" | "pending";

export const STATUS_LABEL: Record<Status, string> = {
  up: "UP",
  down: "DOWN",
  failing: "FAILING",
  paused: "PAUSED",
  pending: "PENDING",
};

/**
 * What one word best describes this endpoint right now?
 *   paused   – checks are switched off
 *   down     – an incident is open (N failures in a row)
 *   failing  – the last check failed, but not enough in a row for an incident yet
 *   pending  – never checked yet
 *   up       – the last check worked
 */
export function endpointStatus(e: EndpointWithStatus): Status {
  if (e.paused) return "paused";
  if (e.open_incident) return "down";
  if (!e.last_check) return "pending";
  return e.last_check.ok ? "up" : "failing";
}

/** "2026-11-10T21:08:33Z" → "5 min ago" (relative to `now`). */
export function timeAgo(iso: string, now: Date = new Date()): string {
  const seconds = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86_400)} d ago`;
}

/** 150000 ms → "2m 30s", 3900000 ms → "1h 5m", 45000 ms → "45s". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** Which badge colour a test run gets: passed = green, failed = red, error = amber, in progress = grey. */
export function runBadge(status: "queued" | "running" | "passed" | "failed" | "error"): Status {
  if (status === "passed") return "up";
  if (status === "failed") return "down";
  if (status === "error") return "failing";
  return "pending";
}

/** schedule_minutes → words: null → "Manual only", 60 → "Every 1 h", 15 → "Every 15 min". */
export function scheduleLabel(minutes: number | null): string {
  if (minutes === null) return "Manual only";
  return minutes % 60 === 0 ? `Every ${minutes / 60} h` : `Every ${minutes} min`;
}

/** A chart bucket's start time as a short label, in the viewer's time zone. */
export function bucketLabel(iso: string, range: "24h" | "7d" | "30d"): string {
  const date = new Date(iso);
  if (range === "24h") return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (range === "7d") return date.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** Show a UTC timestamp in the viewer's own time zone, e.g. "11/11/2026, 02:38:33". */
export function localTime(iso: string): string {
  return new Date(iso).toLocaleString();
}
