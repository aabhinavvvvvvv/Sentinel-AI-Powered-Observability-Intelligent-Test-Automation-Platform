import { pino } from "pino";
import type { Database } from "../src/db.js";

/** A logger that discards everything, so test output stays readable. */
export const silentLogger = pino({ level: "silent" });

/**
 * Empty the test database. CASCADE also empties every table that points at
 * `endpoints` (check_results, incidents, ...); RESTART IDENTITY resets ids to 1.
 */
export async function resetDb(db: Database): Promise<void> {
  await db.query("TRUNCATE endpoints RESTART IDENTITY CASCADE");
}
