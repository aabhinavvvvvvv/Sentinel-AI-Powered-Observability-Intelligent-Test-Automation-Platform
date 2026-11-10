import { pino } from "pino";

/** A logger that discards everything, so test output stays readable. */
export const silentLogger = pino({ level: "silent" });
