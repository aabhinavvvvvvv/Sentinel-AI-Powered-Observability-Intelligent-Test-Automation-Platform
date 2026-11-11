import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "../src/db.js";
import { createEndpoint } from "../src/endpoints/repository.js";
import { CreateEndpointSchema } from "../src/endpoints/schemas.js";
import { runMigrations } from "../src/migrate.js";
import { resetDb, silentLogger } from "./helpers.js";

describe("runMigrations", () => {
  it("is safe to run again: nothing new is applied the second time", async () => {
    // global-setup.ts already migrated the test database once.
    expect(await runMigrations(process.env.TEST_DATABASE_URL!)).toEqual([]);
  });
});

describe("migration 008: re-labels old failures with the finer categories", () => {
  const db = createDatabase(process.env.TEST_DATABASE_URL!, silentLogger);
  beforeEach(() => resetDb(db));
  afterAll(() => db.close());

  it("splits old 'unexpected_status' by status code and old 'network' resets, in checks and incidents", async () => {
    const e = await createEndpoint(db, CreateEndpointSchema.parse({ name: "API", url: "https://example.com" }));
    // Old-style rows, as they were saved before this change.
    const old: [number | null, string, string][] = [
      [307, "unexpected_status", "Expected status 200, got 307"],
      [404, "unexpected_status", "Expected status 200, got 404"],
      [503, "unexpected_status", "Expected status 200, got 503"],
      [200, "unexpected_status", "Expected status 404, got 200"],
      [null, "network", "read ECONNRESET"],
      [null, "network", "Unknown network error"],
    ];
    for (const [status, type, message] of old) {
      await db.query(
        `INSERT INTO check_results (endpoint_id, ok, status_code, response_time_ms, error_type, error_message, checked_at)
         VALUES ($1, false, $2, 100, $3, $4, now())`,
        [e.id, status, type, message],
      );
      // resolved_at = now(): incidents can share an endpoint only if at most one is open.
      await db.query(
        "INSERT INTO incidents (endpoint_id, started_at, resolved_at, error_type, error_message) VALUES ($1, now(), now(), $2, $3)",
        [e.id, type, message],
      );
    }

    await db.query(await readFile(new URL("../migrations/008_finer_failure_categories.sql", import.meta.url), "utf8"));

    const expected = ["redirect", "client_error", "server_error", "unexpected_status", "connection_reset", "network"];
    const checks = await db.query<{ error_type: string }>("SELECT error_type FROM check_results ORDER BY id");
    const incidents = await db.query<{ error_type: string }>("SELECT error_type FROM incidents ORDER BY id");
    expect(checks.map((r) => r.error_type)).toEqual(expected);
    expect(incidents.map((r) => r.error_type)).toEqual(expected);
  });
});
