-- How often a suite runs by itself, in minutes. NULL = only when someone presses "Run now".
ALTER TABLE test_suites
  ADD COLUMN schedule_minutes INTEGER CHECK (schedule_minutes BETWEEN 5 AND 1440);
