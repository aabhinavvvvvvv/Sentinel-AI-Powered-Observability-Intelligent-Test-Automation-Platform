-- How many failed checks in a row open an incident.
-- DEFAULT 3 fills in existing rows; new rows get their default from the API schema.
ALTER TABLE endpoints
  ADD COLUMN failure_threshold INTEGER NOT NULL DEFAULT 3 CHECK (failure_threshold BETWEEN 1 AND 10);

-- An incident = a period when an endpoint was down.
CREATE TABLE incidents (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  endpoint_id   INTEGER     NOT NULL REFERENCES endpoints (id) ON DELETE CASCADE,
  started_at    TIMESTAMPTZ NOT NULL, -- time of the FIRST failed check in the streak
  resolved_at   TIMESTAMPTZ,          -- NULL while the incident is still open
  error_type    TEXT        NOT NULL, -- why the first failed check failed, e.g. "timeout"
  error_message TEXT
);

-- At most ONE open incident per endpoint, guaranteed by the database itself.
-- ("unique endpoint_id, but only among rows where resolved_at IS NULL")
CREATE UNIQUE INDEX incidents_one_open_per_endpoint ON incidents (endpoint_id) WHERE resolved_at IS NULL;

-- Fast "newest incidents first" listing.
CREATE INDEX incidents_started_at ON incidents (started_at DESC);
