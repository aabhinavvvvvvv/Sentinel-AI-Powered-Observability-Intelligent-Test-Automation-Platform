"""
"Is this unusual?" — a transparent statistical baseline (no machine learning yet).

For each hour we ask: compared with the hours just before it, is it much slower than normal?
  normal (baseline) = median of the previous hours
  usual wobble      = MAD (median distance from that median)
  score             = robust z-score = 0.6745 * (value - normal) / wobble
A score above 3.5 is flagged. This is a STATISTICAL SIGNAL, not a cause.
"""

import numpy as np
import pandas as pd

THRESHOLD = 3.5  # robust z above this = unusual (a common rule of thumb in statistics)
WINDOW = 24  # compare each hour with the previous 24 hours
MIN_HISTORY = 12  # need at least 12 previous hours, otherwise we don't judge
MIN_MAD_MS = 1.0  # assume at least 1 ms of normal wobble (a perfectly flat history would divide by zero)
CRITICAL_SCORE = 10.0  # very far from normal: "critical" instead of "warning" (rule of thumb)


def hourly_p50(checks: pd.DataFrame) -> pd.Series:
    """
    Turn raw checks into one number per hour: the median (P50) response time of SUCCESSFUL checks.

    `checks` has columns: checked_at (UTC times), ok (True/False), response_time_ms.
    Hours with no successful checks come out as NaN ("not a number" = no data).
    """
    ok = checks[checks["ok"]]  # keep only rows where ok is True (failed checks aren't "speed")
    return ok.set_index("checked_at")["response_time_ms"].resample("1h").median()
    # set_index: use the time column as the row labels; resample("1h"): group rows into 1-hour buckets.


def find_anomalies(
    values: pd.Series,
    window: int = WINDOW,
    threshold: float = THRESHOLD,
    min_history: int = MIN_HISTORY,
) -> pd.DataFrame:
    """
    Score every point against the points BEFORE it.

    `values`: one number per hour (e.g. from hourly_p50), oldest first.
    Returns a table with one row per point: value, baseline, mad, score, is_anomaly.
    `score` is NaN when there wasn't enough history to judge.
    """
    values = values.dropna()  # hours with no data are skipped, not treated as normal or abnormal
    history = values.shift(1)  # move everything down one row: each row now "sees" only the past
    recent = history.rolling(window, min_periods=min_history)  # a sliding window of the previous hours

    baseline = recent.median()
    mad = recent.apply(lambda w: np.median(np.abs(w - np.median(w))), raw=True).clip(lower=MIN_MAD_MS)
    # 0.6745 scales the score so it reads like the classic z-score ("number of standard deviations").
    score = 0.6745 * (values - baseline) / mad

    return pd.DataFrame(
        {
            "value": values,
            "baseline": baseline,
            "mad": mad,
            "score": score,
            # Only SLOWER than normal is a problem; NaN > 3.5 is False, so "not enough history" is never flagged.
            "is_anomaly": score > threshold,
        }
    )


def to_findings(scored: pd.DataFrame, metric: str = "P50 response time", window: int = WINDOW) -> list[dict]:
    """The flagged rows as plain dicts (ready to send as JSON), each with a human-readable explanation."""
    findings = []
    for time, row in scored[scored["is_anomaly"]].iterrows():  # iterrows: loop over (label, row) pairs
        findings.append(
            {
                "time": time.isoformat(),
                "metric": metric,
                "value": round(float(row["value"]), 1),
                "baseline": round(float(row["baseline"]), 1),
                "score": round(float(row["score"]), 1),
                "severity": "critical" if row["score"] >= CRITICAL_SCORE else "warning",
                "explanation": (
                    f"{metric} was {row['value']:.0f} ms, {row['score']:.1f} robust z-scores above "
                    f"the normal {row['baseline']:.0f} ms (median of up to the previous {window} hours). "
                    "This is a statistical signal, not a diagnosis."
                ),
            }
        )
    return findings
