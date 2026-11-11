/**
 * `npm run replay`: does the suggested order find failures sooner than the normal order?
 * Prints the replay on every real suite, then on SYNTHETIC history (clearly labelled).
 */
import { pino } from "pino";
import { loadConfig } from "../config.js";
import { createDatabase } from "../db.js";
import { loadHistory, replay, type ReplayResult } from "./replay.js";
import { makeHistory, type World } from "./synthetic-history.js";

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

function show(label: string, r: ReplayResult) {
  console.log(`\n${label}: ${r.runs} runs, ${r.runs_with_failures} with at least one failure`);
  if (!r.normal || !r.suggested) return console.log("  nothing failed, so there is nothing to compare");
  const line = (name: string, s: NonNullable<ReplayResult["normal"]>) =>
    console.log(`  ${name.padEnd(16)} APFD ${s.apfd.toFixed(3)}   first failure at test ${s.first_failure.toFixed(2)} (average)`);
  line("normal order", r.normal);
  line("suggested order", r.suggested);
}

const db = createDatabase(loadConfig().DATABASE_URL, pino({ level: "silent" }));
const suites = await db.query<{ id: number; name: string }>("SELECT id, name FROM test_suites ORDER BY id");
console.log("=== REAL history ===");
for (const s of suites) show(`Suite ${s.id} "${s.name}"`, replay(await loadHistory(db, s.id)));
await db.close();

console.log(`\n=== SYNTHETIC history (made up: ${SEEDS.length} seeds × 200 runs × 20 tests) ===`);
for (const world of ["repeating", "random"] as World[]) {
  const results = SEEDS.map((seed) => replay(makeHistory(world, seed)));
  const avg = (pick: (r: ReplayResult) => number) => results.reduce((sum, r) => sum + pick(r), 0) / results.length;
  show(`World "${world}" (averaged over seeds)`, {
    runs: avg((r) => r.runs),
    runs_with_failures: Math.round(avg((r) => r.runs_with_failures)),
    normal: { apfd: avg((r) => r.normal!.apfd), first_failure: avg((r) => r.normal!.first_failure) },
    suggested: { apfd: avg((r) => r.suggested!.apfd), first_failure: avg((r) => r.suggested!.first_failure) },
    per_run: [],
  });
  const wins = results.filter((r) => r.suggested!.apfd > r.normal!.apfd).length;
  console.log(`  suggested order had the higher APFD on ${wins} of ${SEEDS.length} seeds`);
}
