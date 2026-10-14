// Where the judge learns that a cron fired during a load run (#2352).
//
// WHY. `scripts/loadtest/platform-reading.ts` read the cron half from
// `workersInvocationsScheduled` filtered on the load test script name. Measured
// live on 2026-09-15 over 13:20 to 14:05 UTC, that dataset held 61 rows for
// `slate` (production) and ZERO for `slate-loadtest`, while the same Worker's
// ticks were plainly running: `lane_heartbeats` on the branch advanced every
// minute from 13:58, and the run's own archived log held 19 scheduled invocations
// at about 27 seconds of CPU each.
//
// So on a load run that dataset has never once reported a scheduled invocation,
// the cron half of the CPU bar has never measured anything, and the judge wrote
// "with no cron in the window" into a report as a fact about the deployment when
// it was a fact about the read (L98: finding nothing and being unable to look read
// the same).
//
// The run ALREADY archives the answer. `wrangler tail` records every scheduled
// invocation with the cron expression that fired it and the runtime's own
// `cpuTime`, which is better evidence than the analytics dataset ever was: one row
// per invocation rather than a percentile. So the archive is read as a second
// source, and the two are reconciled, and a platform ZERO the archive contradicts
// is a reader fault with its own message rather than an empty window.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-loadtest-scheduled-source.ts
import {
  readScheduledFromArchive,
  reconcileScheduled,
  type ScheduledReading,
} from "./loadtest/platform-reading.ts";
import { LOADTEST_PLACED_ORIGIN } from "../worker/lane-run.ts";
import { assert, eq, finish } from "./lib/harness.ts";

/** One `wrangler tail --format json` event, PRETTY PRINTED the way the real file is. */
function tailEvent(body: Record<string, unknown>): string {
  return JSON.stringify(body, null, 2) + "\n";
}

function scheduled(cron: string, cpuMs: number, at = 1_757_000_000_000): string {
  return tailEvent({
    outcome: "ok",
    scriptName: "slate-loadtest",
    eventTimestamp: at,
    event: { cron, scheduledTime: at },
    logs: [],
    exceptions: [],
    cpuTime: cpuMs,
    wallTime: cpuMs + 100,
  });
}

function request(at = 1_757_000_000_000): string {
  return tailEvent({
    outcome: "ok",
    scriptName: "slate-loadtest",
    eventTimestamp: at,
    event: { request: { url: "https://slate-loadtest.workers.dev/api/bookings?a={b}", method: "POST" } },
    logs: [{ timestamp: at + 10, message: "slate tag=booking-api msg=\"confirmed\"" }],
    exceptions: [],
    cpuTime: 400,
    wallTime: 900,
  });
}

// --- the archive is read, and an archive with nothing in it is NOT a zero ------

{
  const archive = [scheduled("* * * * *", 27_000), request(), scheduled("*/15 * * * *", 4_000), scheduled("* * * * *", 31_500)].join("");
  const r = readScheduledFromArchive(archive);
  assert(r !== null, "an archive holding scheduled invocations is read");
  eq(r!.invocations, 3, "counting only the scheduled ones, never the requests beside them");
  eq(r!.worstCpuMs, 31_500, "the worst CPU is the worst of them");
  eq(r!.byCron["* * * * *"]?.invocations, 2, "each cron expression keeps its own count");
  eq(r!.byCron["*/15 * * * *"]?.worstCpuMs, 4_000, "and its own worst, so a finding can NAME the lane");
}

{
  // An archive that HELD events and none of them scheduled is a real reading of
  // zero. An archive that is not there at all is not a reading, and the two must
  // never render the same (L98).
  const none = readScheduledFromArchive([request(), request()].join(""));
  assert(none !== null, "an archive holding only requests is still a reading");
  eq(none!.invocations, 0, "of zero scheduled invocations");
  eq(readScheduledFromArchive(""), null, "and an empty archive is no reading at all");
  eq(readScheduledFromArchive("   \n  "), null, "nor is one holding no object");
}

{
  // The stream is written under `timeout 15m npx wrangler tail`, so its last event
  // is routinely half written. What was read still counts; the half written one
  // does not become a phantom tick.
  const truncated = scheduled("* * * * *", 27_000) + scheduled("* * * * *", 9_000).slice(0, 60);
  const r = readScheduledFromArchive(truncated);
  eq(r?.invocations, 1, "a stream killed mid event still reports the ticks it did capture");
}

{
  // A tick whose CPU field cannot be read still COUNTS as a tick, because the count
  // is what decides whether the window may be called empty. It contributes nothing
  // to the maximum, and it is counted out loud: folding it in as a zero would be
  // the permissive side of the CPU bar with nothing saying so (L50).
  const archive = [
    scheduled("* * * * *", 27_000),
    tailEvent({ eventTimestamp: 1, event: { cron: "* * * * *" }, cpuTime: "lots" }),
  ].join("");
  const r = readScheduledFromArchive(archive);
  eq(r?.invocations, 2, "a tick with no readable CPU is still a tick");
  eq(r?.worstCpuMs, 27_000, "and does not pull the worst CPU down to a zero it never measured");
  eq(r?.unreadableCpu, 1, "and is counted, so a maximum over unread ticks is not read as a low one");
}

