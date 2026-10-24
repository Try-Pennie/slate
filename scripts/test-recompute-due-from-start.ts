// #3388: a pool falls due from when its compute STARTED, not from its stamp.
//
// The lane's rows are stamped from the eligibility read when it came from the 60
// second cache, so a row can carry a stamp up to a minute before the compute that
// wrote it. That stamp is right for the #1048 write gate (a fresher live write must
// win) and wrong for scheduling: `bucketDueAtMs` places a pool on its own phase grid,
// and a stamp moved back past the pool's grid point lands in the PREVIOUS window, so
// the pool came due again one tick later instead of a window later. Simulated over
// the real due rule, cache hits added 16% to 80% more pool computes a tick.
//
// So the row also records when its compute started (`compute_started_at`, migration
// 0202) and everything that judges DUE reads that. This drives the real
// `bucketsDueForRecompute` and `poolsDueForRecompute` over a day of ticks and fails
// if cache hits cost a single extra compute.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-recompute-due-from-start.ts
import {
  bucketsDueForRecompute,
  staleBuckets,
  RECOMPUTE_FRESH_MS,
  STALE_ALARM_MS,
  type KnownRow,
} from "../src/lib/availability/precompute-cron.ts";
import { poolsDueForRecompute, type PooledBucket } from "../src/lib/availability/pool-recompute.ts";
import { scheduleAnchorMs, MAX_STAMP_LAG_MS } from "../src/lib/availability/slot-row-times.ts";
import { ELIGIBLE_TTL_SECONDS } from "../src/lib/availability/eligible-cache-key.ts";
import { freshnessOf, supplyComputedAtMs } from "../src/lib/admin/bucket-supply.ts";
import type { Bucket } from "../src/lib/db/types.ts";
import { assert, eq, finish } from "./lib/harness.ts";

/** Seeded, so every scenario sees the same draws and the counts are exact. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

const KEYS = Array.from({ length: 15 }, (_, i) => `org|event|pool-${i}`);
const DAY0 = Date.parse("2026-10-23T00:00:00.000Z");
const TICKS = 1440;
const WARM = 60;

/**
 * A day of every minute ticks. Each due pool's compute starts up to 20s into the
 * tick and reads eligibility `ageOf()` ms before that. `split` says whether the row
 * records the start beside the stamp. Returns computes after the warm up hour.
 */
function simulate(ageOf: (tick: number, r: () => number) => number, split: boolean) {
  const startDraw = rng(42);
  const ageDraw = rng(7);
  const known = new Map<string, KnownRow>();
  let computes = 0;
  for (let t = 0; t < TICKS; t++) {
    const now = DAY0 + t * 60_000;
    const due = bucketsDueForRecompute([...known.values()], KEYS, now, RECOMPUTE_FRESH_MS);
    for (const code of due) {
      const start = now + Math.floor(startDraw() * 20_000);
      const stamp = start - ageOf(t, ageDraw);
      known.set(code, split ? { code, computedAtMs: stamp, startedAtMs: start } : { code, computedAtMs: stamp });
      if (t >= WARM) computes++;
    }
  }
  return computes;
}

const live = simulate(() => 0, true);
const scenarios: [string, (t: number, r: () => number) => number][] = [
  ["every compute hits a 55s old entry", () => 55_000],
  ["every compute hits an entry aged 0 to 60s", (_t, r) => Math.floor(r() * 60_000)],
  ["only the tick after a monitor tick hits, at 55s", (t) => (t % 5 === 1 ? 55_000 : 0)],
];

assert(live > 0, `the baseline does work (${live} pool computes)`);
for (const [label, ageOf] of scenarios) {
  // The control first: judged by the stamp alone, cache hits DO add computes. If this
  // ever stops being true the simulation has stopped measuring anything (L1).
  const stampOnly = simulate(ageOf, false);
  assert(stampOnly > live, `${label}: judged by the stamp, it costs extra computes (${stampOnly} against ${live})`);
  eq(simulate(ageOf, true), live, `${label}: judged by the compute's start, it costs none`);
}

// --- Pools: the oldest member's START decides ---

function pooled(code: string, team: string): PooledBucket {
  return {
    code,
    bucket: { id: `id-${code}`, code } as unknown as Bucket,
    orgId: "org-1",
    eventTypeId: "event-1",
    criteria: { debt_team: team },
    fallbackUserId: null,
    memberIds: [],
  };
}

