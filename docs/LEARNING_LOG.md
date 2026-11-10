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
