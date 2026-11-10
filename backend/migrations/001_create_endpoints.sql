-- Endpoints that Sentinel monitors: one row per URL plus how to check it.
-- Default values live in the API schema (src/endpoints/schemas.ts), so there is
-- one source of truth. The CHECK constraints are a last line of defence.
CREATE TABLE endpoints (
  id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name             TEXT        NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  url              TEXT        NOT NULL CHECK (length(url) <= 2048),
  method           TEXT        NOT NULL CHECK (method IN ('GET', 'HEAD')),
  interval_seconds INTEGER     NOT NULL CHECK (interval_seconds BETWEEN 30 AND 3600),
  timeout_ms       INTEGER     NOT NULL CHECK (timeout_ms BETWEEN 1000 AND 30000),
  expected_status  INTEGER     NOT NULL CHECK (expected_status BETWEEN 100 AND 599),
  max_retries      INTEGER     NOT NULL CHECK (max_retries BETWEEN 0 AND 3),
  paused           BOOLEAN     NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
