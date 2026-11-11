/**
 * BullMQ queue for test runs. Two kinds of job:
 *   { runId }   "run this already-created run"     (from "Run now")
 *   { suiteId } "a suite's timer fired: create a scheduled run and run it"
 *
 * Suite timers work like endpoint timers (scheduler.ts): one repeating timer per
 * scheduled suite, id "suite-<id>"; syncAll rebuilds them from the database.
 */
import { Queue } from "bullmq";
import { DEFAULT_PREFIX } from "../scheduler.js";
import type { TestSuite } from "./schemas.js";

export const TEST_RUNS_QUEUE = "test-runs";

export type TestRunJob = { runId: number } | { suiteId: number };

type Schedulable = Pick<TestSuite, "id" | "schedule_minutes">;

export interface TestRunQueue {
  enqueue(runId: number): Promise<void>;
  /** Create/update the suite's timer, or remove it if schedule_minutes is null. */
  schedule(suite: Schedulable): Promise<void>;
  unschedule(suiteId: number): Promise<void>;
  /** Make Redis match the database: timers for scheduled suites only. */
  syncAll(suites: Schedulable[]): Promise<void>;
  close(): Promise<void>;
}

export const suiteTimerId = (suiteId: number) => `suite-${suiteId}`;

export function createTestRunQueue(redisUrl: string, prefix = DEFAULT_PREFIX): TestRunQueue {
  const queue = new Queue<TestRunJob>(TEST_RUNS_QUEUE, { connection: { url: redisUrl }, prefix });

  const runs: TestRunQueue = {
    async enqueue(runId) {
      await queue.add(
        "run",
        { runId },
        // Fixed id → the same run can't be queued twice. No retries: a half-done run
        // shouldn't be repeated automatically (it may have sent POST/DELETE requests).
        { jobId: `run-${runId}`, attempts: 1, removeOnComplete: { age: 24 * 3600 }, removeOnFail: 100 },
      );
    },

    async schedule(suite) {
      if (suite.schedule_minutes === null) return runs.unschedule(suite.id);
      await queue.upsertJobScheduler(
        suiteTimerId(suite.id),
        { every: suite.schedule_minutes * 60_000 },
        { name: "scheduled", data: { suiteId: suite.id }, opts: { attempts: 1, removeOnComplete: true, removeOnFail: 100 } },
      );
    },

    async unschedule(suiteId) {
      await queue.removeJobScheduler(suiteTimerId(suiteId));
    },

    async syncAll(suites) {
      const wanted = new Set(suites.filter((s) => s.schedule_minutes !== null).map((s) => suiteTimerId(s.id)));
      for (const timer of await queue.getJobSchedulers()) {
        if (!wanted.has(timer.key)) await queue.removeJobScheduler(timer.key);
      }
      for (const suite of suites) await runs.schedule(suite);
    },

    async close() {
      await queue.close();
    },
  };
  return runs;
}
