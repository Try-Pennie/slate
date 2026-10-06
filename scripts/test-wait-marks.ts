// #3354: the wait before a confirm's profile starts, split into spans from marks
// taken at fixed points of one request. Final run 1 (run 37390071571) could only
// read that wait as one number, and the split it was read with subtracted a figure
// that also counted calls made after the profile started (L699), so this records
// each point on the request's own clock instead and derives every span from the
// marks of ONE request (L420).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-wait-marks.ts
import {
  makeWaitMarks,
  WAIT_POINTS,
  withEntryMarks,
  readEntryMarks,
  ENTRY_AT_HEADER,
  FETCH_INDEX_HEADER,
} from "../src/lib/booking/wait-marks.ts";
import { assert, eq, finish } from "./lib/harness.ts";

/** A clock the test moves by hand, so no span depends on the machine (L524). */
function clock(start: number) {
  let t = start;
  return { now: () => t, to: (ms: number) => void (t = ms) };
}

// --- every point, in order: spans that add up to the whole ---------------------
{
  const c = clock(1_000);
  const m = makeWaitMarks(c.now, 900);
  c.to(1_000); m.mark("handler");
  c.to(1_200); m.mark("authed");
  c.to(1_210); m.mark("line_start");
  c.to(1_500); m.mark("line_turn");
  c.to(1_800); m.mark("decided");
  c.to(1_850); m.mark("profile");
  const f = m.fields();
  eq(f.wait_route_ms, 100, "worker entry to the handler");
  eq(f.wait_auth_ms, 200, "the handler to auth done");
  eq(f.wait_pre_line_ms, 10, "auth done to the first line call");
  eq(f.wait_line_ms, 290, "the first line call to the turn");
  eq(f.wait_decide_ms, 300, "the turn to the person decision");
  eq(f.wait_to_profile_ms, 50, "the person decision to the profile starting");
  eq(f.wait_total_ms, 950, "the whole wait, worker entry to the profile");
  const parts = ["wait_route_ms", "wait_auth_ms", "wait_pre_line_ms", "wait_line_ms", "wait_decide_ms", "wait_to_profile_ms"];
  eq(parts.reduce((s, k) => s + Number(f[k]), 0), f.wait_total_ms, "the spans sum to the whole, so none is double counted (L466)");
  eq(f.wait_missing, undefined, "nothing is reported missing when every point was marked");
  eq(f.wait_out_of_order, undefined, "and nothing out of order");
}

// --- a point that never happened is NAMED, never scored as zero ----------------
{
  const c = clock(5_000);
  const m = makeWaitMarks(c.now, null);
  m.mark("handler");
  c.to(5_100); m.mark("authed");
  c.to(5_400); m.mark("profile");
  const f = m.fields();
  eq(f.wait_missing, "entry,line_start,line_turn,decided", "the missing points are listed by name (L90)");
  eq(f.wait_auth_ms, 100, "a span whose two ends were both marked is still reported");
  eq(f.wait_line_ms, undefined, "a span with a missing end is absent, not 0");
  eq(f.wait_route_ms, undefined, "and so is the route span with no worker entry");
  eq(f.wait_total_ms, 400, "the whole runs from the first point marked, which is said by wait_missing");
}

// --- the first mark of a point wins, and a repeat is counted --------------------
{
  const c = clock(0);
  const m = makeWaitMarks(c.now, 0);
  m.mark("handler");
  c.to(10); m.mark("line_start");
  c.to(20); m.mark("line_turn");
  c.to(30); m.mark("line_start");
  c.to(40); m.mark("line_turn");
  const f = m.fields();
  eq(f.wait_line_ms, 10, "a second line entry does not stretch the first one's span");
  eq(f.wait_repeats, "line_start:2,line_turn:2", "and each repeated point says how many times it was marked");
}

// --- a later point stamped before an earlier one is flagged, not hidden ---------
{
  // The clock only moves forward, as a Worker's does. A confirm that joined its line
  // late made its person decision BEFORE its turn, so `decided` carries an earlier
  // time than `line_turn`, the point before it in the sequence.
  const c = clock(100);
  const m = makeWaitMarks(c.now, 100);
  m.mark("handler");
  c.to(200); m.mark("decided");
  c.to(300); m.mark("line_turn");
  const f = m.fields();
  eq(f.wait_out_of_order, "decided", "a point earlier than the one before it in the sequence is named");
  eq(f.wait_decide_ms, undefined, "and the span ending at it is withheld rather than reported negative");
}

// --- the points are the fixed sequence the request runs through -----------------
{
  eq(
    [...WAIT_POINTS].join(","),
    "entry,handler,authed,line_start,line_turn,decided,profile",
    "the sequence is fixed, so every report reads the spans in the same order",
  );
  const c = clock(0);
  const m = makeWaitMarks(c.now, undefined);
  assert(Object.keys(m.fields()).every((k) => k.startsWith("wait_")), "every field is prefixed, so it cannot collide with the line's other fields");
}

// --- the Worker's entry stamp and fetch count, carried to the route --------------
// The Worker runs before Next, so its two facts travel on the request: when it was
// entered, and how many requests this isolate had served before this one (0 is a
// fresh isolate's first, counted independently of any module's evaluation).
{
  const req = withEntryMarks(new Request("https://x.test/api/bookings"), { loadtest: true, nowMs: 1_234, fetchIndex: 0 });
  const read = readEntryMarks(req.headers);
  eq(read.entryAtMs, 1_234, "the entry stamp round trips");
  eq(read.fetchIndex, 0, "and so does the fetch index, a fresh isolate's first being 0");

  const plain = new Request("https://x.test/api/bookings");
  const off = withEntryMarks(plain, { loadtest: false, nowMs: 1_234, fetchIndex: 3 });
  assert(off === plain, "off the load test the request is passed through untouched, nothing stamped");

  const spoofed = new Request("https://x.test/api/bookings", { headers: { [ENTRY_AT_HEADER]: "1", [FETCH_INDEX_HEADER]: "99" } });
  const over = readEntryMarks(withEntryMarks(spoofed, { loadtest: true, nowMs: 5_000, fetchIndex: 7 }).headers);
  eq(over.entryAtMs, 5_000, "a stamp a caller sent is overwritten by the Worker's own");
  eq(over.fetchIndex, 7, "and so is a fetch index a caller sent");

  const junk = readEntryMarks(new Headers({ [ENTRY_AT_HEADER]: "soon", [FETCH_INDEX_HEADER]: "-1" }));
  eq(junk.entryAtMs, null, "an unreadable stamp reads as absent, never as a time (L50)");
  eq(junk.fetchIndex, null, "and an unreadable fetch index as absent, never as a count");
  const none = readEntryMarks(new Headers());
  eq(none.entryAtMs, null, "no stamp reads as absent");
  eq(none.fetchIndex, null, "no fetch index reads as absent, not as a first request");
}

finish();
