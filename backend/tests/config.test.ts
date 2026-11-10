import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

const VALID_URL = "postgres://user:secret@localhost:5432/sentinel";

describe("loadConfig", () => {
  it("applies defaults when only the required variable is set", () => {
    const config = loadConfig({ DATABASE_URL: VALID_URL });
    expect(config).toEqual({
      NODE_ENV: "development",
      PORT: 3000,
      LOG_LEVEL: "info",
      DATABASE_URL: VALID_URL,
      HEALTHCHECK_DB_TIMEOUT_MS: 2000,
    });
  });

  it("converts numeric strings to numbers", () => {
    const config = loadConfig({ DATABASE_URL: VALID_URL, PORT: "8080" });
    expect(config.PORT).toBe(8080);
  });

  it("rejects a missing DATABASE_URL and names the variable", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it("rejects a non-Postgres URL", () => {
    expect(() => loadConfig({ DATABASE_URL: "http://localhost:5432/x" })).toThrow(
      /postgres:\/\/ or postgresql:\/\//,
    );
  });

  it.each(["abc", "0", "70000", "3000.5"])("rejects invalid PORT %s", (port) => {
    expect(() => loadConfig({ DATABASE_URL: VALID_URL, PORT: port })).toThrow(/PORT/);
  });

  it("does not leak secret values in the error message", () => {
    const run = () => loadConfig({ DATABASE_URL: VALID_URL, LOG_LEVEL: "loud" });
    expect(run).toThrow(/LOG_LEVEL/);
    expect(run).not.toThrow(/secret/);
  });

  it("returns a frozen (read-only) object", () => {
    expect(Object.isFrozen(loadConfig({ DATABASE_URL: VALID_URL }))).toBe(true);
  });
});
