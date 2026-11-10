/**
 * The worker: a separate program from the API (`npm run dev:worker`).
 * It runs two kinds of jobs from Redis:
 *   "checks" queue → check an endpoint, save the result, open/close incidents
 *   "alerts" queue → send the email for an opened/resolved incident
 *
 * Why separate from the API? Checks can be slow (up to 30s each). Running them
 * here means the API stays fast for users no matter how many checks are running.
 */
import { Worker } from "bullmq";
import { ALERTS_QUEUE, createAlertQueue, type AlertJob } from "./alerts/alert-queue.js";
import { createMailer } from "./alerts/mailer.js";
import { sendIncidentAlert } from "./alerts/send-incident-alert.js";
import { runScheduledCheck } from "./checks/run-scheduled-check.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db.js";
import { listEndpoints } from "./endpoints/repository.js";
import { createLogger } from "./logger.js";
import { createScheduler, DEFAULT_PREFIX, QUEUE_NAME, type CheckJob } from "./scheduler.js";

const CHECK_CONCURRENCY = 10; // at most 10 checks at the same time
const ALERT_CONCURRENCY = 2; // at most 2 emails at the same time

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const db = createDatabase(config.DATABASE_URL, logger);
const scheduler = createScheduler(config.REDIS_URL);
const alertQueue = createAlertQueue(config.REDIS_URL);
const mailer = createMailer(config.SMTP_URL, config.ALERT_EMAIL_FROM);
const alertsEnabled = config.ALERT_EMAIL_TO.length > 0;
const connection = { url: config.REDIS_URL };

// 1. Make Redis's timers match the database (Postgres is the source of truth).
//    This repairs anything missed while Redis or the worker was down.
const endpoints = await listEndpoints(db);
await scheduler.syncAll(endpoints);
logger.info({ endpoints: endpoints.length }, "timers synced with database");

// 2. Check jobs: "check endpoint N now".
const checkWorker = new Worker<CheckJob>(
  QUEUE_NAME,
  async (job) => {
    const outcome = await runScheduledCheck(db, job.data.endpointId);
    if (!outcome) return; // endpoint deleted or paused meanwhile
    const { check, incident } = outcome;
    logger.info(
      { endpointId: check.endpoint_id, ok: check.ok, ms: check.response_time_ms, error: check.error_type },
      "check done",
    );
    if (!incident) return;
    logger[incident.type === "opened" ? "warn" : "info"]({ incident: incident.incident }, `incident ${incident.type}`);
    if (alertsEnabled) await alertQueue.enqueue(incident.type, incident.incident.id);
  },
  { connection, prefix: DEFAULT_PREFIX, concurrency: CHECK_CONCURRENCY },
);

// 3. Alert jobs: "email about incident N". If sending throws, BullMQ retries with backoff.
const alertWorker = new Worker<AlertJob>(
  ALERTS_QUEUE,
  async (job) => {
    const sent = await sendIncidentAlert(db, mailer, config.ALERT_EMAIL_TO, job.data);
    logger.info({ ...job.data, sent, to: config.ALERT_EMAIL_TO }, sent ? "alert email sent" : "alert skipped: incident gone");
  },
  { connection, prefix: DEFAULT_PREFIX, concurrency: ALERT_CONCURRENCY },
);

// A check job "fails" only if OUR code breaks (e.g. the database is down), not when a website is down.
// We don't retry it: the next timer tick checks the endpoint again anyway.
checkWorker.on("failed", (job, err) => logger.error({ err, endpointId: job?.data.endpointId }, "check job failed"));
alertWorker.on("failed", (job, err) =>
  logger.warn({ err, ...job?.data, attempt: job?.attemptsMade }, "alert email attempt failed"),
);
// Connection problems (e.g. Redis restarting). BullMQ reconnects by itself; we just log.
checkWorker.on("error", (err) => logger.error({ err }, "check worker error"));
alertWorker.on("error", (err) => logger.error({ err }, "alert worker error"));

logger.info(
  { alerts: alertsEnabled ? config.ALERT_EMAIL_TO : "off (ALERT_EMAIL_TO is empty)" },
  "worker started",
);

// 4. Graceful shutdown: let running jobs finish, then close connections.
async function shutdown(signal: string) {
  logger.info({ signal }, "worker shutting down");
  await Promise.all([checkWorker.close(), alertWorker.close()]); // waits for in-progress jobs
  await Promise.all([scheduler.close(), alertQueue.close()]);
  mailer.close();
  await db.close();
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
