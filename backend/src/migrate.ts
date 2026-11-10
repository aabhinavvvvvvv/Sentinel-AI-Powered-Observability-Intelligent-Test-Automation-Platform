/**
 * A tiny migration runner.
 *
 * Every file in backend/migrations/ is one schema change, applied once, in
 * filename order (001_, 002_, ...). The table `schema_migrations` remembers
 * which files have already run, so running this again is safe.
 */
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";

// Resolves to backend/migrations/ from both src/ (tsx) and dist/ (compiled).
const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url);

/** Applies pending migrations and returns the names of the ones it applied. */
export async function runMigrations(databaseUrl: string): Promise<string[]> {
  // One dedicated connection: a transaction (BEGIN ... COMMIT) must stay on a single connection.
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
    const alreadyApplied = new Set(rows.map((row) => row.name));

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    const applied: string[] = [];

    for (const file of files) {
      if (alreadyApplied.has(file)) continue;
      const sql = await readFile(new URL(file, MIGRATIONS_DIR), "utf8");
      // Postgres can roll back schema changes, so a failed migration leaves no half-made tables.
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
      applied.push(file);
    }
    return applied;
  } finally {
    await client.end();
  }
}
