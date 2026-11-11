"""
Score anomaly detectors against the SYNTHETIC answer key, hour by hour.

Run `python -m ml.evaluate` (inside analytics/) to print the comparison.
Results describe how a detector handles OUR made-up problems, not real websites.

Fairness rule: seeds 1, 2, 3, 42, 99 are DEVELOPMENT data (we looked at them while designing).
Seeds 100-109 are HELD OUT: only used for the final verdict, never for choosing features or settings.
"""

import pandas as pd

from app.anomaly import find_anomalies
from ml.detectors import isolation_forest, seasonal_robust_z
from ml.synthetic import START, TRAIN_DAYS, make_dataset, split_by_time

DEV_SEEDS = (1, 2, 3, 42, 99)
HELD_OUT_SEEDS = tuple(range(100, 110))


def score(flagged: pd.Series, kind: pd.Series) -> dict:
    """
    flagged: True where the detector raised an alarm.
    kind:    the answer key, "" for a normal hour (same length and order as `flagged`).
    """
    flagged = pd.Series(flagged).reset_index(drop=True).astype(bool)
    kind = pd.Series(kind).reset_index(drop=True)
    real = kind != ""  # hours with a planted problem

    true_alarms = int((flagged & real).sum())  # `&` = "and" for each row, `~` = "not"
    false_alarms = int((flagged & ~real).sum())
    missed = int((~flagged & real).sum())

    # None = undefined (e.g. no alarms at all → precision would be 0 ÷ 0). Never invent a number.
    precision = true_alarms / (true_alarms + false_alarms) if true_alarms + false_alarms else None
    recall = true_alarms / (true_alarms + missed) if true_alarms + missed else None
    f1 = 2 * precision * recall / (precision + recall) if precision and recall else None

    return {
        "alarms": true_alarms + false_alarms,
        "true_alarms": true_alarms,
        "false_alarms": false_alarms,
        "missed": missed,
        "precision": precision,
        "recall": recall,
        "f1": f1,
        # e.g. {"spike": "2/2", "quiet": "0/2"}: how many hours of each problem type were caught
        "caught_per_kind": {
            k: f"{int(flagged[kind == k].sum())}/{int((kind == k).sum())}" for k in sorted(set(kind) - {""})
        },
    }


TRAIN_UNTIL = START + pd.Timedelta(days=TRAIN_DAYS)

# Each detector: hourly values (whole timeline) → True/False per hour.
# All of them only use the past to judge an hour; Isolation Forest also only LEARNS from the train days.
# Settings marked "tuned" were chosen on the DEVELOPMENT seeds only (each method got the same small
# search: 4 values of its one setting), then locked before looking at the held-out seeds.
DETECTORS = {
    "Live rule (vs previous 24 h)": lambda v: find_anomalies(v)["is_anomaly"],
    "Same hour, cut-off 3.5 (untuned)": seasonal_robust_z,
    "Same hour, cut-off 4.5 (tuned)": lambda v: seasonal_robust_z(v, threshold=4.5),
    "Isolation Forest v1 (raw, 2%)": lambda v: isolation_forest(v, TRAIN_UNTIL, version=1),
    "Isolation Forest v2 (eng., 2%)": lambda v: isolation_forest(v, TRAIN_UNTIL, version=2),
    "Isolation Forest v2 (eng., 5%, tuned)": lambda v: isolation_forest(
        v, TRAIN_UNTIL, contamination=0.05, version=2
    ),
}


def evaluate(seed: int = 42) -> dict[str, dict]:
    """Every detector on one synthetic dataset, scored on its test days."""
    data = make_dataset(seed)
    _, test = split_by_time(data)
    values = data.set_index("time")["p50_ms"]
    return {
        name: score(detect(values).reindex(test["time"], fill_value=False), test["kind"])
        for name, detect in DETECTORS.items()
    }


def summarize(seeds: tuple[int, ...]) -> dict[str, dict]:
    """Average precision / recall / F1 (and F1 range) per detector over several datasets."""
    runs = [evaluate(seed) for seed in seeds]
    summary = {}
    for name in DETECTORS:
        results = [run[name] for run in runs]
        f1s = [r["f1"] or 0.0 for r in results]  # undefined F1 counts as 0 in the average
        summary[name] = {
            "f1_mean": sum(f1s) / len(f1s),
            "f1_min": min(f1s),
            "f1_max": max(f1s),
            "precision_mean": sum(r["precision"] or 0.0 for r in results) / len(results),
            "recall_mean": sum(r["recall"] or 0.0 for r in results) / len(results),
            "false_alarms": [r["false_alarms"] for r in results],
        }
    return summary


def show_summary(title: str, seeds: tuple[int, ...]) -> None:
    print(f"{title} (seeds {seeds[0]}..{seeds[-1]}, {len(seeds)} datasets)")
    for name, s in summarize(seeds).items():
        print(
            f"  {name:36} F1 {s['f1_mean']:.2f} ({s['f1_min']:.2f}-{s['f1_max']:.2f})"
            f"  precision {s['precision_mean']:.2f}  recall {s['recall_mean']:.2f}"
            f"  false alarms {s['false_alarms']}"
        )
    print()


if __name__ == "__main__":
    print("SYNTHETIC data. Each dataset: test days 21-30 (240 hours, 28 with planted problems)\n")
    show_summary("DEVELOPMENT", DEV_SEEDS)
    show_summary("HELD OUT (final verdict)", HELD_OUT_SEEDS)
