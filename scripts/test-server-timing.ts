// #3653 / #3652: the availability route's Server-Timing, and the canary that reads it.
//
// The two halves live on opposite sides of a boundary that cannot share code: the route
// writes the header from `src/lib/api/server-timing.ts`, and the latency canary runs on
// bare node with no dependency install, so it parses it in `scripts/lib/latency-slo.ts`
// with its own copy of the names (`CANARY_TIMING_NAMES`; how many is not repeated here,
// since #3713 grew the set and a count in a comment is the first thing to go stale). A
// rename on one side would leave the canary reading `null` for every sample, which
// prints as "no Server-Timing" and reads as the route not sending one (L271). So this
// compares the two sets of names both ways, drives the REAL writer and the REAL reader
// together over every name, and fails if they stop agreeing.
//
// The timer's clock is injected, so nothing here waits (L524).
//
// Run: node --experimental-strip-types scripts/test-server-timing.ts
import { createServerTimer, SERVER_TIMING_NAMES } from "../src/lib/api/server-timing.ts";
import { parseServerTiming, CANARY_TIMING_NAMES, type ServerTiming } from "./lib/latency-slo.ts";
import { assert, eq, finish } from "./lib/harness.ts";

function fakeClock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

/** What the canary reads when the route sent none of the slot read's parts. */
const NO_PARTS = { cacheMs: null, hoursMs: null, rowMs: null, computeMs: null, fallbackMs: null };

{
  const clock = fakeClock();
  const timer = createServerTimer(clock.now);
  clock.advance(2); // auth and parsing before the limiter
  await timer.span(SERVER_TIMING_NAMES.limiter, async () => clock.advance(40));
  clock.advance(1);
  await timer.span(SERVER_TIMING_NAMES.slots, async () => clock.advance(12));
  clock.advance(5);
  const header = timer.header();
  eq(header, "limit;dur=40, slots;dur=12, worker;dur=60", "the header names each span and the total");
  eq(
    parseServerTiming(header),
    { workerMs: 60, limitMs: 40, slotsMs: 12, ...NO_PARTS },
    "and the canary reads back what was written",
  );
}

// --- #3713: the two sides name the SAME set, whichever side grows -----------------
//
// The canary keeps its own copy of the names because it runs on bare node. A name
// added on the route side only would be ignored by the parser and print as never sent;
// one added on the canary side only would wait for an entry nothing writes. So the sets
// are compared both ways, from the real constants, never from a list held here.
{
  const route = Object.values(SERVER_TIMING_NAMES).sort();
  const canary = [...CANARY_TIMING_NAMES.keys()].sort();
  eq(canary, route, "the canary reads exactly the entry names the route writes");
}
{
  // Every name round trips, each with its own duration, so a mapping that sends two
  // names to one field (or a name to the wrong field) fails rather than passing on a
  // fixture that only ever used two of them.
  const clock = fakeClock();
  const timer = createServerTimer(clock.now);
  const names = Object.values(SERVER_TIMING_NAMES).filter((n) => n !== SERVER_TIMING_NAMES.total);
  const wrote = new Map<string, number>();
  for (const [i, name] of names.entries()) {
    const dur = (i + 1) * 10 + 1;
    wrote.set(name, dur);
    await timer.span(name, async () => clock.advance(dur));
  }
  const read = parseServerTiming(timer.header());
  assert(read !== null, "the header with every span is readable");
  for (const [name, dur] of wrote) {
    const field = CANARY_TIMING_NAMES.get(name) as keyof ServerTiming;
    eq(read![field], dur, `the ${name} span reads back as its own duration`);
  }
}

// --- #3713: a part read more than once is one entry, summed -----------------------
//
// The business hours are asked for twice on one read (the served filter and the offered
// window), and a header carrying `hours` twice would be read by the canary as whichever
// came last. So a name records the SUM of every span under it, in the place it first
// finished.
{
  const clock = fakeClock();
  const timer = createServerTimer(clock.now);
  await timer.span(SERVER_TIMING_NAMES.slots, async () => {
    await timer.span(SERVER_TIMING_NAMES.hours, async () => clock.advance(30));
    await timer.span(SERVER_TIMING_NAMES.cache, async () => clock.advance(4));
    await timer.span(SERVER_TIMING_NAMES.hours, async () => clock.advance(0));
    await timer.span(SERVER_TIMING_NAMES.hours, async () => clock.advance(5));
  });
  eq(
    timer.header(),
    "hours;dur=35, cache;dur=4, slots;dur=39, worker;dur=39",
    "a repeated name is one entry holding the sum, and a nested span finishes inside its parent",
  );
  eq(timer.spanMs(SERVER_TIMING_NAMES.hours), 35, "the log line reads the same sum");
  eq(timer.spanMs(SERVER_TIMING_NAMES.slots), 39, "and the parent's own span");
  eq(timer.spanMs(SERVER_TIMING_NAMES.fallback), null, "a part that never ran is null, never a measured 0 (L90)");
}
{
  // A part that ran and took no time on the Worker's clock (no I/O inside it, so the
  // clock did not move) is a real 0, distinct from a part that never ran.
  const clock = fakeClock();
  const timer = createServerTimer(clock.now);
  await timer.span(SERVER_TIMING_NAMES.hours, async () => {});
  eq(timer.spanMs(SERVER_TIMING_NAMES.hours), 0, "a part that ran without moving the clock reads 0");
  eq(timer.header(), "hours;dur=0, worker;dur=0", "and appears in the header, so it reads as ran");
}
{
  // A span that throws is still timed, and still rethrows: timing must never change
  // what the route does with a fault.
  const clock = fakeClock();
  const timer = createServerTimer(clock.now);
  let threw = false;
  try {
    await timer.span(SERVER_TIMING_NAMES.slots, async () => {
      clock.advance(7);
      throw new Error("boom");
    });
  } catch {
    threw = true;
  }
  assert(threw, "a span rethrows the fault it timed");
  eq(timer.header(), "slots;dur=7, worker;dur=7", "and its duration is still recorded");
}
{
  // Only the spans that ran appear: a header never claims a 0ms limiter call that did
  // not happen, which the canary would print as a measured zero.
  const clock = fakeClock();
  const timer = createServerTimer(clock.now);
  clock.advance(3);
  eq(timer.header(), "worker;dur=3", "the total alone when no span ran");
  eq(
    parseServerTiming(timer.header()),
    { workerMs: 3, limitMs: null, slotsMs: null, ...NO_PARTS },
    "read back with the spans null",
  );
}
{
  // A clock that steps backwards (it cannot on the Worker, whose clock only advances at
  // I/O, but can on a host) is clamped, never a negative duration.
  let t = 100;
  const timer = createServerTimer(() => t);
  t = 90;
  eq(timer.header(), "worker;dur=0", "a backwards step is clamped to zero");
}
{
  // Fractions are rounded: the Workers clock is whole milliseconds, and a host's
  // performance clock would otherwise print a long tail of digits on every response.
  let t = 0;
  const timer = createServerTimer(() => t);
  t = 12.6;
  eq(timer.header(), "worker;dur=13", "rounded to whole milliseconds");
}

finish();
