/**
 * Tests the real Express app with a FAKE database.
 * Supertest sends HTTP requests to the app in memory — no real port, no real DB.
 */
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { silentLogger } from "./helpers.js";

function buildApp(ping: (timeoutMs: number) => Promise<void>) {
  // A fake database: only ping() matters for these tests.
  const db = { ping, query: async () => [], close: async () => {} };
  return createApp({ db, logger: silentLogger, healthcheckDbTimeoutMs: 1234 });
}

describe("GET /healthz", () => {
  it("returns 200 when the database responds", async () => {
    const ping = vi.fn().mockResolvedValue(undefined);
    const res = await request(buildApp(ping)).get("/healthz");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", checks: { database: "ok" } });
    expect(ping).toHaveBeenCalledWith(1234); // the configured timeout is passed through
  });

  it("returns 503 (not 500, not a crash) when the database is unreachable", async () => {
    const ping = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED"));
    const res = await request(buildApp(ping)).get("/healthz");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: "error", checks: { database: "error" } });
    // The internal error message must not reach the client.
    expect(JSON.stringify(res.body)).not.toContain("ECONNREFUSED");
  });

  it("forbids caching of health results", async () => {
    const res = await request(buildApp(async () => {})).get("/healthz");
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});

describe("app-wide behaviour", () => {
  const app = buildApp(async () => {});

  it("returns a JSON 404 for unknown routes", async () => {
    const res = await request(app).get("/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { code: "NOT_FOUND", message: "Route GET /does-not-exist not found" },
    });
  });

  it("returns a JSON 400 for malformed JSON bodies", async () => {
    const res = await request(app)
      .post("/anything")
      .set("Content-Type", "application/json")
      .send('{"broken": ');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("BAD_REQUEST");
  });

  it("does not advertise the framework", async () => {
    const res = await request(app).get("/healthz");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
});
