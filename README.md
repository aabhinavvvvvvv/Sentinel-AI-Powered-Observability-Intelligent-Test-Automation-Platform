# Sentinel

**AI-Powered Observability & Intelligent Test Automation Platform.**

Sentinel monitors APIs and services, detects abnormal behaviour, helps engineers investigate failures, predicts degradation where historical data supports it, and prioritizes tests based on risk. Full scope: [docs/PROJECT_BLUEPRINT.md](docs/PROJECT_BLUEPRINT.md).

> **Status: early development (Phase 3: automated API testing).**
> Register endpoints and Sentinel checks them automatically on their interval (Redis + BullMQ worker), with retries and SSRF protection. Every result is saved. After N failures in a row an incident is opened, and it is resolved on recovery. An email goes out for each (with retries if the mail server is down). A web dashboard shows every website's status and open incidents, lets you add, pause, and delete websites, and has a detail page per website (settings, uptime and P50/P95/P99 over 24h/7d/30d, a response-time chart, recent checks, incident history, "check now").
> API testing: suites of request + assertion test cases, run on demand or on a schedule, with per-case results and failure reasons (dashboard: **API tests** tab).
> Anomaly detection (statistical baseline): a Python service flags unusually slow hours; shown on each website's page.
> Not yet: ML models, failure classification, test prioritization (see the roadmap in the blueprint). Analytics, testing, ML, and the dashboard come later (see the roadmap in the blueprint).

## Repository layout

```
sentinel/
├── backend/            Node.js + TypeScript + Express API and background worker
│   ├── src/            application code
│   └── tests/          Vitest + Supertest tests
├── frontend/           React + TypeScript dashboard (Vite)
│   └── src/            pages, components, API client, tests
├── analytics/          Python + FastAPI analytics service (Phase 4, early)
│   ├── app/            the service
│   └── tests/          pytest tests
├── docs/               blueprint, architecture, decisions, learning log
├── docker-compose.yml  local dependencies (PostgreSQL, Redis, Mailpit)
└── .env.example        configuration template (copy to .env)
```

## Prerequisites

- Node.js **22+** and npm
- Docker with Docker Compose v2 (on Windows/WSL: enable WSL integration in Docker Desktop)

## Getting started

```bash
# 1. Create your local config (git-ignored). Edit the password if you like.
cp .env.example .env

# 2. Start PostgreSQL, Redis and Mailpit in the background and wait until they are healthy.
docker compose up -d --wait

# 3. Install backend dependencies.
cd backend
npm install

# 4. Create/update the database tables (safe to run repeatedly).
npm run migrate

# 5. Run the API in development mode (auto-restarts on file changes, pretty logs).
npm run dev

# 6. In a second terminal, run the worker (scheduled checks, incidents, alert emails).
npm run dev:worker

# 7. In a third terminal, run the dashboard, then open http://localhost:5173
cd ../frontend
npm install
npm run dev
```

The dashboard calls `/api/...`. Vite's dev server forwards those requests to the backend on port 3000, so the API must be running.

```bash
# 8. In a fourth terminal, run the Python analytics service (see "Analytics service" below for setup).
cd analytics
.venv/bin/uvicorn app.main:app --env-file ../.env --reload --port 8000
```

The worker asks it once an hour for unusual behaviour. If it isn't running, the worker logs an error and tries again next hour.

**Alert emails (local):** emails go to **Mailpit**, a fake inbox. Open http://localhost:8025 to read them. Nothing is really sent. Recipients come from `ALERT_EMAIL_TO` in `.env` (comma-separated; leave empty to turn alerts off). For real email, point `SMTP_URL` at a real SMTP provider (e.g. `smtps://user:password@smtp.example.com:465`). Keep that in `.env`, never in Git.

In another terminal:

```bash
curl -i http://localhost:3000/healthz
# HTTP/1.1 200 OK
# {"status":"ok","checks":{"database":"ok"}}
```