{
  // A cron expression is a string. A tick carrying something else in that field is
  // not counted as a tick, because inventing one would put a floor under a count
  // the judge decides from.
  const odd = tailEvent({ eventTimestamp: 1, event: { cron: 7 }, cpuTime: 100 });
  eq(readScheduledFromArchive(odd)?.invocations, 0, "an unreadable cron field is not a scheduled tick");
}

// --- placed lanes (#3693) -------------------------------------------------------
//
// Since #3693 a tick sends each lane over the Worker's binding to itself, so the lane's
// CPU is spent in a FETCH invocation and the scheduled one holds only the dispatcher.
// Read from scheduled events alone, the cron half would pass on the dispatcher's
// few hundred milliseconds while a lane burned a minute.

function tickWithTimings(cron: string, cpuMs: number, lanesPlaced: number, at = 1_757_000_000_000): string {
  return tailEvent({
    outcome: "ok",
    scriptName: "slate-loadtest",
    eventTimestamp: at,
    event: { cron, scheduledTime: at },
    logs: [
      {
        timestamp: at + 5,
        message: [`slate tag=cron msg="lane timings" cron="${cron}" total_ms=900 lanes_ok=${lanesPlaced} lanes_failed=0 lanes_placed=${lanesPlaced}`],
      },
    ],
    exceptions: [],
    cpuTime: cpuMs,
    wallTime: cpuMs + 900,
  });
}

function placedLane(path: string, cpuMs: number, origin = LOADTEST_PLACED_ORIGIN, at = 1_757_000_000_000): string {
  return tailEvent({
    outcome: "ok",
    scriptName: "slate-loadtest",
    eventTimestamp: at,
    event: { request: { url: `${origin}${path}`, method: "GET" } },
    logs: [],
    exceptions: [],
    cpuTime: cpuMs,
    wallTime: cpuMs + 50,
  });
}

{
  const archive = [
    placedLane("/api/cron/sync", 30_000),
    placedLane("/api/cron/recompute", 45_000),
    tickWithTimings("* * * * *", 200, 2),
    request(),
  ].join("");
  const r = readScheduledFromArchive(archive);
  eq(r?.invocations, 3, "a placed lane counts as cron work beside the tick that sent it");
  eq(r?.worstCpuMs, 45_000, "and its CPU is what the cron half judges, not the dispatcher's");
  eq(r?.byCron["placed /api/cron/recompute"]?.worstCpuMs, 45_000, "named by its lane, so a finding can name it");
  eq(r?.placedLanesReported, 2, "the ticks' own timings lines say how many lanes ran placed");
  eq(r?.placedLanesSeen, 2, "and the archive holds every one of them");
}

{
  // A request on any other origin is not a placed lane, even on a cron path: only the
  // dispatcher addresses the placed origin, and anybody can request a path.
  const r = readScheduledFromArchive(placedLane("/api/cron/sync", 9_000, "https://slate-loadtest.workers.dev"));
  eq(r?.invocations, 0, "a cron path on another origin is not counted as a placed lane");
}

{
  // The archive does not carry the placed invocations at all: the timings lines say
  // four lanes ran placed and not one is in the stream. Judging the dispatcher would
  // pass blind, so the cron half concludes nothing (L98).
  const archive = [tickWithTimings("* * * * *", 200, 4), request()].join("");
  const r = readScheduledFromArchive(archive);
  eq(r?.placedLanesReported, 4, "four lanes reported placed");
  eq(r?.placedLanesSeen, 0, "none of them in the archive");
  const rec = reconcileScheduled({ platform: { ok: true, reading: { invocations: 0, worstCpuMs: 0, byCron: {} } }, archive: r });
  assert(!rec.ok, "a cron half whose placed lanes were never read concludes nothing");
  assert(!rec.ok && /placed/.test(rec.why) && /4/.test(rec.why), "and says so, with the count");
  const viaPlatform = reconcileScheduled({
    platform: { ok: true, reading: { invocations: 1, worstCpuMs: 200, byCron: { "* * * * *": { invocations: 1, worstCpuMs: 200 } } } },
    archive: r,
  });
  assert(!viaPlatform.ok, "nor does a platform reading, which holds scheduled invocations only");
}

{
  // A stream attached mid tick can miss a lane or two the tick reported; those are
  // counted as ticks with no readable CPU rather than refusing the whole run.
  const archive = [
    placedLane("/api/cron/sync", 30_000),
    placedLane("/api/cron/recompute", 45_000),
    placedLane("/api/cron/outbox", 1_000),
    tickWithTimings("* * * * *", 200, 4),
  ].join("");
  const r = readScheduledFromArchive(archive);
  eq(r?.placedLanesSeen, 3, "three of four placed lanes were read");
  eq(r?.unreadableCpu, 1, "and the missing one is counted as unread, never as cheap");
  const rec = reconcileScheduled({ platform: { ok: true, reading: { invocations: 1, worstCpuMs: 200, byCron: {} } }, archive: r });
  assert(rec.ok, "a run whose placed lanes were read is judged");
  eq(rec.ok ? rec.source : "", "archive", "from the archive, the only source that carries placed lanes");
  eq(rec.ok ? rec.reading.worstCpuMs : -1, 45_000, "on the lane's CPU");
  assert(rec.ok && /placed/.test(rec.why ?? ""), "and says why the archive was preferred");
}

