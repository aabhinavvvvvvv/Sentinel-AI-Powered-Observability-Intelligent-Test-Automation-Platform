"""
SHADOW-MODE detectors: they run live every hour and their findings are saved, but they are
still being evaluated on real data (they won on SYNTHETIC data, see docs/EXPERIMENTS.md).
The dashboard labels their findings "shadow".

Both need history: same-hour statistics need 5+ days, Isolation Forest needs 3+ days of
usable hours (which themselves need 5 days of warm-up). Until then they return nothing.
"""

import pandas as pd

from ml.detectors import features_v2, isolation_forest, same_hour_baseline

METRIC = "P50 response time"
SAME_HOUR_METHOD = "same_hour_z_v1"
SAME_HOUR_CUTOFF = 4.5  # tuned on development data in experiment 2
IFOREST_METHOD = "isolation_forest_v2"
IFOREST_CONTAMINATION = 0.05  # tuned on development data in experiment 2
MIN_TRAIN_HOURS = 72  # Isolation Forest learns from at least 3 days of usable hours


def _finding(time, value, baseline, score, severity, explanation, method) -> dict:
    return {
        "time": time.isoformat(),
        "metric": METRIC,
        "value": round(float(value), 1),
        "baseline": round(float(baseline), 1),
        "score": round(float(score), 2),
        "severity": severity,
        "explanation": explanation,
        "method": method,
    }


def same_hour_findings(values: pd.Series, since: pd.Timestamp) -> list[dict]:
    """Hours since `since` far slower than the same hour on the previous 7 days."""
    baseline, mad = same_hour_baseline(values)
    score = 0.6745 * (values - baseline) / mad.clip(lower=1.0)
    flagged = score[(score > SAME_HOUR_CUTOFF) & (score.index >= since)]
    return [
        _finding(
            time,
            values[time],
            baseline[time],
            s,
            "critical" if s >= 10 else "warning",
            f"{METRIC} was {values[time]:.0f} ms, {s:.1f} robust z-scores above the usual {baseline[time]:.0f} ms "
            "for this time of day (median of the same hour on the previous 7 days). Shadow mode: still being "
            "evaluated on real data. This is a statistical signal, not a diagnosis.",
            SAME_HOUR_METHOD,
        )
        for time, s in flagged.items()
    ]


def isolation_forest_findings(values: pd.Series, since: pd.Timestamp) -> list[dict]:
    """Hours since `since` that Isolation Forest (trained only on hours BEFORE `since`) finds unusual."""
    usable = features_v2(values).dropna()  # hours with enough history for every feature
    if (usable.index < since).sum() < MIN_TRAIN_HOURS:
        return []  # not enough history to learn "normal" from
    flags = isolation_forest(values, train_until=since, contamination=IFOREST_CONTAMINATION, version=2)
    baseline, _ = same_hour_baseline(values)
    return [
        _finding(
            time,
            values[time],
            baseline[time],
            usable.at[time, "vs_same_hour_median"],  # the "score" here = times the usual (e.g. 1.32)
            "warning",  # shadow ML findings are never "critical"
            f"Isolation Forest (machine learning, shadow mode) flagged this hour: {METRIC} was {values[time]:.0f} ms, "
            f"{usable.at[time, 'vs_same_hour_median']:.2f}× the usual {baseline[time]:.0f} ms for this time of day. "
            "Still being evaluated on real data. This is a statistical signal, not a diagnosis.",
            IFOREST_METHOD,
        )
        for time in flags[flags & (flags.index >= since)].index
    ]
