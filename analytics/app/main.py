"""
Sentinel analytics service (Python + FastAPI).

The Node backend stays in charge of everything. This small service only does
number-crunching that Python is best at (Pandas now, machine learning later).
It reads from PostgreSQL but never writes: it returns findings, and Node saves them.
"""

from fastapi import FastAPI, HTTPException

from app.anomaly import METHOD, WINDOW, find_anomalies, hourly_p50, to_findings
from app.db import connect, endpoint_exists, load_finished_hours

# Look back 48 hours: every hour of the last day then has a full 24 hours of history before it.
LOOKBACK_HOURS = 2 * WINDOW

# The web application object, like `const app = express()` in the Node backend.
app = FastAPI(title="Sentinel analytics")


# A "decorator" (the line starting with @) attaches the function below it to a route:
# "when someone sends GET /health, run health() and send back what it returns."
@app.get("/health")
def health() -> dict[str, str]:
    # FastAPI turns a returned Python dict into JSON automatically.
    return {"status": "ok", "service": "sentinel-analytics"}


# `endpoint_id: int`: FastAPI reads it from the URL and checks it's a whole number
# (otherwise it answers 422 by itself).
@app.post("/analyze/{endpoint_id}")
def analyze(endpoint_id: int) -> dict:
    """Find unusually slow hours for one endpoint in the last 48 finished hours."""
    with connect() as conn:  # `with`: the connection is closed automatically at the end
        if not endpoint_exists(conn, endpoint_id):
            raise HTTPException(status_code=404, detail=f"Endpoint {endpoint_id} not found")
        checks = load_finished_hours(conn, endpoint_id, LOOKBACK_HOURS)

    findings: list[dict] = []
    hours_scored = 0
    if not checks.empty:
        scored = find_anomalies(hourly_p50(checks))
        hours_scored = int(scored["score"].notna().sum())  # hours that had enough history to judge
        findings = to_findings(scored)

    return {
        "endpoint_id": endpoint_id,
        "method": METHOD,
        "hours_scored": hours_scored,
        "findings": findings,
    }
