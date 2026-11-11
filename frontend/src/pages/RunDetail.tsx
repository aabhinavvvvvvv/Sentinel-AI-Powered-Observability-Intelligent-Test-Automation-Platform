/** One test run: overall result, then every test case with its reasons for failing. */
import { useCallback } from "react";
import { Link, useParams } from "react-router";
import { api } from "../api";
import { localTime, runBadge } from "../status";
import { usePolling } from "../usePolling";

export function RunDetail() {
  const params = useParams();
  const suiteId = Number(params.id);
  const runId = Number(params.runId);

  const load = useCallback(() => api.getRun(suiteId, runId), [suiteId, runId]);
  const { data: run, error } = usePolling(load, 3000); // updates while the run is still going

  const back = <Link to={`/suites/${suiteId}`}>← Back to suite</Link>;
  if (error && !run) {
    return (
      <main>
        {back}
        <p className="error">{error}</p>
      </main>
    );
  }
  if (!run) {
    return (
      <main>
        {back}
        <p className="muted">Loading…</p>
      </main>
    );
  }

  const inProgress = run.status === "queued" || run.status === "running";

  return (
    <main>
      {back}
      <header>
        <h1>Run #{run.id}</h1>
        <span className={`badge ${runBadge(run.status)}`}>{run.status.toUpperCase()}</span>
        <span className="muted">
          {run.triggered_by} · {localTime(run.created_at)}
        </span>
      </header>

      <section>
        {inProgress && <p className="muted">Running… this page updates by itself.</p>}
        {run.error_message && <p className="error">The run itself failed: {run.error_message}</p>}
        {!inProgress && run.total > 0 && (
          <p>
            <strong>
              {run.passed} of {run.total} test cases passed
            </strong>
            {run.failed > 0 && <span className="error"> · {run.failed} failed</span>}
          </p>
        )}

        <ul className="results">
          {run.results.map((r) => (
            <li key={r.id}>
              <div>
                <span className={`badge ${r.passed ? "up" : "down"}`}>{r.passed ? "PASS" : "FAIL"}</span>{" "}
                <strong>{r.case_name}</strong>{" "}
                <span className="muted small">
                  {r.status_code !== null ? `HTTP ${r.status_code}` : "no response"} · {r.response_time_ms} ms
                  {r.case_id === null && " · (test case deleted since)"}
                </span>
              </div>
              {r.error_message && <div className="error small">↳ {r.error_message}</div>}
              {r.failures.map((f, i) => (
                <div key={i} className="error small">
                  ↳ {f.message}
                </div>
              ))}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
