/**
 * One suite: Run now, schedule, its test cases (add one by pasting JSON), and run history.
 */
import { useCallback, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, ApiError } from "../api";
import { formatDuration, localTime, runBadge, scheduleLabel } from "../status";
import { usePolling } from "../usePolling";
import { SCHEDULE_OPTIONS } from "./Suites";

// A ready-to-edit example, so nobody has to remember the format.
const EXAMPLE_CASE = JSON.stringify(
  {
    name: "Get user 1",
    method: "GET",
    url: "https://jsonplaceholder.typicode.com/users/1",
    assertions: [
      { type: "status_equals", value: 200 },
      { type: "json_path_equals", path: "id", value: 1 },
      { type: "response_time_below_ms", value: 2000 },
    ],
  },
  null,
  2,
);

export function SuiteDetail() {
  const id = Number(useParams().id);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    const [suite, runs, priority] = await Promise.all([api.getSuite(id), api.listRuns(id), api.getPriority(id)]);
    return { suite, runs, priority };
  }, [id]);
  // Refresh every 3 s so a running suite's status updates quickly.
  const { data, error, refresh } = usePolling(load, 3000);

  const [caseJson, setCaseJson] = useState(EXAMPLE_CASE);
  const [caseErrors, setCaseErrors] = useState<string[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);

  async function act(action: () => Promise<unknown>) {
    setActionError(null);
    try {
      await action();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
    void refresh();
  }

  async function addCase(event: FormEvent) {
    event.preventDefault();
    setCaseErrors([]);
    try {
      await api.addCase(id, caseJson);
      void refresh();
    } catch (err) {
      setCaseErrors(
        err instanceof ApiError && err.details.length > 0
          ? err.details.map((d) => `${d.field || "(top level)"}: ${d.message}`)
          : [err instanceof Error ? err.message : String(err)],
      );
    }
  }

  async function removeSuite() {
    if (!window.confirm("Delete this suite, its test cases, and all its runs?")) return;
    await act(() => api.deleteSuite(id));
    navigate("/suites");
  }

  const back = <Link to="/suites">← All suites</Link>;
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
  const { suite, runs, priority } = data;
  const trouble = priority.endpoint;

  return (
    <main>
      {back}
      <header>
        <h1>{suite.name}</h1>
        <span className="muted">{scheduleLabel(suite.schedule_minutes)}</span>
      </header>
      {actionError && <p className="error">{actionError}</p>}

      <section>
        <div className="toolbar">
          <h2>Run</h2>
          <label className="muted small">
            Schedule{" "}
            <select
              value={suite.schedule_minutes ?? ""}
              onChange={(e) =>
                void act(() => api.updateSuite(id, { schedule_minutes: e.target.value === "" ? null : Number(e.target.value) }))
              }
            >
              {SCHEDULE_OPTIONS.map((m) => (
                <option key={String(m)} value={m ?? ""}>
                  {scheduleLabel(m)}
                </option>
              ))}
            </select>
          </label>
          <button disabled={suite.cases.length === 0} onClick={() => void act(() => api.runSuite(id))}>
            Run now
          </button>
          <button disabled={suite.cases.length === 0} onClick={() => void act(() => api.runSuite(id, "priority"))}>
            Run in suggested order
          </button>
          <button className="danger" onClick={() => void removeSuite()}>
            Delete suite
          </button>
        </div>
        {suite.cases.length === 0 && <p className="muted">Add a test case below before running.</p>}
        <p className="muted small">
          ⚠️ Tests send real requests (a DELETE test really deletes). Point them at test environments.
        </p>
      </section>

      {priority.cases.length > 0 && (
        <section>
          <h2>Suggested order</h2>
          <p className="muted small">
            Tests most likely to fail first, with the reasons. Scores are points, not probabilities. Every test still
            runs.
          </p>
          {(trouble.open_incident || trouble.failed_checks_last_hour > 0) && (
            <p className="warning">
              ⚠️ The endpoint is in trouble right now
              {trouble.open_incident && " (open incident)"}
              {trouble.failed_checks_last_hour > 0 && ` (${trouble.failed_checks_last_hour} failed health checks in the last hour)`}
              : a good time to run this suite.
            </p>
          )}
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Test</th>
                <th>Score</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {priority.cases.map((c, i) => (
                <tr key={c.case_id}>
                  <td>
                    {i + 1}
                    {c.position !== i + 1 && <span className="muted small"> (normally {c.position})</span>}
                  </td>
                  <td>{c.name}</td>
                  <td>{c.score}</td>
                  <td className="small">
                    {c.reasons.length > 0 ? c.reasons.join("; ") : <span className="muted">No recent failures</span>}
                    {c.warning && <div className="warning">⚠️ {c.warning}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section>
        <h2>Run history</h2>
        {runs.length === 0 ? (
          <p className="muted">No runs yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Run</th>
                <th>Result</th>
                <th>Passed</th>
                <th>Started</th>
                <th>Took</th>
                <th>By</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link to={`/suites/${id}/runs/${r.id}`}>#{r.id}</Link>
                  </td>
                  <td>
                    <span className={`badge ${runBadge(r.status)}`}>{r.status.toUpperCase()}</span>
                  </td>
                  <td>{r.total > 0 ? `${r.passed} of ${r.total}` : "—"}</td>
                  <td>{localTime(r.created_at)}</td>
                  <td>
                    {r.started_at && r.finished_at
                      ? formatDuration(new Date(r.finished_at).getTime() - new Date(r.started_at).getTime())
                      : "—"}
                  </td>
                  <td className="muted">
                    {r.triggered_by}
                    {r.run_order === "priority" && " · suggested order"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>Test cases ({suite.cases.length})</h2>
        {suite.cases.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Request</th>
                <th>Checks</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {suite.cases.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td className="small">
                    <strong>{c.method}</strong> {c.url}
                  </td>
                  <td className="small">{c.assertions.map((a) => a.type).join(", ")}</td>
                  <td className="actions">
                    <button
                      className="danger"
                      onClick={() => {
                        if (window.confirm(`Delete test case "${c.name}"?`)) void act(() => api.deleteCase(id, c.id));
                      }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <h3>Add a test case</h3>
        <p className="muted small">
          Paste or edit the JSON. Check types: status_equals, response_time_below_ms, header_contains, body_contains,
          json_path_exists, json_path_equals (see README).
        </p>
        <form onSubmit={addCase}>
          <textarea
            className="json-editor"
            aria-label="Test case JSON"
            value={caseJson}
            onChange={(e) => setCaseJson(e.target.value)}
            rows={14}
            spellCheck={false}
          />
          <button type="submit">Add test case</button>
          {caseErrors.length > 0 && (
            <ul className="error" role="alert">
              {caseErrors.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          )}
        </form>
      </section>
    </main>
  );
}
