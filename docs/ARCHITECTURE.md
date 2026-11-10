# Sentinel — Architecture

This document describes what **exists now** and what is **planned**. Planned parts are marked clearly.

## 1. Target architecture (planned)

```mermaid
flowchart TD
    U[Engineer's browser] --> FE[React + TS dashboard]
    FE -->|HTTPS + JSON| API[Node/Express API]
    API -->|SQL| DB[(PostgreSQL — source of truth)]
    API -->|schedule jobs| Q[(Redis / BullMQ)]
    Q --> W[Worker process — same Node codebase]
    W -->|SSRF-guarded HTTP| T[Monitored APIs — untrusted]
    W --> DB
    W --> MAIL[Email / SMTP]
    W -->|periodic analysis request| PY[Python FastAPI analytics/ML]
    PY -->|read-only SELECT| DB
    PY -->|findings JSON| W
```

Style: **modular monolith**. One Node.js codebase runs as an API process and (from M4) a worker process. Python is a separate service only because of the language/ecosystem boundary. See [DECISIONS.md](DECISIONS.md) ADR-001.

Principles:
- PostgreSQL is the durable source of truth; Redis only coordinates jobs.
- Measurements are persisted first; ML runs periodically over windows, never per check.
- Node owns the database schema (migrations). Python reads with a read-only role and returns findings for Node to validate and store (tentative; confirm in Phase 4).
- Every outbound request to a user-supplied URL goes through an SSRF guard (from M3).

## 2. Current state (Milestone 1)

```mermaid
flowchart LR
    C[curl / load balancer / Docker] -->|GET /healthz| S
    subgraph S[backend process — server.ts]
      direction TB
      L[pino-http request log] --> J[express.json body parser] --> H[health router] --> NF[404 handler] --> EH[error handler]
    end
    H -->|SELECT 1 with timeout| P[(PostgreSQL 16 in Docker)]
```

### Backend modules

| File | Responsibility |
|---|---|
| `src/config.ts` | Read and validate environment variables once (Zod), fail fast, never print secret values |
| `src/logger.ts` | Structured JSON logger (pino) with header redaction |
| `src/db.ts` | PostgreSQL connection pool, `ping()` with timeout, idle-error handler, `withTimeout` helper |
| `src/middleware/errors.ts` | JSON 404 and a central error handler (4xx passthrough, generic 500) |
| `src/routes/health.ts` | `GET /healthz` readiness check |
| `src/app.ts` | Builds the Express app from injected dependencies (testable without a network or DB) |
| `src/server.ts` | Entry point: wires real dependencies, listens, graceful shutdown on SIGTERM/SIGINT |

### Request lifecycle: `GET /healthz`

1. `pino-http` records the start time and attaches a request logger.
2. `express.json` does nothing (no body).
3. The health router calls `db.ping(HEALTHCHECK_DB_TIMEOUT_MS)`, which races `SELECT 1` against a timer.
4. Success → `200 {"status":"ok",...}`. Any failure or timeout → logged at warn, `503 {"status":"error",...}`.
5. `pino-http` logs the completed request with status and response time.

### Failure behaviour

| Situation | Behaviour |
|---|---|
| Invalid/missing env var at startup | Prints which variables are wrong (not their values), exits with code 1 |
| Postgres down or slow | `/healthz` returns 503 within the timeout; process keeps running |
| Idle pooled connection dropped (Postgres restart) | Logged by `pool.on("error")`; process does not crash |
| Malformed JSON body | 400 `BAD_REQUEST` |
| Unknown route | 404 `NOT_FOUND` |
| Unexpected exception | Logged in full; client receives generic 500 `INTERNAL_ERROR` |
| SIGTERM / Ctrl+C | Stop accepting connections, finish in-flight requests, close pool, exit 0 (forced exit after 10 s) |

### API contract

