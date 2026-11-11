"""
Sentinel analytics service (Python + FastAPI).

The Node backend stays in charge of everything. This small service only does
number-crunching that Python is best at (Pandas now, machine learning later).
"""

from fastapi import FastAPI

# The web application object, like `const app = express()` in the Node backend.
app = FastAPI(title="Sentinel analytics")


# A "decorator" (the line starting with @) attaches the function below it to a route:
# "when someone sends GET /health, run health() and send back what it returns."
@app.get("/health")
def health() -> dict[str, str]:
    # FastAPI turns a returned Python dict into JSON automatically.
    return {"status": "ok", "service": "sentinel-analytics"}
