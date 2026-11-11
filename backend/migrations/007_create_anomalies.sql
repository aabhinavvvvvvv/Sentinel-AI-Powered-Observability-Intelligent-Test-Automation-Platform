-- Unusual behaviour found by the analytics service (a STATISTICAL SIGNAL, not a diagnosis).
CREATE TABLE anomalies (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  endpoint_id  INTEGER          NOT NULL REFERENCES endpoints (id) ON DELETE CASCADE,
  metric       TEXT             NOT NULL,  -- e.g. "P50 response time"
  bucket_start TIMESTAMPTZ      NOT NULL,  -- the hour that was unusual
  value        DOUBLE PRECISION NOT NULL,  -- what we measured
  baseline     DOUBLE PRECISION NOT NULL,  -- what's normal
  score        DOUBLE PRECISION NOT NULL,  -- how far from normal (robust z-score)
  severity     TEXT             NOT NULL CHECK (severity IN ('warning', 'critical')),
  explanation  TEXT             NOT NULL,
  method       TEXT             NOT NULL,  -- which detector found it, e.g. "robust_z_v1"
  created_at   TIMESTAMPTZ      NOT NULL DEFAULT now(),
  -- The hourly analysis looks back 48 h, so it sees the same hour many times.
  -- This makes saving the same finding again a no-op instead of a duplicate.
  UNIQUE (endpoint_id, metric, bucket_start, method)
);
CREATE INDEX anomalies_endpoint_time ON anomalies (endpoint_id, bucket_start DESC);
