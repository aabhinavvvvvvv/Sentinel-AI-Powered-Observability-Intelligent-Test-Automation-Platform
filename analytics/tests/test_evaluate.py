"""The scoring maths, checked on tiny hand-made examples."""

import pytest

from ml.evaluate import score


def test_counts_precision_recall_f1():
    #          hour:   1      2       3       4      5      6
    flagged = [True, True, False, True, False, False]
    kind = ["spike", "", "spike", "drift", "", "drift"]
    # true alarms: hours 1, 4 → 2 · false alarm: hour 2 → 1 · missed: hours 3, 6 → 2
    result = score(flagged, kind)
    assert (result["true_alarms"], result["false_alarms"], result["missed"]) == (2, 1, 2)
    assert result["precision"] == pytest.approx(2 / 3)  # 2 of 3 alarms were real
    assert result["recall"] == pytest.approx(2 / 4)  # 2 of 4 problems caught
    assert result["f1"] == pytest.approx(2 * (2 / 3) * (1 / 2) / (2 / 3 + 1 / 2))
    assert result["caught_per_kind"] == {"drift": "1/2", "spike": "1/2"}


def test_no_alarms_means_precision_is_undefined_not_zero():
    result = score([False, False], ["spike", ""])
    assert result["precision"] is None
    assert result["recall"] == 0
    assert result["f1"] is None


def test_perfect_detector():
    result = score([True, False], ["spike", ""])
    assert (result["precision"], result["recall"], result["f1"]) == (1, 1, 1)
