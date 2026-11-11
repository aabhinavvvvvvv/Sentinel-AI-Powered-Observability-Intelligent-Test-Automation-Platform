"""
Prediction experiment: "will the NEXT hour be slow (at least 30% slower than usual for that time of day)?"

SYNTHETIC data only (ml.synthetic.make_slowdown_dataset). The warning signs were built into that data
on purpose, so a good result means "a model CAN learn warning signs when they exist", nothing more.

Run `python -m ml.prediction` (inside analytics/) to print the comparison.
Fairness rule (same as ml.evaluate): settings chosen on the DEVELOPMENT seeds, judged once on HELD-OUT seeds.
"""

import pandas as pd
from sklearn.ensemble import RandomForestClassifier

from ml.detectors import same_hour_baseline
from ml.evaluate import DEV_SEEDS, HELD_OUT_SEEDS, TRAIN_UNTIL, score
from ml.synthetic import SLOW, make_slowdown_dataset, split_by_time


def answer_labels(data: pd.DataFrame) -> pd.Series:
    """
    The answer key, split by HOW HARD each "yes" is to predict:
      ""                 the next hour is NOT slow
      "still slow"       this hour is already slow too (easy: "same as now" gets it right)
      "creeping starts"  this hour isn't slow yet but the next one is: needs an EARLY WARNING
      "sudden starts"    the same, for a sudden problem
    """
    slow_now = data["slowdown"] >= SLOW
    labels = pd.Series("", index=data.index, dtype=object)
    labels[data["slow_next_hour"] & slow_now] = "still slow"
    starts = data["slow_next_hour"] & ~slow_now
    labels[starts] = data["kind"].shift(-1)[starts] + " starts"  # the kind of problem that is starting
    return labels


def persistence(values: pd.Series, cut: float = SLOW) -> pd.Series:
    """
    Baseline: "the next hour will be like this one".
    Says "slow next hour" when THIS hour is ≥ `cut` × the usual for its time of day
    (usual = median of the same hour on the previous 7 days). Not enough history yet → False.
    A `cut` below 1.3 means "warn when it's ALREADY getting slower", a simple early-warning rule.
    """
    usual, _ = same_hour_baseline(values)
    return values / usual >= cut


def features(values: pd.Series) -> pd.DataFrame:
    """
    The facts the model sees about each hour. Each one uses only this hour and EARLIER hours.
      vs_usual   this hour ÷ the usual for this time of day (1.0 = normal, 1.3 = 30% slower)
      rise_1h    how much vs_usual went up since one hour ago
      rise_3h    how much vs_usual went up since three hours ago (a slow, steady climb shows here)
    """
    usual, _ = same_hour_baseline(values)
    vs_usual = values / usual
    return pd.DataFrame(
        {"vs_usual": vs_usual, "rise_1h": vs_usual - vs_usual.shift(1), "rise_3h": vs_usual - vs_usual.shift(3)}
    )


def random_forest(values: pd.Series, target: pd.Series, cutoff: float = 0.5, seed: int = 42) -> pd.Series:
    """
    Learn "which patterns come before a slow hour" from the training days, then predict every hour.
    `target` (slow next hour?) is only used for the training rows.
    cutoff: say "slow next hour" when the share of trees voting "slow" is at least this.
    """
    X = features(values).dropna()  # the first days have no "usual" yet → skipped
    # Train only on hours whose answer is fully inside the training days. The very last training hour's
    # answer is about the first TEST hour, so it's left out too (otherwise the future leaks in).
    train = X.index < TRAIN_UNTIL - pd.Timedelta(hours=1)
    model = RandomForestClassifier(n_estimators=100, random_state=seed)
    model.fit(X[train], target[X.index[train]])
    votes_for_slow = model.predict_proba(X)[:, 1]  # 0.0-1.0: share of the 100 trees saying "slow"
    return pd.Series(votes_for_slow >= cutoff, index=X.index)


# Each predictor: (hourly values, target) → True/False per hour, "slow next hour?".
# Only the Random Forest looks at the target, and only for training hours.
# "tuned" = chosen on the DEVELOPMENT seeds with the same budget for both methods (4 values of one
# setting: rule cut 1.15/1.2/1.25/1.3, forest cut-off 0.3/0.4/0.5/0.6), then locked before the held-out run.
PREDICTORS = {
    "Persistence (+30%, untuned)": lambda values, target: persistence(values),
    "Early-warning rule (+20%, tuned)": lambda values, target: persistence(values, cut=1.2),
    "Random Forest (cut-off 0.5, untuned)": random_forest,
    "Random Forest (cut-off 0.4, tuned)": lambda values, target: random_forest(values, target, cutoff=0.4),
}


def evaluate(seed: int) -> dict[str, dict]:
    """Every predictor on one synthetic dataset, scored on its test days (days 21-30)."""
    data = make_slowdown_dataset(seed)
    data["answer"] = answer_labels(data)
    _, test = split_by_time(data)
    values = data.set_index("time")["p50_ms"]
    target = data.set_index("time")["slow_next_hour"]
    return {
        name: score(predict(values, target).reindex(test["time"], fill_value=False), test["answer"])
        for name, predict in PREDICTORS.items()
    }


def summarize(seeds: tuple[int, ...]) -> dict[str, dict]:
    """Average precision / recall / F1 per predictor, and caught/total per answer type over all seeds."""
    runs = [evaluate(seed) for seed in seeds]
    summary = {}
    for name in PREDICTORS:
        results = [run[name] for run in runs]
        caught: dict[str, list[int]] = {}  # e.g. {"still slow": [got, total]}
        for r in results:
            for kind, fraction in r["caught_per_kind"].items():
                got, total = map(int, fraction.split("/"))
                caught.setdefault(kind, [0, 0])
                caught[kind][0] += got
                caught[kind][1] += total
        summary[name] = {
            "f1_mean": sum(r["f1"] or 0.0 for r in results) / len(results),
            "precision_mean": sum(r["precision"] or 0.0 for r in results) / len(results),
            "recall_mean": sum(r["recall"] or 0.0 for r in results) / len(results),
            "caught": {kind: f"{got}/{total}" for kind, (got, total) in sorted(caught.items())},
        }
    return summary


def show_summary(title: str, seeds: tuple[int, ...]) -> None:
    print(f"{title} (seeds {seeds[0]}..{seeds[-1]}, {len(seeds)} datasets)")
    for name, s in summarize(seeds).items():
        print(f"  {name:38} F1 {s['f1_mean']:.2f}  precision {s['precision_mean']:.2f}  recall {s['recall_mean']:.2f}")
        print(f"  {'':38} caught: {s['caught']}")
    print()


if __name__ == "__main__":
    print("SYNTHETIC data. Each dataset: test days 21-30. Target: is the NEXT hour >= 30% slower than usual?\n")
    show_summary("DEVELOPMENT", DEV_SEEDS)
    show_summary("HELD OUT (final verdict)", HELD_OUT_SEEDS)