// --- reconciling the two sources ----------------------------------------------

const PLATFORM_19: ScheduledReading = {
  invocations: 19,
  worstCpuMs: 27_400,
  byCron: { "* * * * *": { invocations: 19, worstCpuMs: 27_400 } },
};
const ZERO: ScheduledReading = { invocations: 0, worstCpuMs: 0, byCron: {} };
const ARCHIVE_19: ScheduledReading = {
  invocations: 19,
  worstCpuMs: 27_000,
  byCron: { "* * * * *": { invocations: 19, worstCpuMs: 27_000 } },
};

const refusals: string[] = [];
const notes: string[] = [];

{
  const r = reconcileScheduled({ platform: { ok: true, reading: PLATFORM_19 }, archive: ARCHIVE_19 });
  assert(r.ok, "both sources reporting ticks is a reading");
  eq(r.ok ? r.source : "", "platform", "and the platform's own dataset is preferred when it answers");
  eq(r.ok ? r.reading.invocations : -1, 19, "with its numbers");
}

{
  // THE ONE THIS ISSUE IS ABOUT. The dataset says zero and the run's own log says
  // nineteen. That is the reader being blind, never an empty window, and reading it
  // as empty is what let the judge apply the per request CPU budget to a window
  // full of cron lanes and write the conclusion into a report.
  const r = reconcileScheduled({ platform: { ok: true, reading: ZERO }, archive: ARCHIVE_19 });
  assert(r.ok, "a blind dataset does not take the cron half down: the archive answers it");
  eq(r.ok ? r.source : "", "archive", "from the run's own archived log");
  eq(r.ok ? r.reading.invocations : -1, 19, "with one row per invocation and its own CPU");
  const why = r.ok ? (r.why ?? "") : "";
  notes.push(why);
  assert(/19/.test(why), "and the note says how many the log held");
  assert(
    !/no cron/i.test(why) && !/empty window/i.test(why),
    "and never describes it as an empty window, which is the false fact this replaces",
  );
}

{
  // Zero and zero AGREE, and that is the only way a window may be called empty:
  // it is what lets the per request CPU budget be applied honestly.
  const r = reconcileScheduled({ platform: { ok: true, reading: ZERO }, archive: ZERO });
  assert(r.ok, "two sources agreeing on zero is a reading");
  eq(r.ok ? r.source : "", "agreed-empty", "and it is the one that may be called an empty window");
  eq(r.ok ? r.reading.invocations : -1, 0, "of zero");
}

{
  // A dataset saying zero with nothing to check it against. Before this, that WAS
  // the empty window conclusion, on every run.
  const r = reconcileScheduled({ platform: { ok: true, reading: ZERO }, archive: null });
  assert(!r.ok, "a dataset reporting zero with no archive to check it against concludes nothing");
  refusals.push(r.ok ? "" : r.why);
}

{
  const r = reconcileScheduled({ platform: { ok: false, why: "the analytics API answered HTTP 503" }, archive: ARCHIVE_19 });
  assert(r.ok, "a refused dataset is answered by the archive");
  eq(r.ok ? r.source : "", "archive", "from the log");
  const why = r.ok ? (r.why ?? "") : "";
  notes.push(why);
  assert(/503/.test(why), "and the note quotes the dataset's own refusal rather than summarising it");
}

{
  const r = reconcileScheduled({ platform: { ok: false, why: "the analytics API answered HTTP 503" }, archive: null });
  assert(!r.ok, "a refused dataset with no archive concludes nothing");
  refusals.push(r.ok ? "" : r.why);
  assert(!r.ok && r.why.includes("503"), "carrying the dataset's own words");
}

{
  // An archive reporting zero is NOT on its own evidence of an empty window: the
  // tail is attached by hand under a timeout, so it can start after the tick it
  // would have seen. Only two sources agreeing may conclude that.
  const r = reconcileScheduled({ platform: { ok: false, why: "the analytics API answered HTTP 503" }, archive: ZERO });
  assert(!r.ok, "an archive alone reporting no ticks cannot call the window empty");
  refusals.push(r.ok ? "" : r.why);
}

// --- every way of learning nothing has its own words --------------------------

{
  eq(new Set(refusals).size, refusals.length, `all ${refusals.length} refusals are distinct`);
  eq(new Set(notes).size, notes.length, `and both notes about a blind dataset are distinct`);
  for (const why of [...refusals, ...notes]) assert(why.trim().length > 25, "and each says something");
}

finish();
