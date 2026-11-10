/**
 * One website: settings, a short summary, recent checks, and incident history.
 * Address: /endpoints/:id. Refreshes every 10 seconds.
 */
import { useCallback, useState } from "react";
import { Link, useParams } from "react-router";
import { api } from "../api";
import { endpointStatus, formatDuration, localTime, STATUS_LABEL, timeAgo } from "../status";
import { usePolling } from "../usePolling";

const CHECKS_SHOWN = 50;

export function EndpointDetail() {
  const id = Number(useParams().id); // "23" from the address → 23

  // Load all three things at once. useCallback keeps the same function until `id` changes,
  // so usePolling doesn't restart its timer on every redraw.
  const load = useCallback(async () => {
    const [endpoint, checks, incidents] = await Promise.all([
      api.getEndpoint(id),
      api.listChecks(id, CHECKS_SHOWN),
      api.listIncidentsFor(id),
    ]);
    return { endpoint, checks, incidents };
  }, [id]);
  const { data, error, refresh } = usePolling(load);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setActionError(null);
    try {
      await action();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
    setBusy(false);
    void refresh();
  }

  const back = <Link to="/">← All websites</Link>;
  if (error && !data) {
    return (
      <main>
        {back}
        <p className="error">{error}</p>
      </main>
    );
  }
  if (!data) {
    return (
      <main>
        {back}
        <p className="muted">Loading…</p>
      </main>
    );
  }

  const { endpoint, checks, incidents } = data;
  const status = endpointStatus({
    ...endpoint,
    last_check: checks[0] ?? null,
    open_incident: incidents.find((i) => i.resolved_at === null) ?? null,
  });
  const passed = checks.filter((c) => c.ok).length;
  const okTimes = checks.filter((c) => c.ok).map((c) => c.response_time_ms);
  const avgMs = okTimes.length > 0 ? Math.round(okTimes.reduce((a, b) => a + b, 0) / okTimes.length) : null;

  return (
    <main>
      {back}
      <header>
        <h1>{endpoint.name}</h1>
        <span className={`badge ${status}`}>{STATUS_LABEL[status]}</span>
        <span className="muted small">{endpoint.url}</span>
      </header>
      {actionError && <p className="error">{actionError}</p>}

      <section>
        <div className="toolbar">
          <h2>Settings</h2>
          <button disabled={busy} onClick={() => void act(() => api.checkNow(id))}>
            {busy ? "Working…" : "Check now"}
          </button>
          <button disabled={busy} onClick={() => void act(() => api.setPaused(id, !endpoint.paused))}>
            {endpoint.paused ? "Resume" : "Pause"}
          </button>
        </div>
        <dl className="settings">
          <dt>Method</dt>
          <dd>{endpoint.method}</dd>
          <dt>Check every</dt>
          <dd>{endpoint.interval_seconds} s</dd>
          <dt>Timeout</dt>
          <dd>{endpoint.timeout_ms} ms</dd>
          <dt>Expected status</dt>
          <dd>{endpoint.expected_status}</dd>
          <dt>Retries</dt>
          <dd>{endpoint.max_retries}</dd>
          <dt>Incident after</dt>
          <dd>{endpoint.failure_threshold} failed checks in a row</dd>
        </dl>
      </section>

      <section>
        <h2>Summary</h2>
        {checks.length === 0 ? (
          <p className="muted">No checks yet.</p>
        ) : (
          <p>
            {/* Say exactly what we counted, so the number can't be misread. */}
            <strong>
              {passed} of the last {checks.length} checks passed ({Math.round((passed / checks.length) * 100)}%)
            </strong>
            {avgMs !== null && <> · average response {avgMs} ms (successful checks only)</>}
          </p>
        )}
      </section>

      <section>
        <h2>Recent checks</h2>
        {checks.length === 0 ? (
          <p className="muted">No checks yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Result</th>
                <th>Status code</th>
                <th>Response</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {checks.map((c) => (
                <tr key={c.id}>
                  <td title={timeAgo(c.checked_at)}>{localTime(c.checked_at)}</td>
                  <td>
                    <span className={`badge ${c.ok ? "up" : "down"}`}>{c.ok ? "OK" : "FAIL"}</span>
                  </td>
                  <td>{c.status_code ?? "—"}</td>
                  <td>{c.response_time_ms} ms</td>
                  <td className="small">{c.error_message ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>Incidents</h2>
        {incidents.length === 0 ? (
          <p className="muted">No incidents. 🎉</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Started</th>
                <th>Ended</th>
                <th>Duration</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {incidents.map((i) => (
                <tr key={i.id}>
                  <td>{localTime(i.started_at)}</td>
                  <td>{i.resolved_at ? localTime(i.resolved_at) : <strong className="error">ongoing</strong>}</td>
                  <td>
                    {formatDuration(
                      (i.resolved_at ? new Date(i.resolved_at).getTime() : Date.now()) -
                        new Date(i.started_at).getTime(),
                    )}
                  </td>
                  <td className="small">{i.error_message ?? i.error_type}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
