import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

const VALID_URL = "postgres://user:secret@localhost:5432/sentinel";

describe("loadConfig", () => {
  it("applies defaults when only the required variable is set", () => {
    const config = loadConfig({ DATABASE_URL: VALID_URL });
    expect(config).toEqual({
      NODE_ENV: "development",
      PORT: 3000,
      HOST: "127.0.0.1", // only this computer can reach the API
      LOG_LEVEL: "info",
      DATABASE_URL: VALID_URL,
      REDIS_URL: "redis://localhost:6379",
      SMTP_URL: "smtp://localhost:1025",
      ALERT_EMAIL_FROM: "Sentinel <sentinel@localhost>",
      ALERT_EMAIL_TO: [], // alerts off by default
      ANALYTICS_URL: "http://localhost:8000",
      HEALTHCHECK_DB_TIMEOUT_MS: 2000,
    });
  });

  it("splits ALERT_EMAIL_TO into a list of addresses", () => {
    const config = loadConfig({ DATABASE_URL: VALID_URL, ALERT_EMAIL_TO: " a@example.com, b@example.com ," });
    expect(config.ALERT_EMAIL_TO).toEqual(["a@example.com", "b@example.com"]);
  });

  it("rejects an invalid address in ALERT_EMAIL_TO", () => {
    expect(() => loadConfig({ DATABASE_URL: VALID_URL, ALERT_EMAIL_TO: "a@example.com, nope" })).toThrow(
      /ALERT_EMAIL_TO/,
    );
  });

  it("rejects a non-Redis REDIS_URL", () => {
    expect(() => loadConfig({ DATABASE_URL: VALID_URL, REDIS_URL: "http://x" })).toThrow(/REDIS_URL/);
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
