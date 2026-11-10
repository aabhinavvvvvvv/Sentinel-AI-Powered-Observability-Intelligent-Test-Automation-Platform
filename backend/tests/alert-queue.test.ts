/** Tests the alert queue against the real Redis, in the separate "sentinel-test" prefix. */
import { Queue } from "bullmq";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ALERTS_QUEUE, alertJobId, createAlertQueue } from "../src/alerts/alert-queue.js";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const prefix = "sentinel-test";
const alerts = createAlertQueue(redisUrl, prefix);
const inspect = new Queue(ALERTS_QUEUE, { connection: { url: redisUrl }, prefix });

beforeEach(() => inspect.obliterate({ force: true }));
afterAll(async () => {
  await inspect.obliterate({ force: true });
  await Promise.all([alerts.close(), inspect.close()]);
});

describe("alert queue", () => {
  it("queues an alert job with retries and backoff", async () => {
    await alerts.enqueue("opened", 7);
    const job = await inspect.getJob(alertJobId("opened", 7));
    expect(job?.data).toEqual({ incidentId: 7, kind: "opened" });
    expect(job?.opts.attempts).toBe(5);
    expect(job?.opts.backoff).toEqual({ type: "exponential", delay: 5000 });
  });

  it("ignores the same alert queued twice (no duplicate emails)", async () => {
    await alerts.enqueue("opened", 7);
    await alerts.enqueue("opened", 7);
    expect(await inspect.count()).toBe(1);
  });

  it("treats 'opened' and 'resolved' for the same incident as different alerts", async () => {
    await alerts.enqueue("opened", 7);
    await alerts.enqueue("resolved", 7);
    expect(await inspect.count()).toBe(2);
  });
});