If PostgreSQL is stopped (`docker compose stop postgres`), the same request returns `503` with `"database":"error"`.

## Backend scripts (run inside `backend/`)

| Command | What it does |
|---|---|
| `npm run dev` | Run the API from TypeScript source with auto-reload and pretty logs |
| `npm run dev:worker` | Run the check worker the same way |
| `npm run migrate` | Apply pending SQL files from `backend/migrations/` |
| `npm test` | Run all tests once. **Needs Postgres and Redis running** (not Mailpit: tests use a fake mailer); uses a separate `sentinel_test` database and `sentinel-test` Redis prefix |
| `npm run typecheck` | Type-check `src/` and `tests/` without emitting files |
| `npm run lint` | Run ESLint |
| `npm run build` | Compile `src/` to JavaScript in `dist/` |
| `npm start` / `npm run start:worker` | Run the compiled API / worker |

## Frontend scripts (run inside `frontend/`)

| Command | What it does |
|---|---|
| `npm run dev` | Dashboard dev server on http://localhost:5173 with instant reload |
| `npm test` | Component and helper tests (jsdom, fake `fetch`; no backend needed) |
| `npm run typecheck` | Type-check |
| `npm run build` | Type-check and build static files into `dist/` |

## Analytics service (Python, inside `analytics/`)

Needs Python 3.12+. One-time setup:

```bash
cd analytics
python3 -m venv .venv                      # private folder for this project's libraries
.venv/bin/pip install -r requirements.txt  # install them
```

| Command | What it does |
|---|---|
| `.venv/bin/uvicorn app.main:app --env-file ../.env --reload --port 8000` | Run the service on http://localhost:8000 (auto-reload). Interactive API docs at `/docs` |
| `.venv/bin/pytest` | Run the Python tests (uses the `sentinel_test` database: run `npm test` in `backend/` once first so it exists) |

