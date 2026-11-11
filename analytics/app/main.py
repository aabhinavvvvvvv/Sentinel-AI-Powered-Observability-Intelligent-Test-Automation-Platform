"""
Sentinel analytics service (Python + FastAPI).

The Node backend stays in charge of everything. This small service only does
number-crunching that Python is best at (Pandas, scikit-learn).
It reads from PostgreSQL but never writes: it returns findings, and Node saves them.
"""

import pandas as pd
from fastapi import FastAPI, HTTPException

from app.anomaly import find_anomalies, hourly_p50, to_findings
from app.db import connect, endpoint_exists, load_finished_hours
from app.shadow import isolation_forest_findings, same_hour_findings

REPORT_HOURS = 48  # report unusual hours from the last 48 finished hours
LOOKBACK_HOURS = 14 * 24  # but load 14 days: the shadow detectors need days of history

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
    """
    Unusual hours for one endpoint in the last 48 finished hours, from three detectors:
    robust_z_v1 (live rule) + same_hour_z_v1 and isolation_forest_v2 (shadow mode).
    Each finding says which `method` found it.
    """
    with connect() as conn:  # `with`: the connection is closed automatically at the end
        if not endpoint_exists(conn, endpoint_id):
            raise HTTPException(status_code=404, detail=f"Endpoint {endpoint_id} not found")
        checks = load_finished_hours(conn, endpoint_id, LOOKBACK_HOURS)

    if checks.empty:
        return {"endpoint_id": endpoint_id, "hours_scored": 0, "findings": []}

    since = pd.Timestamp.now(tz="UTC").floor("h") - pd.Timedelta(hours=REPORT_HOURS)
    values = hourly_p50(checks)  # one value per hour (NaN = no successful checks that hour)
    scored = find_anomalies(values)
    recent = scored[scored.index >= since]

    return {
        "endpoint_id": endpoint_id,
        "hours_scored": int(recent["score"].notna().sum()),  # recent hours the live rule could judge
        "findings": to_findings(recent) + same_hour_findings(values, since) + isolation_forest_findings(values, since),
    }
