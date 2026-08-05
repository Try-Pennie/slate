// Org business hours: the stored rows resolved into the windows the gate judges
// against (#1294, milestone 24 Phase 1). No enforcement yet, so what matters here
// is entirely the resolution and its FAILURE DIRECTIONS.
//
// The asymmetry is deliberate and is the whole point of the file:
//   * NO rows (a fresh database, a wiped table) falls back to the seeded default,
//     because a business-hours gate that resolves to nothing would close the org
//     and blank the booker. Absent means "not configured", never "closed".
//   * A CLOSED day is an explicit stored fact, and it does close that day.
//   * A row that cannot be trusted (an inverted or out of range window that somehow
//     got past the database's own constraints) is refused rather than widened,
//     because silently substituting a default would re-open hours an admin closed.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-business-hours.ts
import {
  resolveBusinessHours,
  SEEDED_BUSINESS_HOURS,
  BUSINESS_ZONE,
} from "../src/lib/booking/business-hours.ts";
import { assert, finish } from "./lib/harness.ts";

const row = (weekday: number, is_open: boolean, start_minute = 480, end_minute = 1200) => ({
  weekday,
  is_open,
  start_minute,
  end_minute,
});

// --- the seeded shape: Monday to Saturday, 8am to 8pm, Sunday closed ---
{
  assert(BUSINESS_ZONE === "America/New_York", "the business zone is Eastern");
  const seeded = SEEDED_BUSINESS_HOURS;
  assert(seeded.length === 6, "six open days are seeded (Monday to Saturday)");
  assert(
    seeded.every((r) => r.start_minute === 480 && r.end_minute === 1200),
    "the seeded window is 8:00 to 20:00 in minutes from local midnight",
  );
  assert(
    seeded.map((r) => r.weekday).join(",") === "1,2,3,4,5,6",
    "Sunday (7) is not among the open days",
  );
}

// --- rows resolve to the open days only ---
{
  const rows = [1, 2, 3, 4, 5, 6, 7].map((d) => row(d, d !== 7));
  const res = resolveBusinessHours(rows);
  assert(res.ok === true, "a full valid week resolves");
  if (res.ok) {
    assert(res.rules.length === 6, "only the open days become rules");
    assert(!res.rules.some((r) => r.weekday === 7), "the closed day is absent from the rules");
    assert(res.source === "stored", "a resolved week reports that it came from the store");
  }
}

// --- a closed day is honoured, not treated as unconfigured ---
{
  // Every day closed is a legitimate stored state (an org that has stopped taking
  // bookings) and must NOT fall back to the default, which would re-open it.
  const allClosed = resolveBusinessHours([1, 2, 3, 4, 5, 6, 7].map((d) => row(d, false)));
  assert(allClosed.ok === true, "an all-closed week is valid");
  if (allClosed.ok) {
    assert(allClosed.rules.length === 0, "an all-closed week offers no windows");
    assert(allClosed.source === "stored", "it is the stored answer, not a fallback");
  }
}

// --- no rows at all: fall back, never close ---
{
  const empty = resolveBusinessHours([]);
  assert(empty.ok === true, "no rows resolves rather than failing");
  if (empty.ok) {
    assert(empty.source === "seeded", "no rows reports the fallback, so a caller can log it");
    assert(
      empty.rules.length === SEEDED_BUSINESS_HOURS.length,
      "no rows falls back to the seeded week rather than closing the org",
    );
  }
}

// --- a partial week is a fallback too, not a silently narrower week ---
{
  // Three rows means someone or something deleted four. Serving the three would
  // close Thursday to Sunday without anyone deciding that.
  const partial = resolveBusinessHours([row(1, true), row(2, true), row(3, true)]);
  assert(partial.ok === false, "an incomplete week is refused rather than served short");
  if (!partial.ok) assert(/7|complete|missing/i.test(partial.error), "the refusal says days are missing");
}

// --- untrustworthy rows are refused, never widened ---
{
  const inverted = [1, 2, 3, 4, 5, 6, 7].map((d) => (d === 3 ? row(d, true, 1200, 480) : row(d, d !== 7)));
  assert(resolveBusinessHours(inverted).ok === false, "an inverted window is refused");

  const outOfRange = [1, 2, 3, 4, 5, 6, 7].map((d) => (d === 4 ? row(d, true, 480, 1441) : row(d, d !== 7)));
  assert(resolveBusinessHours(outOfRange).ok === false, "an end past the day is refused");

  const badDay = [1, 2, 3, 4, 5, 6, 8].map((d) => row(d, true));
  assert(resolveBusinessHours(badDay).ok === false, "a weekday outside 1 to 7 is refused");

  const duplicate = [1, 1, 2, 3, 4, 5, 6].map((d) => row(d, true));
  assert(resolveBusinessHours(duplicate).ok === false, "a duplicated weekday is refused");

  const unreadable = [1, 2, 3, 4, 5, 6, 7].map((d) =>
    d === 5 ? row(d, true, Number.NaN, 1200) : row(d, d !== 7),
  );
  assert(
    resolveBusinessHours(unreadable).ok === false,
    "an unreadable minute is refused, never coerced",
  );

  // A closed day's window is not judged: it is never offered, so a nonsense window
  // on a closed day must not refuse the whole week.
  const closedWithJunk = [1, 2, 3, 4, 5, 6, 7].map((d) =>
    d === 7 ? row(d, false, 1200, 480) : row(d, true),
  );
  assert(
    resolveBusinessHours(closedWithJunk).ok === true,
    "a nonsense window on a CLOSED day does not refuse the week",
  );
}

// --- midnight boundary ---
{
  const toMidnight = [1, 2, 3, 4, 5, 6, 7].map((d) => row(d, d !== 7, 480, 1440));
  assert(resolveBusinessHours(toMidnight).ok === true, "an end at midnight (1440) is allowed");
}

finish();
