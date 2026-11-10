/**
 * Tests the error handler in isolation by mounting it on a tiny app
 * with a route that deliberately throws.
 */
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../src/middleware/errors.js";
import { silentLogger } from "./helpers.js";

describe("errorHandler", () => {
  it("turns an unexpected error into a generic JSON 500 without leaking details", async () => {
    const app = express();
    app.get("/boom", async () => {
      // Express 5 forwards errors thrown in async handlers to the error handler.
      throw new Error("relation \"secret_table\" does not exist");
    });
    app.use(errorHandler(silentLogger));

    const res = await request(app).get("/boom");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Internal server error" },
    });
    expect(res.text).not.toContain("secret_table");
  });
});
