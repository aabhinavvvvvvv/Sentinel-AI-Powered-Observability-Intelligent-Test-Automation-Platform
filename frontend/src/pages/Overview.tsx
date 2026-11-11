/**
 * The main page: open incidents, every website with its status, and a form to add one.
 * Data refreshes every 10 seconds (usePolling).
 */
import { useState } from "react";
import { Link } from "react-router";
import { api, type EndpointWithStatus } from "../api";
import { AddEndpointForm } from "../components/AddEndpointForm";
import { endpointStatus, localTime, STATUS_LABEL, timeAgo } from "../status";
import { usePolling } from "../usePolling";

export function Overview() {
  const endpoints = usePolling(api.listEndpoints);
  const incidents = usePolling(api.listOpenIncidents);
  const [actionError, setActionError] = useState<string | null>(null);

  function refreshAll() {
    void endpoints.refresh();
    void incidents.refresh();
  }

  // Run a button's action; show an error if it fails, and refresh the data either way.
  async function act(action: () => Promise<unknown>) {
    setActionError(null);
    try {
      await action();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
    refreshAll();
  }

  function remove(e: EndpointWithStatus) {
    if (window.confirm(`Delete "${e.name}" and all of its history?`)) void act(() => api.deleteEndpoint(e.id));
  }

  return (
    <main>
      <header>
        <h1>Websites</h1>
        <span className="muted">Refreshes every 10 seconds · times shown in your time zone</span>
      </header>

      {endpoints.error && <p className="error">Can't reach the API: {endpoints.error}</p>}
      {actionError && <p className="error">{actionError}</p>}

      <section>
        <h2>Open incidents</h2>
        {incidents.data?.length === 0 && <p className="muted">None. Everything is up. 🎉</p>}
        <ul className="incidents">
          {incidents.data?.map((i) => (
            <li key={i.id}>
              <strong>
                🔴 <Link to={`/endpoints/${i.endpoint_id}`}>{i.endpoint_name}</Link>
              </strong>{" "}
              down since {localTime(i.started_at)} ({timeAgo(i.started_at)})
              <span className="muted"> · {i.error_message ?? i.error_type}</span> ·{" "}
              <Link to={`/incidents/${i.id}`}>evidence</Link>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>Websites</h2>
        {endpoints.data?.length === 0 && <p className="muted">No websites yet. Add one below.</p>}
        {endpoints.data && endpoints.data.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Status</th>
                <th>Website</th>
                <th>Last check</th>
                <th>Checked</th>
                <th>Every</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {endpoints.data.map((e) => {
                const status = endpointStatus(e);
                return (
                  <tr key={e.id}>
                    <td>
                      <span className={`badge ${status}`}>{STATUS_LABEL[status]}</span>
                    </td>
                    <td>
                      <Link to={`/endpoints/${e.id}`}>{e.name}</Link>
                      <div className="muted small">{e.url}</div>
                    </td>
                    <td>
                      {e.last_check === null
                        ? "—"
                        : e.last_check.ok
                          ? `${e.last_check.response_time_ms} ms`
                          : (e.last_check.error_type ?? "failed")}
                    </td>
                    <td>{e.last_check ? timeAgo(e.last_check.checked_at) : "never"}</td>
                    <td>{e.interval_seconds < 60 ? `${e.interval_seconds} s` : `${e.interval_seconds / 60} min`}</td>
                    <td className="actions">
                      <button onClick={() => void act(() => api.setPaused(e.id, !e.paused))}>
                        {e.paused ? "Resume" : "Pause"}
                      </button>
                      <button className="danger" onClick={() => remove(e)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>Add a website</h2>
        <AddEndpointForm onCreated={refreshAll} />
      </section>
    </main>
  );
}
