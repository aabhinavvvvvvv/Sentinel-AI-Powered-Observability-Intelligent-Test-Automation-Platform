import { describe, expect, it } from "vitest";
import { createDatabase, withTimeout } from "../src/db.js";
import { silentLogger } from "./helpers.js";

describe("withTimeout", () => {
  it("returns the value when the promise settles in time", async () => {
    await expect(withTimeout(Promise.resolve(42), 100, "op")).resolves.toBe(42);
  });

  it("passes through the promise's own rejection", async () => {
    await expect(withTimeout(Promise.reject(new Error("nope")), 100, "op")).rejects.toThrow(
      "nope",
    );
  });

  it("rejects with a labelled error when the promise is too slow", async () => {
    const never = new Promise<never>(() => {});
    await expect(withTimeout(never, 20, "database ping")).rejects.toThrow(
      "database ping timed out after 20ms",
    );
  });
});

describe("createDatabase().ping", () => {
  it("rejects (instead of hanging or crashing) when nothing is listening", async () => {
    // Port 1 on localhost: nothing listens there, so the connection is refused.
    const db = createDatabase("postgres://user:pass@127.0.0.1:1/none", silentLogger);
    try {
      await expect(db.ping(2000)).rejects.toThrow();
    } finally {
      await db.close();
    }
  });
});
