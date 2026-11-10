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
