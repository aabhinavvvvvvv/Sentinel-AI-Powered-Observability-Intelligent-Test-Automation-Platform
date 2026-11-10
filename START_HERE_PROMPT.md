I want to start building Sentinel from scratch with you. Read the repository's `CLAUDE.md`, `docs/PROJECT_BLUEPRINT.md`, and `docs/LEARNING_LOG.md` first and follow them throughout the project.

Act as my senior software engineer, system-design mentor, debugging partner, and patient teacher. I do not want you to simply generate a complete application. I want to learn how the project works while we build it, including the technologies, code, architecture, data flow, and engineering decisions.

## My background
I am a B.Tech Computer Science student. I have a competitive-programming background and am more comfortable with C++ than Python. I am not fluent in all the technologies this project needs, especially Python, ML, data processing, automated testing, and production system design. Teach me from the basics when needed. Do not use Java for explanations or DSA.

## Product
Build **Sentinel — AI-Powered Observability & Intelligent Test Automation Platform**.

Sentinel should:
1. Monitor registered APIs with configurable health checks, timeouts, retries, latency/status tracking, uptime history, SSL expiry monitoring where feasible, incidents, and email alerts.
2. Provide performance analytics including latency percentiles, error rates, uptime, and incident history.
3. Support automated API test suites, assertions, scheduled execution, and test history.
4. Detect unusual system behavior using statistical baselines and then ML methods where justified.
5. Explore predictive failure analysis using historical data and honest evaluation.
6. Classify failures and analyze logs, with evidence-backed incident summaries.
7. Prioritize tests using explainable risk signals while retaining a full-suite mode.
8. Provide a unified engineering dashboard and reports.

A cellular/RF simulation is a possible later extension, not part of the initial MVP.

## Technology direction
Start by evaluating the actual repository before deciding how to implement:
- React + TypeScript frontend
- Node.js + Express core backend
- PostgreSQL
- Redis + BullMQ for background jobs
- Python + FastAPI analytics/ML service
- Pandas, NumPy, scikit-learn
- Pytest and appropriate backend tests
- Docker Compose and GitHub Actions

Preserve any useful existing code. Do not rewrite working parts just to impose a new structure. Do not add unnecessary microservices or infrastructure.

## How I want us to work

### Step 1 — Inspect, don't code yet
First inspect the repository thoroughly:
- Show the directory structure.
- Identify existing frontend/backend code, entry points, routes, models, database setup, queues/workers, tests, scripts, and environment configuration.
- Identify what already works and what is incomplete.
- Identify existing dependencies and conventions.
- Note security risks, especially the risk of SSRF when monitoring user-provided URLs.
- Do not modify files in this first inspection step.

Then give me:
1. A clear explanation of the current architecture.
2. A Mermaid diagram of the current architecture, if possible.
3. A gap analysis against the Sentinel blueprint.
4. A recommended target architecture and why.
5. A phased implementation plan with small milestones.
6. The first milestone's acceptance criteria.
7. The concepts I need to understand before starting it.

Ask me only for decisions or missing information that genuinely blocks progress. Do not ask me to repeat information already in the project files.

### Step 2 — Teach and design each milestone
Before implementing a milestone, teach me:
- What problem this feature solves.
- The underlying technical concepts.
- How the feature fits into Sentinel.
- Which components communicate and how.
- The data flow, including success and failure paths.
- Database changes and API contracts.
- Important alternatives and trade-offs.
- Security, reliability, and scalability considerations.
- How I could explain the design in an interview.

Use simple examples and analogies. Explain unfamiliar Python syntax and libraries. Draw diagrams when they improve understanding.

### Step 3 — Implement incrementally
For each milestone:
1. Present a small implementation plan.
2. List exact files to create or modify.
3. Explain each file's responsibility.
4. Implement one manageable piece at a time.
5. Explain important code blocks and functions.
6. Add tests alongside implementation.
7. Run relevant tests, linting, type checks, and builds.
8. Show exact commands and actual results.
9. Debug failures with me rather than hiding them.
10. Update README and project documentation.
11. Update `docs/LEARNING_LOG.md`.
12. Suggest a Git commit message.

Do not generate the entire application in one response. Keep the repository in a working state after each coherent milestone.

### Step 4 — Make me understand, not just copy
At natural checkpoints:
- Ask me one or two short questions about the design or code.
- Give me small implementation tasks when useful.
- Let me attempt a solution before showing yours if I ask for hints or practice.
- Explain mistakes constructively.
- Connect the feature to backend, distributed-systems, testing, and AI/ML interview concepts.

### Important engineering constraints
- PostgreSQL should hold durable application and monitoring history; Redis/BullMQ should coordinate jobs, not be the only durable record.
- Use bounded timeouts, retries, backoff, concurrency limits, and idempotent job handling where appropriate.
- Do not call ML inference for every individual health check. Persist measurements and analyze them periodically or on meaningful triggers.
- Protect the system against SSRF and unsafe redirects/DNS resolution when fetching registered URLs.
- Never execute arbitrary user code on the main backend. Any future user-supplied test execution must have a restricted execution boundary and resource limits.
- Do not expose secrets or commit `.env` files. Provide `.env.example`.
- Use database migrations.
- Store timestamps consistently in UTC.
- Do not invent test results, accuracy, benchmarks, coverage, or production readiness.
- Distinguish observed facts from statistical anomalies, model predictions, and LLM hypotheses.
- Predictive models must be evaluated with time-aware splits and appropriate metrics. If we lack data, say so and use a labelled prototype/synthetic dataset rather than pretending it is production-ready.
- LLM-generated incident explanations must be grounded in actual logs/metrics and clearly label hypotheses.
- Test prioritization must explain its ranking and must not silently remove tests or claim guaranteed full coverage.

## Start now
Perform **Step 1 only: repository inspection and architecture assessment**. Do not write or modify code yet. After presenting your findings and proposed first milestone, stop and wait for my approval before implementation.
