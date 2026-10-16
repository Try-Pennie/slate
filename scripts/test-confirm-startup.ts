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
//     picked off a histogram (L203). Since #3418 that measurement is the Worker's
//     own count of how many times the isolate had run the app before this request
//     (`isolate_invocation_index`, 0 for its first). The module stamp it replaced
//     also called a confirm cold when it was the first CONFIRM on an isolate that
//     had already run the app, which loads the confirm's code without the isolate
//     starting: run 37520312761 counted 8 cold by the stamp and 4 by the Worker.
//     The stamp is kept only to name where the two disagree.
//   - a reading it could not make is reported as one, never folded into the
//     numbers as a zero (L98). A confirm with no readable invocation index is on
//     NEITHER side, and counted as such.
//
// Run: node --experimental-strip-types scripts/test-confirm-startup.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readConfirmStartup, readLineTailFile, readDeferredSpans, UNAWAITED_LINE_OPS } from "./loadtest/confirm-startup.ts";
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
  /** Null for an event that carried no `eventTimestamp` at all (#3436). */
  eventTimestamp: number | null;
  logTimestamp: number;
  totalMs: number;
  isolateAgeMs: number;
  cpuTime?: number;
  /** #3354: the same invocation's `confirm answered` fields, when it logged that line. */
  answer?: Record<string, number | string>;
  /**
   * #3418: how many times the isolate had run the app before this request, written on
   * the answer line as the route writes it. Given, the invocation logs an answer line
   * even with no other `answer` field; absent, the index is not on the line at all.
   */
  index?: number;
  /** #3354: the Worker version that served it, as the tail names it. */
  scriptVersion?: string;
}): string {
  const answer =
    opts.answer !== undefined || opts.index !== undefined
      ? { ...(opts.answer ?? {}), ...(opts.index !== undefined ? { isolate_invocation_index: opts.index } : {}) }
      : undefined;
  return JSON.stringify({
    ...(opts.scriptVersion ? { scriptVersion: { id: opts.scriptVersion } } : {}),
    cpuTime: opts.cpuTime ?? 400,
    ...(opts.eventTimestamp !== null ? { wallTime: opts.logTimestamp - opts.eventTimestamp } : {}),
    outcome: "ok",
    ...(opts.eventTimestamp !== null ? { eventTimestamp: opts.eventTimestamp } : {}),
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
      ...(answer
        ? [
            {
              level: "info",
              timestamp: opts.logTimestamp + 5,
              message: [formatLine("booking-api", { msg: "confirm answered", response_ms: 2_000, status: 200, ...answer })],
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
    tailLine({ eventTimestamp: 1_000, logTimestamp: 2_500, totalMs: 900, isolateAgeMs: 120_000, index: 4 }),
  )!;
  eq(r.samples, 1, "one confirm was read");
  eq(r.handlerMs, [900], "the handler's own wall time comes from the profile");
  eq(r.preProfileMs, [600], "and what came before it is the invocation's wall minus that");
  eq(r.cold, 0, "an isolate that had run the app four times before was not started by this request");
  eq(r.warm, 1, "so the confirm is counted warm");
  eq(r.warmPreProfileMs, [600], "and the reading is a warm one");
  eq(r.coldPreProfileMs, [], "with nothing on the cold side");
}

// --- cold is the Worker's own count, not a threshold (#3418) ------------------------------
{
  // The invocation began 3,100ms before the confirm started, and the Worker counted
  // it as the isolate's FIRST run of the app: this request started the isolate.
  const cold = readConfirmStartup(
    tailLine({ eventTimestamp: 0, logTimestamp: 4_400, totalMs: 1_300, isolateAgeMs: 200, index: 0 }),
  )!;
  eq(cold.cold, 1, "the isolate's first request is cold");
  eq(cold.coldPreProfileMs, [3_100], "and its startup is reported on its own");
  eq(cold.warmPreProfileMs, [], "and not mixed into the warm ones");

  // The same durations, and the same module stamp, on an isolate that had already run
  // the app once. Nothing about the DURATIONS decides the side; the count does, which
  // is the point of measuring rather than thresholding.
  const warm = readConfirmStartup(
    tailLine({ eventTimestamp: 0, logTimestamp: 4_400, totalMs: 1_300, isolateAgeMs: 200, index: 1 }),
  )!;
  eq(warm.cold, 0, "an isolate that had already run the app was not started by this request");
  eq(warm.warmPreProfileMs, [3_100], "so the same 3,100ms is a warm reading");
}

// --- the module stamp's boundary, which now decides only a disagreement count ---------------
{
  // The stamp reads the confirm's code as evaluated inside this request exactly when it
  // is no older than the time since the invocation began. At the boundary that is
  // still inside, so on an isolate already running it is a disagreement to name.
  const exactly = readConfirmStartup(
    tailLine({ eventTimestamp: 0, logTimestamp: 1_500, totalMs: 500, isolateAgeMs: 1_000, index: 2 }),
  )!;
  eq(exactly.cold, 0, "the Worker's count says the isolate was already running");
  eq(
    exactly.stampColdNotFirst,
    1,
    "and an age exactly equal to the time since the invocation began is the stamp reading the " +
      "confirm's code as loaded inside this request, which is named as the stamp disagreeing",
  );
}

// --- several invocations, kept apart ----------------------------------------------------
{
  const r = readConfirmStartup(
    [
      otherLine("cycle"),
      tailLine({ eventTimestamp: 0, logTimestamp: 5_000, totalMs: 1_000, isolateAgeMs: 100, index: 0 }),
      tailLine({ eventTimestamp: 0, logTimestamp: 900, totalMs: 400, isolateAgeMs: 60_000, index: 6 }),
      tailLine({ eventTimestamp: 0, logTimestamp: 950, totalMs: 450, isolateAgeMs: 60_000, index: 9 }),
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
      tailLine({ eventTimestamp: 0, logTimestamp: 5_000, totalMs: 1_000, isolateAgeMs: 100, cpuTime: 2_900, index: 0 }),
      tailLine({ eventTimestamp: 0, logTimestamp: 900, totalMs: 400, isolateAgeMs: 60_000, cpuTime: 380, index: 5 }),
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
        // The invocation index puts it on the warm side, so the empty list below is the
        // CPU reading being absent, not the confirm being on neither side.
        { timestamp: 1_005, message: [formatLine("booking-api", { msg: "confirm answered", status: 200, isolate_invocation_index: 3 })] },
      ],
    },
    null,
    4,
  );
  const r = readConfirmStartup(noCpu)!;
  eq(r.samples, 1, "the confirm is still a sample");
  eq(r.warm, 1, "on the warm side");
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
  eq(`${r.cold} ${r.warm} ${r.indexUnknown}`, "1 1 1", "one first request, one warm, and the profile with no answer line on neither side");
  eq(r.stampColdNotFirst + r.stampWarmFirst, 0, "and the module stamp agreed with the Worker on both it could judge");
}

{
  // An answer line with an unreadable span or invocation index contributes nothing for it.
  const archive = tailLine({ eventTimestamp: 0, logTimestamp: 1_500, totalMs: 900, isolateAgeMs: 1_000, answer: { wait_auth_ms: "soon", isolate_invocation_index: "first" } });
  const r = readConfirmStartup(archive)!;
  eq(r.waitSpans.cold.wait_auth_ms, undefined, "an unreadable span is no reading (L50)");
  eq(r.indexUnknown, 1, "and an unreadable invocation index is not known");
}

// --- #3418: cold is the Worker's own count, and where the stamp disagrees is named ----------
// Run 37520312761's report counted a fresh server's first confirms two ways: 8 "the first
// on their isolate" by the module stamp, and 4 "their isolate's first request" by the
// Worker's invocation index. The startup bar judged the 8. These are those 8 confirms,
// every figure copied from that run's archived tail (artifact 11443066359): when the
// invocation began, when the profile was logged, the profile's own total, the module's
// age, the Worker's count and the marks' whole span.
//
// The four the Worker counted 1, 1, 2 and 1 had NO gap between the invocation starting
// and the Worker's handler being entered (their `wait_total_ms` equals the whole wait),
// while the four it counted 0 waited 585 to 1,021ms there: the isolate starting. Across
// all 518 confirms the Worker counted above 0 that gap was never over 2ms. So the four
// were the first CONFIRM on an isolate that had already run the app, loading the
// confirm's code inside the request without the isolate starting, and are warm.
const RUN_37520312761_STAMP_COLD = [
  { eventTimestamp: 1_791_317_165_528, logOffset: 7_437, totalMs: 4_954, isolateAgeMs: 2_483, index: 1, wholeMs: 2_483 },
  { eventTimestamp: 1_791_317_172_484, logOffset: 4_545, totalMs: 3_438, isolateAgeMs: 1_107, index: 1, wholeMs: 1_107 },
  { eventTimestamp: 1_791_317_225_009, logOffset: 4_493, totalMs: 3_634, isolateAgeMs: 859, index: 2, wholeMs: 859 },
  { eventTimestamp: 1_791_317_361_194, logOffset: 3_158, totalMs: 2_037, isolateAgeMs: 510, index: 0, wholeMs: 510 },
  { eventTimestamp: 1_791_317_449_032, logOffset: 3_309, totalMs: 1_827, isolateAgeMs: 897, index: 0, wholeMs: 897 },
  { eventTimestamp: 1_791_317_576_423, logOffset: 5_195, totalMs: 3_693, isolateAgeMs: 864, index: 0, wholeMs: 864 },
  { eventTimestamp: 1_791_317_932_424, logOffset: 7_993, totalMs: 5_192, isolateAgeMs: 1_780, index: 0, wholeMs: 1_780 },
  { eventTimestamp: 1_791_317_943_164, logOffset: 5_561, totalMs: 4_483, isolateAgeMs: 1_078, index: 1, wholeMs: 1_078 },
];
{
  const archive = [
    ...RUN_37520312761_STAMP_COLD.map((c) =>
      tailLine({
        eventTimestamp: c.eventTimestamp,
        logTimestamp: c.eventTimestamp + c.logOffset,
        totalMs: c.totalMs,
        isolateAgeMs: c.isolateAgeMs,
        index: c.index,
        answer: { wait_total_ms: c.wholeMs },
      }),
    ),
    // And one ordinary warm confirm from the same run, at its warm median.
    tailLine({ eventTimestamp: 1_791_317_500_000, logTimestamp: 1_791_317_504_000, totalMs: 2_336, isolateAgeMs: 600_000, index: 37, answer: { wait_total_ms: 1_664 } }),
  ].join("\n");
  const r = readConfirmStartup(archive)!;
  // Positive control: the stamp still reads all eight as cold, so the fixture holds the
  // disagreement the report printed rather than a set where the two happen to agree.
  eq(r.cold - r.stampWarmFirst + r.stampColdNotFirst, 8, "control: the module stamp reads the 8 as cold, as the report's wall time line did");
  eq(r.cold, 4, "only the 4 the Worker counted as their isolate's first run of the app are cold");
  eq([...r.coldPreProfileMs].sort((a, b) => a - b).join(","), "1121,1482,1502,2801", "and the cold waits are theirs");
  eq(r.stampColdNotFirst, 4, "the 4 the stamp alone called cold are counted as the stamp disagreeing");
  eq(r.warm, 5, "and they are warm, beside the ordinary warm confirm");
  eq(
    [...r.warmPreProfileMs].sort((a, b) => a - b).join(","),
    "859,1078,1107,1664,2483",
    "with their waits on the warm side",
  );
  eq(r.indexUnknown, 0, "every one carried the Worker's count");
  eq(r.samples, r.cold + r.warm + r.indexUnknown, "and every sample is on exactly one side or counted as on neither");
}

// --- #3436: the isolate's own start, from the invocation to the Worker's entry ---------------
// Every span on the report's span line starts at the Worker's entry stamp, so the time
// before it (the runtime starting the invocation, then a fresh isolate evaluating the
// bundle before the fetch handler runs) was in no span. On run 37520312761 it was the
// biggest single piece of the startup bar's miss: cold pre profile p95 2801ms against a
// "whole" p95 of 1780ms.
//
// The entry stamp is now written on the answer line (`wait_entry_at_ms`), and the span is
// measured from the event's own `eventTimestamp` to it. That run predates the field, so
// these are its 8 confirms above with the stamp put where that run's own marks place the
// entry: the profile's start (log time less the profile's total) less the marks' whole
// span, which begins at the entry. Computed here from the copied figures, never typed in,
// so the fixture holds what the run measured (L48): 611, 585, 638 and 1,021ms on the four
// first requests, and 0 on the four the Worker counted above 0, as on all but 6 of that
// run's 518 warm confirms (the other 6 were 1 or 2ms).
function entryStampOf(c: (typeof RUN_37520312761_STAMP_COLD)[number]): number {
  return c.eventTimestamp + c.logOffset - c.totalMs - c.wholeMs;
}
{
  const archive = RUN_37520312761_STAMP_COLD.map((c) =>
    tailLine({
      eventTimestamp: c.eventTimestamp,
      logTimestamp: c.eventTimestamp + c.logOffset,
      totalMs: c.totalMs,
      isolateAgeMs: c.isolateAgeMs,
      index: c.index,
      answer: { wait_total_ms: c.wholeMs, wait_entry_at_ms: entryStampOf(c) },
    }),
  ).join("\n");
  const r = readConfirmStartup(archive)!;
  eq([...r.isolateStart.cold].sort((a, b) => a - b).join(","), "585,611,638,1021", "a first request's isolate start is the gap before the Worker's entry");
  eq(r.isolateStart.warm.join(","), "0,0,0,0", "and a later request on a running isolate has none");
  eq(`${r.isolateStart.unstamped.cold} ${r.isolateStart.unstamped.warm}`, "0 0", "every one carried both stamps");
  // Control: the isolate start and the marks' whole span add up to the wait the bar
  // judges, so the new span is the part the old ones could not see, not a second copy.
  const sum = RUN_37520312761_STAMP_COLD.filter((c) => c.index === 0).map((c) => entryStampOf(c) - c.eventTimestamp + c.wholeMs);
  eq(sum.sort((a, b) => a - b).join(","), [...r.coldPreProfileMs].sort((a, b) => a - b).join(","), "control: isolate start plus the whole span is the cold wait before the profile");
}

{
  // A confirm with no entry stamp (a deployment older than #3436, or a request the
  // Worker did not stamp) is COUNTED on its side and gives no span, never a zero, which
  // would be the fastest isolate start there is and pull every percentile down (L622).
  const real = RUN_37520312761_STAMP_COLD[3]!; // a first request, 611ms before the entry
  const unstamped = readConfirmStartup(
    tailLine({ eventTimestamp: real.eventTimestamp, logTimestamp: real.eventTimestamp + real.logOffset, totalMs: real.totalMs, isolateAgeMs: real.isolateAgeMs, index: 0, answer: { wait_total_ms: real.wholeMs } }),
  )!;
  eq(unstamped.cold, 1, "it is still a cold confirm");
  eq(unstamped.isolateStart.cold.length, 0, "with no isolate start read");
  eq(unstamped.isolateStart.unstamped.cold, 1, "and counted as carrying no entry stamp");
  // Control: the same confirm with its stamp gives its span, so the fixture is not one
  // the reader could never measure.
  const stamped = readConfirmStartup(
    tailLine({ eventTimestamp: real.eventTimestamp, logTimestamp: real.eventTimestamp + real.logOffset, totalMs: real.totalMs, isolateAgeMs: real.isolateAgeMs, index: 0, answer: { wait_total_ms: real.wholeMs, wait_entry_at_ms: entryStampOf(real) } }),
  )!;
  eq(stamped.isolateStart.cold.join(","), "611", "control: stamped, the span is read");
  eq(stamped.isolateStart.unstamped.cold, 0, "and nothing is counted unstamped");

  // A warm one with no stamp is counted on the warm side, so neither side's count is
  // short of its confirms in silence.
  const warm = RUN_37520312761_STAMP_COLD[0]!;
  const w = readConfirmStartup(
    tailLine({ eventTimestamp: warm.eventTimestamp, logTimestamp: warm.eventTimestamp + warm.logOffset, totalMs: warm.totalMs, isolateAgeMs: warm.isolateAgeMs, index: warm.index, answer: { wait_total_ms: warm.wholeMs, wait_entry_at_ms: "soon" } }),
  )!;
  eq(`${w.isolateStart.unstamped.warm} ${w.isolateStart.warm.length}`, "1 0", "an unreadable stamp on a warm confirm is counted as no stamp, never read (L50)");
}

{
  // A confirm whose event carried no `eventTimestamp` cannot be placed at all: it was
  // never a sample, so it is counted unreadable, and gives no isolate start either.
  const real = RUN_37520312761_STAMP_COLD[6]!; // the 2801ms first request
  const r = readConfirmStartup(
    tailLine({ eventTimestamp: null, logTimestamp: real.eventTimestamp + real.logOffset, totalMs: real.totalMs, isolateAgeMs: real.isolateAgeMs, index: 0, answer: { wait_total_ms: real.wholeMs, wait_entry_at_ms: entryStampOf(real) } }),
  )!;
  eq(r.unreadable, 1, "a confirm with no invocation start is counted as unreadable");
  eq(r.samples, 0, "and is not a sample");
  eq(r.isolateStart.cold.length + r.isolateStart.warm.length, 0, "so no isolate start is read from its entry stamp alone");
}

{
  // An entry stamp EARLIER than the invocation's start is two clocks disagreeing. It is
  // counted rather than read as a negative span or clamped to the most flattering zero.
  const real = RUN_37520312761_STAMP_COLD[4]!;
  const r = readConfirmStartup(
    tailLine({ eventTimestamp: real.eventTimestamp, logTimestamp: real.eventTimestamp + real.logOffset, totalMs: real.totalMs, isolateAgeMs: real.isolateAgeMs, index: 0, answer: { wait_total_ms: real.wholeMs, wait_entry_at_ms: real.eventTimestamp - 5 } }),
  )!;
  eq(r.isolateStart.cold.length, 0, "no span is read from a stamp before the invocation began");
  eq(r.isolateStart.beforeStart.cold, 1, "and it is counted as such");
}

{
  // A confirm on neither side (no invocation index) has no side to file its isolate
  // start under; it is already counted as `indexUnknown`, and is not counted twice.
  const real = RUN_37520312761_STAMP_COLD[3]!;
  const r = readConfirmStartup(
    tailLine({ eventTimestamp: real.eventTimestamp, logTimestamp: real.eventTimestamp + real.logOffset, totalMs: real.totalMs, isolateAgeMs: real.isolateAgeMs, answer: { wait_total_ms: real.wholeMs, wait_entry_at_ms: entryStampOf(real) } }),
  )!;
  eq(r.indexUnknown, 1, "no index, on neither side");
  eq(r.isolateStart.cold.length + r.isolateStart.warm.length + r.isolateStart.unstamped.cold + r.isolateStart.unstamped.warm, 0, "and its isolate start is on neither side either");
}

{
  // A confirm the Worker counted as its isolate's FIRST request is cold even when the
  // module stamp calls it warm: it is the request that started the isolate whatever the
  // stamp read. It is in the cold population, and the disagreement is named (L457).
  const archive = tailLine({ eventTimestamp: 0, logTimestamp: 1_500, totalMs: 900, isolateAgeMs: 90_000, index: 0 });
  const r = readConfirmStartup(archive)!;
  eq(r.cold, 1, "the Worker's first request is cold");
  eq(r.coldPreProfileMs, [600], "and its wait is judged with the cold ones");
  eq(r.stampWarmFirst, 1, "and the stamp reading it warm is counted");
}

{
  // A confirm whose invocation carried no invocation index is on NEITHER side. Filing it
  // by the module stamp instead would put a second definition into the same population
  // (L93), so it is counted, and the stamp reading it cold changes nothing.
  const unknown = readConfirmStartup(tailLine({ eventTimestamp: 0, logTimestamp: 2_000, totalMs: 900, isolateAgeMs: 100 }))!;
  eq(`${unknown.cold} ${unknown.warm} ${unknown.indexUnknown}`, "0 0 1", "no index: neither cold nor warm, and counted");
  eq(unknown.coldPreProfileMs.length + unknown.warmPreProfileMs.length, 0, "contributing to neither side's waits");
  eq(unknown.byVersion.unknown?.unknown.join(","), "1100", "while its wait is still filed, under no side, never dropped");
  // Control: the same confirm with the Worker's count of 0 is cold, so the fixture is
  // not one the reader could never call cold.
  const counted = readConfirmStartup(tailLine({ eventTimestamp: 0, logTimestamp: 2_000, totalMs: 900, isolateAgeMs: 100, index: 0 }))!;
  eq(`${counted.cold} ${counted.indexUnknown}`, "1 0", "control: with an index of 0 it is cold");
}


// --- #3354: the line's wait, split by the object's own log of each call ------------
// A confirm's `wait_line_ms` is its client's view. The object logs every traced call
// with the runtime's `wallTime`, so the wait splits into the time held behind a
// leader (polls), the object's own work on the other calls the confirm waited for,
// and what is left: everything outside the object. Calls sent during the turn are not
// part of the wait and are left out, and so is the lead's ack, which the client sends
// without waiting for it though it is stamped during the wait (#3813).
{
  const archive = [
    objectLine({ eventTimestamp: 100, wallTime: 30, op: "enter", trace: "tc", stage: "wait" }),
    objectLine({ eventTimestamp: 200, wallTime: 500, op: "poll", trace: "tc", stage: "wait" }),
    objectLine({ eventTimestamp: 700, wallTime: 200, op: "poll", trace: "tc", stage: "wait" }),
    objectLine({ eventTimestamp: 900, wallTime: 20, op: "ack", trace: "tc", stage: "wait" }),
    objectLine({ eventTimestamp: 1_200, wallTime: 15, op: "done", trace: "tc", stage: "turn" }),
    tailLine({ eventTimestamp: 0, logTimestamp: 2_000, totalMs: 900, isolateAgeMs: 1_000, index: 0, answer: { line: "shared", line_trace: "tc", wait_line_ms: 900 } }),
    tailLine({ eventTimestamp: 10_000, logTimestamp: 11_000, totalMs: 800, isolateAgeMs: 60_000, index: 6, answer: { line: "shared", line_trace: "tw", wait_line_ms: 100 } }),
    objectLine({ eventTimestamp: 10_010, wallTime: 10, op: "enter", trace: "tw", stage: "wait" }),
    objectLine({ eventTimestamp: 10_030, wallTime: 5, op: "ack", trace: "tw", stage: "wait" }),
  ].join("\n");
  const r = readConfirmStartup(archive)!;
  const c = r.lineSplit.cold;
  eq(c.traced, 1, "one cold confirm was traced on the shared line");
  eq(c.joined, 1, "and its object calls were found");
  eq(c.heldMs.join(","), "700", "held behind a leader is its polls' time in the object");
  // The ack (20) is left out: since #3355 the client sends it without waiting for it.
  eq(c.objectMs.join(","), "30", "the object's own work is the rest of what it spent on calls the confirm waited for");
  eq(c.outsideMs.join(","), "170", "and outside the object is whatever of the wait the object did not account for");
  const w = r.lineSplit.warm;
  eq(`${w.joined} ${w.heldMs.join(",")} ${w.objectMs.join(",")} ${w.outsideMs.join(",")}`, "1 0 10 90", "a confirm that never polled held for zero, measured, since its calls were found (its unawaited ack left out)");
  eq(r.lineSplit.orphanCalls, 0, "every object call belonged to a confirm in the archive");
}

{
  // A traced shared confirm whose calls never reached the archive is MISSING, never a
  // zero split (L98); a confirm on its isolate's own line calls no object and is not
  // traced on it at all; an object call whose confirm is not in the archive is counted;
  // and an object that accounts for more than the whole wait is an impossible reading.
  const archive = [
    tailLine({ eventTimestamp: 0, logTimestamp: 2_000, totalMs: 900, isolateAgeMs: 1_000, index: 0, answer: { line: "shared", line_trace: "lost", wait_line_ms: 400 } }),
    tailLine({ eventTimestamp: 3_000, logTimestamp: 5_000, totalMs: 900, isolateAgeMs: 1_000, index: 0, answer: { line: "isolate", line_trace: "own", wait_line_ms: 4 } }),
    tailLine({ eventTimestamp: 6_000, logTimestamp: 8_000, totalMs: 900, isolateAgeMs: 1_000, index: 0, answer: { line: "shared", line_trace: "over", wait_line_ms: 50 } }),
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
  // A reading scoped to one leg leaves another leg's confirms out, and their object calls
  // with them: those calls belong to a confirm the archive does hold, so counting them
  // as orphans would report a fault in a run that had none.
  const archive = [
    objectLine({ eventTimestamp: 100, wallTime: 30, op: "enter", trace: "tc", stage: "wait" }),
    tailLine({ eventTimestamp: 0, logTimestamp: 2_000, totalMs: 900, isolateAgeMs: 1_000, index: 0, answer: { line: "shared", line_trace: "tc", wait_line_ms: 300, loadtest_leg: "cold" } }),
    objectLine({ eventTimestamp: 5_100, wallTime: 20, op: "enter", trace: "tf", stage: "wait" }),
    objectLine({ eventTimestamp: 5_200, wallTime: 10, op: "ack", trace: "tf", stage: "wait" }),
    tailLine({ eventTimestamp: 5_000, logTimestamp: 7_000, totalMs: 900, isolateAgeMs: 1_000, index: 0, answer: { line: "shared", line_trace: "tf", wait_line_ms: 200, loadtest_leg: "fault" } }),
  ].join("\n");
  const whole = readConfirmStartup(archive)!;
  eq(`${whole.lineSplit.cold.joined} ${whole.lineSplit.orphanCalls}`, "2 0", "control: read whole, both confirms join their calls");
  const cold = readConfirmStartup(archive, { leg: "cold" })!;
  eq(cold.otherLegs, 1, "scoped to the cold leg, the fault confirm is left out");
  eq(cold.lineSplit.cold.joined, 1, "the cold confirm still joins its own calls");
  eq(cold.lineSplit.orphanCalls, 0, "and the fault confirm's calls are left out with it, not counted as orphans");
}

{
  // A call the archive carried with no wall time cannot be apportioned: counted as
  // unreadable, apart from a missing one, and contributing no number.
  const noWall = JSON.parse(objectLine({ eventTimestamp: 10, wallTime: 0, op: "enter", trace: "nw", stage: "wait" })) as Record<string, unknown>;
  delete noWall.wallTime;
  const archive = [
    tailLine({ eventTimestamp: 0, logTimestamp: 2_000, totalMs: 900, isolateAgeMs: 1_000, index: 0, answer: { line: "shared", line_trace: "nw", wait_line_ms: 400 } }),
    JSON.stringify(noWall, null, 4),
  ].join("\n");
  const c = readConfirmStartup(archive)!.lineSplit.cold;
  eq(`${c.traced} ${c.unreadable} ${c.missing} ${c.joined}`, "1 1 0 0", "a call with no wall time makes the confirm unreadable, never missing and never a reading");
}

// --- the lead's ack is not part of the wait ------------------------------------------
// The client sends the ack without waiting for it (`shared-confirm-line.ts`, "not counted
// in lineMs"), stamped while the confirm was still in its wait. Counted as part of the
// wait, its time came out larger than the wait itself: 123 of run 38912230442's 137
// impossible splits were the ack alone.
{
  const archive = [
    tailLine({ eventTimestamp: 0, logTimestamp: 2_000, totalMs: 900, isolateAgeMs: 60_000, index: 4, answer: { line: "shared", line_trace: "ak", wait_line_ms: 11 } }),
    objectLine({ eventTimestamp: 100, wallTime: 6, op: "enter", trace: "ak", stage: "wait" }),
    objectLine({ eventTimestamp: 106, wallTime: 206, op: "ack", trace: "ak", stage: "wait" }),
  ].join("\n");
  const w = readConfirmStartup(archive)!.lineSplit.warm;
  eq(`${w.joined} ${w.impossible}`, "1 0", "an unawaited ack never makes a split impossible");
  eq(`${w.heldMs.join(",")} ${w.objectMs.join(",")} ${w.outsideMs.join(",")}`, "0 6 5", "and its time is left out of the wait");
}
{
  // A confirm whose only archived call is its ack lost the calls it waited for, so it
  // is missing, never a split with nothing held and nothing in the object.
  const archive = [
    tailLine({ eventTimestamp: 0, logTimestamp: 2_000, totalMs: 900, isolateAgeMs: 60_000, index: 4, answer: { line: "shared", line_trace: "ao", wait_line_ms: 40 } }),
    objectLine({ eventTimestamp: 106, wallTime: 206, op: "ack", trace: "ao", stage: "wait" }),
  ].join("\n");
  const w = readConfirmStartup(archive)!.lineSplit.warm;
  eq(`${w.joined} ${w.missing}`, "0 1", "only the ack archived is missing, not a split");
}
{
  // The judge's list of calls the client does not wait for is the client's own: every
  // `void call(stub, { op: ... })` in the shared line, read from its source (L41, L96).
  const src = readFileSync(join(import.meta.dirname, "..", "src", "lib", "booking", "shared-confirm-line.ts"), "utf8");
  const sent = [...src.matchAll(/void call\(stub, \{ op: "(\w+)"/g)].map((m) => m[1]!).sort();
  assert(sent.length > 0, "control: the scan finds the client's unawaited calls");
  eq([...UNAWAITED_LINE_OPS].sort(), sent, "the judge leaves out exactly the calls the client does not wait for");
}

// --- #3781: the object's calls arrive in the LINE Worker's own log ---------------------
// Since #3500 the object runs in its own Worker (`slate-confirm-line-loadtest`), so its
// traced calls are written to THAT Worker's tail and never to the app Worker's. The
// fixtures above put both in one archive, which is the shape the reader assumed and
// the run never produced (L52): run 41 joined 0 of 537 traced confirms.
{
  const appArchive = [
    tailLine({ eventTimestamp: 0, logTimestamp: 2_000, totalMs: 900, isolateAgeMs: 1_000, index: 0, answer: { line: "shared", line_trace: "la", wait_line_ms: 600 } }),
  ].join("\n");
  const lineArchive = [
    objectLine({ eventTimestamp: 100, wallTime: 40, op: "enter", trace: "la", stage: "wait" }),
    objectLine({ eventTimestamp: 200, wallTime: 300, op: "poll", trace: "la", stage: "wait" }),
    "{ not json",
  ].join("\n");
  const without = readConfirmStartup(appArchive)!;
  eq(`${without.lineSplit.cold.missing} ${without.lineSplit.lineLog}`, "1 absent", "control: the app Worker's log alone holds none of the object's calls, and says the line log was absent");
  const r = readConfirmStartup(appArchive, { lineArchive })!;
  const c = r.lineSplit.cold;
  eq(`${c.traced} ${c.joined} ${c.missing}`, "1 1 0", "read beside the line Worker's log, the confirm joins its calls");
  eq(`${c.heldMs.join(",")} ${c.objectMs.join(",")} ${c.outsideMs.join(",")}`, "300 40 260", "and its wait splits from them");
  eq(r.lineSplit.lineLog, "read", "the line log is named as read");
  eq(r.lineSplit.lineUnparsable, 1, "an unreadable line in the line Worker's log is counted there");
  eq(r.unparsable, 0, "and never charged to the app Worker's archive, whose own count it would misstate (L11)");
  eq(r.samples, 1, "the line Worker's log adds no confirm samples");
}

{
  // #3781: the archive step creates `line-tail.jsonl` before the tail connects, so an
  // EMPTY file is a tail that caught nothing, which is not a log that was read (L98).
  const appArchive = tailLine({ eventTimestamp: 0, logTimestamp: 2_000, totalMs: 900, isolateAgeMs: 1_000, index: 0, answer: { line: "shared", line_trace: "le", wait_line_ms: 600 } });
  eq(readConfirmStartup(appArchive, { lineArchive: "" })!.lineSplit.lineLog, "empty", "an empty line log is named as empty, never as read");
  eq(readConfirmStartup(appArchive, { lineArchive: "{ half" })!.lineSplit.lineLog, "empty", "and so is one holding only unreadable lines");
  eq(readConfirmStartup(appArchive, { lineArchive: null })!.lineSplit.lineLog, "unreadable", "a file that was there and could not be read is unreadable, never absent (L11)");
}

{
  // #3781: how the judge reads `line-tail.jsonl`. A file that never arrived is
  // undefined, one that is there and could not be read is null, and they are told
  // apart so the report never says "not archived" about a file that was (L11).
  const notes: string[] = [];
  const refusedWith = (code: string) => () => {
    throw Object.assign(new Error(`${code}: boom`), { code });
  };
  eq(readLineTailFile(() => "{}\n", (n) => notes.push(n)), "{}\n", "a readable file is its text");
  eq(readLineTailFile(refusedWith("ENOENT"), (n) => notes.push(n)), undefined, "a file that never arrived is undefined");
  eq(notes.length, 0, "and says nothing, since absent is a state the report names");
  eq(readLineTailFile(refusedWith("EISDIR"), (n) => notes.push(n)), null, "a file that could not be read is null, never undefined");
  assert(notes.length === 1 && notes[0]!.includes("EISDIR"), `and its cause is printed (got ${JSON.stringify(notes)})`);
}

// --- #3354: the wait before the profile, by script version and by leg -----------------
// A run's cold confirms come from different places: a fresh deploy's first requests, the
// burst's crowd, the fault leg's redeploy. Split both ways so a reader can see which.
{
  const archive = [
    tailLine({ eventTimestamp: 0, logTimestamp: 2_000, totalMs: 900, isolateAgeMs: 1_000, scriptVersion: "v1", index: 0, answer: { loadtest_leg: "burst" } }),
    tailLine({ eventTimestamp: 3_000, logTimestamp: 5_500, totalMs: 900, isolateAgeMs: 1_000, scriptVersion: "v2", index: 0, answer: { loadtest_leg: "fault" } }),
    tailLine({ eventTimestamp: 10_000, logTimestamp: 11_000, totalMs: 800, isolateAgeMs: 60_000, scriptVersion: "v1", index: 6, answer: { loadtest_leg: "steady" } }),
    tailLine({ eventTimestamp: 20_000, logTimestamp: 21_000, totalMs: 800, isolateAgeMs: 60_000, index: 3 }),
    // #3418: no answer line at all, so no invocation index: filed under neither side.
    tailLine({ eventTimestamp: 30_000, logTimestamp: 31_500, totalMs: 800, isolateAgeMs: 60_000 }),
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
  eq(r.byLeg.none?.unknown.join(","), "700", "a confirm with no invocation index is filed under neither side, never dropped");
}

{
  // #3418: a traced confirm with no invocation index is on neither side of the line's
  // split, and its object calls still belong to a confirm the archive holds, so they are
  // not counted as orphans of one it does not.
  const archive = [
    objectLine({ eventTimestamp: 100, wallTime: 30, op: "enter", trace: "nx", stage: "wait" }),
    tailLine({ eventTimestamp: 0, logTimestamp: 2_000, totalMs: 900, isolateAgeMs: 1_000, answer: { line: "shared", line_trace: "nx", wait_line_ms: 300 } }),
  ].join("\n");
  const r = readConfirmStartup(archive)!;
  eq(r.lineSplit.cold.traced + r.lineSplit.warm.traced, 0, "split on neither side");
  eq(r.lineSplit.orphanCalls, 0, "and its calls are not orphans");
}

finish();
