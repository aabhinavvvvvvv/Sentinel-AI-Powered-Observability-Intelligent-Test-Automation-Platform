# Sentinel — Learning Log

Use this document to preserve what the developer has learned. Update it after each substantial teaching/building session. Keep explanations concise but useful for revision.

## Developer learning goals
- Understand Sentinel end to end, not just copy code.
- Learn backend architecture, queues, databases, testing, observability, Python, data analysis, and applied ML.
- Be able to explain architecture and implementation choices in interviews.
- Build confidence through small working increments.

## Session template

### Session [number] — [date] — [feature/topic]

**What we are building**
- 

**Concepts taught**
- 

**Simple explanation / analogy**
- 

**System design**
- Components involved:
- Data flow:
- Why this design:
- Alternatives and trade-offs:

**Files and code changed**
- 

**Commands and verification**
- Commands run:
- Test/build result:
- Known issues:

**What I can now explain**
- 

**Questions to revisit**
- 

**Next step**
- 

---

### Session 1 — 2026-11-11 — Architecture overview + Milestone 1: walking skeleton

**What we are building**
- The thinnest end-to-end slice of the backend: a TypeScript Express app that loads validated config, connects to PostgreSQL (Docker), and answers `GET /healthz` with 200 (DB reachable) or 503 (DB down). Every later feature plugs into this skeleton.

**Concepts taught**
- Target architecture: modular monolith (API + worker processes) plus a Python analytics service; PostgreSQL = durable truth, Redis = job coordination only.
- Why a queue beats `setInterval` (restarts, duplicates, concurrency, retries, scaling). pg-boss noted as an alternative.
- Node event loop and `async`/`await`: awaiting I/O pauses *that function*, not the thread.
- Express middleware pipeline; order matters; 4-parameter error handlers.
- Fail-fast configuration from environment variables; `.env` vs `.env.example`.
- Connection pools; why `pool.on("error")` is mandatory.
- Timeouts with `Promise.race` (stops waiting but does not cancel the work).
- Dependency injection (`createApp(deps)`) to make code testable with fakes.
- Liveness vs readiness, and why a dependency failure is 503, not 500.
- Graceful shutdown with SIGTERM.
- Reading `npm audit` output: dev-only vs production risk.

**Simple explanation / analogy**
- Sentinel is a hospital ward: workers are nurses taking vitals, Redis is the nurse's clipboard (disposable), PostgreSQL is the patient chart (permanent), Python is the specialist who reviews charts periodically, and the dashboard is the nurses'-station screen.
- Middleware is an assembly line: each station either finishes the product (responds) or passes it on (`next`).

**System design**
- Components involved: `server.ts` → `app.ts` (middleware chain) → `routes/health.ts` → `db.ts` pool → PostgreSQL container.
- Data flow: request → pino-http → JSON parser → health router → `SELECT 1` with timeout → 200/503 → response log.
- Why this design: separating `app` from `server` allows in-memory tests; injecting `db` lets tests simulate outages.
- Alternatives and trade-offs: Fastify/NestJS vs Express; dotenv vs Node's built-in `--env-file`; native Postgres vs Docker.

**Files and code changed**
- New: `.gitignore`, `.env.example`, `docker-compose.yml`, `README.md`, `backend/` (package.json, tsconfig.json, tsconfig.build.json, eslint.config.js, `src/{config,logger,db,app,server}.ts`, `src/middleware/errors.ts`, `src/routes/health.ts`, `tests/*.test.ts`), `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`.
- Removed: two `*:Zone.Identifier` Windows metadata files.

