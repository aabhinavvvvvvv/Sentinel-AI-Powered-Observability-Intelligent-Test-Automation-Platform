/** "API tests" page: every suite with its last run and schedule, plus a form to create one. */
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { api, ApiError } from "../api";
import { runBadge, scheduleLabel, timeAgo } from "../status";
import { usePolling } from "../usePolling";

export const SCHEDULE_OPTIONS = [null, 15, 60, 360, 1440] as const;

export function Suites() {
  const suites = usePolling(api.listSuites);
  const endpoints = usePolling(api.listEndpoints, 60_000); // only needed for the form's dropdown
  const navigate = useNavigate();

  const [endpointId, setEndpointId] = useState("");
  const [name, setName] = useState("");
  const [schedule, setSchedule] = useState("");
  const [errors, setErrors] = useState<string[]>([]);

  async function create(event: FormEvent) {
    event.preventDefault();
    setErrors([]);
    try {
      const suite = await api.createSuite({
        endpoint_id: Number(endpointId),
        name,
        schedule_minutes: schedule === "" ? null : Number(schedule),
      });
      navigate(`/suites/${suite.id}`); // go straight to the new suite to add test cases
    } catch (err) {
      setErrors(
        err instanceof ApiError && err.details.length > 0
          ? err.details.map((d) => `${d.field}: ${d.message}`)
          : [err instanceof Error ? err.message : String(err)],
      );
    }
  }

  return (
    <main>
      <header>
        <h1>API tests</h1>
        <span className="muted">Suites of request + assertion checks, run on demand or on a schedule</span>
      </header>
      {suites.error && <p className="error">Can't reach the API: {suites.error}</p>}

      <section>
        <h2>Suites</h2>
        {suites.data?.length === 0 && <p className="muted">No suites yet. Create one below.</p>}
        {suites.data && suites.data.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Suite</th>
                <th>Website</th>
                <th>Cases</th>
                <th>Schedule</th>
                <th>Last run</th>
              </tr>
            </thead>
            <tbody>
              {suites.data.map((s) => (
                <tr key={s.id}>
                  <td>
                    <Link to={`/suites/${s.id}`}>{s.name}</Link>
                  </td>
                  <td>{s.endpoint_name}</td>
                  <td>{s.case_count}</td>
                  <td>{scheduleLabel(s.schedule_minutes)}</td>
                  <td>
                    {s.last_run ? (
                      <>
                        <span className={`badge ${runBadge(s.last_run.status)}`}>{s.last_run.status.toUpperCase()}</span>{" "}
                        <span className="muted small">
                          {s.last_run.passed}✓ {s.last_run.failed}✗ · {timeAgo(s.last_run.created_at)}
                        </span>
                      </>
                    ) : (
                      <span className="muted">never run</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>New suite</h2>
        <form className="add-form" onSubmit={create}>
          <label>
            Website
            <select value={endpointId} onChange={(e) => setEndpointId(e.target.value)}>
              <option value="">Choose…</option>
              {endpoints.data?.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name} ({e.url})
                </option>
              ))}
            </select>
          </label>
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Users API" />
          </label>
          <label>
            Run
            <select value={schedule} onChange={(e) => setSchedule(e.target.value)}>
              {SCHEDULE_OPTIONS.map((m) => (
                <option key={String(m)} value={m ?? ""}>
                  {scheduleLabel(m)}
                </option>
              ))}
            </select>
          </label>
          <button type="submit">Create suite</button>
          {errors.length > 0 && (
            <ul className="error" role="alert">
              {errors.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          )}
        </form>
      </section>
    </main>
  );
}
