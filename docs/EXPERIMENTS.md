# Sentinel — Experiments

Results here come from **synthetic (made-up) data** unless stated otherwise. They show how a method
handles the problems *we* planted. They are **not** evidence about real websites.

## Experiment 1 — Anomaly detectors on synthetic hourly latency

**Data:** `analytics/ml/synthetic.py`, seed 42. 30 days of hourly P50 (240 ms ± daily rhythm of ±40 ms
± random wobble σ ≈ 8 ms). Planted problems, which form the answer key:

| Kind | What | Train (days 1–20) | Test (days 21–30) |
|---|---|---|---|
| spike | single hour ×3 | 4 | 2 |
| level_shift | +30% for 12 hours (bad deploy) | 0 | 12 |
| drift | +0% → +80% over 12 hours | 0 | 12 |
| quiet | single hour +15% | 2 | 2 |

**Scoring:** per hour on the test days (240 hours, 28 with planted problems). Precision = true alarms ÷ alarms. Recall = true alarms ÷ problem hours. F1 = their harmonic mean. Reproduce with `cd analytics && .venv/bin/python -m ml.evaluate`.

### Methods compared

| Method | How it works |
|---|---|
| **Live rule** (`robust_z_v1`) | Robust z vs the median/MAD of the previous 24 hours. Flags z > 3.5, slower only. |
| **Same hour** | Robust z vs the median/MAD of the **same hour** on the previous 7 days. Needs at least 5 days. Flags z > 3.5, slower only. |
| **Isolation Forest** | scikit-learn, `contamination=0.02` (a prior guess, **not tuned** on test data), seed 42. Fit on days 1–20 only. Features: value, hour of day (sin/cos), ratio to previous hour, ratio to same hour yesterday. Flags both directions. |

All three judge an hour using only earlier hours. Isolation Forest also learns only from the training days.

### Results (seed 42)

| Method | Alarms (true / false) | Precision | Recall | F1 | spike | level_shift | drift | quiet |
|---|---|---|---|---|---|---|---|---|
| Live rule (vs previous 24 h) | 5 (5 / 0) | 1.00 | 0.18 | 0.30 | 2/2 | 0/12 | 3/12 | 0/2 |
| Same hour on previous 7 days | 33 (26 / 7) | 0.79 | 0.93 | 0.85 | 2/2 | 12/12 | 11/12 | 1/2 |
| Isolation Forest | 18 (16 / 2) | 0.89 | 0.57 | 0.70 | 2/2 | 5/12 | 8/12 | 1/2 |

### Robustness: 5 different synthetic datasets (seeds 1, 2, 3, 42, 99)

| Method | F1 min–max (mean) | Precision mean | Recall mean | False alarms per 10 test days |
|---|---|---|---|---|
| Live rule | 0.30–0.49 (0.37) | 1.00 | 0.23 | 0, 0, 0, 0, 0 |
| Same hour | 0.73–0.89 (0.82) | 0.78 | 0.87 | 6, 14, 2, 7, 7 |
| Isolation Forest | 0.33–0.81 (0.58) | 0.84 | 0.46 | 4, 3, 1, 2, 2 |

### What we learned

- **The live rule is blind to problems hidden inside the daily rhythm.** Measured: its MAD is about 29 ms while the true wobble is about 8 ms, because day-vs-night counts as "wobble". A +30% level shift scores only about 2.6. (My prediction that it would catch the *start* of the shift was wrong.) Real sites have daily rhythms too, so this weakness applies to the live detector.
- **A time-of-day-aware statistical baseline beats Isolation Forest** on F1 and recall, consistently across seeds. Isolation Forest is unstable (F1 0.33–0.81). **ML did not earn its place here**, on this data.
- **The same-hour method's false alarms** were mostly ordinary night hours slightly above usual. Cause: only about 7 values per estimate, so the MAD is sometimes too small. Possible fixes (a larger MAD floor, 14 days of history, a higher threshold) must be judged on **fresh seeds**, never by tuning on these test days.
- **Limits:** one synthetic generator, one metric (P50), hand-picked problem types, untuned contamination. None of this proves anything about real traffic.

