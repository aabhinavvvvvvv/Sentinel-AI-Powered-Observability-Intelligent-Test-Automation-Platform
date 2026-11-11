"""The shadow-mode detectors as used live: findings only after `since`, method labels, and missing history."""

import math

import numpy as np
import pandas as pd

from app.shadow import IFOREST_METHOD, SAME_HOUR_METHOD, isolation_forest_findings, same_hour_findings
from ml.detectors import same_hour_baseline
from ml.synthetic import START, make_dataset

data = make_dataset(42)
values = data.set_index("time")["p50_ms"]
since = START + pd.Timedelta(days=21)  # report from day 22 on (the level shift is on day 22)
level_shift_hours = set(data[data["kind"] == "level_shift"]["time"])


def test_same_hour_findings_catch_the_level_shift_and_stay_after_since():
    findings = same_hour_findings(values, since)
    times = {pd.Timestamp(f["time"]) for f in findings}
    assert all(t >= since for t in times)
    assert len(times & level_shift_hours) >= 10  # most of the 12 level-shift hours
    assert {f["method"] for f in findings} == {SAME_HOUR_METHOD}
    assert all("Shadow mode" in f["explanation"] and "not a diagnosis" in f["explanation"] for f in findings)


def test_isolation_forest_findings_are_labelled_shadow_and_never_critical():
    findings = isolation_forest_findings(values, since)
    assert findings  # it does flag something on this data
    assert all(pd.Timestamp(f["time"]) >= since for f in findings)
    assert {f["method"] for f in findings} == {IFOREST_METHOD}
    assert {f["severity"] for f in findings} == {"warning"}
    # Slower than usual for that time of day. (">= 1" because the score is rounded: 1.004 shows as 1.0.)
    assert all(f["score"] >= 1 for f in findings)


def test_with_too_little_history_both_stay_silent():
    two_days = values.iloc[: 2 * 24]
    cut = two_days.index[24]
    assert same_hour_findings(two_days, cut) == []
    assert isolation_forest_findings(two_days, cut) == []


def test_missing_hours_are_skipped_not_fatal():
    with_gaps = values.copy()
    with_gaps[with_gaps.index.day == 10] = np.nan  # the worker was off for a whole day
    median, mad = same_hour_baseline(with_gaps)
    assert math.isfinite(median.iloc[15 * 24]) and math.isfinite(mad.iloc[15 * 24])  # still computed
    assert isinstance(isolation_forest_findings(with_gaps, since), list)
