# Sentinel — Architecture Decision Records

Each record: context, options, decision, why, trade-offs, and what would make us revisit it.

---

## ADR-001 — Modular monolith with a separate Python analytics service

**Date:** 2026-11-11 · **Status:** Accepted

**Context.** Sentinel has many modules (monitoring, analytics, testing, ML, dashboard). We are a single developer building incrementally.

**Options.** (a) Microservices per module. (b) Modular monolith (one Node codebase, separate API and worker processes) plus a Python service. (c) Everything in one language/process.

**Decision.** (b).

**Why.** Microservices add network calls, distributed failures, deployment overhead and data-consistency problems with no benefit at our scale. Python is split out only because the ML ecosystem (Pandas, scikit-learn) is Python-based, which is a real language boundary. API and worker run as separate processes from the same codebase so slow checks never block user requests, and each can be scaled separately.

**Trade-offs.** Module boundaries inside the monolith are enforced by discipline (folders, interfaces), not by the network.

**Revisit if.** A module needs independent scaling or deployment cadence that separate processes cannot provide, or a team grows around one module.

---

## ADR-002 — TypeScript for the Node.js backend

**Date:** 2026-11-11 · **Status:** Accepted

**Context.** Backend language choice: JavaScript or TypeScript.

**Decision.** TypeScript in strict mode, compiled with `tsc`, run in development with `tsx`, using native ES modules (`"module": "NodeNext"`).

**Why.** It catches type errors at compile time (familiar from C++), shares types with the React frontend, and makes refactoring safer. Types vanish at runtime, so we still validate external input with Zod.

**Trade-offs.** It needs a build step. NodeNext requires `.js` extensions in relative imports, which is surprising at first.

**Revisit if.** Node's built-in type stripping becomes mature enough to drop the build step.

---

## ADR-003 — Docker Compose for local dependencies

**Date:** 2026-11-11 · **Status:** Accepted

**Context.** PostgreSQL 16 was installed natively in WSL but stopped. Later milestones also need Redis and a local mail catcher.

**Decision.** Run dependencies (currently only PostgreSQL 16) with Docker Compose. Run the Node app itself directly on the host for fast iteration.

**Why.** Pinned versions, one-command setup and teardown, identical setup for CI. Ports are bound to 127.0.0.1 so local databases are not exposed to the network.

**Trade-offs.** Requires Docker Desktop and its WSL integration, plus some resource overhead.

**Revisit if.** We containerize the app itself for deployment (Phase 8). That extends this decision rather than replacing it.

---

## ADR-004 — Express 5, Zod, pino, Vitest + Supertest

**Date:** 2026-11-11 · **Status:** Accepted

- **Express 5** (not Fastify/NestJS): small, explicit, and good for learning the middleware model. Version 5 forwards errors thrown in async handlers to the error middleware automatically.
- **Zod** for runtime validation of environment and (later) request bodies, with TypeScript types inferred from the schemas.
- **pino** for structured JSON logs. It's fast, and redaction of sensitive headers is built in.
- **Vitest + Supertest**: Vitest runs TypeScript directly. Supertest sends requests to the Express app in memory.

**Known issue accepted (ADR-004).** `npm audit` reports a moderate ReDoS advisory in `minimatch`, pulled in by ESLint/typescript-eslint (**dev-only**; it processes only our own glob patterns). `npm audit --omit=dev` reports 0 vulnerabilities. The suggested `--force` fix downgrades ESLint a major version. Revisit when typescript-eslint publishes a patched release.

---

## ADR-005 — Raw SQL, a tiny migration runner, and snake_case JSON

**Date:** 2026-11-11 · **Status:** Accepted

**Context.** M2 adds the first table. We need a way to run queries and evolve the schema. The project prefers simple, transparent code.

**Options.** (a) ORM (Prisma, Drizzle, TypeORM). (b) Query builder (Knex, Kysely). (c) Raw SQL through `pg`, plus a migration library (node-pg-migrate). (d) Raw SQL plus our own ~40-line migration runner over plain `.sql` files.

**Decision.** (d). Routes call small repository functions that run parameterized SQL. JSON field names are snake_case, the same as the columns.

**Why.** You see exactly what runs against the database, and SQL is a skill interviews test directly. The migration runner is short enough to read in full, and it shows what migration tools actually do: an ordered list of files, a tracking table, one transaction per file. snake_case JSON removes a mapping layer and matches the future Python service.

**Trade-offs.** No automatic type generation from the schema: the `Endpoint` TypeScript type is kept in sync by hand. No "down" migrations (fix forward with a new file). Dynamic `UPDATE` builds column names from validated keys, which is safe only because the Zod schema whitelists them.

**Revisit if.** Many tables with complex joins make hand-written types error-prone, or we need rollback migrations.

---

