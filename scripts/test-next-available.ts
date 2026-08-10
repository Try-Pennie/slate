/**
 * #1329 / #1339: finding the first bookable days on the far side of a closure.
 *
 * The ordinary search is bounded for cost, so during a long closure it honestly
 * returns nothing and a lead is left with no idea when to come back. This is the
 * way through, and it runs only for the lead who asks.
 *
 * Two things here are worth testing rather than trusting, and both are about COST
 * on a request somebody is waiting on:
 *
 *  - **The walk stops early.** It must not pay for the whole lookahead when the
 *    answer sits in the first week. A single long compute would, which is why this
 *    probes in short windows, and the assertion counts computes rather than
 *    inspecting the result.
 *  - **The walk is bounded.** With nothing bookable at all (the live state while
 *    the routing pool is off) it must give up rather than turn one click into an
 *    unbounded bill.
 *
 * And one that is about honesty: it returns FEWER days than asked for when that is
 * the truth, rather than padding to fill the strip.
 *
 * Run: node --experimental-strip-types scripts/test-next-available.ts
 */
import {
  probeWindows,
  findNextAvailableSlots,
  PROBE_WINDOW_DAYS,
  MAX_LOOKAHEAD_DAYS,
  type Probe,
} from "../src/lib/availability/next-available.ts";
import { DateTime } from "luxon";
import { assert, eq, finish } from "./lib/harness.ts";

const ZONE = "America/New_York";

// ------------------------------------------------------------ the windows

{
  const probes = probeWindows({ searchedThroughDay: "2026-08-16", zone: ZONE });
  assert(probes.length > 0, "there are windows to try");
  // The first window starts the day AFTER the ordinary search gave up, so the walk
  // never re-computes ground that already came back empty.
  assert(
    probes[0].fromIso.startsWith("2026-08-17"),
    "the first window starts the day after the searched range",
  );
  eq(
    probes.length,
    Math.ceil(MAX_LOOKAHEAD_DAYS / PROBE_WINDOW_DAYS),
    "the windows tile the lookahead",
  );
  // Contiguous, so no bookable day can fall between two probes and be missed.
  for (let i = 1; i < probes.length; i++) {
    assert(
      Date.parse(probes[i].fromIso) > Date.parse(probes[i - 1].fromIso),
      `window ${i} starts after window ${i - 1}`,
    );
    assert(
      Date.parse(probes[i].fromIso) - Date.parse(probes[i - 1].toIso) < 60 * 60 * 1000,
      `window ${i} follows straight on from window ${i - 1}, leaving no gap`,
    );
  }
  // And the walk never looks past the cap. Computed in the ZONE, because that is
  // where the walk's own day boundaries are.
  const lastTo = Date.parse(probes[probes.length - 1].toIso);
  const cap = DateTime.fromISO("2026-08-16", { zone: ZONE })
    .plus({ days: MAX_LOOKAHEAD_DAYS })
    .endOf("day")
    .toMillis();
  assert(lastTo <= cap, "the last window ends within the lookahead cap");
}

{
  eq(
    probeWindows({ searchedThroughDay: "not-a-date", zone: ZONE }).length,
    0,
    "an unreadable start yields no windows rather than a bad walk",
  );
}

// ------------------------------------------------------------- the walk

/** A compute that answers from a fixed set of slots, counting its calls. */
function computeFrom(slots: string[]) {
  const calls: Probe[] = [];
  return {
    calls,
    compute: async (probe: Probe) => {
      calls.push(probe);
      const from = Date.parse(probe.fromIso);
      const to = Date.parse(probe.toIso);
      return slots.filter((s) => {
        const ms = Date.parse(s);
        return ms >= from && ms <= to;
      });
    },
  };
}

const probes = probeWindows({ searchedThroughDay: "2026-08-16", zone: ZONE });

