/** Tests the test-run queue against the real Redis, in the separate "sentinel-test" prefix. */
import { Queue } from "bullmq";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTestRunQueue, suiteTimerId, TEST_RUNS_QUEUE } from "../src/testing/run-queue.js";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const prefix = "sentinel-test";
const runs = createTestRunQueue(redisUrl, prefix);
const inspect = new Queue(TEST_RUNS_QUEUE, { connection: { url: redisUrl }, prefix });

const timer = (suiteId: number) => inspect.getJobScheduler(suiteTimerId(suiteId));

beforeEach(() => inspect.obliterate({ force: true }));
afterAll(async () => {
  await inspect.obliterate({ force: true });
  await Promise.all([runs.close(), inspect.close()]);
});

describe("test-run queue", () => {
  it("queues a run once, even if asked twice", async () => {
    await runs.enqueue(7);
    await runs.enqueue(7);
    const job = await inspect.getJob("run-7");
    expect(job?.data).toEqual({ runId: 7 });
    expect(job?.opts.attempts).toBe(1); // no automatic re-runs
    expect(await inspect.getJobCountByTypes("waiting", "prioritized", "delayed")).toBe(1);
  });

  it("creates, updates, and removes a suite's timer", async () => {
    await runs.schedule({ id: 1, schedule_minutes: 60 });
    expect((await timer(1))?.every).toBe(3_600_000);

    await runs.schedule({ id: 1, schedule_minutes: 15 });
    expect((await timer(1))?.every).toBe(900_000);
    expect(await inspect.getJobSchedulers()).toHaveLength(1); // updated, not duplicated

    await runs.schedule({ id: 1, schedule_minutes: null }); // manual only
    expect(await timer(1)).toBeUndefined();
  });

  it("unschedule removes the timer", async () => {
    await runs.schedule({ id: 2, schedule_minutes: 30 });
    await runs.unschedule(2);
    expect(await timer(2)).toBeUndefined();
  });

  it("syncAll keeps timers only for scheduled suites in the database", async () => {
    await runs.schedule({ id: 1, schedule_minutes: 60 }); // still scheduled
    await runs.schedule({ id: 2, schedule_minutes: 60 }); // deleted meanwhile
    await runs.syncAll([
      { id: 1, schedule_minutes: 60 },
      { id: 3, schedule_minutes: 1440 },
      { id: 4, schedule_minutes: null },
    ]);
    const keys = (await inspect.getJobSchedulers()).map((t) => t.key).sort();
    expect(keys).toEqual([suiteTimerId(1), suiteTimerId(3)]);
  });
});
