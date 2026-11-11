"""
Experiment 5 (SYNTHETIC): learned weights vs the hand-written test-priority rule.

Phase 7's rule (backend/src/testing/priority.ts) gives hand-picked points:
    40 × failed_last_run + round(30 × failure_share_in_last_10_runs)
Here a logistic regression LEARNS weights for the same two signals from past runs.
Question: does the learned model order tests better (higher APFD) than the hand rule?

Data: the same two made-up worlds as backend/src/testing/synthetic-history.ts (ported to
NumPy, so the random numbers differ): "repeating" bugs and "random" failures.

Fairness:
  - Time split inside each history: the model learns from runs 1-100, is judged on runs 101-200.
  - Features for a run use only EARLIER runs (no peeking ahead).
  - No tuning (scikit-learn defaults), so the test runs are looked at once.

Run `python -m ml.prioritization` (inside analytics/) to print the comparison.
"""

import numpy as np
from sklearn.linear_model import LogisticRegression

HISTORY = 10  # look at the last 10 runs, like the backend
RUNS, CASES = 200, 20
TRAIN_RUNS = 100  # learn from runs 1-100, judge on runs 101-200
SEEDS = range(1, 11)
WORLDS = ("repeating", "random")
FEATURES = ("failed_last_run", "failure_share")


def make_history(world: str, seed: int, runs: int = RUNS, cases: int = CASES) -> np.ndarray:
    """failed[run, case] = True if that test failed in that run. SYNTHETIC."""
    rng = np.random.default_rng(seed)
    failed = np.zeros((runs, cases), dtype=bool)
    broken_for = np.zeros(cases, dtype=int)  # runs left until a broken test is fixed
    for r in range(runs):
        for c in range(cases):
            if world == "random":
                failed[r, c] = rng.random() < 0.05
            elif broken_for[c] > 0:  # still broken
                broken_for[c] -= 1
                failed[r, c] = True
            elif rng.random() < 0.01:  # breaks now, for 2-6 runs in total
                broken_for[c] = 1 + rng.integers(0, 5)
                failed[r, c] = True
            else:
                failed[r, c] = rng.random() < 0.01  # noise
    return failed


def features(failed: np.ndarray) -> np.ndarray:
    """
    X[run, case] = [failed_last_run, failure_share], computed from the runs BEFORE `run` only.
    Run 0 has no history: both are 0.
    """
    runs, cases = failed.shape
    X = np.zeros((runs, cases, len(FEATURES)))
    for r in range(1, runs):
        past = failed[max(0, r - HISTORY) : r]
        X[r, :, 0] = past[-1]
        X[r, :, 1] = past.mean(axis=0)
    return X


def hand_scores(X: np.ndarray) -> np.ndarray:
    """The backend's rule. np.floor(x + 0.5) rounds like JavaScript's Math.round."""
    return 40 * X[..., 0] + np.floor(30 * X[..., 1] + 0.5)


def train(X: np.ndarray, failed: np.ndarray) -> LogisticRegression:
    """Learn weights from the TRAINING runs only."""
    model = LogisticRegression()
    model.fit(X[:TRAIN_RUNS].reshape(-1, X.shape[-1]), failed[:TRAIN_RUNS].ravel())
    return model


def apfd(order: np.ndarray, failed_now: np.ndarray) -> float | None:
    """APFD = 1 - sum(positions of failing tests) / (n × m) + 1 / (2n). None if nothing failed."""
    positions = np.nonzero(failed_now[order])[0] + 1
    if len(positions) == 0:
        return None
    n = len(order)
    return 1 - positions.sum() / (n * len(positions)) + 1 / (2 * n)


def evaluate(scores: np.ndarray, failed: np.ndarray) -> dict:
    """Mean APFD and first-failure position over the TEST runs that had a failure."""
    apfds, firsts = [], []
    for r in range(TRAIN_RUNS, failed.shape[0]):
        if not failed[r].any():
            continue
        order = np.argsort(-scores[r], kind="stable")  # highest first; ties keep test-number order
        apfds.append(apfd(order, failed[r]))
        firsts.append(np.argmax(failed[r][order]) + 1)
    return {"apfd": float(np.mean(apfds)), "first_failure": float(np.mean(firsts))}


def run_world(world: str) -> dict:
    """Compare normal order, hand rule and learned weights on every seed of one world."""
    rows = {"normal": [], "hand rule": [], "learned": []}
    weights = []
    for seed in SEEDS:
        failed = make_history(world, seed)
        X = features(failed)
        model = train(X, failed)
        learned = model.predict_proba(X.reshape(-1, X.shape[-1]))[:, 1].reshape(failed.shape)
        rows["normal"].append(evaluate(np.zeros(failed.shape), failed))
        rows["hand rule"].append(evaluate(hand_scores(X), failed))
        rows["learned"].append(evaluate(learned, failed))
        weights.append(model.coef_[0])
    return {"rows": rows, "weights": np.mean(weights, axis=0)}


def main() -> None:
    print(f"SYNTHETIC: {len(SEEDS)} seeds x {RUNS} runs x {CASES} tests; learn on runs 1-{TRAIN_RUNS}, judge on the rest")
    for world in WORLDS:
        result = run_world(world)
        rows = result["rows"]
        print(f'\nWorld "{world}"')
        for name, per_seed in rows.items():
            mean_apfd = np.mean([s["apfd"] for s in per_seed])
            mean_first = np.mean([s["first_failure"] for s in per_seed])
            print(f"  {name:10} APFD {mean_apfd:.3f}   first failure at test {mean_first:.2f}")
        wins = sum(l["apfd"] > h["apfd"] for l, h in zip(rows["learned"], rows["hand rule"]))
        ties = sum(l["apfd"] == h["apfd"] for l, h in zip(rows["learned"], rows["hand rule"]))
        print(f"  learned beat the hand rule on {wins}/{len(SEEDS)} seeds ({ties} exact ties)")
        print("  learned weights (mean): " + ", ".join(f"{f} {w:+.2f}" for f, w in zip(FEATURES, result["weights"])))


if __name__ == "__main__":
    main()
