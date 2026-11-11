"""
SYNTHETIC (made-up) data for Phase 5 experiments. NOT real monitoring data.

30 days of hourly P50 response times for a pretend website, with problems we plant
on purpose. Because we planted them, we know exactly which hours are "bad":
that's the ANSWER KEY (column `kind`) used to score detectors.

Run `python -m ml.synthetic` (inside analytics/) to print a summary.
"""

import numpy as np
import pandas as pd

DAYS = 30
TRAIN_DAYS = 20  # learn on days 1-20, test on days 21-30 (the "future")
START = pd.Timestamp("2026-01-01", tz="UTC")


def make_dataset(seed: int = 42) -> pd.DataFrame:
    """
    Returns one row per hour with columns:
      time    hour start (UTC)
      p50_ms  the hourly median response time
      kind    "" for a normal hour, else which planted problem: spike / level_shift / drift / quiet
    Same seed → exactly the same data every time.
    """
    rng = np.random.default_rng(seed)  # a random-number generator with a fixed starting point
    n = DAYS * 24
    time = pd.date_range(START, periods=n, freq="h")

    # Normal behaviour: 240 ms, slower in the afternoon (peak ~14:00), faster at night, plus wobble.
    hour_of_day = time.hour.to_numpy()
    daily_rhythm = 40 * np.sin((hour_of_day - 8) / 24 * 2 * np.pi)
    p50 = 240 + daily_rhythm + rng.normal(0, 8, n)  # normal(0, 8): random wobble of about ±8 ms
    kind = np.full(n, "", dtype=object)  # the answer key; "" = normal

    def at(day: int, hour: int) -> int:
        """Row number of a given day (1-30) and hour (0-23)."""
        return (day - 1) * 24 + hour

    # 1. Spikes: single hours about 3x slower. Four in the training days, two in the test days.
    for day in (3, 7, 12, 17, 23, 28):
        i = at(day, int(rng.integers(0, 24)))  # a random hour that day
        p50[i] *= 3
        kind[i] = "spike"

    # 2. Level shift: a pretend bad deploy, 30% slower from 10:00 for 12 hours, then rolled back.
    start = at(22, 10)
    p50[start : start + 12] *= 1.30
    kind[start : start + 12] = "level_shift"

    # 3. Drift: 12 hours getting slower and slower, from +0% up to +80%.
    start = at(26, 6)
    p50[start : start + 12] *= 1 + np.linspace(0, 0.8, 12)  # linspace: 12 evenly spaced steps 0 → 0.8
    kind[start : start + 12] = "drift"

    # 4. Quiet problems: single hours only 15% slower. Deliberately hard to spot.
    for day in (9, 14, 24, 27):
        i = at(day, int(rng.integers(0, 24)))
        p50[i] *= 1.15
        kind[i] = "quiet"

    return pd.DataFrame({"time": time, "p50_ms": p50.round(1), "kind": kind})


def split_by_time(data: pd.DataFrame, train_days: int = TRAIN_DAYS) -> tuple[pd.DataFrame, pd.DataFrame]:
    """
    Train = the first `train_days` days, test = everything after. NEVER shuffled:
    a detector must be judged on the future, not on hours it has already seen.
    """
    cut = START + pd.Timedelta(days=train_days)
    return data[data["time"] < cut], data[data["time"] >= cut]


if __name__ == "__main__":  # runs only for `python -m ml.synthetic`, not when imported
    data = make_dataset()
    train, test = split_by_time(data)
    print("SYNTHETIC data (made up, not real monitoring data)")
    print(f"{len(data)} hours: {len(train)} train (days 1-{TRAIN_DAYS}), {len(test)} test (the rest)\n")
    print("Planted problems per period:")
    print(pd.crosstab(data["kind"].replace("", "(normal)"), data["time"] >= START + pd.Timedelta(days=TRAIN_DAYS))
          .rename(columns={False: "train", True: "test"}))
    print("\nFirst 6 hours:")
    print(data.head(6).to_string(index=False))
