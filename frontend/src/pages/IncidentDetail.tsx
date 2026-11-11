/**
 * One incident's evidence: what failed, when, whether it was already slow, whether it keeps
 * coming back, which API tests failed at the same time, and what to check next.
 * Facts are measured; the suggestions are a generic checklist, clearly labelled as such.
 */
import { useCallback } from "react";
import { Link, useParams } from "react-router";
import { api } from "../api";
import { localTime } from "../status";
import { usePolling } from "../usePolling";

export function IncidentDetail() {
  const id = Number(useParams().id);
  const load = useCallback(() => api.getIncidentReport(id), [id]);
  const { data: r, error } = usePolling(load, 10_000); // an open incident keeps changing

  if (error && !r) return <main><Link to="/">← Overview</Link><p className="error">{error}</p></main>;
  if (!r) return <main><p className="muted">Loading…</p></main>;

  const { incident: i, window: w, failed_checks: fc, response_time_ms: rt, similar } = r;

  return (
    <main>
      <Link to={`/endpoints/${i.endpoint_id}`}>← {i.endpoint_name}</Link>
      <header>
        <h1>Incident #{i.id}</h1>
        <span className={`badge ${w.open ? "down" : "up"}`}>{w.open ? "ONGOING" : "RESOLVED"}</span>
        <span className="muted">{i.url}</span>
      </header>

      <section>
        <h2>What happened</h2>
        <p>
          From {localTime(w.from)} to {w.open ? "now" : localTime(w.to)} ({w.minutes} min).
          First error: <strong>{i.error_type}</strong>
          {i.error_message && <span className="muted"> · {i.error_message}</span>}
        </p>
        <p>
          {fc.total} failed check{fc.total === 1 ? "" : "s"} in this window
          {fc.by_type.length > 0 && ": "}
          {fc.by_type.map((t) => `${t.error_type} × ${t.count}`).join(", ")}
        </p>
      </section>

      <section>
        <h2>Was it already slow?</h2>
        {rt.p50_week_before === null ? (
          <p className="muted">No successful checks in the week before, so nothing to compare.</p>
        ) : (
          <p>
            Median response time of successful checks: {rt.p50_hour_before ?? "–"} ms in the hour before, vs{" "}
            {rt.p50_week_before} ms over the week before.
          </p>
        )}
      </section>

      <section>
        <h2>Has it happened before?</h2>
        <p>
          {similar.count} earlier <strong>{i.error_type}</strong> incident{similar.count === 1 ? "" : "s"} on this
          endpoint in the previous {similar.days} days
          {similar.median_minutes !== null && `, lasting ${similar.median_minutes} min (median)`}.
          {similar.flapping && <> <span className="badge down">FLAPPING</span></>}
        </p>
        <p className="muted small">
          Flapping = at least 3 similar incidents in {similar.days} days, lasting a median of 10 minutes or less.
        </p>
      </section>

      <section>
        <h2>API tests that failed during the incident</h2>
        {r.failing_tests.length === 0 ? (
          <p className="muted">None.</p>
        ) : (
          <ul className="results">
            {r.failing_tests.map((t) => (
              <li key={`${t.run_id}-${t.case_name}`}>
                <Link to={`/suites/${t.suite_id}/runs/${t.run_id}`}>{t.case_name}</Link>{" "}
                <span className="muted small">{localTime(t.at)}</span>
                {t.message && <div className="error small">↳ {t.message}</div>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>What to check next</h2>
        <p className="muted small">Suggestions for this kind of failure, not a diagnosis.</p>
        <ul>
          {r.suggestions.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      </section>
    </main>
  );
}