## Experiment 2 — Feature engineering for Isolation Forest, with a fair tuning protocol

**Question:** can better inputs make the ML detector competitive with the best statistical baseline?

**Isolation Forest v2:**
- Engineered feature `vs_same_hour_median` = value ÷ median of the same hour on the previous 7 days.
- Plus hour of day (sin/cos), `vs_previous_hour`, and `vs_same_hour_yesterday`. The raw value is dropped.
- "Slower only", like the statistical methods.

**Protocol (to avoid fooling ourselves):**
- Seeds 1, 2, 3, 42, 99 = **development**: allowed to look at them and tune.
- Seeds 100–109 = **held out**: run **once**, after all settings were locked.
- Equal tuning budget: each method's single setting was searched over 4 values on development seeds only.
  - Same hour, cut-off: 3.5 / **4.5** / 6 / 8.
  - Isolation Forest v2, contamination: 1% / 2% / **5%** / 10%.

Reproduce with `cd analytics && .venv/bin/python -m ml.evaluate`.

### Held-out results (10 datasets, final verdict)

| Method | F1 mean (min–max) | Precision | Recall | False alarms per 10 test days |
|---|---|---|---|---|
| Live rule (vs previous 24 h) | 0.35 (0.13–0.44) | 1.00 | 0.22 | 0 in every dataset |
| Isolation Forest v1 (raw, 2%) | 0.44 (0.24–0.65) | 0.77 | 0.33 | 1–5 |
| Isolation Forest v2 (engineered, 2%) | 0.71 (0.49–0.87) | 0.93 | 0.59 | 0–3 |
| Same hour, cut-off 3.5 (untuned) | 0.87 (0.79–0.93) | 0.85 | 0.89 | 1–10 |
| **Isolation Forest v2 (engineered, 5%, tuned)** | **0.86 (0.76–0.92)** | 0.81 | **0.92** | 3–13 |
| **Same hour, cut-off 4.5 (tuned)** | **0.88 (0.84–0.94)** | **0.93** | 0.85 | 0–5 |

Development-seed results were almost identical (same hour tuned 0.86, IF v2 tuned 0.85), so the tuning **did not overfit**.

### What we learned

- **Feature engineering roughly doubled the ML detector's F1** (0.44 → 0.86). The model didn't change; its inputs did.
- **The two best methods are essentially tied on F1** and differ in *character*:
  - "Same hour" has fewer false alarms (precision 0.93).
  - Isolation Forest v2 misses fewer problems (recall 0.92).
  - Which is better depends on whether false alarms or missed problems cost more.
- **The key ingredient for both is the same knowledge**: compare with the same time of day. Most of the gain came from understanding the data, not from the algorithm.
- **Limits:** still synthetic data from one generator, one metric, four planted problem types. Real traffic may behave differently. That's why the next step is a side-by-side comparison on real data, not a promotion.
- **Observed quirk (found while building shadow mode):** Isolation Forest v2 can raise a false alarm on the **normal hour right after a spike**. Its `vs_previous_hour` feature sees a sudden *drop* (e.g. 0.33×) and finds that unusual. The "slower only" filter doesn't stop it, because that hour is a hair above its same-hour median (1.004×). This is an "echo" effect of a backward-looking feature. Not fixed (fixing it would require re-running the protocol); to be measured in shadow mode.

---

## Experiment 3 — Predicting a slow hour, one hour ahead

**Question:** can a supervised model warn that the **next** hour will be slow (≥ 30% slower than usual for that time of day)?

**Data (SYNTHETIC, `make_slowdown_dataset`):** 30 days, one slowdown per 2-day block at a random hour.
- **creeping** (like a memory leak): +0% → +80% over 12 h. The first 5 hours are **warning signs** (+0…+29%).
- **sudden** (like a bad deploy): +50% for 6 h, with no warning.
- The warning signs were **built in on purpose**. A good result therefore shows only that a method *can* use warning signs when they exist, not that real websites give them.

