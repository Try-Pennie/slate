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
import { readConfirmStartup, readDeferredSpans } from "./loadtest/confirm-startup.ts";
import { formatLine } from "../src/lib/log.ts";
import { assert, eq, finish } from "./lib/harness.ts";

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
  cpuTime?: number;
  /** #3354: the same invocation's `confirm answered` fields, when it logged that line. */
  answer?: Record<string, number | string>;
  /** #3354: the Worker version that served it, as the tail names it. */
  scriptVersion?: string;
}): string {
  return JSON.stringify({
    ...(opts.scriptVersion ? { scriptVersion: { id: opts.scriptVersion } } : {}),
    cpuTime: opts.cpuTime ?? 400,
    wallTime: opts.logTimestamp - opts.eventTimestamp,
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
      ...(opts.answer
        ? [
            {
              level: "info",
              timestamp: opts.logTimestamp + 5,
              message: [formatLine("booking-api", { msg: "confirm answered", response_ms: 2_000, status: 200, ...opts.answer })],
            },
          ]
        : []),
    ],
    // PRETTY PRINTED, four spaces, exactly as `wrangler tail --format json`
    // writes it. Measured on run 34889873261's own artifact: 1,336 invocations
    // over 179,056 lines. A compact fixture is the one that agreed with the
    // reader's first, wrong, assumption about the shape (L52).
  }, null, 4);
}

/**
 * #3354: one call to the shared line's object, as the tail archives it: its own
 * event, with the runtime's `wallTime` for the call and the object's own log line
 * naming the op, the confirm's trace and the stage, written with the app's formatter.
 */
function objectLine(opts: { eventTimestamp: number; wallTime: number; op: string; trace: string; stage: string }): string {
  return JSON.stringify(
    {
      wallTime: opts.wallTime,
      cpuTime: 0,
      executionModel: "durableObject",
      outcome: "ok",
      entrypoint: "ConfirmLine",
      eventTimestamp: opts.eventTimestamp,
      event: { request: { url: "https://confirm-line/", method: "POST" }, response: { status: 200 } },
      logs: [
        {
          level: "info",
          timestamp: opts.eventTimestamp,
          message: [formatLine("confirm-line-object", { msg: "line call", op: opts.op, trace: opts.trace, stage: opts.stage })],
        },
      ],
    },
    null,
    4,
  );
}

