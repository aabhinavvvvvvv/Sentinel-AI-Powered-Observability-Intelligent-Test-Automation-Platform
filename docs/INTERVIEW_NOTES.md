# Sentinel — Interview Notes

How to talk about Sentinel in an interview: the pitch, the design, the stories, and honest limits.
Every number here comes from a real test run or experiment in this repo. Don't round them up.

---

## 1. The 30-second pitch

> "Sentinel is an API monitoring and testing platform I built end to end. It checks websites on a
> schedule, opens incidents and sends email alerts when they go down, shows uptime and P50/P95/P99
> latency on a React dashboard, and runs declarative API test suites. A separate Python service does
> anomaly detection. I compared a robust statistical baseline against Isolation Forest on held-out
> synthetic data, and showed that feature engineering doubled the ML model's F1, from 0.44 to 0.86.
> It's Node/TypeScript, PostgreSQL, Redis/BullMQ, React, and Python/FastAPI, with about 300 automated tests."

Test counts at the time of writing: backend 232, frontend 34, Python 45.

---

## 2. Architecture in one picture

```
Browser (React) ──/api──▶ Node/Express API ──▶ PostgreSQL  (source of truth)
                               │                    ▲
                               ▼                    │ read-only
                        Redis + BullMQ ──▶ Node worker ──▶ Python/FastAPI (analytics/ML)
                         (timers, jobs)     │   checks websites (SSRF-guarded)
                                            │   runs API tests, sends emails
```

**Why this shape (be ready to defend each line):**
- **Modular monolith + one Python service.** One Node codebase runs as two processes, API and worker, so slow checks never block user requests. Python is separate only because of its ML ecosystem (a language boundary), not because "microservices are cool".
- **PostgreSQL is the truth; Redis only holds timers and queues.** If Redis loses its data, the worker rebuilds every timer from Postgres on startup (`syncAll`).
- **One writer.** Python reads Postgres through a **read-only** connection, so the database itself refuses writes. Node owns the schema and all writes.
- **ML runs in hourly batches over saved data**, never once per health check.

---

## 3. Feature stories (problem → what I did → trade-off → proof)

### Monitoring + SSRF protection
- **Problem:** users register any URL, so a malicious user could make the server call `localhost:5432` or the cloud metadata IP `169.254.169.254` (this attack is called SSRF).
- **Did:** block private, loopback, link-local and reserved ranges. The check runs **inside the HTTP client's DNS lookup, at connect time**, so DNS rebinding can't swap the IP between "check" and "connect". IPs typed directly in the URL are checked separately, and redirects aren't followed.
- **Trade-off:** sites that redirect (e.g. `example.com` → `www.example.com`) report their 3xx status. The fix is to register the final URL.
- **Proof:** tests for localhost, `::1`, `169.254.169.254`, and an IPv4-mapped IPv6 address.

### Scheduling with Redis + BullMQ (why not `setInterval`)
- `setInterval` loses schedules on restart, runs every check twice with two instances, and has no retries or concurrency limit. A queue fixes all four.
- **One timer per endpoint with a fixed id** (`endpoint-5`): scheduling twice *updates* the timer instead of duplicating it (idempotency).
- **The job carries only the id;** the worker reads the latest settings from Postgres, so edits apply on the next tick.
- I also considered polling Postgres directly (fewer moving parts). BullMQ was chosen for learning value and exact intervals, and the decision is documented as an ADR.

### Incidents
- **Rule:** open after N consecutive failures (configurable, default 3). The start time is the **first** failure, which answers "when did it start?". Resolve on the first success.
- **No duplicate open incidents, even with two workers:** a **partial unique index** (`UNIQUE (endpoint_id) WHERE resolved_at IS NULL`) plus `ON CONFLICT DO NOTHING`. The database enforces it, not my code.
- **Trade-off:** a flapping site creates many short incidents. A recovery threshold would fix that later.

### Email alerts
- Alerts go through **their own queue** with **5 attempts and exponential backoff** (5 s, 10 s, 20 s, 40 s), and a fixed job id `incident-7-opened` to prevent duplicate emails.
- **Proof:** I stopped the mail server, triggered an incident, and restarted it. The first attempt failed, the retry delivered.