## ADR-006 — SSRF protection with a connection-time DNS check

**Date:** 2026-11-11 · **Status:** Accepted

**Context.** Users register arbitrary URLs and Sentinel visits them from inside our network.

**Options.** (a) Check the URL only when it's registered. (b) Look up the IP just before the request, then fetch. (c) Check the IP inside the HTTP client's own DNS lookup, at connection time.

**Decision.** (c), using `undici` (Node's official HTTP client) with a custom `lookup`, plus a direct check for IPs typed into the URL. Redirects are not followed.

**Why.** (a) fails because DNS answers can change after registration. (b) has a gap: DNS could answer differently on the second lookup (DNS rebinding). (c) checks the exact IP we connect to. Not following redirects stops "public URL → redirect to internal address" tricks without extra code.

**Trade-offs.** Sites that redirect (e.g. http → https) are reported with their 3xx status, so users must register the final URL or set `expected_status` to the 3xx. Private/local services can't be monitored.

**Revisit if.** We need to follow redirects (then re-check each hop) or allow an explicit allowlist of private targets.

---

## ADR-007 — Scheduling with Redis + BullMQ job schedulers

**Date:** 2026-11-11 · **Status:** Accepted (developer's choice)

**Context.** Endpoints must be checked automatically every `interval_seconds`.

**Options.** (A) A worker that polls Postgres every few seconds for due endpoints: no new infrastructure. (B) Redis + BullMQ: one repeating job scheduler per endpoint.

**Decision.** (B). The API upserts/removes the endpoint's scheduler on create/update/delete. A separate worker process consumes jobs (concurrency 10) and resyncs all schedulers from Postgres on startup.

**Why.** It's the planned stack, it's widely used, and it's good learning: queues, workers, concurrency limits, and the idea of de-duplicating by a fixed scheduler id. It also fires jobs at exact intervals without polling.

**Trade-offs.** One more service (Redis), and Redis state must be kept consistent with Postgres: API calls plus startup `syncAll`. Option A would have needed neither. If Redis is down, edits to endpoints fail with 500 until it's back, and the worker restart repairs timers.

**Revisit if.** Running Redis becomes a burden, or consistency issues appear. Option A or a periodic `syncAll` would address them.

---

## ADR-008 — Incident rule: N consecutive failures open, one success closes

**Date:** 2026-11-11 · **Status:** Accepted

**Context.** A single failed check is often noise. We need a clear definition of "down".

**Decision.** Open an incident when the newest `failure_threshold` checks (per endpoint, default 3) all failed; it starts at the first failure of that streak. Resolve on the first successful check. At most one open incident per endpoint, enforced by a partial unique index.

**Why.** It's easy to explain, easy to test, and configurable per endpoint. The database constraint makes duplicates impossible, without needing locks in our code.

**Trade-offs.** Detection delay is about `failure_threshold × interval`. One success closes the incident, so flapping sites produce several short incidents. Time-based rules ("down for 5 minutes") and "N successes to recover" are not supported.

**Revisit if.** Flapping creates noisy incidents/alerts in practice. Then add a recovery threshold.

---

## ADR-009 — Email alerts via an alerts queue, SMTP (nodemailer), and Mailpit locally

**Date:** 2026-11-11 · **Status:** Accepted

**Context.** Engineers must be told when an incident opens or resolves. Email delivery can fail temporarily.

**Options.** (a) Send the email directly inside the check job. (b) Put an "alert" job on a second BullMQ queue with retries. (c) A third-party alerting service.

**Decision.** (b). SMTP through nodemailer, configured by `SMTP_URL`. Mailpit in Docker for development. One global recipient list (`ALERT_EMAIL_TO`). Only the worker decides incidents, so there's one place that triggers alerts.

**Why.** Retries with exponential backoff come for free, and a fixed job id prevents duplicate emails. SMTP works with any provider, and no credentials are in code. Mailpit lets us see real emails without sending any.

**Trade-offs.** More moving parts than a direct send. Alerts can arrive a few seconds late. After 5 failed attempts the alert is dropped (kept in the failed list, logged). A global recipient list, no per-user settings yet. "Check now" no longer opens/closes incidents immediately.

**Revisit if.** We add users (per-user recipients) or other channels (Slack, webhooks).

---

## ADR-010 — Dashboard: Vite + React Router, plain CSS, polling, dev proxy

**Date:** 2026-11-11 · **Status:** Accepted

**Context.** First UI. It should be simple to read and build.

**Decision.** React 19 + TypeScript 6 built with Vite. React Router for page addresses. Plain CSS. Data refreshed by polling every 10 s with a small `usePolling` hook (no data-fetching library). Vite's dev proxy forwards `/api` to the backend. Frontend types are hand-copied from the backend.

**Why.** Fewest new concepts. Polling every 10 s is plenty for checks that run every 30 s or more. The proxy avoids CORS during development.

**Trade-offs.** Polling makes requests even when nothing changed (fine at this scale). Hand-copied types can drift from the backend. No component library, so styling is basic. TypeScript pinned to 6 to match the backend (npm offered 7).

**Revisit if.** Many users (then consider server-sent events/WebSockets), or types drift often (then a shared types package).

---

## ADR-011 — Analytics computed on request; Recharts for charts

**Date:** 2026-11-11 · **Status:** Accepted

**Context.** Phase 2 needs uptime and percentiles over 24h/7d/30d and a chart.

**Decision.** Compute stats and time-series buckets in SQL on each request (`percentile_disc`, `FILTER`, `date_bin`, `generate_series`). No pre-aggregated tables. Draw charts with Recharts. Speed percentiles use successful checks only. Gaps are kept as nulls.

**Why.** It's the least code and always exact: no roll-up job to keep in sync. Data volume is small (about 43k rows per endpoint per 30 days, with an index on `(endpoint_id, checked_at)`). Recharts is the common React choice and declarative.

**Trade-offs.** Each request scans the window's rows. Buckets are aligned to UTC (daily buckets split at UTC midnight). Recharts adds ~400 kB to the bundle.

**Revisit if.** Stats queries get slow (add hourly roll-up tables), or local-time daily buckets are needed.

---

## ADR-012 — API tests are declarative data, run by Sentinel (no Pytest, no user code)

**Date:** 2026-11-11 · **Status:** Accepted

**Context.** Users need automated API tests. The project rules forbid executing user-submitted code on the main server.

**Options.** (a) Users upload test scripts (e.g. Pytest/JS) and we run them in a sandbox. (b) Tests are JSON data: a request plus a fixed menu of assertions, evaluated by our own code.

**Decision.** (b). Suites belong to an endpoint, and cases hold request + assertions as JSONB. Pytest stays for testing our own Python service later.

**Why.** No code execution means no sandbox to build or secure. Every test is validatable, storable, and explainable ("expected 200, got 500"). The same SSRF guard applies to every request.

**Trade-offs.** Less flexible than code: no loops, variables, or chained requests (e.g. login then use the token). The assertion menu is small (no JSON Schema yet). Headers are stored unencrypted.

**Revisit if.** Users need multi-step flows (add variables/chaining as data) or schema validation (add a `json_schema` assertion with a validator library).

---

## ADR-013 — Anomaly detection: robust z-score in a read-only Python service, called hourly by Node

**Date:** 2026-11-11 · **Status:** Accepted

**Context.** Phase 4 needs a transparent statistical baseline for unusual behaviour, before any ML.

**Decision.**
- **Method:** hourly P50 of successful checks vs the median of the previous ≤ 24 hours, robust z-score (MAD), threshold 3.5, slower only, at least 12 hours of history.
- **Where:** a separate Python/FastAPI service that reads Postgres with a read-only connection and returns findings as JSON.
- **Who saves:** the Node worker calls it hourly for each active endpoint, validates the response (Zod), and saves with `ON CONFLICT DO NOTHING`.

**Why.**
- Median/MAD aren't dragged by earlier spikes (demonstrated in a test), and every number is explainable.
- Python for pandas now and scikit-learn later.
- Read-only access keeps a single writer and owner of the schema.
- Hourly batches instead of per-check calls, as the architecture rules require.

**Trade-offs.**
- Only one metric so far (P50 latency); error rate and availability aren't covered.
- Fixed thresholds are rules of thumb, not tuned.
- Python reads the tables directly, so it depends on Node's schema (the contract covers the response, not the query).
- A 4th process to run locally.
- Not evaluated on real data yet.

**Revisit if.** False positives or missed slowdowns show up in real data (tune, or add an ML detector and compare via `method`), or more metrics are needed.

---

## ADR-014 — Shadow mode for new detectors

**Date:** 2026-11-11 · **Status:** Accepted

**Context.** On held-out synthetic data, same-hour statistics (F1 0.88) and Isolation Forest v2 (F1 0.86) beat the live rule (0.35). Synthetic data doesn't prove real-world value.

**Decision.** Run both live in **shadow mode**: computed hourly, saved with their `method`, and shown with a SHADOW tag. Nothing is promoted (e.g. alerting on them) until real-data evidence supports it.

**Why.** It's the standard safe way to introduce models. It collects real evidence, users see the output with a clear "unproven" label, and it's reversible.

**Trade-offs.** More findings on the page, possibly noisy. 14 days of data loaded per endpoint per hour. Real-data evaluation still lacks an answer key (it will need manual review of findings).

**Revisit if.** After enough real history, review shadow findings against incidents and known events, then promote, tune, or drop each detector.
