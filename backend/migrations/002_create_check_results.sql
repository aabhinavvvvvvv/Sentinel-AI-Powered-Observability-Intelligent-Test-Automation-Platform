-- One row per check: what happened when Sentinel visited an endpoint.
CREATE TABLE check_results (
  id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Which endpoint was checked. ON DELETE CASCADE: deleting an endpoint
  -- also deletes its history (no orphan rows pointing at nothing).
  endpoint_id      INTEGER     NOT NULL REFERENCES endpoints (id) ON DELETE CASCADE,
  ok               BOOLEAN     NOT NULL,
  status_code      INTEGER,              -- NULL when there was no answer at all
  response_time_ms INTEGER     NOT NULL,
  error_type       TEXT,                 -- NULL when ok
  error_message    TEXT,
  checked_at       TIMESTAMPTZ NOT NULL
);

-- An index is like the index at the back of a book: it lets Postgres jump
-- straight to "endpoint 5's newest results" instead of reading every row.
CREATE INDEX check_results_endpoint_time ON check_results (endpoint_id, checked_at DESC);
