// The two decisions the load run's preflight and ceiling control make (#2244).
//
// The first is the most expensive thing in the run to get wrong: if the deployment
// is not running with SLATE_LOADTEST on, six hundred bookings become six hundred
// REAL calendar events and six hundred real invitations on agents' real calendars.
// Nothing about the run's own output would say so, because every booking would
// succeed.
//
// Run: node --experimental-strip-types scripts/test-loadtest-preflight-checks.ts
import { stubShapedEventId, ceilingVerdict } from "./loadtest/preflight-checks.ts";
import { stubCreateEvent } from "../src/lib/google/loadtest-stub.ts";
import { deterministicEventId } from "../src/lib/booking/core.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// --- an id the stub really produced is recognised -----------------------------

{
  // Driven through the SHIPPED stub rather than against a hand written string, so
  // the check cannot pass against a shape the stub stopped producing (L58). Both
  // of its shapes: the pinned client id returned verbatim, and the id it mints
  // when none was supplied.
  const clientId = await deterministicEventId("idem-key", "user-1");
  const input = { summary: "Pennie call", start: "2026-09-15T15:00:00Z", end: "2026-09-15T15:20:00Z" };
  assert(
    stubShapedEventId(stubCreateEvent(input, clientId)),
    "the id the stub returns for a pinned client id is recognised",
  );
  assert(
    stubShapedEventId(stubCreateEvent(input)),
    "and so is the one it mints when no client id was supplied",
  );
}

// --- a real Google id is NOT -----------------------------------------------------

{
  // Real ids, in the shapes Google actually uses. Every one of these must be
  // refused, because each is the run about to send real invitations.
  for (const real of [
    "7v1k2m3n4o5p6q7r8s9t0u1v2w",
    "_6tj4c9k6cpj6b9k6ss3ib9o70r3ac9p6cp3cb9m6grjic9n6t",
    "abcdefghijklmnopqrstuvwxyz",
    "f2ZGPAxE8skjLBtiQeCsgH",
  ]) {
    assert(!stubShapedEventId(real), `a real Google id is refused: ${real.slice(0, 16)}`);
  }
  assert(!stubShapedEventId(""), "and so is an empty id");
  assert(!stubShapedEventId("   "), "and a blank one");
}

{
  // The check is POSITIVE on purpose. A negative one ("does it look like Google")
  // passes on any id whose shape nobody anticipated, and the direction that fails
  // safe is refusing what we do not recognise.
  assert(!stubShapedEventId("slate"), "a prefix alone is not the stub's shape");
  assert(!stubShapedEventId("slate123"), "nor a short hex tail");
  assert(!stubShapedEventId(`slate${"z".repeat(64)}`), "nor 64 characters that are not hex");
  assert(!stubShapedEventId("lt-evt-"), "nor the mint prefix with nothing after it");
  assert(
    !stubShapedEventId("slate-real-google-id-that-happens-to-start-this-way"),
    "and an id merely STARTING with the prefix is refused, which the first version accepted",
  );
}

// --- the per address ceiling control ----------------------------------------------

{
  const ok = ceilingVerdict([...Array(60).fill(200), 429]);
  eq(ok.firstRefusedAt, 61, "the 61st request refused is the ceiling doing its job");
  eq(ok.unreachable, 0, "and nothing failed to reach the deployment");

  const never = ceilingVerdict(Array(61).fill(200));
  eq(never.firstRefusedAt, null, "nothing refused is reported as null, never as a number");

  const early = ceilingVerdict([...Array(19).fill(200), 429, ...Array(41).fill(429)]);
  eq(early.firstRefusedAt, 20, "an early refusal is reported at the position it happened");

  // A transport fault is UNREACHABLE, never a refusal. Counting it as one would
  // report the ceiling working when the control never reached the deployment,
  // which is the whole failure this control exists to rule out (L98).
  const dead = ceilingVerdict(Array(61).fill(0));
  eq(dead.firstRefusedAt, null, "a control that never reached the deployment refused nothing");
  eq(dead.unreachable, 61, "and says how many never arrived");

  const mixed = ceilingVerdict([200, 0, 200, 429]);
  eq(mixed.firstRefusedAt, 4, "a fault before a refusal does not move the refusal's position");
  eq(mixed.unreachable, 1, "and is still counted");

  eq(ceilingVerdict([]).firstRefusedAt, null, "no requests refused nothing");
  eq(ceilingVerdict([]).unreachable, 0, "and none were unreachable");
}

finish();
