"""Checks for the prediction experiment's answer key and its baseline."""

from ml.prediction import answer_labels, evaluate
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
    caught = evaluate(42)["Persistence (next hour = this hour)"]["caught_per_kind"]
    # The hour before a sudden problem is truly normal, so "same as now" can't warn about it.
    # (It does catch SOME creeping starts, by luck: the +29% warning hour is sometimes MEASURED
    # above +30% because of random wobble, so persistence thinks it's already slow.)
    assert caught["sudden starts"].startswith("0/")
    got, total = map(int, caught["still slow"].split("/"))
    assert got >= 0.9 * total
