// Retention for the inbound Regal call feed (#2090). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-regal-call-retention.ts
//
// `regal_call_events` grows with call volume (about 6,000 a weekday) and the
// detector only ever reads a recent window, so it is pruned from its first
// migration rather than after it has grown (#1252 is what happens otherwise). This
// pins what the sweep deletes and what it keeps, against a fake table holding rows
// either side of the boundary, and that a failed delete throws rather than reading
// as "nothing needed cleaning" (#1165).
import {
  REGAL_CALL_RETENTION_DAYS,
  REGAL_OUTCOME_RETENTION_DAYS,
  regalCallCutoffIso,
  regalOutcomeCutoffIso,
  pruneRegalCalls,
  pruneRegalCallOutcomes,
} from "@/lib/regal/retention";
import { assert, eq, finish } from "./lib/harness.ts";

const DAY = 24 * 60 * 60_000;
const NOW = Date.UTC(2026, 8, 24, 3, 5, 0);

// Long enough to read a Friday evening's events on the Monday morning after, and
// no longer: the detector's own window is minutes and its daily alarms a day.
assert(REGAL_CALL_RETENTION_DAYS >= 3, "retention covers a weekend, Friday evening to Monday morning");
assert(REGAL_CALL_RETENTION_DAYS <= 7, "retention is a few days, not a history");

const cutoff = regalCallCutoffIso(NOW);
eq(cutoff, new Date(NOW - REGAL_CALL_RETENTION_DAYS * DAY).toISOString(), "the cutoff is exactly the window back");

// A fake table: `deleteReceivedBefore` removes rows STRICTLY older than the
// cutoff, which is what `.lt("received_at", cutoff)` does.
const rows = [
  { id: "old", received_at: new Date(NOW - REGAL_CALL_RETENTION_DAYS * DAY - 1).toISOString() },
  { id: "edge", received_at: cutoff },
  { id: "recent", received_at: new Date(NOW - 60_000).toISOString() },
  { id: "yesterday", received_at: new Date(NOW - DAY).toISOString() },
];
let seenCutoff = "";
const report = await pruneRegalCalls({
  nowMs: NOW,
  deleteReceivedBefore: async (iso) => {
    seenCutoff = iso;
    const doomed = rows.filter((r) => r.received_at < iso);
    for (const d of doomed) rows.splice(rows.indexOf(d), 1);
    return doomed.length;
  },
});
eq(seenCutoff, cutoff, "the sweep deletes against the computed cutoff");
eq(report, { deleted: 1, cutoff }, "the report says how many went and against what boundary");
eq(rows.map((r) => r.id).sort(), ["edge", "recent", "yesterday"], "only the row past the window is deleted");

let threw = "";
try {
  await pruneRegalCalls({
    nowMs: NOW,
    deleteReceivedBefore: async () => {
      throw new Error("delete refused");
    },
  });
} catch (err) {
  threw = err instanceof Error ? err.message : String(err);
}
eq(threw, "delete refused", "a failed delete throws, so the lane fails loud rather than reporting zero");

// --- the call outcomes (#2944): 120 days, one DELETE on received_at -------------
//
// The show rate in the Slate vs cal.com split reads these back over the split's
// window, so they outlive the detector's three days by design, and a failed delete
// of them must fail the lane just as loudly.

eq(REGAL_OUTCOME_RETENTION_DAYS, 120, "call outcomes are kept 120 days");
const outcomeCutoff = regalOutcomeCutoffIso(NOW);
eq(outcomeCutoff, new Date(NOW - 120 * DAY).toISOString(), "the outcome cutoff is exactly 120 days back");
{
  const outcomes = [
    { id: "past-window", received_at: new Date(NOW - 120 * DAY - 1).toISOString() },
    { id: "edge", received_at: outcomeCutoff },
    { id: "a-week-old", received_at: new Date(NOW - 7 * DAY).toISOString() },
    { id: "ninety-days", received_at: new Date(NOW - 90 * DAY).toISOString() },
  ];
  const seen: string[] = [];
  const r = await pruneRegalCallOutcomes({
    nowMs: NOW,
    deleteReceivedBefore: async (iso) => {
      seen.push(iso);
      const doomed = outcomes.filter((o) => o.received_at < iso);
      for (const d of doomed) outcomes.splice(outcomes.indexOf(d), 1);
      return doomed.length;
    },
  });
  eq(seen, [outcomeCutoff], "one DELETE, against the 120 day cutoff");
  eq(r, { deleted: 1, cutoff: outcomeCutoff }, "the report says how many outcomes went and against what boundary");
  eq(outcomes.map((o) => o.id).sort(), ["a-week-old", "edge", "ninety-days"], "a week old outcome survives the detector's three day window");
}
{
  let msg = "";
  try {
    await pruneRegalCallOutcomes({
      nowMs: NOW,
      deleteReceivedBefore: async () => {
        throw new Error("outcome delete refused");
      },
    });
  } catch (err) {
    msg = err instanceof Error ? err.message : String(err);
  }
  eq(msg, "outcome delete refused", "a failed outcome delete throws rather than reporting zero");
}

// The lane runs BOTH sweeps, and wires the outcome one to the right table.
{
  const { readFileSync } = await import("node:fs");
  const lane = readFileSync("src/app/api/cron/prune-regal-calls/route.ts", "utf8");
  assert(/pruneRegalCallOutcomes\(/.test(lane), "the prune-regal-calls lane runs the outcome sweep");
  assert(
    /from\("regal_call_outcomes"\)\.delete\(\{ count: "exact" \}\)\.lt\("received_at", cutoff\)/.test(lane),
    "the outcome sweep deletes from regal_call_outcomes on received_at",
  );
}

finish();
