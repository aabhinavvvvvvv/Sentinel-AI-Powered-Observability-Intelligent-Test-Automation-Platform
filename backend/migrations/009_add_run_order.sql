-- The order a run used for its test cases. Every case runs either way; only the order differs.
--   default  = the normal order (by case id)
--   priority = highest priority score first (src/testing/priority.ts)
-- ("order" is an SQL keyword, hence "run_order".) Old runs become 'default', which is what they used.
ALTER TABLE test_runs
  ADD COLUMN run_order TEXT NOT NULL DEFAULT 'default' CHECK (run_order IN ('default', 'priority'));
