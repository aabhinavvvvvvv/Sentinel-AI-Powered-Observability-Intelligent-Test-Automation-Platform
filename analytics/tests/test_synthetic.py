"""Checks that the synthetic dataset really is what we say it is."""

import pandas as pd

from ml.synthetic import DAYS, START, TRAIN_DAYS, make_dataset, split_by_time

data = make_dataset()
normal = data[data["kind"] == ""]


def test_same_seed_gives_identical_data_and_another_seed_does_not():
    assert make_dataset(seed=42).equals(make_dataset(seed=42))
    assert not make_dataset(seed=42).equals(make_dataset(seed=7))


def test_one_row_per_hour_for_30_days_in_utc():
    assert len(data) == DAYS * 24
    assert (data["time"].diff().dropna() == "1h").all()  # every step is exactly one hour
    assert str(data["time"].dt.tz) == "UTC"


def test_normal_hours_look_realistic():
    assert 230 < normal["p50_ms"].mean() < 250
    by_hour = normal.groupby(normal["time"].dt.hour)["p50_ms"].mean()
    assert by_hour[14] > by_hour[2] + 50  # afternoon clearly slower than night


def test_answer_key_counts():
    assert data["kind"].value_counts().to_dict() == {
        "": 720 - 34,
        "level_shift": 12,
        "drift": 12,
        "spike": 6,
        "quiet": 4,
    }


def test_planted_problems_have_the_intended_size():
    # Compare each planted hour with the average NORMAL hour at the same time of day.
    typical = normal.groupby(normal["time"].dt.hour)["p50_ms"].mean()
    ratio = data["p50_ms"] / data["time"].dt.hour.map(typical)
    assert (ratio[data["kind"] == "spike"] > 2.4).all()
    assert ratio[data["kind"] == "quiet"].between(1.0, 1.35).all()


def test_split_is_by_time_with_every_problem_kind_in_the_test_period():
    train, test = split_by_time(data)
    assert len(train) == TRAIN_DAYS * 24 and len(test) == (DAYS - TRAIN_DAYS) * 24
    assert train["time"].max() < test["time"].min()  # all training hours come before all test hours
    assert test["time"].min() == START + pd.Timedelta(days=TRAIN_DAYS)
    assert set(test["kind"]) == {"", "spike", "level_shift", "drift", "quiet"}