### Analytics: uptime and percentiles
- Uptime is reported with its **definition**: "passed ÷ all checks in the window, N checks". Paused time and gaps count as neither up nor down.
- **Why P95/P99, not the average:** with 90 checks at 200 ms and 10 at 3000 ms, the average is 480 ms (no request took that long), while P95 = 3000 ms shows that 1 in 20 users waited 3 seconds.
- I used `percentile_disc` (returns a real measured value) rather than `percentile_cont` (interpolates). Speed percentiles use **successful checks only**, so timeouts don't pose as "slow".
- Chart gaps mean **no data**, never "up" (`generate_series` + `LEFT JOIN` keeps empty buckets).

### Declarative API testing (no user code)
- Tests are **data, not code**: a request plus a fixed menu of assertions (status, header, body, JSON path, latency). That means no sandbox is needed, and every failure has a plain reason like `"user.id" is 1, expected 2`.
- **Exactly-once run start:** `UPDATE test_runs SET status='running' WHERE id=$1 AND status='queued'`. Only one worker can win.
- **No automatic retries,** because a test may have sent a real POST or DELETE. The response body read is capped at **1 MB** so a huge response can't exhaust memory.

### Failure categories + incident evidence (Phase 6)
- **Looked at the data before choosing ML:** 1,701 failed checks had only 5 distinct messages, all written by my own code. Rules classify those perfectly, so I didn't build a text classifier.
- **Finer categories:** `connection_reset`, `redirect` (the message says where it points), `client_error` (4xx), and `server_error` (5xx). A tested data migration re-labelled the history.
- **Incident report:** measured evidence per incident: failures by category, response time before vs normal, similar past incidents, API tests that failed in the same window, and a category checklist labelled "suggestions, not a diagnosis".
- **Real finding:** one site had 41 short timeout incidents in 7 days (median 2 min). The report flags it as **flapping** using a stated rule (≥ 3 in 7 days, median ≤ 10 min).

### Python service + contract
- Node calls `POST /analyze/{id}` hourly and **validates the response shape** (Zod) before saving. A broken answer from Python is rejected, not stored.
- Saving is **idempotent**: `UNIQUE (endpoint_id, metric, bucket_start, method)`, because the 48-hour lookback re-reports the same hours every run.

### ML experiments (the strongest story — tell it in this order)
1. **Baseline:** robust z-score vs the previous 24 hours (median + MAD, threshold 3.5). Medians aren't dragged by earlier spikes; two earlier spikes hide a new one from the mean/std z-score (≈ 3.3) but not from the robust one.
2. **Synthetic data with an answer key:** 30 days hourly, a daily rhythm, and planted spikes, level shift, drift and quiet problems. Seeded for reproducibility; train on days 1–20, test on days 21–30 (time-based split, no leakage).
3. **Finding:** the live rule had precision 1.00 but recall only 0.18. **Root cause, measured:** its MAD was ≈ 29 ms while the real noise was ≈ 8 ms, because the day/night rhythm counted as "noise". A +30% problem scored only 2.6.
4. **Fix 1 (statistics):** compare with the **same hour on previous days**.
5. **Fix 2 (ML):** Isolation Forest. With raw features F1 was 0.44; with an **engineered feature** (value ÷ same-hour median) it was **0.86**.
6. **Fair protocol:** tune on development seeds only, with **the same tuning budget for both methods**, then run **once** on 10 held-out seeds. Development and held-out results matched, so there was no overfitting.
7. **Verdict (held-out, synthetic):**

| Method | F1 | Precision | Recall |
|---|---|---|---|
| Live rule (previous 24 h) | 0.35 | 1.00 | 0.22 |
| Isolation Forest, raw features | 0.44 | 0.77 | 0.33 |
| Isolation Forest, engineered features | 0.86 | 0.81 | 0.92 |
| Same-hour statistics | 0.88 | 0.93 | 0.85 |

   A tie with different personalities: statistics give fewer false alarms, ML gives fewer misses.
8. **Shadow mode (built):** both now run live every hour next to the old rule. Each finding is saved with its `method` and shown with a SHADOW tag; nothing is promoted until real data supports it. Building it surfaced a quirk: Isolation Forest can raise an **"echo" false alarm on the hour right after a spike**, because its "vs previous hour" feature sees a sudden drop. I recorded it rather than quietly re-tuning, because changing the model would mean redoing the fair experiment.