{
  // Four bookable days, all inside the first probe.
  const slots = [
    "2026-08-17T13:00:00.000Z",
    "2026-08-17T15:00:00.000Z",
    "2026-08-18T13:00:00.000Z",
    "2026-08-19T13:00:00.000Z",
    "2026-08-20T13:00:00.000Z",
  ];
  const { compute, calls } = computeFrom(slots);
  const found = await findNextAvailableSlots({ probes, wantDays: 4, zone: ZONE, compute });

  eq(found.length, 5, "every slot on the found days comes back, not one per day");
  eq(found[0], "2026-08-17T13:00:00.000Z", "in time order");
  // The whole point: it stopped after ONE compute rather than paying for 56 days.
  eq(calls.length, 1, "the walk stops at the first window that answers");
}

{
  // The answer sits in the third week, and only TWO days exist there against a
  // want of four, so the walk correctly keeps looking to the cap for the missing
  // two. That is the expensive case, and it is bounded: a handful of short
  // computes, only for a lead who clicked during a closure.
  const { compute, calls } = computeFrom([
    "2026-09-02T13:00:00.000Z",
    "2026-09-03T13:00:00.000Z",
  ]);
  const found = await findNextAvailableSlots({ probes, wantDays: 4, zone: ZONE, compute });

  eq(found.length, 2, "returns the two days it found");
  assert(calls.length > 2, "it walked past the empty windows to reach them");
  eq(calls.length, probes.length, "and kept looking for the missing days, bounded by the cap");
}

{
  // Early exit, proved by the compute count: the wanted days are satisfied in the
  // THIRD window, so the remaining five are never computed.
  const { compute, calls } = computeFrom([
    "2026-09-02T13:00:00.000Z",
    "2026-09-03T13:00:00.000Z",
    "2026-09-04T13:00:00.000Z",
  ]);
  const found = await findNextAvailableSlots({ probes, wantDays: 3, zone: ZONE, compute });
  eq(found.length, 3, "the three wanted days come back");
  eq(calls.length, 3, "and the walk stops there rather than running to the cap");
  assert(calls.length < probes.length, "so most of the lookahead is never paid for");
}

{
  // Fewer days than asked for is the honest answer during an open ended closure.
  const { compute } = computeFrom(["2026-08-18T13:00:00.000Z"]);
  const found = await findNextAvailableSlots({ probes, wantDays: 4, zone: ZONE, compute });
  eq(found.length, 1, "one day found means one day returned, never padded to four");
}

{
  // Nothing bookable anywhere: the live state while the routing pool is off. It
  // must give up at the cap rather than walk forever.
  const { compute, calls } = computeFrom([]);
  const found = await findNextAvailableSlots({ probes, wantDays: 4, zone: ZONE, compute });
  eq(found.length, 0, "nothing found means nothing returned");
  eq(calls.length, probes.length, "and the walk is bounded by the lookahead cap");
}

{
  // More days available than wanted: trimmed to the first N, so the strip length is
  // the same as it is on an ordinary day.
  const { compute } = computeFrom([
    "2026-08-17T13:00:00.000Z",
    "2026-08-18T13:00:00.000Z",
    "2026-08-19T13:00:00.000Z",
    "2026-08-20T13:00:00.000Z",
    "2026-08-21T13:00:00.000Z",
  ]);
  const found = await findNextAvailableSlots({ probes, wantDays: 3, zone: ZONE, compute });
  eq(found.length, 3, "trimmed to the first three days");
  assert(
    found.every((s) => s < "2026-08-20"),
    "and the days kept are the EARLIEST ones, not any three",
  );
}

{
  // A day is counted in the VIEWER's zone: 2026-08-18T01:30Z is Aug 17, 21:30 in
  // New York, so it belongs to the 17th and must not spend one of the N.
  const { compute } = computeFrom([
    "2026-08-18T01:30:00.000Z",
    "2026-08-17T13:00:00.000Z",
  ]);
  const found = await findNextAvailableSlots({ probes, wantDays: 1, zone: ZONE, compute });
  eq(found.length, 2, "a late evening slot belongs to the day the viewer sees it on");
}

{
  eq(
    (await findNextAvailableSlots({ probes, wantDays: 0, zone: ZONE, compute: computeFrom([]).compute })).length,
    0,
    "asking for no days computes nothing",
  );
}

finish();