**Answer key split by difficulty:** "still slow" (already slow now), "creeping starts" and "sudden starts" (not slow yet, slow next hour: needs a real early warning).

**Methods:**
- Persistence: "next hour = this hour" (slow now if ≥ 1.3 × usual).
- Early-warning rule: the same with a lower bar (≥ 1.2 × usual).
- Random Forest (100 trees). Features: `vs_usual`, `rise_1h`, `rise_3h` (all backward-looking). Trained only on hours whose answer lies in days 1–20.

**Protocol:** same as Experiment 2. Equal tuning budget, 4 values of one setting each, on development seeds 1, 2, 3, 42, 99:
- rule cut 1.15 / **1.2** / 1.25 / 1.3 (1.2 and 1.25 tied at F1 0.87; picked 1.2 for more early warnings)
- forest probability cut-off 0.3 / **0.4** / 0.5 / 0.6

Then **one** run on held-out seeds 100–109. Reproduce with `cd analytics && .venv/bin/python -m ml.prediction`.

### Held-out results (10 datasets)

| Method | F1 | Precision | Recall | Creeping starts warned | Sudden starts | Still slow |
|---|---|---|---|---|---|---|
| Persistence (+30%) | 0.85 | 0.84 | 0.85 | 8/20 | 0/30 | 265/270 |
| **Early-warning rule (+20%, tuned)** | **0.86** | 0.82 | **0.90** | **18/20** | 0/30 | **270/270** |
| Random Forest (0.5, untuned) | 0.86 | **0.87** | 0.85 | 15/20 | 0/30 | 258/270 |
| Random Forest (0.4, tuned) | 0.86 | 0.84 | 0.88 | 16/20 | 0/30 | 266/270 |

Development results were nearly identical (F1 0.85–0.87), so there was no sign of overfitting.

### What we learned

- **The Random Forest did not beat a one-line rule.** The only warning sign in this data is "it's already getting slower", and a lower threshold captures that directly.
- **F1 hides the interesting part.** All methods score ≈ 0.86 because most "yes" hours are *still slow* hours, which are easy. The real difference is early warnings: 18/20 vs 16/20 vs 8/20.
- **Nothing predicts sudden problems** (0/30 for every method). This is expected and is a useful sanity check: catching them would have pointed to leakage.
- **Persistence's "early warnings" are partly luck:** a +29% hour is sometimes *measured* above +30% because of random wobble.
- **Leakage guard tested:** flipping every answer from the last training hour onward leaves the forest's predictions unchanged. With a deliberate bug (training on 3 test days), that test fails.
- **Decision:** no prediction model ships. ML would be worth revisiting with richer signals (error rate, traffic, deploy events) or real incidents with warning patterns (ADR-015).

## Experiment 4 — Does the suggested test order find failures sooner?

**Question:** in past runs, would the Phase 7 priority score (ADR-016) have run the failing tests earlier than the normal order (by case id)?

**Method (replay, `backend/src/testing/replay.ts`):**
- For each past run, build both orders for the cases it ran.
- The suggested order uses **only the runs before it**. A test checks this: changing a run and everything after it leaves that run's order unchanged, and a deliberate peek-ahead bug makes the test fail.
- Measure two things:
  - **APFD** (Average Percentage of Faults Detected): with n tests and failures at positions p₁…pₘ, APFD = 1 − Σp / (n·m) + 1/(2n). Closer to 1 means earlier.
  - **First failure at test N.**
