-- API testing: a suite is a group of test cases for one monitored endpoint (website/API).
CREATE TABLE test_suites (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  endpoint_id INTEGER     NOT NULL REFERENCES endpoints (id) ON DELETE CASCADE,
  name        TEXT        NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX test_suites_endpoint ON test_suites (endpoint_id);

-- A test case = one HTTP request + a list of checks ("assertions") on the response.
-- It is DATA, never code: Sentinel itself sends the request and evaluates the checks.
CREATE TABLE test_cases (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  suite_id   INTEGER     NOT NULL REFERENCES test_suites (id) ON DELETE CASCADE,
  name       TEXT        NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  method     TEXT        NOT NULL CHECK (method IN ('GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE')),
  url        TEXT        NOT NULL CHECK (length(url) <= 2048),
  headers    JSONB       NOT NULL, -- {"authorization": "Bearer ..."}; stored as plain text, see README
  body       TEXT,                 -- request body, e.g. JSON text; NULL = no body
  timeout_ms INTEGER     NOT NULL CHECK (timeout_ms BETWEEN 1000 AND 30000),
  assertions JSONB       NOT NULL, -- [{"type": "status_equals", "value": 200}, ...]
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX test_cases_suite ON test_cases (suite_id);
