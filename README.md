# Sentinel

**AI-Powered Observability & Intelligent Test Automation Platform.**

Sentinel monitors APIs and services, detects abnormal behaviour, helps engineers investigate failures, predicts degradation where historical data supports it, and prioritizes tests based on risk. Full scope: [docs/PROJECT_BLUEPRINT.md](docs/PROJECT_BLUEPRINT.md).

> **Status: early development (Milestone 3: manual checks).**
> You can register endpoints and check any of them on demand ("check now"), with SSRF protection.
> Results are **not saved yet**, and checks do **not run automatically yet** (Milestone 4). Analytics, testing, ML, and the dashboard come later (see the roadmap in the blueprint).

## Repository layout

```
sentinel/
├── backend/            Node.js + TypeScript + Express API (later also the background worker)
│   ├── src/            application code
│   └── tests/          Vitest + Supertest tests
├── docs/               blueprint, architecture, decisions, learning log
├── docker-compose.yml  local dependencies (PostgreSQL)
└── .env.example        configuration template (copy to .env)
```

## Prerequisites

- Node.js **22+** and npm
- Docker with Docker Compose v2 (on Windows/WSL: enable WSL integration in Docker Desktop)

## Getting started

```bash
# 1. Create your local config (git-ignored). Edit the password if you like.
cp .env.example .env

# 2. Start PostgreSQL in the background and wait until it is healthy.
docker compose up -d --wait

# 3. Install backend dependencies.
cd backend
npm install

# 4. Create/update the database tables (safe to run repeatedly).
npm run migrate

# 5. Run the API in development mode (auto-restarts on file changes, pretty logs).
npm run dev
```

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
| `npm run dev` | Run from TypeScript source with auto-reload and pretty logs |
| `npm run migrate` | Apply pending SQL files from `backend/migrations/` |
| `npm test` | Run all tests once. **Needs Postgres running**; uses a separate `sentinel_test` database that it creates automatically |
| `npm run typecheck` | Type-check `src/` and `tests/` without emitting files |
| `npm run lint` | Run ESLint |
| `npm run build` | Compile `src/` to JavaScript in `dist/` |
| `npm start` | Run the compiled build (`dist/server.js`) |

## Configuration

All configuration comes from environment variables, validated at startup by `backend/src/config.ts`. The app refuses to start with a clear message if anything is missing or invalid. See [.env.example](.env.example) for every variable. **Never commit `.env`.**

## API (current)

| Method | Path | Success | Errors |
|---|---|---|---|
| GET | `/healthz` | `200` DB reachable | `503` DB unreachable |
| POST | `/endpoints` | `201` created endpoint | `400` validation |
| GET | `/endpoints` | `200` list | |
| GET | `/endpoints/:id` | `200` endpoint | `400` bad id, `404` |
| PATCH | `/endpoints/:id` | `200` updated endpoint | `400`, `404` |
| DELETE | `/endpoints/:id` | `204` | `400`, `404` |
| POST | `/endpoints/:id/check` | `200` check result (even if the site is down) | `400`, `404` |

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
| `paused` | boolean | `false` | |

A check result looks like this:

```json
{"ok":true,"status_code":200,"response_time_ms":241,"error_type":null,"error_message":null,"checked_at":"2026-11-10T19:57:53.641Z"}
```

`error_type` is one of `blocked`, `timeout`, `dns`, `connection_refused`, `tls`, `unexpected_status`, `network`.

**Safety:** Sentinel refuses to visit private/internal addresses (localhost, 10.x, 192.168.x, 169.254.169.254, etc.) and does not follow redirects. This blocks SSRF attacks, and it also means you can't monitor services on your own machine or home network.

All errors use the shape `{"error":{"code":"...","message":"..."}}`. Validation errors add `details: [{field, message}]`. Timestamps are returned in UTC (ISO-8601, ending in `Z`).

## Documentation

- [Project blueprint](docs/PROJECT_BLUEPRINT.md): scope and roadmap
- [Architecture](docs/ARCHITECTURE.md): components, data flow, contracts
- [Decisions](docs/DECISIONS.md): architecture decision records
- [Learning log](docs/LEARNING_LOG.md): concepts learned while building