- Only runs with at least one failure can be scored.
- The weights were fixed in step 1, **before** any replay. There was no tuning, so no development/held-out split was needed. Changing the weights because of these numbers would need one.
- Not replayable: "edited since its last run" (old edits aren't recorded).

**Data:**
- **Real:** the demo suite (5 cases, 50 runs).
- **SYNTHETIC** (`synthetic-history.ts`): 10 seeds × 200 runs × 20 tests, two made-up worlds with about 5% failures each:
  - *repeating:* a test breaks and stays broken for 2–6 runs, plus 1% noise.
  - *random:* every test fails 5% of the time, independently. This is the control: history carries no information.

Reproduce with `cd backend && npm run replay`.

### Results

| History | Runs scored | Normal order: APFD / first failure | Suggested order: APFD / first failure |
|---|---|---|---|
| Real demo suite | 50 | 0.471 / test 2.96 | **0.878 / test 1.04** |
| Synthetic "repeating" (mean of 10 seeds) | ~130 per seed | 0.493 / test 9.05 | **0.771 / test 3.76** (better on 10/10 seeds) |
| Synthetic "random" (mean of 10 seeds) | ~125 per seed | 0.504 / test 8.63 | 0.508 / test 8.63 (better on 5/10 seeds) |

### What we learned

- **It helps exactly when failures repeat.** In the "repeating" world, the first failure came at test 3.8 instead of 9.1 out of 20.
- **It doesn't help when failures are random,** which is the expected result: no score can predict coin flips. The control shows no gain, so the replay isn't flattering the method by accident.
- **The real-data gain is mostly not useful.** It comes from "Deliberately wrong", a test that fails on purpose every run. Finding a known-broken test sooner tells you nothing new, which is why the page warns about always-failing tests.
- **The synthetic result depends on the assumption we built in** ("bugs stay for a few runs"). Real suites probably sit between the two worlds. Real history with real bugs is needed before claiming a real speed-up.
- **Decision:** keep the rule (ADR-016). Revisit the weights only with more real history, using a held-out set of runs.

## Experiment 5 — Learned weights vs the hand-written priority rule

**Question:** the step-1 rule uses hand-picked points: `40 × failed_last_run + round(30 × failure_share)`. Does a **logistic regression** that *learns* weights for the same two signals order tests better?

**Data (SYNTHETIC):** the same two worlds as Experiment 4 ("repeating" bugs, "random" failures), ported to NumPy in `analytics/ml/prioritization.py`, so the random numbers differ. 10 seeds × 200 runs × 20 tests.

**Protocol:**
- **Time split** in each history: the model learns from runs 1–100 and is judged on runs 101–200.
- Features use only earlier runs. Tests check both rules, and a deliberate leak (training on 20 test runs) makes the test fail.
- No tuning (scikit-learn defaults).
- Cross-check of the port: on the test runs, normal APFD ≈ 0.51 and hand rule ≈ 0.80 in the "repeating" world, in line with Experiment 4 (0.49 / 0.77).

Reproduce with `cd analytics && .venv/bin/python -m ml.prioritization`.

### Results (test runs, mean of 10 seeds)

| World | Normal order | Hand rule | Learned (logistic regression) | Learned vs hand |
|---|---|---|---|---|
| repeating | 0.511 / test 8.64 | **0.800 / test 3.07** | 0.795 / test 3.17 | better on 1/10 seeds, **7 exact ties** |
| random | 0.499 / test 8.84 | 0.478 / test 9.19 | 0.502 / test 8.73 | better on 7/10 (all noise, see below) |

Learned weights, mean over seeds:
- repeating: failed_last_run **+4.11**, failure_share +0.16
- random: −0.14 and −0.21 (≈ nothing)

### What we learned

- **The learned model mostly gives the same order as the hand rule** (7 of 10 seeds tie exactly). To order tests, only the *ranking* matters, not the exact points. Both say "failed last run" matters most, so they sort the same.
- **The model confirms the hand rule's main idea from the data.** "Failed last run" got by far the biggest weight. "Failure share" added little, because in this world a fixed bug doesn't come back.
- **In the "random" world it learned ≈ zero weights.** That is the right answer: history carries no information there.
- **Noise check:** with 10 seeds, the hand rule looked 0.021 *worse* than the normal order in the random world. Re-run with 100 seeds, the gap was −0.002 ± 0.003 (hand better on 52/100). So it was noise, and 10 seeds can mislead by about 0.02. The 7/10 "wins" for the learned model in that world are noise too.
- **Decision:** keep the hand rule. It's just as good, needs no training, and every point can be explained. A model would only earn its place with **more signals** than the rule can easily weigh, such as code changes or which files a test touches. Real CI systems have those signals; Sentinel doesn't.
