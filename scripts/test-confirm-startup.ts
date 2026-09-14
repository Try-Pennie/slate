// Telling a confirm's own work apart from the isolate starting up (#2340).
//
// Run 34889873261 judged the request path at a CPU p99 of 2,988ms against a
// 2,500ms budget, and the expensive confirms were not doing more confirm work: the
// stage profile is the SAME shape for the ones over two seconds of CPU and the
// ones under half a second. What differs is the three to four and a half seconds
// before the profile starts, which is the Next.js server bundle being evaluated on
// a fresh isolate and charged to whichever request that isolate serves first.
//
// So the bar could not pass whatever the confirm did. A ten minute run at sixty a
// minute across four addresses spins up a few dozen isolates, and a p99 over six
// to eight hundred requests is exactly the top few percent, which is where those
// requests land. A bar that cannot pass for a reason nobody should fix is one
// nobody reads by the second week (L36).
//
// This reads the run's own archived log and splits the two, so the next run can
// say WHICH number moved. Two things it has to get right:
//
//   - cold and warm are told apart by a MEASUREMENT, not by a threshold somebody
//     picked off a histogram (L203). The confirm profile carries how long before
//     it started that this isolate evaluated the confirm module, so the isolate
//     became ready inside this request exactly when that age is no greater than
//     the time since the invocation began. No magic number.
//   - a reading it could not make is reported as one, never folded into the
//     numbers as a zero (L98).
//
// Run: node --experimental-strip-types scripts/test-confirm-startup.ts
import { readConfirmStartup } from "./loadtest/confirm-startup.ts";
import { formatLine } from "../src/lib/log.ts";
import { eq, finish } from "./lib/harness.ts";

/**
 * One tail line, built with the app's OWN formatter.
 *
 * The fields are rendered by `formatLine` rather than typed out here, so a change
 * to how Slate writes a log line changes these fixtures too and the parser is
 * exercised against the shape that really ships (L41). A hand written fixture
 * would go on passing over a format the reader can no longer parse.
 */
function tailLine(opts: {
  eventTimestamp: number;
  logTimestamp: number;
  totalMs: number;
  isolateAgeMs: number;
}): string {
  return JSON.stringify({
    outcome: "ok",
    eventTimestamp: opts.eventTimestamp,
    event: { request: { url: "https://x/api/bookings", method: "POST" } },
    logs: [
      {
        level: "info",
        timestamp: opts.logTimestamp,
        message: [
          formatLine("confirm-profile", {
            msg: "where the confirm spent its wall time",
            booking_id: "b1",
            bucket: "112",
            total_ms: opts.totalMs,
            isolate_age_ms: opts.isolateAgeMs,
            detail: `${opts.totalMs}ms wall: complete-reservation 700ms (60%, x1)`,
          }),
        ],
      },
    ],
  });
}

/** An invocation carrying something that is not a confirm profile. */
function otherLine(msg: string): string {
  return JSON.stringify({
    outcome: "ok",
    eventTimestamp: 1_000,
    logs: [{ level: "info", timestamp: 1_010, message: [formatLine("recompute", { msg })] }],
  });
}

// --- nothing to read is UNMEASURED, never a reading of zero ----------------------
{
  eq(readConfirmStartup(""), null, "an empty archive is unmeasured");
  eq(readConfirmStartup("\n\n"), null, "and so is one holding only blank lines");
  eq(
    readConfirmStartup([otherLine("cycle"), otherLine("cycle")].join("\n")),
    null,
    "an archive with no confirm profile in it is unmeasured, not a run whose confirms cost nothing",
  );
}

// --- the split itself --------------------------------------------------------------
{
  // Invocation received at 1,000. The profile is logged at 2,500 having measured
  // 900ms of its own, so 600ms passed before it started.
  const r = readConfirmStartup(
    tailLine({ eventTimestamp: 1_000, logTimestamp: 2_500, totalMs: 900, isolateAgeMs: 120_000 }),
  )!;
  eq(r.samples, 1, "one confirm was read");
  eq(r.handlerMs, [900], "the handler's own wall time comes from the profile");
  eq(r.preProfileMs, [600], "and what came before it is the invocation's wall minus that");
  eq(r.cold, 0, "an isolate two minutes old did not become ready inside this request");
  eq(r.warmPreProfileMs, [600], "so the reading is a warm one");
  eq(r.coldPreProfileMs, [], "with nothing on the cold side");
}

