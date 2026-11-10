/**
 * Writes the alert email for an incident. Pure function: data in, text out
 * (no database, no network), so it's easy to test.
 */
import type { Incident } from "../incidents/repository.js";

export type IncidentWithEndpoint = Incident & { endpoint_name: string; endpoint_url: string };

export function incidentEmail(
  kind: "opened" | "resolved",
  i: IncidentWithEndpoint,
): { subject: string; text: string } {
  const reason = i.error_message ? `${i.error_type}: ${i.error_message}` : i.error_type;

  if (kind === "opened") {
    return {
      subject: `🔴 DOWN: ${i.endpoint_name}`,
      text: [
        `Sentinel opened an incident for ${i.endpoint_name}.`,
        "",
        `URL:         ${i.endpoint_url}`,
        `Down since:  ${formatTime(i.started_at)}`,
        `Reason:      ${reason}`,
        "",
        "This is based on failed checks Sentinel measured.",
        "It tells you WHAT failed, not WHY. Investigate before assuming a cause.",
      ].join("\n"),
    };
  }

  const resolvedAt = i.resolved_at ?? new Date();
  const downFor = formatDuration(resolvedAt.getTime() - i.started_at.getTime());
  return {
    subject: `✅ RECOVERED: ${i.endpoint_name} (down ${downFor})`,
    text: [
      `${i.endpoint_name} is back up.`,
      "",
      `URL:          ${i.endpoint_url}`,
      `Down since:   ${formatTime(i.started_at)}`,
      `Recovered at: ${formatTime(resolvedAt)}`,
      `Downtime:     ${downFor}`,
      `Reason was:   ${reason}`,
    ].join("\n"),
  };
}

/** 2026-11-10T20:37:53.215Z → "2026-11-10 20:37:53 UTC". Emails can't know the reader's time zone. */
export function formatTime(date: Date): string {
  return `${date.toISOString().slice(0, 19).replace("T", " ")} UTC`;
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