/** An invocation carrying something that is not a confirm profile. */
function otherLine(msg: string): string {
  return JSON.stringify(
    {
      outcome: "ok",
      eventTimestamp: 1_000,
      cpuTime: 12,
      wallTime: 10,
      logs: [{ level: "info", timestamp: 1_010, message: [formatLine("recompute", { msg })] }],
    },
    null,
    4,
  );
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

// --- a half written line is COUNTED, never skipped in silence ---------------------------
{
  // Not hypothetical. The archive is written by
  // `timeout 15m npx wrangler tail ... > results/tail.jsonl`, so a stream killed on
  // that timeout leaves its last line half written. Skipping it would drop a
  // reading and say nothing, and a reader would take the samples it did read for
  // the whole run (L10, L11).
  const good = tailLine({
    eventTimestamp: 0,
    logTimestamp: 1_000,
    totalMs: 400,
    isolateAgeMs: 90_000,
  });
  const r = readConfirmStartup([good, good.slice(0, good.length - 40)].join("\n"))!;
  eq(r.samples, 1, "the complete line is still read");
  eq(r.unparsable, 1, "and the truncated one is counted");
  eq(
    r.unreadable,
    0,
    "under its OWN name, because nothing can say whether a half written line held a confirm " +
      "profile, and the two send a reader somewhere different",
  );
}

// --- a file holding NOTHING but a half written line still says so --------------------------
{
  const r = readConfirmStartup("{\"eventTimestamp\": 0, \"logs\": [{\"mess")!;
  eq(r.unparsable, 1, "an archive that is only a truncated line is a reading, not an absence");
  eq(r.samples, 0, "with nothing measured in it");
}

// --- a number too long to be finite is refused, not compared -------------------------------
{
  // The pattern admits a digit string long enough to parse as Infinity, and
  // Infinity compares false against every bound, which lands the reading on the
  // permissive side with nothing raised anywhere (L50).
  const huge = "9".repeat(400);
  const line = JSON.stringify({
    eventTimestamp: 0,
    logs: [
      {
        timestamp: 1_000,
        message: [`slate tag=confirm-profile total_ms=${huge} isolate_age_ms=5`],
      },
    ],
  });
  const r = readConfirmStartup(line)!;
  eq(r.samples, 0, "a reading that cannot be finite is not a sample");
  eq(r.unreadable, 1, "it is a confirm profile this could not read");
}

// --- the shape the real archive actually has (#2340, second pass) ----------------------
{
  // The defect this whole pass exists for. `wrangler tail --format json` PRETTY
  // PRINTS, so the archive is 1,336 invocations over 179,056 lines, and a reader
  // that split on newlines found 1,336 bare opening braces and zero confirms.
  // Every fixture agreed with it, because they were written by the same hand that
  // assumed the shape (L52).
  const pretty = tailLine({
    eventTimestamp: 0,
    logTimestamp: 1_000,
    totalMs: 400,
    isolateAgeMs: 90_000,
  });
  assert(pretty.split("\n").length > 5, "the fixture really is laid out over many lines");
  eq(readConfirmStartup(pretty)!.samples, 1, "and it is read as one confirm");
}

// --- a brace inside a string does not open an object ------------------------------------
{
  // Not hypothetical: every event carries the request URL, and Slate's own log
  // lines carry JSON shaped detail. A scanner blind to strings would split an
  // event in half and read neither.
  const withBraces = JSON.stringify(
    {
      cpuTime: 500,
      wallTime: 1_000,
      eventTimestamp: 0,
      event: { request: { url: "https://x/api/bookings?q={not:json}" } },
      logs: [
        {
          timestamp: 1_000,
          message: [
            formatLine("confirm-profile", {
              msg: "where the confirm spent its wall time",
              detail: 'outcomes {"ok":3}',
              total_ms: 400,
              isolate_age_ms: 90_000,
            }),
          ],
        },
      ],
    },
    null,
    4,
  );
  const r = readConfirmStartup(withBraces)!;
  eq(r.samples, 1, "an event whose strings hold braces is still one event");
  eq(r.unparsable, 0, "and nothing is reported as damaged");
}

// --- a stream killed mid object is counted, not swallowed ---------------------------------
{
  const good = tailLine({
    eventTimestamp: 0,
    logTimestamp: 1_000,
    totalMs: 400,
    isolateAgeMs: 90_000,
  });
  const r = readConfirmStartup(good + "\n" + good.slice(0, good.length - 60))!;
  eq(r.samples, 1, "the complete event is read");
  eq(r.unparsable, 1, "and the half written one is counted rather than swallowed");
}

// --- the runtime's own CPU reading, split the same way -------------------------------------
{
  // The number the CPU bar is about. The analytics API reports it as ONE percentile
  // over every invocation with nothing in it saying which invocations it came from,
  // which is exactly why a run could not tell a slow confirm from a cold isolate.
  const r = readConfirmStartup(
    [
      tailLine({ eventTimestamp: 0, logTimestamp: 5_000, totalMs: 1_000, isolateAgeMs: 100, cpuTime: 2_900 }),
      tailLine({ eventTimestamp: 0, logTimestamp: 900, totalMs: 400, isolateAgeMs: 60_000, cpuTime: 380 }),
    ].join("\n"),
  )!;
  eq(r.coldCpuMs, [2_900], "the cold confirm's own CPU");
  eq(r.warmCpuMs, [380], "and the warm one's, kept apart from it");
}

// --- an archive with no CPU reading gives a SHORTER list, never a zero ----------------------
{
  // A zero would be the cheapest possible confirm and would pull every percentile
  // down, which is a measurement rather than an absent one (L98).
  const noCpu = JSON.stringify(
    {
      eventTimestamp: 0,
      logs: [
        {
          timestamp: 1_000,
          message: [
            formatLine("confirm-profile", {
              msg: "x",
              total_ms: 400,
              isolate_age_ms: 90_000,
            }),
          ],
        },
      ],
    },
    null,
    4,
  );
  const r = readConfirmStartup(noCpu)!;
  eq(r.samples, 1, "the confirm is still a sample");
  eq(r.warmCpuMs, [], "and its missing CPU reading is absent rather than zero");
}

// --- the span #2340 did not know it was measuring -------------------------------------
{
  // That issue computed ONE number, the invocation's wall minus the profile's own
  // total, and read it as the time BEFORE the handler started. It is both sides at
  // once. On run 34889873261's own archive the 32 confirms over two seconds of CPU
  // differ from the 409 under half a second almost entirely on the AFTER side
  // (2,758ms against 258ms), while the BEFORE side is 297ms against 209ms. They
  // are not starting up slowly; their invocations carry on after the booking is
  // written, which on this path is the webhook send deferred by #884.
  const one = JSON.stringify(
    {
      eventTimestamp: 1_000,
      cpuTime: 2_900,
      // Logged at 3,500 and the invocation ran to 8,000: 2,500 of the 4,500 after
      // the line was written.
      wallTime: 7_000,
      logs: [
        {
          timestamp: 3_500,
          message: [
            formatLine("confirm-profile", {
              msg: "x",
              total_ms: 2_000,
              isolate_age_ms: 90_000,
            }),
          ],
        },
      ],
    },
    null,
    4,
  );
  const r = readConfirmStartup(one)!;
  eq(r.preProfileMs, [500], "before the confirm began");
  eq(r.handlerMs, [2_000], "inside it");
  eq(r.afterProfileMs, [4_500], "and everything the invocation did after the line was written");
}

// --- no wall reading gives a SHORTER list, never a zero ----------------------------------
{
  const noWall = JSON.stringify(
    {
      eventTimestamp: 0,
      logs: [
        {
          timestamp: 1_000,
          message: [formatLine("confirm-profile", { msg: "x", total_ms: 400, isolate_age_ms: 9 })],
        },
      ],
    },
    null,
    4,
  );
  const r = readConfirmStartup(noWall)!;
  eq(r.samples, 1, "the confirm is still a sample");
  eq(
    r.afterProfileMs,
    [],
    "and the absent span is absent rather than a zero, which would read as an invocation that " +
      "ended the moment the booking was written",
  );
}

// --- what each DEFERRED job cost, by name (#2353) ------------------------------
//
// Run 34980777198 measured warm confirms at 2.8 to 3.4s of CPU on a 6.5s
// invocation, of which about 3.5s was spent AFTER the response had gone. That span
// was ONE number, inferred by subtracting the confirm's own log line from the
// invocation's wall, so nothing could say whether it was the webhook send or the
// tally beside it. Each deferred job reports its own line now, and this reads them.
//
// WALL, like everything else a Worker can time: `Date.now()` returns the time of
// the LAST I/O and does not advance during execution, and no other timer exists
// (Cloudflare's security model page). Per stage CPU is not obtainable from inside
// a Worker at all, which is why nothing here claims to be it.
{
  const line = (context: string, ms: number, failed = false) =>
    JSON.stringify(
      {
        outcome: "ok",
        eventTimestamp: 0,
        logs: [
          {
            timestamp: 1,
            message: [
              formatLine("after-response-profile", {
                msg: "deferred work finished",
                context,
                ms,
                failed,
              }),
            ],
          },
        ],
      },
      null,
      2,
    );

  const r = readDeferredSpans(
    [line("booking-webhook", 2_400), line("booking-api-tally", 90), line("booking-webhook", 3_100, true)].join("\n"),
  );
  assert(r !== null, "an archive carrying deferred spans is read");
  eq(r!["booking-webhook"]?.calls, 2, "each job is counted under its own name");
  eq(r!["booking-webhook"]?.ms.sort((a, b) => a - b).join(","), "2400,3100", "keeping every reading");
  eq(r!["booking-api-tally"]?.calls, 1, "and a second job is not folded into the first");
  // A job that FAILED still cost the invocation its time, and it is the one
  // somebody profiles, so it counts. It is named separately so a reader is not
  // told a healthy span was expensive when it was a failing one (L11).
  eq(r!["booking-webhook"]?.failed, 1, "a failed job is timed and counted as failed");
}

{
  // An archive with no deferred line at all is NULL, never an empty table: a run
  // whose archive never arrived and a run whose deferred work cost nothing would
  // otherwise render the same (L98).
  eq(readDeferredSpans(""), null, "an empty archive is no reading");
  eq(
    readDeferredSpans(JSON.stringify({ eventTimestamp: 0, logs: [{ timestamp: 1, message: ["slate tag=recompute msg=\"cycle\""] }] })),
    null,
    "and so is one carrying no deferred line",
  );
}

{
  // A line whose `ms` cannot be read is COUNTED and contributes no reading, never
  // a zero: a zero is the cheapest possible span and would pull every percentile
  // down while looking like a measurement (L50).
  const bad = JSON.stringify({
    eventTimestamp: 0,
    logs: [{ timestamp: 1, message: [`slate tag=after-response-profile context=booking-webhook ms=lots`] }],
  });
  const r = readDeferredSpans(bad);
  eq(r?.["booking-webhook"]?.calls, 1, "a deferred line with no readable time is still a job");
  eq(r?.["booking-webhook"]?.ms.length, 0, "contributing no reading rather than a zero");
  eq(r?.["booking-webhook"]?.unreadable, 1, "and counted, so a thin sample is not read as a cheap one");
}

// --- #3354: the wait before the profile, split by the confirm's own marks -----------
// Read from the `confirm answered` line of the SAME invocation as the profile, so a
// span and the cold or warm call it is filed under describe one request (L420).
{
  const spans = { wait_route_ms: 400, wait_auth_ms: 150, wait_pre_line_ms: 5, wait_line_ms: 300, wait_decide_ms: 200, wait_to_profile_ms: 10, wait_total_ms: 1_065 };
  const archive = [
    // Cold: the module is no older than the time since the invocation began, and the
    // Worker counted it as the isolate's first request.
    tailLine({ eventTimestamp: 0, logTimestamp: 2_000, totalMs: 900, isolateAgeMs: 1_000, answer: { ...spans, isolate_invocation_index: 0 } }),
    // Warm, and the isolate's eighth request.
    tailLine({ eventTimestamp: 10_000, logTimestamp: 11_000, totalMs: 800, isolateAgeMs: 60_000, answer: { wait_auth_ms: 90, wait_line_ms: 120, isolate_invocation_index: 7 } }),
    // A profile whose invocation logged no answer line: counted, contributing nothing.
    tailLine({ eventTimestamp: 20_000, logTimestamp: 21_000, totalMs: 800, isolateAgeMs: 60_000 }),
  ].join("\n");
  const r = readConfirmStartup(archive)!;
  eq(r.samples, 3, "every profile is still a sample");
  eq(r.markedSamples, 2, "two of them carried an answer line with marks or an invocation index");
  eq(r.waitSpans.cold.wait_auth_ms?.join(","), "150", "a cold confirm's auth span is filed under cold");
  eq(r.waitSpans.cold.wait_line_ms?.join(","), "300", "and so is its line span");
  eq(r.waitSpans.warm.wait_auth_ms?.join(","), "90", "a warm confirm's under warm");
  eq(r.waitSpans.warm.wait_decide_ms, undefined, "a span a confirm did not carry contributes nothing, never a zero (L90)");
  eq(r.firstRequests, 1, "one confirm was its isolate's first request by the Worker's count");
  eq(r.invocationIndexKnown, 2, "and the invocation index was known on two");
  eq(r.firstRequestsReadWarm, 0, "and the module stamp agreed it was cold");
}

{
  // A confirm the Worker counted as its isolate's FIRST request cannot have found the
  // confirm module already evaluated. If the module stamp calls it warm anyway, the
  // cold population the bar judges is missing it, which has to be said (L457).
  const archive = tailLine({ eventTimestamp: 0, logTimestamp: 1_500, totalMs: 900, isolateAgeMs: 90_000, answer: { isolate_invocation_index: 0 } });
  const r = readConfirmStartup(archive)!;
  eq(r.cold, 0, "the module stamp reads it as warm");
  eq(r.firstRequests, 1, "while the Worker counted it as the first request");
  eq(r.firstRequestsReadWarm, 1, "and the disagreement is counted");
}

{
  // An answer line with an unreadable span or invocation index contributes nothing for it.
  const archive = tailLine({ eventTimestamp: 0, logTimestamp: 1_500, totalMs: 900, isolateAgeMs: 1_000, answer: { wait_auth_ms: "soon", isolate_invocation_index: "first" } });
  const r = readConfirmStartup(archive)!;
  eq(r.waitSpans.cold.wait_auth_ms, undefined, "an unreadable span is no reading (L50)");
  eq(r.invocationIndexKnown, 0, "and an unreadable invocation index is not known");
}


// --- #3354: the line's wait, split by the object's own log of each call ------------
// A confirm's `wait_line_ms` is its client's view. The object logs every traced call
// with the runtime's `wallTime`, so the wait splits into the time held behind a
// leader (polls), the object's own work on the other calls sent while waiting, and
// what is left: everything outside the object. Calls sent during the turn are not
// part of the wait and are left out.
{
  const archive = [
    objectLine({ eventTimestamp: 100, wallTime: 30, op: "enter", trace: "tc", stage: "wait" }),
    objectLine({ eventTimestamp: 200, wallTime: 500, op: "poll", trace: "tc", stage: "wait" }),
    objectLine({ eventTimestamp: 700, wallTime: 200, op: "poll", trace: "tc", stage: "wait" }),
    objectLine({ eventTimestamp: 900, wallTime: 20, op: "ack", trace: "tc", stage: "wait" }),
    objectLine({ eventTimestamp: 1_200, wallTime: 15, op: "done", trace: "tc", stage: "turn" }),
    tailLine({ eventTimestamp: 0, logTimestamp: 2_000, totalMs: 900, isolateAgeMs: 1_000, answer: { line: "shared", line_trace: "tc", wait_line_ms: 900 } }),
    tailLine({ eventTimestamp: 10_000, logTimestamp: 11_000, totalMs: 800, isolateAgeMs: 60_000, answer: { line: "shared", line_trace: "tw", wait_line_ms: 100 } }),
    objectLine({ eventTimestamp: 10_010, wallTime: 10, op: "enter", trace: "tw", stage: "wait" }),
    objectLine({ eventTimestamp: 10_030, wallTime: 5, op: "ack", trace: "tw", stage: "wait" }),
  ].join("\n");
  const r = readConfirmStartup(archive)!;
  const c = r.lineSplit.cold;
  eq(c.traced, 1, "one cold confirm was traced on the shared line");
  eq(c.joined, 1, "and its object calls were found");
  eq(c.heldMs.join(","), "700", "held behind a leader is its polls' time in the object");
  eq(c.objectMs.join(","), "50", "the object's own work is the rest of what it spent on calls sent while waiting");
  eq(c.outsideMs.join(","), "150", "and outside the object is whatever of the wait the object did not account for");
  const w = r.lineSplit.warm;
  eq(`${w.joined} ${w.heldMs.join(",")} ${w.objectMs.join(",")} ${w.outsideMs.join(",")}`, "1 0 15 85", "a confirm that never polled held for zero, measured, since its calls were found");
  eq(r.lineSplit.orphanCalls, 0, "every object call belonged to a confirm in the archive");
}

{
  // A traced shared confirm whose calls never reached the archive is MISSING, never a
  // zero split (L98); a confirm on its isolate's own line calls no object and is not
  // traced on it at all; an object call whose confirm is not in the archive is counted;
  // and an object that accounts for more than the whole wait is an impossible reading.
  const archive = [
    tailLine({ eventTimestamp: 0, logTimestamp: 2_000, totalMs: 900, isolateAgeMs: 1_000, answer: { line: "shared", line_trace: "lost", wait_line_ms: 400 } }),
    tailLine({ eventTimestamp: 3_000, logTimestamp: 5_000, totalMs: 900, isolateAgeMs: 1_000, answer: { line: "isolate", line_trace: "own", wait_line_ms: 4 } }),
    tailLine({ eventTimestamp: 6_000, logTimestamp: 8_000, totalMs: 900, isolateAgeMs: 1_000, answer: { line: "shared", line_trace: "over", wait_line_ms: 50 } }),
    objectLine({ eventTimestamp: 6_010, wallTime: 80, op: "enter", trace: "over", stage: "wait" }),
    objectLine({ eventTimestamp: 9_000, wallTime: 10, op: "enter", trace: "nobody", stage: "wait" }),
  ].join("\n");
  const r = readConfirmStartup(archive)!;
  const c = r.lineSplit.cold;
  eq(c.traced, 2, "only the shared line's confirms are traced on it");
  eq(c.missing, 1, "the confirm whose calls never arrived is missing");
  eq(c.impossible, 1, "the one the object over accounts for is impossible");
  eq(c.joined, 0, "neither is a reading");
  eq(c.heldMs.length + c.objectMs.length + c.outsideMs.length, 0, "and neither contributes a number");
  eq(r.lineSplit.orphanCalls, 1, "the call whose confirm is not in the archive is counted");
}

{
  // A call the archive carried with no wall time cannot be apportioned: counted as
  // unreadable, apart from a missing one, and contributing no number.
  const noWall = JSON.parse(objectLine({ eventTimestamp: 10, wallTime: 0, op: "enter", trace: "nw", stage: "wait" })) as Record<string, unknown>;
  delete noWall.wallTime;
  const archive = [
    tailLine({ eventTimestamp: 0, logTimestamp: 2_000, totalMs: 900, isolateAgeMs: 1_000, answer: { line: "shared", line_trace: "nw", wait_line_ms: 400 } }),
    JSON.stringify(noWall, null, 4),
  ].join("\n");
  const c = readConfirmStartup(archive)!.lineSplit.cold;
  eq(`${c.traced} ${c.unreadable} ${c.missing} ${c.joined}`, "1 1 0 0", "a call with no wall time makes the confirm unreadable, never missing and never a reading");
}

// --- #3354: the wait before the profile, by script version and by leg -----------------
// A run's cold confirms come from different places: a fresh deploy's first requests, the
// burst's crowd, the fault leg's redeploy. Split both ways so a reader can see which.
{
  const archive = [
    tailLine({ eventTimestamp: 0, logTimestamp: 2_000, totalMs: 900, isolateAgeMs: 1_000, scriptVersion: "v1", answer: { loadtest_leg: "burst" } }),
    tailLine({ eventTimestamp: 3_000, logTimestamp: 5_500, totalMs: 900, isolateAgeMs: 1_000, scriptVersion: "v2", answer: { loadtest_leg: "fault" } }),
    tailLine({ eventTimestamp: 10_000, logTimestamp: 11_000, totalMs: 800, isolateAgeMs: 60_000, scriptVersion: "v1", answer: { loadtest_leg: "steady" } }),
    tailLine({ eventTimestamp: 20_000, logTimestamp: 21_000, totalMs: 800, isolateAgeMs: 60_000 }),
  ].join("\n");
  const r = readConfirmStartup(archive)!;
  eq(r.byVersion.v1?.cold.join(","), "1100", "a cold confirm on v1 is filed under v1");
  eq(r.byVersion.v2?.cold.join(","), "1600", "and one on v2 under v2");
  eq(r.byVersion.v1?.warm.join(","), "200", "a warm one beside it");
  eq(r.byVersion.unknown?.warm.join(","), "200", "a confirm whose event named no version is filed as unknown, never dropped");
  eq(r.byLeg.burst?.cold.join(","), "1100", "the burst's cold confirm under burst");
  eq(r.byLeg.fault?.cold.join(","), "1600", "the fault leg's under fault");
  eq(r.byLeg.steady?.warm.join(","), "200", "the steady pass's under steady");
  eq(r.byLeg.none?.warm.join(","), "200", "and one that named no leg under none");
}

finish();