9. **Prediction experiment ("will the next hour be slow?"):** supervised Random Forest vs a persistence baseline ("next hour = this hour") vs a simple early-warning rule ("≥ 20% above usual"). On 10 held-out synthetic datasets all three scored F1 ≈ 0.86. Early warnings for creeping slowdowns: rule 18/20, forest 16/20, persistence 8/20. Sudden slowdowns: 0/30 for every method, as expected, since nothing warns about them. **I did not ship the model**, because it didn't beat a one-line rule (ADR-015). A test proves no leakage: flipping all future answers leaves the predictions unchanged.

**One-line lesson:** "Understanding the data (the daily rhythm) mattered more than the algorithm."

**Second lesson:** "Always compare ML with the simplest rule that uses the same idea. Here the rule won, so the rule is what I'd ship."

**Interview phrase:** "shadow mode": run a new model live, log its output, compare, and only then let it make decisions. It's how real teams introduce models safely.

---

## 4. Debugging stories ("tell me about a bug you found")

| Bug | How I found it | Lesson |
|---|---|---|
| The SSRF blocklist blocked **every** IPv4 address | A test "allows 8.8.8.8" failed. Node's `BlockList` treats IPv4 as IPv4-mapped IPv6, so my `::ffff:0:0/96` rule matched everything | Test what should be **allowed**, not only what should be blocked |
| The server printed "listening" but had exited | In Express 5, the `listen` callback also runs **on failure** (port in use) | Check the error argument; "it says it works" isn't proof |
| PATCH silently reset fields to their defaults | Zod's `.partial()` still applies `.default()` values. Caught by a regression test, proven by mutation testing | Re-introduce the bug to prove the test catches it |
| JSON arrays were saved as Postgres arrays | The `pg` driver converts JS arrays to Postgres arrays. Removing `JSON.stringify` made 8 tests fail | Know your driver's type conversions |
| Monitoring silently stopped for 8 minutes | Jobs sat in Redis `wait`. The dev worker had crashed on reload while the API still said "healthy" | **Monitor the monitor**: a worker heartbeat is needed |
| "My site is up but Sentinel says down" | The site answered 307 → `www.`. Browsers follow redirects; Sentinel doesn't (by design, for SSRF) | Explain the design; fix with config, not code |
| My own explanation was wrong | I claimed one earlier spike hides the next from the classic z-score. The test showed z ≈ 4.8; it takes two (≈ 3.3) | Tests check explanations too |

---

## 5. Honest limitations (say these before you're asked)

- The ML results are on **synthetic data**. Shadow mode will compare on real data, which needs at least 5 days of history first.
- Anomaly detection covers **one metric** (P50 latency), not error rate or availability.
- If the worker dies, monitoring stops and nothing alerts. A heartbeat or Docker restart policy is planned.
- Test-case headers (e.g. auth tokens) are stored **unencrypted**.
- No authentication or multi-user support yet.
- Not deployed. Runs locally with Docker Compose for Postgres, Redis and Mailpit.

---

## 6. Likely questions, short answers

- **"Why a queue instead of cron/setInterval?"** It survives restarts, gives each job to one worker only, and has retries, backoff and concurrency limits. It scales by adding workers (I saw two workers share jobs with no duplicates).
- **"How do you prevent duplicates?"** Fixed job ids for timers and alerts, a partial unique index for open incidents, `UNIQUE … ON CONFLICT DO NOTHING` for anomalies, and an atomic `UPDATE … WHERE status='queued'` for test runs.
- **"What if Redis loses its data?"** Postgres is the truth; the worker rebuilds all timers on startup.
- **"How did you avoid data leakage?"** A time-based split (never shuffled), features that only look backward (`shift(1)`), the model fit only on training days, and settings tuned on development seeds with a single held-out verdict.
- **"Why not just use ML everywhere?"** I compared fairly. Raw ML lost to statistics; ML became competitive only after feature engineering. I ship what's proven, and run the rest in shadow mode.
- **"Precision or recall?"** It depends on cost. Alert fatigue argues for precision; missing outages argues for recall. My two best detectors sit on opposite sides of that trade-off.
- **"How do you know your tests work?"** Mutation checks: I deliberately re-introduced bugs and watched specific tests fail.
