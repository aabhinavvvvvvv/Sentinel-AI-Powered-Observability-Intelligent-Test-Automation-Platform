import { describe, expect, it } from "vitest";
import type { EndpointWithStatus } from "./api";
import { endpointStatus, formatDuration, runBadge, scheduleLabel, timeAgo } from "./status";

describe("runBadge", () => {
  it.each([
    ["passed", "up"],
    ["failed", "down"],
    ["error", "failing"],
    ["queued", "pending"],
    ["running", "pending"],
  ] as const)("%s → %s", (status, badge) => {
    expect(runBadge(status)).toBe(badge);
  });
});

describe("scheduleLabel", () => {
  it.each([
    [null, "Manual only"],
    [15, "Every 15 min"],
    [60, "Every 1 h"],
    [1440, "Every 24 h"],
  ])("%s → %s", (minutes, label) => {
    expect(scheduleLabel(minutes)).toBe(label);
  });
});

describe("formatDuration", () => {
  it.each([
    [45_000, "45s"],
    [150_000, "2m 30s"],
    [3_900_000, "1h 5m"],
  ])("%i ms → %s", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});

const base = { paused: false, last_check: null, open_incident: null } as unknown as EndpointWithStatus;
const check = (ok: boolean) => ({ ok, status_code: 200, response_time_ms: 100, error_type: null, checked_at: "" });

describe("endpointStatus", () => {
  it.each([
    ["paused wins over everything", { paused: true, last_check: check(true) }, "paused"],
    ["open incident → down", { open_incident: { id: 1, started_at: "", error_type: "x", error_message: null } }, "down"],
    ["never checked → pending", {}, "pending"],
    ["last check ok → up", { last_check: check(true) }, "up"],
    ["last check failed, no incident yet → failing", { last_check: check(false) }, "failing"],
  ])("%s", (_label, extra, expected) => {
    expect(endpointStatus({ ...base, ...extra } as EndpointWithStatus)).toBe(expected);
  });
});

describe("timeAgo", () => {
  const now = new Date("2026-11-10T12:00:00Z");
  it.each([
    ["2026-11-10T11:59:50Z", "10s ago"],
    ["2026-11-10T11:55:00Z", "5 min ago"],
    ["2026-11-10T09:00:00Z", "3 h ago"],
    ["2026-11-08T12:00:00Z", "2 d ago"],
  ])("%s → %s", (iso, text) => {
    expect(timeAgo(iso, now)).toBe(text);
  });
});
