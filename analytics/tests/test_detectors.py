"""Small, hand-made checks of the candidate detectors (the big comparison is in ml/evaluate.py)."""

import numpy as np
import pandas as pd

from app.anomaly import find_anomalies
from ml.detectors import features, features_v2, isolation_forest, seasonal_robust_z
from ml.evaluate import evaluate


def rhythm_days(days: int) -> pd.Series:
    """A clean daily rhythm: 200 ms at night, up to 280 ms in the afternoon, tiny wobble."""
    time = pd.date_range("2026-01-01", periods=days * 24, freq="h", tz="UTC")
    rhythm = 240 + 40 * np.sin((time.hour.to_numpy() - 8) / 24 * 2 * np.pi)
    wobble = np.tile([-2, -1, 0, 1, 2], len(time) // 5 + 1)[: len(time)]
    return pd.Series(rhythm + wobble, index=time)


def test_same_hour_baseline_catches_a_shift_the_24h_window_misses():
    values = rhythm_days(10)
    shifted = values.copy()
    shifted.iloc[-12] *= 1.25  # one hour 25% slower on the last day
    target = shifted.index[-12]

    assert seasonal_robust_z(shifted)[target]  # caught: compared with the same hour on earlier days
    assert not find_anomalies(shifted)["is_anomaly"][target]  # missed: the day/night swing looks "normal"


def test_same_hour_baseline_needs_five_earlier_days():
    values = rhythm_days(5)
    values.iloc[-1] *= 3
    assert not seasonal_robust_z(values).any()  # only 4 earlier days at that hour: no verdict


def test_features_only_look_backward():
    values = rhythm_days(3)
    f = features(values)
    assert f["vs_same_hour_yesterday"].iloc[:24].isna().all()  # no "yesterday" for the first day
    assert f["vs_previous_hour"].iloc[30] == values.iloc[30] / values.iloc[29]


def test_isolation_forest_is_reproducible_and_flags_a_big_spike():
    values = rhythm_days(10)
    values.iloc[-5] *= 3
    cut = values.index[0] + pd.Timedelta(days=7)
    first = isolation_forest(values, train_until=cut)
    assert first.equals(isolation_forest(values, train_until=cut))  # same seed → same answer
    assert first[values.index[-5]]


def test_v2_feature_compares_with_the_same_hour_on_previous_days():
    values = rhythm_days(10)
    values.iloc[-12] *= 1.25
    f = features_v2(values)
    assert f["vs_same_hour_median"].iloc[: 5 * 24].isna().all()  # needs 5 earlier days
    assert abs(f["vs_same_hour_median"].iloc[-13] - 1) < 0.02  # a normal hour ≈ 1.0
    assert abs(f["vs_same_hour_median"].iloc[-12] - 1.25) < 0.02  # the slow hour ≈ 1.25


def test_isolation_forest_v2_never_flags_faster_hours():
    values = rhythm_days(10)
    values.iloc[-5] *= 0.3  # suddenly much FASTER
    cut = values.index[0] + pd.Timedelta(days=7)
    assert not isolation_forest(values, train_until=cut, version=2)[values.index[-5]]


def test_the_comparison_is_reproducible():
    assert evaluate(42) == evaluate(42)
