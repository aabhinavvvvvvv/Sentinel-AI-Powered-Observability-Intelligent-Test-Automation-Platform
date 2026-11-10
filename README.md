# Sentinel

**AI-Powered Observability & Intelligent Test Automation Platform.**

Sentinel monitors APIs and services, detects abnormal behaviour, helps engineers investigate failures, predicts degradation where historical data supports it, and prioritizes tests based on risk. Full scope: [docs/PROJECT_BLUEPRINT.md](docs/PROJECT_BLUEPRINT.md).

> **Status: early development (Phase 2: historical analytics).**
> Register endpoints and Sentinel checks them automatically on their interval (Redis + BullMQ worker), with retries and SSRF protection. Every result is saved. After N failures in a row an incident is opened, and it is resolved on recovery. An email goes out for each (with retries if the mail server is down). A web dashboard shows every website's status and open incidents, lets you add, pause, and delete websites, and has a detail page per website (settings, uptime and P50/P95/P99 over 24h/7d/30d, a response-time chart, recent checks, incident history, "check now").
> Not yet: API test suites, anomaly detection/ML (see the roadmap in the blueprint). Analytics, testing, ML, and the dashboard come later (see the roadmap in the blueprint).

## Repository layout

```
sentinel/
├── backend/            Node.js + TypeScript + Express API and background worker
│   ├── src/            application code
│   └── tests/          Vitest + Supertest tests
├── frontend/           React + TypeScript dashboard (Vite)
│   └── src/            pages, components, API client, tests
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
| GET | `/endpoints/:id/timeseries?window=24h\|7d\|30d` | `200` per-bucket checks, uptime %, P50/P95, oldest first (1 h / 6 h / 1 day buckets) | `400`, `404` |
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

`error_type` is one of `blocked`, `timeout`, `dns`, `connection_refused`, `tls`, `unexpected_status`, `network`.

**Safety:** Sentinel refuses to visit private/internal addresses (localhost, 10.x, 192.168.x, 169.254.169.254, etc.) and does not follow redirects. This blocks SSRF attacks, and it also means you can't monitor services on your own machine or home network.

**Tip: sites that redirect.** If a site answers 301/302/307/308 (e.g. `example.com` → `www.example.com`), Sentinel reports that status instead of following it. Register the **final** URL (the one your browser ends up on), or set `expected_status` to the redirect code.

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
