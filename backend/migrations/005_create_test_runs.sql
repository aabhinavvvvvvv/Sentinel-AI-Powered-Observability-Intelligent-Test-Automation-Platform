-- One row each time a suite is run.
CREATE TABLE test_runs (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  suite_id      INTEGER     NOT NULL REFERENCES test_suites (id) ON DELETE CASCADE,
  triggered_by  TEXT        NOT NULL CHECK (triggered_by IN ('manual', 'scheduled')),
  -- queued → running → passed | failed | error ("error" = the run itself broke, e.g. no cases)
  status        TEXT        NOT NULL CHECK (status IN ('queued', 'running', 'passed', 'failed', 'error')),
  total         INTEGER     NOT NULL DEFAULT 0,
  passed        INTEGER     NOT NULL DEFAULT 0,
  failed        INTEGER     NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ
);
CREATE INDEX test_runs_suite_created ON test_runs (suite_id, created_at DESC);

-- One row per test case per run.
CREATE TABLE test_case_results (
  id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id           INTEGER     NOT NULL REFERENCES test_runs (id) ON DELETE CASCADE,
  -- SET NULL: if the case is deleted later, its old results stay in the run's history.
  case_id          INTEGER     REFERENCES test_cases (id) ON DELETE SET NULL,
  case_name        TEXT        NOT NULL, -- copy of the name at run time, for the same reason
  passed           BOOLEAN     NOT NULL,
  status_code      INTEGER,              -- NULL if the request itself failed
  response_time_ms INTEGER     NOT NULL,
  error_type       TEXT,                 -- network error type if the request failed
  error_message    TEXT,
  failures         JSONB       NOT NULL, -- [{"assertion": {...}, "message": "expected status 200, got 500"}]
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX test_case_results_run ON test_case_results (run_id);