```
GET /healthz
200 {"status":"ok","checks":{"database":"ok"}}
503 {"status":"error","checks":{"database":"error"}}
Headers: Cache-Control: no-store

Error shape (all endpoints):
{"error":{"code":"NOT_FOUND"|"BAD_REQUEST"|"INTERNAL_ERROR","message":"..."}}
```

## 3. Endpoint registry (Milestone 2)

```mermaid
flowchart LR
    C[client] -->|POST/GET/PATCH/DELETE /endpoints| R[endpoints/routes.ts<br/>parse id, validate body with Zod]
    R --> Repo[endpoints/repository.ts<br/>parameterized SQL]
    Repo --> DB[(endpoints table)]
```

Layers, each with one job:

| File | Job |
|---|---|
| `src/endpoints/schemas.ts` | What valid input is (Zod). Defaults live here only. |
| `src/endpoints/routes.ts` | HTTP: parse id, validate, call repository, choose status code |
| `src/endpoints/repository.ts` | SQL only; values always passed as `$1, $2...` parameters |
| `migrations/001_create_endpoints.sql` | Table definition with CHECK constraints as a second line of defence |
| `src/migrate.ts` | Applies pending `.sql` files in order inside a transaction; records them in `schema_migrations` |

### Schema: `endpoints`

| Column | Type | Notes |
|---|---|---|
| id | INTEGER identity PK | |
| name | TEXT | 1–100 chars |
| url | TEXT | ≤ 2048 chars; protocol checked by API |
| method | TEXT | `GET` / `HEAD` |
| interval_seconds | INTEGER | 30–3600 |
| timeout_ms | INTEGER | 1000–30000 (always < min interval) |
| expected_status | INTEGER | 100–599 |
| max_retries | INTEGER | 0–3 |
| paused | BOOLEAN | paused endpoints will not be scheduled (M4) |
| created_at / updated_at | TIMESTAMPTZ | stored in UTC; `updated_at` set by UPDATE |

Not yet: ownership (`user_id`), which comes with authentication. The URL is only checked *syntactically* here. The SSRF check (does it resolve to a private IP?) happens at request time in M3, because DNS answers can change after registration.

### Testing approach

- `health`, `config`, `errors`, `db` tests use fakes and need no database.
- `endpoints` and `migrate` tests are **integration tests** against a real `sentinel_test` database. `tests/global-setup.ts` creates and migrates it once, and each test truncates the table first. Test files run one at a time because they share that database.

## 4. Checking an endpoint (Milestone 3)

```mermaid
flowchart LR
    C[client] -->|POST /endpoints/:id/check| R[routes.ts]
    R -->|load row| DB[(endpoints)]
    R --> CE[checks/check-endpoint.ts]
    CE -->|1. IP typed in URL? check it| G[checks/ssrf-guard.ts]
    CE -->|2. fetch via safe Agent| U[undici]
    U -->|DNS lookup → safeLookup checks every IP| G
    U -->|connect only if allowed| T[target website]
    CE -->|CheckResult JSON| C
```

- `checkEndpoint()` **never throws**. Every outcome (up, wrong status, timeout, DNS failure, blocked) is returned as a `CheckResult`.
- Timeout: `AbortSignal.timeout(timeout_ms)` cancels the request.
- Response time = time until response headers arrive. The body is discarded.
- Redirects are **not followed** (`redirect: "manual"`). A 3xx is reported as the status.
- Since M4 step 1, "check now" saves each result to `check_results` (see below). Automatic scheduling is the next step.

### Schema: `check_results` (M4 step 1)

| Column | Type | Notes |
|---|---|---|
| id | INTEGER identity PK | |
| endpoint_id | INTEGER FK → endpoints(id) | `ON DELETE CASCADE`: deleting an endpoint deletes its history |
| ok | BOOLEAN | |
| status_code | INTEGER NULL | NULL when there was no answer |
| response_time_ms | INTEGER | |
| error_type / error_message | TEXT NULL | NULL when ok |
| checked_at | TIMESTAMPTZ | UTC |

Index `(endpoint_id, checked_at DESC)` makes "newest results for endpoint X" fast. API: `GET /endpoints/:id/checks?limit=N` (1–500, default 50).

