// #3653 / #3652: the availability route's Server-Timing, and the canary that reads it.
//
// The two halves live on opposite sides of a boundary that cannot share code: the route
// writes the header from `src/lib/api/server-timing.ts`, and the latency canary runs on
// bare node with no dependency install, so it parses it in `scripts/lib/latency-slo.ts`
// with its own copy of the three names. A rename on one side would leave the canary
// reading `null` for every sample, which prints as "no Server-Timing" and reads as the
// route not sending one (L271). So this drives the REAL writer and the REAL reader
// together, and fails if they stop agreeing.
//
// The timer's clock is injected, so nothing here waits (L524).
//
// Run: node --experimental-strip-types scripts/test-server-timing.ts
import { createServerTimer, SERVER_TIMING_NAMES } from "../src/lib/api/server-timing.ts";
import { parseServerTiming } from "./lib/latency-slo.ts";
import { assert, eq, finish } from "./lib/harness.ts";

function fakeClock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

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
  eq(parseServerTiming(header), { workerMs: 60, limitMs: 40, slotsMs: 12 }, "and the canary reads back what was written");
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
  eq(parseServerTiming(timer.header()), { workerMs: 3, limitMs: null, slotsMs: null }, "read back with the spans null");
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
