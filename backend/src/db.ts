/**
 * Database access: one shared PostgreSQL connection pool for the whole process.
 *
 * A pool keeps a few connections open and lends them out per query, because
 * opening a new connection (TCP handshake + authentication) for every query
 * is slow. Think of it like a thread pool, but for DB connections.
 */
import pg from "pg";
import type { Logger } from "./logger.js";

/** What the rest of the app needs from the database (so tests can provide a fake). */
export interface Database {
  /** Run one SQL statement and return its rows. Use $1, $2... placeholders for values. */
  query<Row>(sql: string, params?: unknown[]): Promise<Row[]>;
  /** Resolves if the DB answers `SELECT 1` within `timeoutMs`, rejects otherwise. */
  ping(timeoutMs: number): Promise<void>;
  /** Close all pooled connections (used during graceful shutdown). */
  close(): Promise<void>;
}

export function createDatabase(connectionString: string, logger: Logger): Database {
  const pool = new pg.Pool({
    connectionString,
    max: 10, // at most 10 simultaneous connections from this process
    connectionTimeoutMillis: 5_000, // give up waiting for a free/new connection after 5s
    idleTimeoutMillis: 30_000, // close connections unused for 30s
  });

  // IMPORTANT: if an *idle* pooled connection dies (e.g. Postgres restarts), the pool
  // emits 'error'. Without a listener, Node treats that as an unhandled error and
  // CRASHES the process. We log it instead; the pool will open a fresh connection later.
  pool.on("error", (err) => {
    logger.error({ err }, "idle PostgreSQL client error");
  });

  return {
    async query<Row>(sql: string, params: unknown[] = []) {
      const result = await pool.query(sql, params);
      return result.rows as Row[];
    },
    async ping(timeoutMs) {
      await withTimeout(pool.query("SELECT 1"), timeoutMs, "database ping");
    },
    async close() {
      await pool.end();
    },
  };
}

/**
 * Race a promise against a timer. Whichever settles first wins.
 * Note: this stops *us* waiting; it does not cancel the underlying work.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  // `finally` clears the timer either way so it can't keep the process alive.
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
