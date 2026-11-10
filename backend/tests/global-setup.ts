/**
 * Runs ONCE before all tests: make sure the test database exists and is migrated.
 * Tests use a separate database so they can wipe tables without touching dev data.
 */
import pg from "pg";
import { runMigrations } from "../src/migrate.js";

export default async function setup(): Promise<void> {
  const testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl) throw new Error("TEST_DATABASE_URL is not set. Copy it from .env.example into .env.");

  // CREATE DATABASE has to be run while connected to some OTHER database,
  // so connect to the built-in "postgres" database first.
  const dbName = new URL(testUrl).pathname.slice(1);
  const adminUrl = new URL(testUrl);
  adminUrl.pathname = "/postgres";

  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error("Cannot reach Postgres for tests. Is it running? (docker compose up -d --wait)", {
      cause: err,
    });
  }
  try {
    const { rowCount } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    if (rowCount === 0) await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }

  await runMigrations(testUrl);
}
