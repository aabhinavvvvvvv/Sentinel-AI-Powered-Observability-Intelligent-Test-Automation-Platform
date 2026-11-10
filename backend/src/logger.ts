/**
 * Structured logging. Every log line is one JSON object, e.g.
 *   {"level":30,"time":1731300000000,"msg":"server listening","port":3000}
 * Machines (log search tools) can filter on fields; humans can pipe the
 * output through `pino-pretty` (the `npm run dev` script does this).
 */
import { pino, type Logger } from "pino";

export type { Logger };

export function createLogger(level: string): Logger {
  return pino({
    level,
    // Never write these fields to logs even if someone logs a whole request object.
    redact: ["req.headers.authorization", "req.headers.cookie"],
  });
}
