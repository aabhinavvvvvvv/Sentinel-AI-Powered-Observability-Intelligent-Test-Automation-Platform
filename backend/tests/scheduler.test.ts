/**
 * Tests the real scheduler against the real Redis, using a separate prefix
 * ("sentinel-test") so it never touches the timers of your running app.
 */
import { Queue } from "bullmq";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createScheduler, QUEUE_NAME, timerId } from "../src/scheduler.js";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const prefix = "sentinel-test";
const scheduler = createScheduler(redisUrl, prefix);
// A second handle on the same queue, used only to look inside.
const inspect = new Queue(QUEUE_NAME, { connection: { url: redisUrl }, prefix });

const timer = (endpointId: number) => inspect.getJobScheduler(timerId(endpointId));
const endpoint = (id: number, extra = {}) => ({ id, paused: false, interval_seconds: 60, ...extra });

beforeEach(async () => {
  await inspect.obliterate({ force: true }); // wipe everything in the test queue
});
afterAll(async () => {
  await inspect.obliterate({ force: true });
  await Promise.all([scheduler.close(), inspect.close()]);
});

describe("scheduler", () => {
  it("creates a repeating timer for an active endpoint", async () => {
    await scheduler.schedule(endpoint(1));
    expect((await timer(1))?.every).toBe(60_000);
  });

  it("updates the existing timer instead of adding a second one", async () => {
    await scheduler.schedule(endpoint(1));
    await scheduler.schedule(endpoint(1, { interval_seconds: 120 }));
    expect((await timer(1))?.every).toBe(120_000);
    expect(await inspect.getJobSchedulers()).toHaveLength(1);
  });

  it("removes the timer when the endpoint is paused", async () => {
    await scheduler.schedule(endpoint(1));
    await scheduler.schedule(endpoint(1, { paused: true }));
    expect(await timer(1)).toBeUndefined();
  });

  it("removes the timer on unschedule", async () => {
    await scheduler.schedule(endpoint(1));
    await scheduler.unschedule(1);
    expect(await timer(1)).toBeUndefined();
  });

  it("syncAll makes Redis match the database", async () => {
    await scheduler.schedule(endpoint(1)); // still in DB
    await scheduler.schedule(endpoint(2)); // deleted from DB meanwhile
    await scheduler.syncAll([endpoint(1), endpoint(3), endpoint(4, { paused: true })]);

    const keys = (await inspect.getJobSchedulers()).map((t) => t.key).sort();
    expect(keys).toEqual([timerId(1), timerId(3)]);
  });
});
