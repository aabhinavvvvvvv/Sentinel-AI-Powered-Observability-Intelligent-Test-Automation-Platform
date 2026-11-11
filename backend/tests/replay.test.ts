/**
 * The replay experiment: APFD maths, the "no peeking ahead" rule, synthetic history, and loading real runs.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "../src/db.js";
import { createEndpoint } from "../src/endpoints/repository.js";
import { CreateEndpointSchema } from "../src/endpoints/schemas.js";
import { apfd, loadHistory, replay, suggestedOrder, type PastRun } from "../src/testing/replay.js";
import { createCase, createSuite } from "../src/testing/repository.js";
import { TestCaseSchema } from "../src/testing/schemas.js";
import { makeHistory } from "../src/testing/synthetic-history.js";
import { resetDb, silentLogger } from "./helpers.js";

const db = createDatabase(process.env.TEST_DATABASE_URL!, silentLogger);
beforeEach(() => resetDb(db));
afterAll(() => db.close());

/** A run where the listed cases fail and the others (of 1..n) pass. */
const run = (run_id: number, n: number, failing: number[] = []): PastRun => ({
  run_id,
  results: Array.from({ length: n }, (_, i) => ({ case_id: i + 1, passed: !failing.includes(i + 1) })),
});

describe("apfd", () => {
  it("matches hand-worked examples", () => {
    // 4 tests: APFD = 1 - sum(positions) / (4 × m) + 1/8
    expect(apfd([1, 2, 3, 4], new Set([1]))).toBeCloseTo(0.875); // found first: best
    expect(apfd([1, 2, 3, 4], new Set([3]))).toBeCloseTo(0.375);
    expect(apfd([1, 2, 3, 4], new Set([2, 4]))).toBeCloseTo(0.375); // 1 - 6/8 + 1/8
    expect(apfd([1, 2, 3, 4], new Set())).toBeNull(); // nothing to find
  });
});

describe("suggestedOrder", () => {
  it("puts the case that failed last time first; with no history, keeps the normal order", () => {
    expect(suggestedOrder([run(1, 3, [3])], [1, 2, 3])).toEqual([3, 1, 2]);
    expect(suggestedOrder([], [1, 2, 3])).toEqual([1, 2, 3]);
  });
});

describe("replay", () => {
  it("scores only runs with failures, using hand-worked numbers", () => {
    const r = replay([run(1, 3), run(2, 3, [3]), run(3, 3, [3])]);
    expect(r).toMatchObject({ runs: 3, runs_with_failures: 2 });
    // Run 2: nobody has failed before, so both orders are 1,2,3 → failure at test 3, APFD 1 - 3/3 + 1/6.
    // Run 3: case 3 failed in run 2 → suggested 3,1,2 → failure at test 1, APFD 1 - 1/3 + 1/6.
    expect(r.normal!.first_failure).toBe(3);
    expect(r.normal!.apfd).toBeCloseTo(1 / 6);
    expect(r.suggested!.first_failure).toBe(2); // (3 + 1) / 2
    expect(r.suggested!.apfd).toBeCloseTo((1 / 6 + 5 / 6) / 2);
  });

  it("never uses a run's own results or later runs to order it (no peeking ahead)", () => {
    const history = [run(1, 4, [2]), run(2, 4, [4]), run(3, 4, [1]), run(4, 4)];
    const changed = [history[0]!, run(2, 4, [1, 2, 3]), run(3, 4), run(4, 4, [3])]; // change run 2 and everything after
    expect(replay(changed).per_run[1]!.suggested).toEqual(replay(history).per_run[1]!.suggested);
  });
});

describe("makeHistory (SYNTHETIC)", () => {
  const failureRate = (h: PastRun[]) => {
    const all = h.flatMap((r) => r.results);
    return all.filter((r) => !r.passed).length / all.length;
  };
  // How often a failing test also fails in the next run.
  const repeatRate = (h: PastRun[]) => {
    let fails = 0;
    let repeats = 0;
    for (let k = 0; k + 1 < h.length; k++) {
      for (const r of h[k]!.results.filter((x) => !x.passed)) {
        fails++;
        if (!h[k + 1]!.results.find((x) => x.case_id === r.case_id)!.passed) repeats++;
      }
    }
    return repeats / fails;
  };

  it("is reproducible: the same seed gives the same history", () => {
    expect(makeHistory("repeating", 7)).toEqual(makeHistory("repeating", 7));
    expect(makeHistory("repeating", 7)).not.toEqual(makeHistory("repeating", 8));
  });

  it("both worlds fail about 5% of the time, but only 'repeating' failures come back", () => {
    const repeating = makeHistory("repeating", 1);
    const random = makeHistory("random", 1);
    for (const h of [repeating, random]) expect(failureRate(h)).toBeGreaterThan(0.03);
    for (const h of [repeating, random]) expect(failureRate(h)).toBeLessThan(0.07);
    expect(repeatRate(repeating)).toBeGreaterThan(0.5);
    expect(repeatRate(random)).toBeLessThan(0.15);
  });
});

describe("loadHistory", () => {
  it("returns finished runs oldest first, without deleted cases", async () => {
    const e = await createEndpoint(db, CreateEndpointSchema.parse({ name: "API", url: "https://example.com" }));
    const suite = await createSuite(db, e.id, { name: "Suite", schedule_minutes: null });
    const make = (name: string) =>
      createCase(db, suite.id, TestCaseSchema.parse({ name, url: "https://example.com", assertions: [{ type: "status_equals", value: 200 }] }));
    const a = await make("a");
    const b = await make("b");

    const addRun = async (status: string, results: [number, boolean][]) => {
      const [r] = await db.query<{ id: number }>(
        "INSERT INTO test_runs (suite_id, triggered_by, status) VALUES ($1, 'manual', $2) RETURNING id",
        [suite.id, status],
      );
      for (const [caseId, passed] of results) {
        await db.query(
          "INSERT INTO test_case_results (run_id, case_id, case_name, passed, response_time_ms, failures) VALUES ($1, $2, 'x', $3, 1, '[]')",
          [r!.id, caseId, passed],
        );
      }
      return r!.id;
    };
    const first = await addRun("passed", [[a.id, true], [b.id, true]]);
    const second = await addRun("failed", [[a.id, false], [b.id, true]]);
    await addRun("running", [[a.id, true]]); // not finished: left out
    await db.query("DELETE FROM test_cases WHERE id = $1", [b.id]); // its results keep case_id NULL: left out

    expect(await loadHistory(db, suite.id)).toEqual([
      { run_id: first, results: [{ case_id: a.id, passed: true }] },
      { run_id: second, results: [{ case_id: a.id, passed: false }] },
    ]);
  });
});