Endpoints:
- `GET /health` → `{"status":"ok","service":"sentinel-analytics"}`
- `POST /analyze/{endpoint_id}` → `{endpoint_id, hours_scored, findings: [{time, metric, value, baseline, score, severity, explanation, method}]}` (404 if the endpoint doesn't exist)

**Detectors** (each finding names its `method`):

| method | Status | Needs | What it does |
|---|---|---|---|
| `robust_z_v1` | live | 12 h history | Robust z vs the previous 24 hours (details below) |
| `same_hour_z_v1` | **shadow** | 5+ days | Robust z vs the same hour on the previous 7 days, cut-off 4.5 |
| `isolation_forest_v2` | **shadow** | 5 days warm-up + 3 days to learn | Isolation Forest (scikit-learn, contamination 5%) with time-of-day features; trained only on hours before the reported window; never "critical" |

Shadow = it runs live and its findings are saved and shown (tagged SHADOW), but it's still being evaluated on real data. It won on synthetic data (`docs/EXPERIMENTS.md`). The service loads 14 days of history and reports the last 48 finished hours.

**How the live rule finds anomalies** (`method: robust_z_v1`): for each **finished** hour in the last 48 hours, P50 response time of successful checks is compared with the median of the previous up-to-24 hours. Robust z = 0.6745 × (value − median) / MAD (MAD floored at 1 ms). Flagged if z > 3.5 (slower only). `critical` if z ≥ 10, else `warning`. Hours with fewer than 12 hours of history before them aren't judged. This is a **statistical signal, not a diagnosis**, and it has only been tested on made-up data so far. The service connects to Postgres **read-only**; the Node worker saves findings in the `anomalies` table.

Known: pytest shows one `StarletteDeprecationWarning` suggesting `httpx2` instead of `httpx` for the test client. It's harmless today. Switching packages is left for a deliberate, verified change.

## Configuration

All configuration comes from environment variables, validated at startup by `backend/src/config.ts`. The app refuses to start with a clear message if anything is missing or invalid. See [.env.example](.env.example) for every variable. **Never commit `.env`.**

## API (current)

| Method | Path | Success | Errors |
|---|---|---|---|
| GET | `/healthz` | `200` DB reachable | `503` DB unreachable |
| POST | `/endpoints` | `201` created endpoint | `400` validation |
| GET | `/endpoints` | `200` list; each item also has `last_check` and `open_incident` (or null) | |
| GET | `/endpoints/:id` | `200` endpoint | `400` bad id, `404` |
| PATCH | `/endpoints/:id` | `200` updated endpoint | `400`, `404` |
| DELETE | `/endpoints/:id` | `204` | `400`, `404` |
| POST | `/endpoints/:id/check` | `200` saved check result (even if the site is down) | `400`, `404` |
| GET | `/endpoints/:id/checks?limit=50` | `200` check history, newest first (limit 1–500) | `400`, `404` |
| GET | `/endpoints/:id/stats?window=24h\|7d\|30d` | `200` uptime %, P50/P95/P99, failures by type (see definitions below) | `400`, `404` |
| GET | `/endpoints/:id/anomalies?limit=50` | `200` unusual hours found by the analytics service, newest first | `400`, `404` |
| GET | `/endpoints/:id/timeseries?window=24h\|7d\|30d` | `200` per-bucket checks, uptime %, P50/P95, oldest first (1 h / 6 h / 1 day buckets) | `400`, `404` |
| POST / GET | `/suites` (`?endpoint_id=N`) | create `{endpoint_id, name, schedule_minutes?}` (201) / list with `case_count`, `last_run` | `400` |
| GET / PATCH / DELETE | `/suites/:id` | one suite + its `cases` / change `{name?, schedule_minutes?}` / delete (204) | `400`, `404` |
| POST | `/suites/:id/cases` | add a test case (201) | `400`, `404` |
| PATCH / DELETE | `/suites/:id/cases/:caseId` | change some fields (full case re-validated) / delete (204) | `400`, `404` |
| POST | `/suites/:id/runs` | `202` run queued; the worker runs the cases one at a time | `400` (no cases), `404` |
| GET | `/suites/:id/runs?limit=50` | run history, newest first (`queued` → `running` → `passed`/`failed`/`error`) | `400`, `404` |
| GET | `/suites/:id/runs/:runId` | one run + `results` per case (`passed`, status, time, `failures` with reasons) | `400`, `404` |
| GET | `/incidents?status=open\|resolved&endpoint_id=N&limit=100` | `200` incidents, newest first (all filters optional) | `400` |

Example:

```bash
curl -X POST localhost:3000/endpoints -H "Content-Type: application/json" \
  -d '{"name":"GitHub API","url":"https://api.github.com","interval_seconds":120}'
# Pause it:
curl -X PATCH localhost:3000/endpoints/1 -H "Content-Type: application/json" -d '{"paused":true}'
```

Endpoint fields (JSON uses the same snake_case names as the database):

| Field | Type | Default | Rules |
|---|---|---|---|
| `name` | string | required | 1–100 chars |
| `url` | string | required | `http://` or `https://`, ≤ 2048 chars |
| `method` | string | `"GET"` | `GET` or `HEAD` |
| `interval_seconds` | integer | `60` | 30–3600 |
| `timeout_ms` | integer | `5000` | 1000–30000 |
| `expected_status` | integer | `200` | 100–599 |
| `max_retries` | integer | `0` | 0–3 |
| `failure_threshold` | integer | `3` | 1–10 failed checks in a row that open an incident |
| `paused` | boolean | `false` | |

A check result looks like this:

```json
{"ok":true,"status_code":200,"response_time_ms":241,"error_type":null,"error_message":null,"checked_at":"2026-11-10T19:57:53.641Z"}
```

`error_type` is one of:
- no answer: `blocked` (SSRF guard), `timeout`, `dns`, `connection_refused`, `connection_reset` (server hung up mid-request), `tls`, `network` (anything else)
- wrong status: `redirect` (3xx; the message says where it points), `client_error` (4xx), `server_error` (5xx), `unexpected_status` (e.g. 200 when 404 was expected)

Migration 008 re-labelled older history with the same rules.

**Safety:** Sentinel refuses to visit private/internal addresses (localhost, 10.x, 192.168.x, 169.254.169.254, etc.) and does not follow redirects. This blocks SSRF attacks, and it also means you can't monitor services on your own machine or home network.

**Tip: sites that redirect.** If a site answers 301/302/307/308 (e.g. `example.com` → `www.example.com`), Sentinel reports that status instead of following it. Register the **final** URL (the one your browser ends up on), or set `expected_status` to the redirect code.

**API test cases** are data, never code: a request plus a list of assertions that Sentinel evaluates itself.

```json
{
  "name": "Get user 1",
  "method": "GET",
  "url": "https://api.example.com/users/1",
  "headers": { "Authorization": "Bearer <token>" },
  "timeout_ms": 5000,
  "assertions": [
    { "type": "status_equals", "value": 200 },
    { "type": "response_time_below_ms", "value": 500 },
    { "type": "header_contains", "name": "content-type", "value": "application/json" },
    { "type": "body_contains", "value": "Ada" },
    { "type": "json_path_exists", "path": "user.email" },
    { "type": "json_path_equals", "path": "user.id", "value": 1 }
  ]
}
```

Methods: GET, HEAD, POST, PUT, PATCH, DELETE (default GET). `body` is text, not allowed with GET/HEAD. 1–20 assertions. JSON paths use dots, with numbers for array positions (`items.0.name`). Headers `Host`, `Content-Length`, `Connection`, `Transfer-Encoding` can't be set. ⚠️ **Headers are stored unencrypted** in the database, so don't put production secrets in test cases.

**Running a suite:** `POST /suites/:id/runs` answers `202` immediately, and the worker sends each case's request (SSRF guard, timeout, no redirects, response body read up to 1 MB) and checks its assertions. Results include a reason per failed assertion, e.g. `"user.id" is 1, expected 2`. Runs are not retried automatically, because a test may have sent POST/DELETE requests. **Schedules:** set `schedule_minutes` (5–1440, or `null` for manual only) and the worker runs the suite by itself on that interval. Saving a schedule starts the first run right away. ⚠️ Tests send **real** requests: a DELETE test really deletes. Point tests at test environments, not production data.

**Metric definitions** (used by `/stats`):
- **Window:** the last 24 hours, 7 days, or 30 days, ending now. The response includes the exact `from`/`to`.
- **Uptime %** = passed checks ÷ all checks in the window × 100, rounded to 2 decimals. Paused time and gaps contain no checks, so they count as neither up nor down. `checks_total` is returned so gaps are visible. `null` when there were no checks.
- **P50 / P95 / P99** = response times of **successful checks only**, sorted. The value 50% / 95% / 99% of the way along (`percentile_disc`, always a real measured value). Failed checks (e.g. timeouts) are excluded here and counted in uptime instead.
- **Failures by type** = failed checks in the window grouped by `error_type`.
- **Time series buckets** (`/timeseries`): 1 hour (24h), 6 hours (7d), 1 day (30d), aligned to UTC. The first and last buckets are partial. Empty buckets are kept with `checks_total: 0` and `null` values: a gap means **no data**, not "up". Only P50/P95 per bucket (P99 of ~60 checks would just be the single slowest one).

All errors use the shape `{"error":{"code":"...","message":"..."}}`. Validation errors add `details: [{field, message}]`. Timestamps are returned in UTC (ISO-8601, ending in `Z`).

## Documentation

- [Project blueprint](docs/PROJECT_BLUEPRINT.md): scope and roadmap
- [Architecture](docs/ARCHITECTURE.md): components, data flow, contracts
- [Decisions](docs/DECISIONS.md): architecture decision records
- [Learning log](docs/LEARNING_LOG.md): concepts learned while building
