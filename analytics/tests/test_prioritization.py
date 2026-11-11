"""Experiment 5 (learned test-priority weights): APFD, no peeking ahead, the hand rule port, the time split."""

import numpy as np
import pytest

from ml.prioritization import TRAIN_RUNS, apfd, features, hand_scores, make_history, train


def test_apfd_matches_hand_worked_examples():
    order = np.array([0, 1, 2, 3])
    assert apfd(order, np.array([True, False, False, False])) == pytest.approx(0.875)  # found first
    assert apfd(order, np.array([False, False, True, False])) == pytest.approx(0.375)
    assert apfd(order, np.array([False, True, False, True])) == pytest.approx(0.375)  # 1 - 6/8 + 1/8
    assert apfd(order, np.zeros(4, dtype=bool)) is None  # nothing to find


def test_features_use_only_earlier_runs():
    failed = make_history("repeating", 3)
    changed = failed.copy()
    changed[50:] = ~changed[50:]  # flip run 50 and everything after it
    assert np.array_equal(features(failed)[:51], features(changed)[:51])  # run 50's features can't see run 50


def test_hand_rule_gives_the_same_points_as_the_backend():
    failed = np.array([[False], [False], [True], [False]])  # one test: pass, pass, FAIL, ...
    scores = hand_scores(features(failed))
    assert scores[3, 0] == 50  # failed last run (+40) + failed 1 of 3 (+10), as in backend/tests/priority.test.ts
    assert scores[2, 0] == 0  # before the failure: no points


def test_model_learns_only_from_training_runs():
    failed = make_history("repeating", 4)
    changed = failed.copy()
    changed[TRAIN_RUNS:] = ~changed[TRAIN_RUNS:]  # change every TEST run
    a = train(features(failed), failed)
    b = train(features(changed), changed)
    assert np.allclose(a.coef_, b.coef_) and np.allclose(a.intercept_, b.intercept_)


def test_synthetic_worlds_are_reproducible_and_fail_about_5_percent():
    assert np.array_equal(make_history("random", 7), make_history("random", 7))
    assert not np.array_equal(make_history("random", 7), make_history("random", 8))
    for world in ("repeating", "random"):
        assert 0.03 < make_history(world, 1).mean() < 0.07
