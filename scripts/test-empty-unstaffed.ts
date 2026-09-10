// #2158: a bucket with NOBODY in its pool is not a full week.
//
// "All times are taken right now. Check back soon." is untrue in both halves for
// an unstaffed bucket: nothing is taken, and soon may be never. It was the third
// instance of one class (#1328 added the closure sentence, #1414 the unclassified
// one), each because one cause was being reported as another (L11).
//
// The interesting part is the ORDER. A shut org and an empty pool can be true at
// once, and only one of them can be said, so the precedence is asserted here
// rather than left to whichever branch happens to run first.
// Run: node --experimental-strip-types scripts/test-empty-unstaffed.ts
import { assert, finish } from "./lib/harness.ts";
import { explainEmptyWindow } from "../src/lib/availability/empty-reason.ts";

const OPEN_WEEK = {
  zone: "America/New_York",
  // Every weekday open, so nothing here is a closure.
  rules: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
    weekday,
    start_minute: 9 * 60,
    end_minute: 17 * 60,
  })),
  exceptions: [],
};
const SHUT_WEEK = { zone: "America/New_York", rules: [], exceptions: [] };
// A Wednesday, well inside an ordinary week.
const NOW = Date.parse("2026-09-09T15:00:00.000Z");

// 1. An open week with nobody in the pool is UNSTAFFED, not busy.
{
  const out = explainEmptyWindow({ hours: OPEN_WEEK, horizonDays: 4, nowMs: NOW, pooledAgents: 0 });
  assert(out.reason?.kind === "unstaffed", `got ${JSON.stringify(out.reason)}`);
}

// 2. An open week with people in it, and still no times, is busy. That is the
//    honest reading: they exist and none of them is free.
{
  const out = explainEmptyWindow({ hours: OPEN_WEEK, horizonDays: 4, nowMs: NOW, pooledAgents: 17 });
  assert(out.reason?.kind === "busy", `got ${JSON.stringify(out.reason)}`);
}

// 3. A SHUT week wins over an empty pool. Both can be true at once and only one
//    can be said, and the closure is the one carrying a date the lead can act on;
//    "nobody is available" during a holiday shutdown would be true and useless.
{
  const out = explainEmptyWindow({ hours: SHUT_WEEK, horizonDays: 4, nowMs: NOW, pooledAgents: 0 });
  assert(out.reason?.kind === "closed", `a closure outranks an empty pool, got ${JSON.stringify(out.reason)}`);
}

// 4. An UNKNOWN pool size is not an empty one. The count is a read that can fail,
//    and a failed read arriving as zero would tell every lead nobody works here
//    (L215, and the #1641 class).
{
  const out = explainEmptyWindow({ hours: OPEN_WEEK, horizonDays: 4, nowMs: NOW, pooledAgents: null });
  assert(out.reason?.kind === "busy", `an unknown pool falls back to busy, got ${JSON.stringify(out.reason)}`);
  assert(out.reason?.kind !== "unstaffed", "an unread count never claims nobody works here");
}

// 5. An unreadable week still refuses to guess, whatever the pool says. The
//    unclassified sentence (#1414) exists for exactly this and must not be
//    overtaken by a pool count that happens to be zero.
{
  const out = explainEmptyWindow({ hours: null, horizonDays: 4, nowMs: NOW, pooledAgents: 0 });
  assert(out.reason === null, "no week, no verdict");
  assert(out.blockedBy !== null, "and it says what it could not read");
}

finish();