// --- cold is a measurement, not a threshold -------------------------------------------
{
  // The module became ready 200ms before the confirm started, and the invocation
  // began 3,100ms before it. 200 is no greater than 3,100, so the module was
  // evaluated inside THIS request: this is the isolate's first.
  const cold = readConfirmStartup(
    tailLine({ eventTimestamp: 0, logTimestamp: 4_400, totalMs: 1_300, isolateAgeMs: 200 }),
  )!;
  eq(cold.cold, 1, "the isolate became ready inside this request");
  eq(cold.coldPreProfileMs, [3_100], "and its startup is reported on its own");
  eq(cold.warmPreProfileMs, [], "and not mixed into the warm ones");

  // The same shape with the module older than the invocation. Nothing about the
  // DURATIONS changed; only which side of the split it lands on, which is the
  // point of measuring rather than thresholding.
  const warm = readConfirmStartup(
    tailLine({ eventTimestamp: 0, logTimestamp: 4_400, totalMs: 1_300, isolateAgeMs: 3_101 }),
  )!;
  eq(warm.cold, 0, "a module older than the invocation was evaluated before it");
  eq(warm.warmPreProfileMs, [3_100], "so the same 3,100ms is a warm reading");
}

// --- the boundary, stated rather than left to a rounding accident ----------------------
{
  const exactly = readConfirmStartup(
    tailLine({ eventTimestamp: 0, logTimestamp: 1_500, totalMs: 500, isolateAgeMs: 1_000 }),
  )!;
  eq(
    exactly.cold,
    1,
    "an age exactly equal to the time since the invocation began is the module having been " +
      "evaluated at the very start of it, which is this isolate's first request",
  );
}

// --- several invocations, kept apart ----------------------------------------------------
{
  const r = readConfirmStartup(
    [
      otherLine("cycle"),
      tailLine({ eventTimestamp: 0, logTimestamp: 5_000, totalMs: 1_000, isolateAgeMs: 100 }),
      tailLine({ eventTimestamp: 0, logTimestamp: 900, totalMs: 400, isolateAgeMs: 60_000 }),
      tailLine({ eventTimestamp: 0, logTimestamp: 950, totalMs: 450, isolateAgeMs: 60_000 }),
    ].join("\n"),
  )!;
  eq(r.samples, 3, "every confirm profile is read and nothing else is");
  eq(r.cold, 1, "one of them paid for its isolate starting up");
  eq(r.coldPreProfileMs, [4_000], "the cold one's startup");
  eq(r.warmPreProfileMs.sort((a, b) => a - b), [500, 500], "and the warm ones' own overhead");
}

// --- an arithmetic that cannot be right is COUNTED, never clamped in silence ------------
{
  // A profile claiming more wall time than its whole invocation took. Clamping to
  // zero and saying nothing would report a startup of zero, which is the most
  // flattering possible answer and indistinguishable from a fast one (L98).
  const r = readConfirmStartup(
    tailLine({ eventTimestamp: 1_000, logTimestamp: 1_100, totalMs: 900, isolateAgeMs: 50 }),
  )!;
  eq(r.samples, 1, "the sample is kept");
  eq(r.preProfileMs, [0], "its startup reads as zero rather than as a negative number");
  eq(r.impossible, 1, "and the reading is counted as one that cannot be right");
}

// --- lines this cannot read are counted, never dropped -----------------------------------
{
  const r = readConfirmStartup(
    [
      "not json at all",
      JSON.stringify({ logs: [{ message: [formatLine("confirm-profile", { msg: "x" })] }] }),
      JSON.stringify({
        eventTimestamp: 0,
        logs: [
          {
            timestamp: 100,
            message: [formatLine("confirm-profile", { msg: "x", total_ms: 10 })],
          },
        ],
      }),
      tailLine({ eventTimestamp: 0, logTimestamp: 1_000, totalMs: 400, isolateAgeMs: 90_000 }),
    ].join("\n"),
  )!;
  eq(r.samples, 1, "only the complete one is a sample");
  eq(
    r.unreadable,
    2,
    "a confirm profile missing a timestamp and one missing the isolate age are both counted, " +
      "because a reader told nothing takes the remaining samples for the whole run",
  );
}

// --- a line that is not JSON at all is not a confirm profile -------------------------------
{
  // wrangler prints its own banner before the stream starts. That is noise rather
  // than a reading it failed to make, and counting it as unreadable would put a
  // permanent floor under a number somebody is meant to act on.
  const r = readConfirmStartup(
    [
      "Successfully created tail, expires at 2026-09-14T21:00:00Z",
      tailLine({ eventTimestamp: 0, logTimestamp: 1_000, totalMs: 400, isolateAgeMs: 90_000 }),
    ].join("\n"),
  )!;
  eq(r.unreadable, 0, "a line carrying no confirm profile is not a confirm profile this failed to read");
  eq(r.samples, 1, "and the real one is still read");
}

finish();