Growth: one endpoint every 60 s produces about 1,440 rows/day (about 525k/year). A retention or cleanup job will be needed eventually; not yet.

### SSRF guard

Two checks, because there are two ways to reach an address:
1. **IP typed in the URL** (`http://127.0.0.1`): no DNS lookup happens, so `checkEndpoint` checks the IP itself.
2. **Hostname** (`http://localhost`): undici's Agent uses `safeLookup`, which does the normal DNS lookup and refuses if *any* returned IP is blocked. The check happens at connection time, so DNS changing its answer between check and connect (DNS rebinding) doesn't help an attacker.

Blocked ranges: 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.168/16, 224/4, 240/4, ::, ::1, fc00::/7, fe80::/10, ff00::/8. IPv4-mapped IPv6 (`::ffff:127.0.0.1`) is matched by the IPv4 rules automatically.

Known limits: the fetch standard refuses some ports outright ("bad port", reported as `network`). Private targets can't be monitored, which is by design. Tests pass `allowPrivateAddresses: true` so they can use a local fake server.

## 5. Automatic checks: Redis + BullMQ (Milestone 4)

```mermaid
flowchart LR
    API[API process<br/>server.ts] -->|add/edit → upsert timer<br/>pause/delete → remove timer| R[(Redis<br/>BullMQ job schedulers)]
    R -->|every N s: job endpointId| W[Worker process<br/>worker.ts, concurrency 10]
    W -->|read latest config| DB[(PostgreSQL)]
    W -->|checkEndpoint + retries| T[target website]
    W -->|INSERT check_results| DB
    W -.->|on startup: syncAll from DB| R
```

- **One timer per endpoint**, with the fixed id `endpoint-<id>`. `upsertJobScheduler` updates it instead of creating duplicates.
- **Jobs carry only `endpointId`.** The worker reads the current URL, timeout and paused flag from Postgres for every job, so edits apply on the next tick.
- **Retries** (`max_retries`) happen inside one job, 1 s apart. Only the final result is saved.
- **A failed job** means our code broke (e.g. the DB is down), not that a site is down. It is logged and not retried: the next tick checks again.
- **Postgres is the source of truth.** Redis has no volume. `syncAll` on worker startup creates timers for active endpoints and removes timers for deleted/paused ones.
- Finished jobs are removed from Redis (`removeOnComplete`). Results live in Postgres.
- Redis keys use the prefix `sentinel`. Tests use `sentinel-test`.

Known limitation: if Redis is down when an endpoint is created or edited, the DB change succeeds but the request returns 500 and the timer isn't updated. Restarting the worker repairs it (`syncAll`).

## 6. Incidents (Milestone 5)

After every **scheduled** check, the worker runs `incidents/update-incidents.ts` (since M6, only the worker decides incidents; "check now" results are saved and counted at the next scheduled check). It applies one rule:

