"""
Candidate detectors for the Phase 5 experiment. NOT used by the live service (yet).
Each takes hourly values (indexed by time) and returns True/False per hour: "unusual?".
"""

import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest


def same_hour_baseline(values: pd.Series, days: int = 7, min_days: int = 5) -> tuple[pd.Series, pd.Series]:
    """
    For every hour: the median and MAD of the SAME hour of day on the previous `days` days
    (e.g. for Tuesday 13:00, the 13:00 values of the 7 days before). NaN until `min_days` exist.
    """
    medians, mads = [], []
    for hour in range(24):
        same_hour = values[values.index.hour == hour]  # e.g. every 13:00, oldest first
        history = same_hour.shift(1).rolling(days, min_periods=min_days)  # previous days only
        medians.append(history.median())
        mads.append(history.apply(lambda w: np.median(np.abs(w - np.median(w))), raw=True))
    # Put the 24 pieces back in time order.
    return pd.concat(medians).sort_index(), pd.concat(mads).sort_index()


def seasonal_robust_z(values: pd.Series, threshold: float = 3.5) -> pd.Series:
    """
    Like the live rule, but "normal" for 1 PM = the median of 1 PM on the previous 7 days.
    Day-vs-night differences then no longer count as wobble.
    """
    baseline, mad = same_hour_baseline(values)
    score = 0.6745 * (values - baseline) / mad.clip(lower=1.0)
    return score > threshold  # slower only; NaN (not enough days yet) → False


def features(values: pd.Series) -> pd.DataFrame:
    """v1: the facts Isolation Forest looked at first (each uses only this hour and earlier ones)."""
    hour = values.index.hour
    return pd.DataFrame(
        {
            "value": values,
            # Hour of day as a point on a circle, so 23:00 and 00:00 are close together.
            "hour_sin": np.sin(2 * np.pi * hour / 24),
            "hour_cos": np.cos(2 * np.pi * hour / 24),
            "vs_previous_hour": values / values.shift(1),
            "vs_same_hour_yesterday": values / values.shift(24),
        },
        index=values.index,
    )


def features_v2(values: pd.Series) -> pd.DataFrame:
    """
    v2 (feature engineering): hand the model "how unusual for THIS time of day" directly,
    and drop the raw value (it mostly carried the day/night swing, which is normal).
    """
    baseline, _ = same_hour_baseline(values)
    hour = values.index.hour
    return pd.DataFrame(
        {
            "vs_same_hour_median": values / baseline,  # 1.0 = normal for this hour, 1.3 = 30% slower
            "hour_sin": np.sin(2 * np.pi * hour / 24),
            "hour_cos": np.cos(2 * np.pi * hour / 24),
            "vs_previous_hour": values / values.shift(1),
            "vs_same_hour_yesterday": values / values.shift(24),
        },
        index=values.index,
    )


def isolation_forest(
    values: pd.Series,
    train_until: pd.Timestamp,
    contamination: float = 0.02,
    seed: int = 42,
    version: int = 1,
) -> pd.Series:
    """
    Learn what normal hours look like from the hours BEFORE `train_until`, then judge every hour.
    contamination: roughly what share of hours we expect to be unusual (a guess, not tuned on test data).
    version 1: raw features, flags anything odd (unusually FAST hours count as false alarms).
    version 2: engineered features + "slower only", the same goal as the statistical methods.
    """
    X = (features if version == 1 else features_v2)(values).dropna()  # rows without enough history are skipped
    model = IsolationForest(contamination=contamination, random_state=seed)
    model.fit(X[X.index < train_until])  # learn ONLY from the past
    flags = pd.Series(model.predict(X) == -1, index=X.index)  # -1 = "isolated quickly" = unusual
    if version == 2:
        flags &= X["vs_same_hour_median"] > 1  # only slower than usual for this time of day
    return flags
