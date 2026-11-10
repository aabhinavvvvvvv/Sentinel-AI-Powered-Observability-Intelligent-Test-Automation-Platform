/**
 * A second BullMQ queue, just for alert emails.
 *
 * Why a queue and not "just send it"? If the email server is down for a moment,
 * BullMQ tries again later (5s, 10s, 20s, 40s) instead of losing the alert.
 */
import { Queue } from "bullmq";
import { DEFAULT_PREFIX } from "../scheduler.js";

export const ALERTS_QUEUE = "alerts";

export interface AlertJob {
  incidentId: number;
  kind: "opened" | "resolved";
}

export interface AlertQueue {
  enqueue(kind: AlertJob["kind"], incidentId: number): Promise<void>;
  close(): Promise<void>;
}

/** One fixed job id per alert, e.g. "incident-7-opened". Adding the same id twice is ignored. */
export const alertJobId = (kind: AlertJob["kind"], incidentId: number) => `incident-${incidentId}-${kind}`;

export function createAlertQueue(redisUrl: string, prefix = DEFAULT_PREFIX): AlertQueue {
  const queue = new Queue<AlertJob>(ALERTS_QUEUE, { connection: { url: redisUrl }, prefix });
  return {
    async enqueue(kind, incidentId) {
      await queue.add(
        "incident-alert",
        { incidentId, kind },
        {
          jobId: alertJobId(kind, incidentId), // never send the same alert twice
          attempts: 5, // 1 try + up to 4 retries
          backoff: { type: "exponential", delay: 5000 }, // wait 5s, 10s, 20s, 40s between tries
          // Keep finished jobs for a day, so the job id stays "taken" and blocks duplicates.
          removeOnComplete: { age: 24 * 3600 },
          removeOnFail: 100,
        },
      );
    },
    async close() {
      await queue.close();
    },
  };
}