| Check | Open incident? | Action |
|---|---|---|
| ok | yes | resolve it (`resolved_at` = this check's time) |
| ok | no | nothing |
| failed | yes | nothing (still down) |
| failed | no | if the newest `failure_threshold` checks all failed → open one |

- `started_at` = time of the **first** failure in the streak (answers "when did it start?"). `error_type`/`error_message` come from that first failure.
- A partial unique index (`endpoint_id WHERE resolved_at IS NULL`) guarantees at most one open incident per endpoint, even if two workers race. Inserts use `ON CONFLICT ... DO NOTHING`.
- The rule returns `opened` / `resolved` / null. The worker logs it; M6 will send email on it.
- API: `GET /incidents?status=&endpoint_id=&limit=`, joined with the endpoint name.

### Schema: `incidents`

| Column | Type | Notes |
|---|---|---|
| id | INTEGER identity PK | |
| endpoint_id | INTEGER FK → endpoints | `ON DELETE CASCADE` |
| started_at | TIMESTAMPTZ | first failed check of the streak |
| resolved_at | TIMESTAMPTZ NULL | NULL = open |
| error_type / error_message | TEXT | from the first failed check |

`endpoints.failure_threshold` (1–10, default 3) was added in the same migration.

Known limitations: one success resolves an incident, so a "flapping" site (up/down/up) can open and close many incidents. Pausing an endpoint leaves an open incident open.

## 7. Email alerts (Milestone 6)

```mermaid
flowchart LR
    CW[check worker] -->|incident opened/resolved| AQ[(Redis: alerts queue<br/>jobId incident-7-opened)]
    AQ --> AW[alert worker<br/>concurrency 2]
    AW -->|load incident + endpoint| DB[(PostgreSQL)]
    AW -->|nodemailer SMTP| M[Mailpit locally<br/>real SMTP in production]
    AW -.->|send failed → retry 5s,10s,20s,40s| AQ
```

- Both workers run in the same `worker.ts` process.
- **Retries:** `attempts: 5`, exponential backoff from 5 s. A failed send throws, and BullMQ schedules the retry.
- **No duplicates:** the job id `incident-<id>-<kind>` is fixed, and finished jobs are kept for 24 h, so the same alert can't be queued twice.
- **Content:** `alerts/incident-email.ts` (pure function). Times are shown in UTC. The email states measured facts and explicitly says it doesn't know the cause.
- **Recipients:** global list `ALERT_EMAIL_TO`; empty = alerts off. Per-user preferences need authentication (later).
- The job carries only `incidentId` + `kind`. The worker reads current data from Postgres. If the incident was deleted, the alert is skipped.

## 8. Dashboard (Milestone 7)

```mermaid
flowchart LR
    B[Browser<br/>localhost:5173] -->|page + /api/... requests| V[Vite dev server]
    V -->|/api/endpoints → /endpoints| API[Express API :3000]
```

| File | Job |
|---|---|
| `frontend/src/main.tsx` | Mounts React, defines page addresses (React Router) |
| `frontend/src/api.ts` | Typed `fetch` wrapper for every backend call; `ApiError` carries validation details |
| `frontend/src/usePolling.ts` | Hook: load now, then every 10 s |
| `frontend/src/status.ts` | Pure helpers: status word (up/down/failing/paused/pending), "5 min ago", local time |
| `frontend/src/pages/Overview.tsx` | Open incidents, websites table with Pause/Resume/Delete, add form |
| `frontend/src/components/AddEndpointForm.tsx` | Add-website form; shows the backend's validation messages |
| `frontend/src/pages/EndpointDetail.tsx` | `/endpoints/:id`: settings, Check now / Pause, summary of the last 50 checks, recent checks table, incident history |

The detail page loads the endpoint, its last 50 checks and its incidents in parallel (`Promise.all`) in one polling cycle. Its summary states exactly what it counts ("X of the last N checks passed"; average response uses successful checks only). Proper time-window uptime and percentiles are Phase 2.

- **One request for the table:** `GET /endpoints` includes each endpoint's `last_check` and `open_incident` (sub-queries with `row_to_json`), which avoids one request per row.
- **Status words:** `down` = an incident is open. `failing` = the last check failed but the threshold isn't reached yet. Facts first, no guessing.
- **Validation lives in the backend only.** The form shows the API's error messages.
- **Times:** the API sends UTC, and the browser shows local time.
- **Types are duplicated** in `api.ts` (not shared with the backend). It's simple, but they must be kept in sync by hand.
- No CORS needed in development thanks to the Vite proxy. A production deployment must serve the page and API from one origin (or add CORS): Phase 8.

## 9. Local infrastructure

`docker-compose.yml` runs, all on `127.0.0.1` only:
- `postgres:16-alpine`: named volume `pgdata`, `pg_isready` healthcheck.
- `redis:7-alpine`: no volume (rebuilt from Postgres), `redis-cli ping` healthcheck.
- `axllent/mailpit:v1.33.1`: fake SMTP server on 1025, web inbox on http://localhost:8025.
