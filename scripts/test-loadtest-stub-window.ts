// #1542: the soak's fake Google must honour the bounds a bootstrap sends.
//
// WHY IT MATTERS. #1261 bounded the bootstrap fetch, and the reconcile that follows may now
// only judge what the fetch asked for. Getting that pairing wrong deletes cached busy time
// for meetings still sitting in an agent's calendar and leaves them bookable during those
// meetings. Everything proving it correct is a unit test with a hand-written fake, and a fake
// agrees with our assumptions by construction (L52).
//
// The 200-agent soak is the only automated path that runs this code at scale, and its stub
// ignored the bounds entirely, answering the same way whatever window it was handed. So the
// one harness that could catch a real-shaped mistake was blind to the property just added.
//
// The stub now models the two behaviours Google was MEASURED to have (#1252), which are not
// the same and are the whole reason hydration exists:
//
//   a BOOTSTRAP is scoped: it returns only `ends_at > timeMin AND starts_at < timeMax`;
//   a DELTA is not: an out-of-window event still arrives, exactly once.
//
// Run: node --experimental-strip-types scripts/test-loadtest-stub-window.ts
import { assert, eq, finish } from "./lib/harness.ts";
import { stubSyncEvents } from "@/lib/google/loadtest-stub";

const NOW = Date.UTC(2026, 7, 17, 12, 0, 0);
const DAY = 86_400_000;
const WINDOW = {
  timeMinIso: new Date(NOW - DAY).toISOString(),
  timeMaxIso: new Date(NOW + 21 * DAY).toISOString(),
};

const startMs = (e: { start?: { dateTime?: string } }) => Date.parse(e.start?.dateTime ?? "");
const endMs = (e: { end?: { dateTime?: string } }) => Date.parse(e.end?.dateTime ?? "");

// --- a bootstrap is scoped to what it asked for -------------------------------
{
  const { events } = stubSyncEvents("agent@x.com", null, NOW, WINDOW);
  assert(events.length > 0, "a bootstrap returns events at all, so the checks below are not vacuous");

  const min = Date.parse(WINDOW.timeMinIso);
  const max = Date.parse(WINDOW.timeMaxIso);
  for (const e of events) {
    assert(
      endMs(e) > min && startMs(e) < max,
      `every returned event is inside the fetched window (${e.id})`,
    );
  }
}

{
  // The window is HONOURED, not ignored: a narrower one returns strictly fewer events. A stub
  // that returned the same set whatever it was handed would pass the check above and prove
  // nothing, which is exactly the state this replaces.
  const wide = stubSyncEvents("agent@x.com", null, NOW, WINDOW).events.length;
  const narrow = stubSyncEvents("agent@x.com", null, NOW, {
    timeMinIso: WINDOW.timeMinIso,
    timeMaxIso: new Date(NOW + 2 * DAY).toISOString(),
  }).events.length;
  assert(narrow < wide, `a narrower window returns fewer events (${narrow} < ${wide})`);
  assert(narrow > 0, "but not zero, so the narrow case still exercises the write path");
}

{
  // The straddling cases, which are the ones the reconcile predicate exists for. Google's two
  // bounds apply to two DIFFERENT fields: timeMin bounds an event's END, timeMax its START.
  const { events } = stubSyncEvents("agent@x.com", null, NOW, WINDOW);
  const min = Date.parse(WINDOW.timeMinIso);
  const max = Date.parse(WINDOW.timeMaxIso);
  assert(
    events.some((e) => startMs(e) < min && endMs(e) > min),
    "the batch includes an event straddling the LOWER bound, which a real fetch returns",
  );
  assert(
    events.some((e) => startMs(e) < max && endMs(e) > max),
    "and one straddling the UPPER bound, which a real fetch also returns",
  );
}

// --- a delta is NOT scoped ----------------------------------------------------
{
  // Measured behaviour (#1252), and the entire reason hydration exists: an out-of-window
  // event arrives through the delta and is delivered exactly once, so nothing re-adds it
  // later. The soak has to reproduce that, or the case the window filter is dangerous for
  // never occurs in it.
  const { events } = stubSyncEvents("agent@x.com", "a-token", NOW, WINDOW);
  const max = Date.parse(WINDOW.timeMaxIso);
  assert(events.length > 0, "an incremental returns something");
  assert(
    events.some((e) => startMs(e) > max),
    "and it includes an event BEYOND the window, because Google's delta is not scoped by it",
  );
}

{
  // Deterministic, so a soak run is reproducible and a difference between two runs means the
  // code changed rather than the fixture rolling differently.
  const a = stubSyncEvents("agent@x.com", null, NOW, WINDOW).events.map((e) => e.id).join(",");
  const b = stubSyncEvents("agent@x.com", null, NOW, WINDOW).events.map((e) => e.id).join(",");
  eq(a, b, "the same inputs produce the same batch");
}

{
  // A window whose bounds cannot be read must not silently produce the unscoped set, which
  // would put the soak back where it started while looking like it was testing something.
  const { events } = stubSyncEvents("agent@x.com", null, NOW, { timeMinIso: "nope", timeMaxIso: "nope" });
  eq(events.length, 0, "an unreadable window returns nothing rather than everything");
}

finish();
