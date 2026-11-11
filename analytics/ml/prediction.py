"""
Prediction experiment: "will the NEXT hour be slow (at least 30% slower than usual for that time of day)?"

SYNTHETIC data only (ml.synthetic.make_slowdown_dataset). The warning signs were built into that data
on purpose, so a good result means "a model CAN learn warning signs when they exist", nothing more.

Run `python -m ml.prediction` (inside analytics/) to print the comparison on the development seeds.
"""

import pandas as pd

from ml.detectors import same_hour_baseline
from ml.evaluate import DEV_SEEDS, score
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


def persistence(values: pd.Series) -> pd.Series:
    """
    Baseline: "the next hour will be like this one".
    Says "slow next hour" when THIS hour is ≥ 30% above the usual for its time of day
    (usual = median of the same hour on the previous 7 days). Not enough history yet → False.
    """
    usual, _ = same_hour_baseline(values)
    return values / usual >= SLOW


# Each predictor: hourly values (whole timeline) → True/False per hour, "slow next hour?".
PREDICTORS = {
    "Persistence (next hour = this hour)": persistence,
}


def evaluate(seed: int) -> dict[str, dict]:
    """Every predictor on one synthetic dataset, scored on its test days (days 21-30)."""
    data = make_slowdown_dataset(seed)
    data["answer"] = answer_labels(data)
    _, test = split_by_time(data)
    values = data.set_index("time")["p50_ms"]
    return {
        name: score(predict(values).reindex(test["time"], fill_value=False), test["answer"])
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


if __name__ == "__main__":
    # Only the DEVELOPMENT seeds for now. The held-out seeds are used once, for the final verdict.
    print(f"SYNTHETIC data, DEVELOPMENT seeds {DEV_SEEDS}, test days 21-30 of each\n")
    for name, s in summarize(DEV_SEEDS).items():
        print(f"{name}\n  F1 {s['f1_mean']:.2f}  precision {s['precision_mean']:.2f}  recall {s['recall_mean']:.2f}")
        print(f"  caught: {s['caught']}\n")
