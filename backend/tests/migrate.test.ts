import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/migrate.js";

describe("runMigrations", () => {
  it("is safe to run again: nothing new is applied the second time", async () => {
    // global-setup.ts already migrated the test database once.
    expect(await runMigrations(process.env.TEST_DATABASE_URL!)).toEqual([]);
  });
});
