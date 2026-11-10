import { describe, expect, it } from "vitest";
import { formatDuration, formatTime, incidentEmail } from "../src/alerts/incident-email.js";

const incident = {
  id: 7,
  endpoint_id: 1,
  endpoint_name: "Payments API",
  endpoint_url: "https://pay.example.com/health",
  started_at: new Date("2026-11-10T20:37:53.215Z"),
  resolved_at: null,
  error_type: "timeout",
  error_message: "No response before the timeout",
};

describe("incidentEmail", () => {
  it("writes a DOWN email when an incident opens", () => {
    const email = incidentEmail("opened", incident);
    expect(email.subject).toBe("🔴 DOWN: Payments API");
    expect(email.text).toContain("https://pay.example.com/health");
    expect(email.text).toContain("Down since:  2026-11-10 20:37:53 UTC");
    expect(email.text).toContain("timeout: No response before the timeout");
    expect(email.text).toContain("not WHY"); // facts, not a guessed cause
  });

  it("writes a RECOVERED email with the downtime", () => {
    const resolved = { ...incident, resolved_at: new Date("2026-11-10T20:40:23.215Z") }; // +2m 30s
    const email = incidentEmail("resolved", resolved);
    expect(email.subject).toBe("✅ RECOVERED: Payments API (down 2m 30s)");
    expect(email.text).toContain("Recovered at: 2026-11-10 20:40:23 UTC");
  });

  it("works when there is no error message", () => {
    expect(incidentEmail("opened", { ...incident, error_message: null }).text).toContain("Reason:      timeout\n");
  });
});

describe("formatDuration", () => {
  it.each([
    [45_000, "45s"],
    [150_000, "2m 30s"],
    [3_900_000, "1h 5m"],
    [0, "0s"],
  ])("%i ms → %s", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});

describe("formatTime", () => {
  it("shows UTC clearly", () => {
    expect(formatTime(new Date("2026-01-02T03:04:05.999Z"))).toBe("2026-01-02 03:04:05 UTC");
  });
});
