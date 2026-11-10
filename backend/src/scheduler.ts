/**
 * Scheduling with BullMQ: one repeating "timer" per active endpoint, kept in Redis.
 *
 *   timer "endpoint-5", every 60s  →  puts a job {endpointId: 5} on the "checks" queue
 *   the worker (worker.ts) picks up each job and checks endpoint 5
 *
 * The API calls schedule()/unschedule() whenever an endpoint is added, edited,
 * paused, or deleted. PostgreSQL stays the source of truth: syncAll() rebuilds
 * every timer from the database (the worker runs it on startup).
 */
import { Queue } from "bullmq";
import type { Endpoint } from "./endpoints/schemas.js";

export const QUEUE_NAME = "checks";
export const DEFAULT_PREFIX = "sentinel"; // all our Redis keys start with this

/** What each job carries: just WHICH endpoint to check. The worker reads the rest from the DB. */
export interface CheckJob {
  endpointId: number;
}

type Schedulable = Pick<Endpoint, "id" | "paused" | "interval_seconds">;

export interface Scheduler {
  /** Create or update the endpoint's timer, or remove it if the endpoint is paused. */
  schedule(endpoint: Schedulable): Promise<void>;
  /** Remove the endpoint's timer (if any). */
  unschedule(endpointId: number): Promise<void>;
  /** Make Redis match the database: timers for active endpoints only, nothing else. */
  syncAll(endpoints: Schedulable[]): Promise<void>;
  close(): Promise<void>;
}

/** One fixed timer name per endpoint, so scheduling twice updates it instead of making a duplicate. */
export const timerId = (endpointId: number) => `endpoint-${endpointId}`;

export function createScheduler(redisUrl: string, prefix = DEFAULT_PREFIX): Scheduler {
  const queue = new Queue<CheckJob>(QUEUE_NAME, { connection: { url: redisUrl }, prefix });

  const scheduler: Scheduler = {
    async schedule(endpoint) {
      if (endpoint.paused) return scheduler.unschedule(endpoint.id);
      // "upsert" = update if it exists, insert if it doesn't.
      await queue.upsertJobScheduler(
        timerId(endpoint.id),
        { every: endpoint.interval_seconds * 1000 },
        {
          name: "check",
          data: { endpointId: endpoint.id },
          // Results live in Postgres, so Redis doesn't need to keep finished jobs.
          opts: { removeOnComplete: true, removeOnFail: 100 },
        },
      );
    },

    async unschedule(endpointId) {
      await queue.removeJobScheduler(timerId(endpointId));
    },

    async syncAll(endpoints) {
      const wanted = new Set(endpoints.filter((e) => !e.paused).map((e) => timerId(e.id)));
      // Remove timers for endpoints that were deleted or paused.
      for (const timer of await queue.getJobSchedulers()) {
        if (!wanted.has(timer.key)) await queue.removeJobScheduler(timer.key);
      }
      // Create/update timers for the rest.
      for (const endpoint of endpoints) await scheduler.schedule(endpoint);
    },

    async close() {
      await queue.close();
    },
  };
  return scheduler;
}
