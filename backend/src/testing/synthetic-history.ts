/**
 * SYNTHETIC test history, made up for the replay experiment only. Never shown as real data.
 *
 * Two made-up worlds, to see WHEN the suggested order helps:
 *   repeating: a test sometimes breaks and stays broken for 2–6 runs (like a real bug until
 *              someone fixes it), plus 1% random noise. History carries information here.
 *   random:    every test fails 5% of the time, independently. History carries NO information,
 *              so the suggested order should do no better than the normal order.
 * Both worlds have roughly the same overall failure rate (about 5%).
 */
import type { PastRun } from "./replay.js";

export type World = "repeating" | "random";

export function makeHistory(world: World, seed: number, cases = 20, runs = 200): PastRun[] {
  const rng = mulberry32(seed);
  const brokenFor = new Array<number>(cases).fill(0); // runs left until this test is fixed
  const history: PastRun[] = [];

  for (let run = 1; run <= runs; run++) {
    const results = [];
    for (let c = 0; c < cases; c++) {
      let failed: boolean;
      if (world === "random") {
        failed = rng() < 0.05;
      } else if (brokenFor[c]! > 0) {
        brokenFor[c]!--; // still broken
        failed = true;
      } else if (rng() < 0.01) {
        brokenFor[c] = 1 + Math.floor(rng() * 5); // breaks now, for 2–6 runs in total
        failed = true;
      } else {
        failed = rng() < 0.01; // noise
      }
      results.push({ case_id: c + 1, passed: !failed });
    }
    history.push({ run_id: run, results });
  }
  return history;
}

/** A tiny seeded random number generator (0 ≤ x < 1), so every seed gives the same history. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
