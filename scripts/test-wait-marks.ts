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
  INVOCATION_INDEX_HEADER,
  LOADTEST_LEG_HEADER,
  LOADTEST_LEGS,
  readLoadtestLeg,
  WAIT_SPAN_FIELDS,
  AUTH_STEPS,
  ENTRY_STAMP_FIELD,
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

// --- #3529, #3124: the auth span split by the ceiling call it waited on ------------
// Load run 37785947346 failed its startup bar on one confirm whose auth span was 2.7s,
// spent in waits before each rate limit object call that the span could not tell
// apart, so each step inside the span is stamped. Since #3124 the per key and the per
// address checks run side by side, so the split is per PATH: each path's two steps add
// up to that path's own wait, and the auth span is the longer path, never their sum.
{
  eq([...AUTH_STEPS], ["key_edge", "key_ceiling", "ip_edge", "ip_ceiling"], "the steps inside auth, each path's edge limiter then its exact ceiling");
  const c = clock(1_000);
  const m = makeWaitMarks(c.now, 1_000);
  m.mark("handler");
  // Both paths start at the handler; their answers interleave.
  c.to(1_020); m.mark("ip_edge");
  c.to(1_030); m.mark("key_edge");
  c.to(1_700); m.mark("key_ceiling");
  c.to(2_000); m.mark("ip_ceiling");
  c.to(2_000); m.mark("authed");
  const f = m.fields();
  eq(f.wait_auth_key_edge_ms, 30, "the handler to the per key edge limiter answering");
  eq(f.wait_auth_key_ceiling_ms, 670, "then to the per key exact ceiling answering");
  eq(f.wait_auth_ip_edge_ms, 20, "the handler to the per address edge limiter answering, measured from its own start");
  eq(f.wait_auth_ip_ceiling_ms, 980, "then to the per address exact ceiling answering");
  eq(f.wait_auth_ms, 1_000, "the auth span is the longer path, the address one here");
  eq(Number(f.wait_auth_ip_edge_ms) + Number(f.wait_auth_ip_ceiling_ms), f.wait_auth_ms, "the longer path's steps make up the span");
  assert(
    Number(f.wait_auth_key_edge_ms) + Number(f.wait_auth_key_ceiling_ms) <= Number(f.wait_auth_ms),
    "and the shorter path's steps sit inside it, since the two overlap",
  );
  eq(f.wait_out_of_order, undefined, "interleaved steps are not out of order: only each path has an order");
  assert(!String(f.wait_missing ?? "").includes("key_edge"), "a step is never reported as a missing point of the main sequence");
}
{
  // A route with no per address ceiling stamps only the key path: its split is reported,
  // and no address span is invented, nor named missing.
  const c = clock(0);
  const m = makeWaitMarks(c.now, 0);
  m.mark("handler");
  c.to(10); m.mark("key_edge");
  c.to(150); m.mark("key_ceiling");
  c.to(150); m.mark("authed");
  const f = m.fields();
  eq(f.wait_auth_key_edge_ms, 10, "the key path stands alone");
  eq(f.wait_auth_key_ceiling_ms, 140, "both of its steps");
  eq(f.wait_auth_ip_edge_ms, undefined, "no address span without the address path");
  eq(f.wait_auth_ip_ceiling_ms, undefined, "on either step");
}
{
  // A path with a step missing (an older deployment, or a refusal part way) is withheld
  // whole rather than reported in part, and the auth span stands without it.
  const c = clock(0);
  const m = makeWaitMarks(c.now, 0);
  m.mark("handler");
  c.to(50); m.mark("key_edge");
  c.to(60); m.mark("ip_edge");
  c.to(90); m.mark("ip_ceiling");
  c.to(200); m.mark("authed");
  const f = m.fields();
  eq(f.wait_auth_ms, 200, "the auth span stands without the steps");
  eq(f.wait_auth_key_edge_ms, undefined, "a path with a step missing is withheld whole rather than reported in part");
  eq(f.wait_auth_ip_edge_ms, 60, "while the other path, stamped whole, is reported");
  eq(f.wait_missing, "line_start,line_turn,decided,profile", "a missing step is not counted among the missing points");
}
{
  // A refusal never reaches `authed`, so no path is split from a request that answered no.
  const c = clock(0);
  const m = makeWaitMarks(c.now, 0);
  m.mark("handler");
  c.to(10); m.mark("key_edge");
  c.to(20); m.mark("key_ceiling");
  const f = m.fields();
  eq(f.wait_auth_key_edge_ms, undefined, "no split without the auth span it belongs to");
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
{
  // And the span STARTING at an out of order point is withheld too: its stamp is the
  // one the sequence says is wrong, so a span measured from it is wrong as well
  // (#3358 review: decided at 200 after line_turn at 300 made the profile span 200).
  const c = clock(100);
  const m = makeWaitMarks(c.now, 100);
  m.mark("handler");
  c.to(300); m.mark("line_turn");
  c.to(200);
  m.mark("decided");
  c.to(400); m.mark("profile");
  const f = m.fields();
  eq(f.wait_out_of_order, "decided", "the out of order point is named");
  eq(f.wait_to_profile_ms, undefined, "and the span from it to the next point is withheld, not measured from a stamp known to be wrong");
}

// --- one list of span names, derived from the points (L41) ---------------------------
{
  eq(
    [...WAIT_SPAN_FIELDS].join(","),
    "wait_route_ms,wait_auth_ms,wait_auth_key_edge_ms,wait_auth_key_ceiling_ms,wait_auth_ip_edge_ms,wait_auth_ip_ceiling_ms,wait_pre_line_ms,wait_line_ms,wait_decide_ms,wait_to_profile_ms,wait_total_ms",
    "the span names are the points' spans in order, auth's steps beside it, then the whole, from the module that writes them",
  );
  const c = clock(100);
  const m = makeWaitMarks(c.now, 100);
  let t = 200;
  for (const p of WAIT_POINTS.slice(1)) {
    if (p === "authed") for (const step of AUTH_STEPS) m.mark((c.to(t), (t += 10), step));
    c.to(t);
    t += 10;
    m.mark(p);
  }
  // The entry stamp is the one `wait_` field that is not a span (#3436).
  const written = Object.keys(m.fields()).filter((k) => k.startsWith("wait_") && k !== ENTRY_STAMP_FIELD);
  eq(written.sort().join(","), [...WAIT_SPAN_FIELDS].sort().join(","), "and every span the marks write is in the list, and nothing else");
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

// --- the Worker's entry stamp and invocation count, carried to the route ---------
// The Worker runs before Next, so its two facts travel on the request: when it was
// entered, and how many times this isolate had run the app before this request,
// counting cron ticks and receipts too (0 is a fresh isolate's first run, counted
// independently of any module's evaluation).
{
  const req = withEntryMarks(new Request("https://x.test/api/bookings"), { loadtest: true, nowMs: 1_234, invocationIndex: 0 });
  const read = readEntryMarks(req.headers);
  eq(read.entryAtMs, 1_234, "the entry stamp round trips");
  eq(read.invocationIndex, 0, "and so does the invocation index, a fresh isolate's first being 0");

  const plain = new Request("https://x.test/api/bookings");
  const off = withEntryMarks(plain, { loadtest: false, nowMs: 1_234, invocationIndex: 3 });
  assert(off === plain, "off the load test the request is passed through untouched, nothing stamped");

  const spoofed = new Request("https://x.test/api/bookings", { headers: { [ENTRY_AT_HEADER]: "1", [INVOCATION_INDEX_HEADER]: "99" } });
  const over = readEntryMarks(withEntryMarks(spoofed, { loadtest: true, nowMs: 5_000, invocationIndex: 7 }).headers);
  eq(over.entryAtMs, 5_000, "a stamp a caller sent is overwritten by the Worker's own");
  eq(over.invocationIndex, 7, "and so is an invocation index a caller sent");

  const junk = readEntryMarks(new Headers({ [ENTRY_AT_HEADER]: "soon", [INVOCATION_INDEX_HEADER]: "-1" }));
  eq(junk.entryAtMs, null, "an unreadable stamp reads as absent, never as a time (L50)");
  eq(junk.invocationIndex, null, "and an unreadable invocation index as absent, never as a count");
  const none = readEntryMarks(new Headers());
  eq(none.entryAtMs, null, "no stamp reads as absent");
  eq(none.invocationIndex, null, "no invocation index reads as absent, not as a first request");
}

// --- #3436: the Worker's entry stamp itself, so the isolate's own start can be read ----
// Every span above starts at the entry stamp, so the time from the invocation starting
// to the Worker's handler being entered (a fresh isolate starting up) was in none of
// them. The archive carries the invocation's start (`eventTimestamp`); the line carries
// the entry stamp, and the reader measures the span between the two directly rather
// than as a residual of other spans (L699).
{
  eq(ENTRY_STAMP_FIELD, "wait_entry_at_ms", "the stamp's field name, read by the load run's reader from this one constant");
  assert(!(WAIT_SPAN_FIELDS as readonly string[]).includes(ENTRY_STAMP_FIELD), "it is a stamp, not a span, so it is not in the span list");
  const c = clock(1_791_317_362_000);
  const m = makeWaitMarks(c.now, 1_791_317_361_805);
  m.mark("handler");
  eq(m.fields()[ENTRY_STAMP_FIELD], 1_791_317_361_805, "the Worker's own stamp is written as it was given, on the Worker's clock");
  const none = makeWaitMarks(c.now, null);
  none.mark("handler");
  eq(none.fields()[ENTRY_STAMP_FIELD], undefined, "no stamp given, none written, never a zero or the handler's time (L90)");
  eq(none.fields().wait_missing, "entry,authed,line_start,line_turn,decided,profile", "and the entry is still named missing");
}

// --- #3354: which leg of the run sent a confirm, as its driver names it ------------
{
  eq([...LOADTEST_LEGS], ["steady", "burst", "fault", "baseline", "preflight", "ceiling", "cold"], "the legs are the driver's four modes, the two controls that also confirm, and the cold leg");
  eq(LOADTEST_LEG_HEADER, "x-loadtest-leg", "the leg header's name");
  for (const leg of LOADTEST_LEGS) eq(readLoadtestLeg(new Headers({ [LOADTEST_LEG_HEADER]: leg })), leg, `a confirm sent by the ${leg} leg reads as that leg`);
  eq(readLoadtestLeg(new Headers()), null, "a confirm that named no leg reads as absent, which a hand run's are");
  eq(readLoadtestLeg(new Headers({ [LOADTEST_LEG_HEADER]: "Steady" })), "unreadable", "a leg outside the vocabulary reads as unreadable, never as one of the legs (L11)");
  eq(readLoadtestLeg(new Headers({ [LOADTEST_LEG_HEADER]: "" })), "unreadable", "and so does an empty one, which a driver did send");
}

finish();
