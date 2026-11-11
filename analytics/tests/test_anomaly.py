"""
Tests for the anomaly logic, using MADE-UP data where we know the right answer.
(Real data comes in step 3; there's only about a day of it so far.)
"""

import math

import numpy as np
import pandas as pd

from app.anomaly import find_anomalies, hourly_p50, to_findings


def hourly(values: list[float]) -> pd.Series:
    """Put values on consecutive UTC hours starting 2026-01-01 00:00."""
    return pd.Series(values, index=pd.date_range("2026-01-01", periods=len(values), freq="h", tz="UTC"))


def normal_hours(n: int) -> list[float]:
    """A realistic 'normal' site: about 240 ms, wobbling a little (238..242)."""
    return [240 + (i % 5) - 2 for i in range(n)]


def test_a_sudden_slow_hour_is_flagged():
    scored = find_anomalies(hourly(normal_hours(30) + [900]))

    last = scored.iloc[-1]  # iloc[-1] = the last row
    assert last["is_anomaly"]
    assert last["baseline"] == 240
    assert last["score"] > 100
    assert scored["is_anomaly"].sum() == 1  # nothing else is flagged


def test_normal_wobble_is_not_flagged():
    scored = find_anomalies(hourly(normal_hours(48)))
    assert not scored["is_anomaly"].any()


def test_getting_faster_is_not_flagged():
    scored = find_anomalies(hourly(normal_hours(30) + [50]))
    assert scored["score"].iloc[-1] < 0
    assert not scored["is_anomaly"].iloc[-1]


def test_not_enough_history_means_no_judgement():
    # A spike at hour 6: only 5-6 hours before it, fewer than the 12 we require.
    scored = find_anomalies(hourly(normal_hours(5) + [900]))
    assert math.isnan(scored["score"].iloc[-1])
    assert not scored["is_anomaly"].any()


def test_earlier_spikes_do_not_hide_a_later_one():
    """
    Why medians and not averages: earlier spikes inflate the average and standard deviation.
    (One earlier spike in 24 hours isn't enough to hide the next one: classic z ≈ 4.8.
    Two are: classic z ≈ 3.3, below the 3.5 threshold.)
    """
    values = normal_hours(10) + [900] + normal_hours(11) + [900] + normal_hours(1) + [900]
    scored = find_anomalies(hourly(values))
    assert scored["is_anomaly"].iloc[-1]  # the robust score still catches the latest spike

    # The classic z-score (mean and standard deviation of the previous 24 hours) MISSES it:
    previous = np.array(values[-25:-1])
    classic_z = (values[-1] - previous.mean()) / previous.std()
    assert classic_z < 3.5


def test_empty_hours_are_skipped():
    values = normal_hours(30) + [float("nan")] * 3 + [900]
    scored = find_anomalies(hourly(values))
    assert len(scored) == 31  # the 3 empty hours are dropped, not scored
    assert scored["is_anomaly"].iloc[-1]


def test_a_perfectly_flat_history_does_not_divide_by_zero():
    scored = find_anomalies(hourly([240.0] * 30 + [250.0]))
    assert scored["mad"].iloc[-1] == 1.0  # the minimum wobble
    assert math.isfinite(scored["score"].iloc[-1])


def test_hourly_p50_uses_only_successful_checks():
    checks = pd.DataFrame(
        {
            "checked_at": pd.to_datetime(
                ["2026-01-01 10:05", "2026-01-01 10:35", "2026-01-01 10:50", "2026-01-01 11:10"], utc=True
            ),
            "ok": [True, True, False, True],
            "response_time_ms": [200, 300, 5000, 250],  # the 5000 ms one failed (timeout)
        }
    )
    p50 = hourly_p50(checks)
    assert list(p50.values) == [250.0, 250.0]  # 10:00 → median(200, 300); 11:00 → 250


def test_findings_explain_themselves():
    findings = to_findings(find_anomalies(hourly(normal_hours(30) + [900])))
    assert len(findings) == 1
    f = findings[0]
    assert f["value"] == 900 and f["baseline"] == 240 and f["severity"] == "critical"
    assert f["time"] == "2026-01-02T06:00:00+00:00"  # hour number 30 after the start
    assert "statistical signal, not a diagnosis" in f["explanation"]
