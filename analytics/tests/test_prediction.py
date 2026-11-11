"""Checks for the prediction experiment's answer key and its baseline."""

import pandas as pd

from ml.evaluate import TRAIN_UNTIL
from ml.prediction import answer_labels, evaluate, random_forest
from ml.synthetic import DAYS, make_slowdown_dataset

data = make_slowdown_dataset()
labels = answer_labels(data)


def test_every_episode_has_exactly_one_start_hour():
    assert labels.str.endswith("starts").sum() == DAYS // 2
    # Creeping: the hour before it turns slow is the last warning hour (+29%).
    assert (data.loc[labels == "creeping starts", "slowdown"].round(2) == 1.29).all()
    # Sudden: the hour before looks perfectly normal.
    assert (data.loc[labels == "sudden starts", "slowdown"] == 1.0).all()


def test_persistence_never_sees_a_sudden_start_but_catches_problems_that_continue():
    caught = evaluate(42)["Persistence (+30%, untuned)"]["caught_per_kind"]
    # The hour before a sudden problem is truly normal, so "same as now" can't warn about it.
    # (It does catch SOME creeping starts, by luck: the +29% warning hour is sometimes MEASURED
    # above +30% because of random wobble, so persistence thinks it's already slow.)
    assert caught["sudden starts"].startswith("0/")
    got, total = map(int, caught["still slow"].split("/"))
    assert got >= 0.9 * total


def test_random_forest_never_peeks_at_answers_from_the_test_days():
    # Flip every answer from the last training hour onward. If the model only learns from
    # training answers (no leakage), its predictions must stay exactly the same.
    values = data.set_index("time")["p50_ms"]
    target = data.set_index("time")["slow_next_hour"]
    flipped = target.copy()
    future = flipped.index >= TRAIN_UNTIL - pd.Timedelta(hours=1)
    flipped[future] = ~flipped[future]
    assert random_forest(values, target).equals(random_forest(values, flipped))