{
  const pools = new Map([["low", [pooled("100", "low"), pooled("101", "low")]]]);
  // Written by the lane from a list read 55s before its compute started. With no
  // jitter a pool is due a full window after its anchor, so 3m20s after the start it
  // is not due by the start (due at 4m) and IS due by the stamp (due at 3m05s).
  const start = DAY0 + 10 * 60_000;
  const now = start + 200_000;
  const rows: KnownRow[] = [
    { code: "100", computedAtMs: start - 55_000, startedAtMs: start },
    { code: "101", computedAtMs: start - 55_000, startedAtMs: start },
  ];
  eq(poolsDueForRecompute(rows, pools, now, RECOMPUTE_FRESH_MS, 0).length, 0, "a pool is due from its start");
  eq(
    poolsDueForRecompute(
      rows.map(({ code, computedAtMs }) => ({ code, computedAtMs })),
      pools,
      now,
      RECOMPUTE_FRESH_MS,
      0,
    ).length,
    1,
    "the control: with no start recorded the stamp decides, and the same pool is due 55s sooner",
  );
  eq(
    poolsDueForRecompute(
      [rows[0]!, { code: "101", computedAtMs: start - 200_000, startedAtMs: start - 200_000 }],
      pools,
      now,
      RECOMPUTE_FRESH_MS,
      0,
    ).length,
    1,
    "the pool is as fresh as its member that started longest ago",
  );
}

// --- The anchor rule ---

{
  const at = DAY0;
  eq(scheduleAnchorMs(at, null), at, "no start recorded (the column is not there yet): the stamp");
  eq(scheduleAnchorMs(at, undefined), at, "an older row with no start: the stamp");
  eq(scheduleAnchorMs(at, at + 30_000), at + 30_000, "a start 30s after the stamp: the start");
  eq(scheduleAnchorMs(at, at), at, "a start equal to the stamp (every live path): either");
  eq(scheduleAnchorMs(at, at + MAX_STAMP_LAG_MS), at + MAX_STAMP_LAG_MS, "a start a full cache lifetime later: the start");
  eq(MAX_STAMP_LAG_MS, ELIGIBLE_TTL_SECONDS * 1000, "and that lifetime is the cache's own, not a second number");
  eq(
    scheduleAnchorMs(at, at + MAX_STAMP_LAG_MS + 1),
    at,
    "a start further after the stamp than any cached read explains: the stamp",
  );
  // A settings save (or the runbook's hand SQL) back dates the stamp to the epoch to
  // force every row due, and touches nothing else. The start it leaves behind must
  // not hold the row off.
  eq(scheduleAnchorMs(0, at), 0, "a stamp back dated to the epoch: the stamp, so the row is due at once");
  eq(scheduleAnchorMs(at, at - 5_000), at, "a start before the stamp (a writer that did not record one): the stamp");
  eq(scheduleAnchorMs(at, Number.NaN), at, "an unreadable start: the stamp (L50)");
}

// --- The stale alarm agrees with the due set ---

{
  // Stamped 6m30s ago from a 60s old list, started 5m30s ago. By the stamp it is past
  // the alarm; by its start it is due but still inside the margin the alarm leaves
  // the lane (#1248), which is the question the alarm asks.
  const now = DAY0 + 60 * 60_000;
  const start = now - STALE_ALARM_MS + 30_000;
  const row: KnownRow = { code: "100", computedAtMs: start - 60_000, startedAtMs: start };
  eq(staleBuckets([row], ["100"], now, STALE_ALARM_MS), [], "the alarm judges by the compute's start");
  eq(
    staleBuckets([{ code: "100", computedAtMs: 0, startedAtMs: start }], ["100"], now, STALE_ALARM_MS),
    ["100"],
    "and an unreadable or back dated stamp still pages, whatever start it carries",
  );
}

// --- The admin "Last computed" column and its grade read the same anchor ---

{
  const start = DAY0 + 60 * 60_000;
  const stamp = new Date(start - 60_000).toISOString();
  const started = new Date(start).toISOString();
  eq(supplyComputedAtMs({ computed_at: stamp, compute_started_at: started }), start, "the column reads the start");
  eq(supplyComputedAtMs({ computed_at: stamp }), start - 60_000, "a row with no start reads the stamp");
  eq(
    freshnessOf(supplyComputedAtMs({ computed_at: stamp, compute_started_at: started }), start + STALE_ALARM_MS - 30_000),
    "aging",
    "so it shows the same verdict the stale alarm reaches, not stale 60s early",
  );
  eq(supplyComputedAtMs({ computed_at: "not a time", compute_started_at: started }), null, "an unreadable stamp is unknown");
}

finish();