**Commands and verification**
- Commands run: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`; a manual end-to-end run against Docker Postgres with curl (healthy, DB stopped, DB restarted, SIGTERM, bad config).
- Test/build result: typecheck OK, lint OK, 21/21 tests passed, build OK. E2E: 200 healthy; 503 in ~13 ms with DB stopped; 200 after restart; exit 0 on SIGTERM; exit 1 with readable message on bad config; process survived the Postgres restart (idle-client error logged, not crashed).
- Known issues: moderate dev-only `minimatch` advisory via ESLint tooling (see DECISIONS.md ADR-004).

**What I can now explain**
- (Fill in after answering the checkpoint questions.)

**Questions to revisit**
- Why does TypeScript with NodeNext require `import ... from "./db.js"` when the file is `db.ts`?
- Should `/healthz` be split into `/livez` (process alive) and `/readyz` (dependencies OK)?

**Next step**
- M2: endpoint registry — first migration (`endpoints` table) and validated CRUD API.

---

### Session 2 — 2026-11-11 — Milestone 2: endpoint registry

**What we are building**
- A REST API to register, list, update, pause and delete the endpoints Sentinel will monitor, stored in PostgreSQL. No checks run yet (M3/M4).

**Concepts taught**
- Migrations: ordered SQL files + a `schema_migrations` tracking table; idempotent re-runs; transactional DDL in Postgres.
- Why a transaction needs a single connection (`pg.Client`, not the pool).
- REST conventions: POST 201, GET 200, PATCH partial update, DELETE 204, 400 vs 404.
- Validation at the boundary (Zod) plus DB CHECK constraints as defence in depth.
- SQL injection and parameterized queries (`$1, $2`); why column names can't be parameters, and how the whitelist keeps them safe.
- Layering: schemas (what's valid) → routes (HTTP) → repository (SQL).
- Unit tests with fakes vs integration tests against a real database; a separate test database; `TRUNCATE ... RESTART IDENTITY`.
- Proving a test works by re-introducing the bug it guards against (mutation check).
- Error `cause` chaining.

**Simple explanation / analogy**
- Migrations are like numbered patches applied to the database: a logbook records which patches are installed, so each one is applied exactly once.
- Parameterized SQL is like a form with labelled boxes: whatever the user writes in the "name" box is only ever treated as a name, never as an instruction.

**System design**
- Components involved: `routes.ts` → `repository.ts` → `endpoints` table; `migrate.ts` owns the schema.
- Data flow: JSON body → Zod validate (defaults filled) → INSERT ... RETURNING * → JSON response.
- Why this design: smallest code that stays readable; SQL visible; one place for defaults.
- Alternatives and trade-offs: ORM/query builder vs raw SQL (ADR-005); camelCase mapping vs snake_case JSON.

**Files and code changed**
- New: `backend/migrations/001_create_endpoints.sql`, `src/migrate.ts`, `src/migrate-cli.ts`, `src/endpoints/{schemas,repository,routes}.ts`, `vitest.config.ts`, `tests/{global-setup,endpoints.test,migrate.test}.ts`.
- Changed: `src/db.ts` (added `query`), `src/app.ts` (mount `/endpoints`), `tests/health.test.ts` (fake db shape), `package.json` (`migrate` script), `.env.example` (`TEST_DATABASE_URL`), docs.

**Commands and verification**
- Commands run: `npm run migrate` (twice), `npm run typecheck`, `npm run lint`, `npx vitest run`, `npm run build`, curl CRUD run against the dev DB.
- Test/build result: migrate applied `001_create_endpoints.sql`, then "up to date". Typecheck OK. Lint initially failed (2 × `preserve-caught-error`), fixed with `{ cause: err }`, then OK. 47/47 tests passed. Build OK. Mutation check: with the defaults bug re-introduced, 2 PATCH tests failed as expected; file restored.
- Known issues: none new.

**Gotcha discovered**
- Zod 4's `.partial()` still applies `.default()` values. Building the PATCH schema from the create schema would silently reset unsent fields to defaults. Guarded by a regression test.

**What I can now explain**
- (Fill in after answering the checkpoint questions.)

**Questions to revisit**
- What happens if two people run `npm run migrate` at the same moment?
- Why is the SSRF check done at check time rather than at registration time?

**Next step**
- M3: the checker — check one endpoint once with a timeout, categorize errors, SSRF guard.

---

### Session 3 — 2026-11-11 — Milestone 3: checking a website (+ simple-words preference)

**What we are building**
- A "check now" button: Sentinel visits one website and reports up/down, status code, speed, and the reason for any failure.

**Concepts taught (in simple words)**
- A check = visit the URL, time it, compare the answer to the expected status.
- Timeout = stop waiting after N milliseconds.
- Error types: timeout, dns (name doesn't exist), connection_refused (nobody listening), tls (certificate problem), unexpected_status, blocked.
- SSRF: the "delivery person inside the office" analogy. Never let users send Sentinel to inside addresses.
- Why check at connection time (DNS can change its answer).
- Why the API returns 200 even when the website is down (our request worked; the result says "down").

**Simple explanation / analogy**
- Sentinel is a delivery person who goes to any address you give. Inside addresses (the server room) are off-limits, even though the delivery person could get in.

**Files and code changed**
- New: `src/checks/ssrf-guard.ts`, `src/checks/check-endpoint.ts`, `tests/ssrf-guard.test.ts`, `tests/check-endpoint.test.ts`.
- Changed: `src/endpoints/routes.ts` (check route), `src/server.ts` (startup error fix), `tests/endpoints.test.ts`, docs. Added dependency `undici`.

**Commands and verification**
- typecheck OK, lint OK, build OK, 74/74 tests passed.
- Real run: example.com → ok 200; api.github.com → 403 (unexpected_status); fake .invalid site → dns; localhost:5432 → blocked; 169.254.169.254 → blocked.

**Bugs found and fixed (good debugging lessons)**
1. Blocklist rule `::ffff:0:0/96` blocked *every* IPv4 address, because Node's BlockList treats IPv4 as IPv4-mapped IPv6. Caught by the "allows 8.8.8.8" test. Fix: removed the rule; the IPv4 rules already cover mapped addresses.
2. A test used port 1 for "nothing listening", but fetch refuses that port ("bad port"). The test was wrong, not the code.
3. M1 bug: in Express 5, the `app.listen` callback also runs on failure (e.g. port busy). We logged "listening" and exited silently. Fix: check the `err` argument, log fatal, exit 1. Found because the developer's own `npm run dev` was holding port 3000.

**Questions to revisit**
- Why does checking only at registration time not stop SSRF?
- Why don't we follow redirects?

**Next step**
- M4: save every check result and run checks automatically on a schedule (BullMQ + worker).

---

### Session 4 — 2026-11-11 — M4 step 1: saving check history

**What we built**
- Table `check_results` (one row per check), "check now" saves its result, `GET /endpoints/:id/checks` shows history newest first.

**Concepts (simple words)**
- Foreign key: `endpoint_id` must point at a real endpoint. `ON DELETE CASCADE` means deleting an endpoint deletes its history too.
- Index: like a book's index, it finds "endpoint 5's newest results" without reading every row.
- Query parameters (`?limit=2`) arrive as text, so we convert and range-check them.
- TRUNCATE of a table that another table points at needs both tables listed together.

**Verification**
- Dev DB migrated (`002_create_check_results.sql`). typecheck OK, lint OK, build OK, 82/82 tests. Real run: two example.com checks saved (301 ms, 248 ms) and listed newest first.

**Next step**
- Decide how to run checks automatically: Postgres polling worker vs Redis + BullMQ.

---

### Session 5 — 2026-11-11 — M4 step 2: automatic checks with Redis + BullMQ

**Decision**
- The developer chose Redis + BullMQ over a simple Postgres-polling worker (ADR-007).

**What we built**
- Redis in Docker. `scheduler.ts`: one repeating timer per active endpoint. The API updates timers on add/edit/pause/delete. `worker.ts`: a separate program that runs the checks (max 10 at once), with retries, and saves results.

**Concepts (simple words)**
- Queue: a to-do list of jobs. Worker: the program that does the jobs.
- Timer (job scheduler): "put a job for endpoint 5 on the list every 60 s".
- Why a separate worker: slow checks never slow down the API.
- Fixed timer id (`endpoint-5`): scheduling twice updates the timer, it doesn't duplicate it.
- The job carries only the id: the worker always reads the latest settings from the database.
- Postgres = truth, Redis = helper: Redis can be rebuilt from the database (`syncAll`).
- Retry (website flaky) vs job failure (our code broke): handled differently.
- Fake vs real in tests: the API tests use a fake scheduler; the scheduler tests use real Redis with a separate prefix.

**Verification**
- typecheck OK, lint OK, build OK, 97/97 tests.
- Real run: endpoint with a 30 s interval was checked automatically at +0 s, +30 s, +60 s (example.com, about 235 ms). Pausing removed its timer from Redis. Worker shut down cleanly (exit 0). The worker also found and scheduled a pre-existing dev endpoint on startup.

**Questions to revisit**
- What happens to timers if Redis restarts? (They're lost until the worker restarts and runs syncAll.)
- Why is a "website down" not a failed job?

**Next step**
- M5: incidents. Open an incident after N failures in a row, close it after recovery.

---

### Session 6 — 2026-11-11 — M5: incidents

**What we built**
- Table `incidents` and setting `failure_threshold` (default 3). After every check: N failures in a row open an incident (starting at the first failure), and the first success resolves it. `GET /incidents` with status/endpoint filters.

**Concepts (simple words)**
- Incident = a period of being down, with a start and an end.
- "When did it start?" means the first failure, not the moment we noticed.
- Partial unique index: "only one *open* incident per endpoint", enforced by the database itself, so even two workers can't create duplicates.
- `ON CONFLICT DO NOTHING`: if the rule is broken, insert nothing instead of erroring.
- JOIN: add the endpoint's name to each incident row.
- `TRUNCATE ... CASCADE` empties every table linked to endpoints (test helper `resetDb`).
- Fake outage for testing: expect status 500 from a site that returns 200.

**Verification**
- Dev DB migrated (003). typecheck OK, lint OK, build OK, 113/113 tests.
- Real run: incident opened after 2 failures (started_at = first failure), resolved 60 s later at the first good check.
- Observed: the developer's own `dev:worker` and the test worker shared jobs, and each check ran exactly once (queue = horizontal scaling).

**Known limits**
- Flapping sites create many short incidents. A paused endpoint keeps its open incident.

**Next step**
- M6: email alerts when an incident opens or resolves.

---

### Session 7 — 2026-11-11 — M6: email alerts

**What we built**
- Mailpit (fake inbox) in Docker. An email on incident opened (🔴 DOWN) and resolved (✅ RECOVERED, with downtime). Sent through a second BullMQ queue ("alerts") with retries.

**Concepts (simple words)**
- SMTP: the standard way programs hand emails to an email server. nodemailer speaks it for us.
- Fake inbox for development: real emails, nobody receives them.
- Retry with exponential backoff: wait 5 s, then 10 s, 20 s, 40 s, so we don't hammer a broken server.
- Fixed job id = no duplicate emails (idempotency).
- Pure function for the email text, so it's easy to test.
- Emails state facts (what failed, when) and say they don't know why.
- One decision-maker: only the worker opens/closes incidents and triggers alerts.

**Verification**
- typecheck OK, lint OK, build OK, 129/129 tests.
- Real run: DOWN email after 2 failures, RECOVERED email ("down 1m 0s") after the fix. With Mailpit stopped, the first send failed. After restarting Mailpit the retry succeeded and the email arrived.

**Next step**
- M7: minimal dashboard (React) to see endpoints, checks, and incidents.

---

### Session 8 — 2026-11-11 — M7 step 1: overview page

**What we built**
- `frontend/` with React + Vite. The overview page shows open incidents, a table of websites with status badges, and Pause/Resume/Delete buttons, plus a form to add a website. Refreshes every 10 s.
- Backend: `GET /endpoints` now also returns each website's latest check and open incident.

**Concepts (simple words)**
- Component: a reusable piece of the page (the form, the table).
- State (`useState`): values that change and redraw the page when they do.
- Hook (`usePolling`): reusable behaviour, here "load now and every 10 s".
- Proxy: Vite passes `/api/...` to the backend, so the browser sees one website.
- The backend is the only judge of valid input; the form just shows its messages.
- UTC in the API, local time on the screen.
- Testing UI with a fake browser (jsdom) and a fake `fetch`.

**Verification**
- Backend: 130/130 tests. Frontend: typecheck OK, 11/11 tests, build OK.
- Dev server: page and source files served (HTTP 200), `/api/endpoints` forwarded correctly and returned the developer's 3 endpoints. Not visually checked by Claude (no browser); the developer is to look at it.

**Next step**
- M7 step 2: endpoint detail page (recent checks, incident history).

---

### Session 9 — 2026-11-11 — M7 step 2: detail page (+ two real-world puzzles)

**What we built**
- `/endpoints/:id` page: settings, Check now / Pause, "X of the last N checks passed", recent checks, incident history. Names on the overview link to it.

**Concepts (simple words)**
- Route with a placeholder (`/endpoints/:id`) and reading it with `useParams`.
- Loading several things at once with `Promise.all`.
- `useCallback` so the polling timer doesn't restart on every redraw.
- Always say what a number counts ("of the last 50 checks"), so it can't be misread.

**Real-world puzzles solved**
1. The portfolio showed DOWN while it opened fine in the browser. Cause: the site answers 307 → `www.` address. Browsers follow redirects; Sentinel deliberately doesn't (SSRF safety). Fix without code: register the final URL. README tip added. Following redirects safely was offered and declined as not needed.
2. Incidents "disappeared". Cause: the endpoint had been deleted and re-added. Deleting cascades to its checks and incidents (by design). Found by reading `created_at` and the check history directly in Postgres.

**Verification**
- Frontend: typecheck OK, 16/16 tests, build OK. Dev server: `/endpoints/23` serves the app (SPA fallback), and the real data for endpoint 23 came through the proxy.

**Next step**
- Phase 2: historical analytics (uptime over a time window, P50/P95/P99, charts).

---

### Session 10 — 2026-11-11 — Phase 2 step 1: stats API

**What we built**
- `GET /endpoints/:id/stats?window=24h|7d|30d`: uptime %, number of checks, P50/P95/P99 (successful checks only), failures by type.

**Concepts (simple words)**
- Uptime % only means something with its definition: which checks, which time window, how many.
- Average vs percentiles: 90×200 ms + 10×3000 ms → average 480 ms (nobody saw that), P50 200 ms, P95 3000 ms.
- `percentile_disc` picks a real value; `percentile_cont` blends neighbours.
- SQL `FILTER (WHERE ...)` counts only some rows inside one query. `GROUP BY` makes a count per error type.
- Test with made-up data where you know the right answer (`generate_series` inserts many rows at once).

**Real data (first look)**
- example.com: P50 ≈ 240 ms but P99 ≈ 600–700 ms. The slowest 1% take nearly 3× the normal time (tail latency).
- Portfolio (#23): 84.21% uptime over 38 checks, 6 timeouts. 4 in a row opened incident 6 and a DOWN email was sent. Cause not known (measured fact only).
- #24: the non-www portfolio URL again → 307 → 0% uptime (the redirect behaviour).

**Verification**
- typecheck OK, lint OK, build OK, 140/140 tests.

**Next step**
- Phase 2 step 2: time-series API for charts.

---

### Session 11 — 2026-11-11 — Phase 2 step 2: time-series API

**What we built**
- `GET /endpoints/:id/timeseries?window=...`: checks, uptime %, P50/P95 per bucket (1 h / 6 h / 1 day), oldest first.

**Concepts (simple words)**
- Bucket: a slice of time. Every check falls into exactly one.
- `date_bin`: round a time down to its bucket (14:37 → 14:00).
- `generate_series` + `LEFT JOIN`: list every bucket, even empty ones, so gaps show as "no data", never as "fine".
- Why no P99 per hour: with ~60 checks, the "slowest 1 in 100" is just the single slowest check, which is too noisy.

**Verification**
- typecheck OK, lint OK, build OK, 147/147 tests.
- Real data: the portfolio shows 2 hours with data (21:00 UTC 92.59%, 22:00 UTC 75%) and 23 gaps (it was added at 21:47).

**Next step**
- Phase 2 step 3: stats cards + chart on the detail page (Recharts).

---

### Session 12 — 2026-11-11 — Phase 2 step 3: performance panel + chart

**What we built**
- On the detail page: 24h/7d/30d buttons, cards (uptime with "X of N checks passed", P50/P95/P99, failures by type), a P50/P95 line chart with gaps, and a "show as table" view. It replaces the old "last 50 checks" summary (one uptime number per page, not two).

**Concepts (simple words)**
- Chart colours are checked with a validator (colour-blind safe), not chosen by eye.
- Two lines need a legend, and their names written at the line ends. Text stays in normal text colour.
- A gap in the line = no data. Never draw a line across it.
- Tooltips are a bonus. Every value must also be readable without hovering (the table).
- Turn off chart animation when the data refreshes every 10 s.
- jsdom has no ResizeObserver, so tests provide a do-nothing stand-in.

**Verification**
- Frontend: typecheck OK, 19/19 tests, build OK (warning: bundle > 500 kB because of Recharts, accepted). Dev server serves the chart and Recharts. Real stats/timeseries come through the proxy. Not visually checked by Claude (no browser).

**Next step**
- The developer looks at the chart. Then commit Phase 2 and move to Phase 3 (API test suites).

---

## Concept checklist

Mark a topic complete only when the developer can explain it in their own words and connect it to Sentinel.

### Backend and networking
- [ ] HTTP methods, status codes, headers, request/response lifecycle
- [ ] DNS, TLS/SSL, certificate expiry
- [ ] Timeouts, retries, backoff, jitter
- [ ] Latency percentiles (P50/P95/P99)
- [ ] Uptime and error-rate calculations
- [ ] API validation and error handling
- [ ] Authentication and authorization
- [ ] SSRF and safe outbound requests

### Distributed systems
- [ ] Polling and scheduling
- [ ] Job queues and workers
- [ ] Redis and BullMQ concepts
- [ ] Idempotency and duplicate jobs
- [ ] Retry semantics and dead-letter handling
- [ ] Concurrency limits and rate limiting
- [ ] Eventual consistency and failure handling

### Databases
- [ ] Relational modeling and foreign keys
- [ ] Indexes and query plans
- [ ] Migrations
- [ ] Transactions
- [ ] Time-window aggregation
- [ ] Retention and data growth

### Testing and observability
- [ ] Unit vs integration vs end-to-end tests
- [ ] API assertions and schema validation
- [ ] Test execution history
- [ ] Metrics vs logs vs traces
- [ ] Incident lifecycle
- [ ] CI/CD basics

### Python and data
- [ ] Python syntax, functions, classes, virtual environments
- [ ] NumPy arrays
- [ ] Pandas DataFrames and time-series operations
- [ ] Data cleaning and missing values
- [ ] Feature engineering
- [ ] Visualization and exploratory data analysis

### Machine learning
- [ ] Supervised vs unsupervised learning
- [ ] Classification vs regression
- [ ] Train/validation/test split
- [ ] Data leakage
- [ ] Baseline models
- [ ] Precision, recall, F1, confusion matrix
- [ ] Regression metrics
- [ ] Anomaly detection and false positives
- [ ] Time-aware validation
- [ ] Model limitations and monitoring

### NLP and AI
- [ ] Text normalization and tokenization
- [ ] TF-IDF
- [ ] Text classification
- [ ] Embeddings and similarity
- [ ] LLM prompting and structured output
- [ ] Grounding output in logs and measurements
- [ ] Hallucination and confidence limitations

### System design and delivery
- [ ] Modular monolith vs microservices
- [ ] Service boundaries and API contracts
- [ ] Scalability bottlenecks
- [ ] Security and secrets management
- [ ] Docker and Docker Compose
- [ ] Git branching and meaningful commits
- [ ] Architecture diagrams and trade-off explanations
