/**
 * #1338: the manage page's heading says how far away the call is ("Aisha, in
 * three days"). It is COMPUTED at render from the booking's time, so a
 * reschedule moves it and a link opened days later reads correctly.
 *
 * Run: node --experimental-strip-types scripts/test-booking-countdown.ts
 */
import { countdownPhrase, advisorFirstName } from "../src/lib/booking/countdown.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ZONE = "America/New_York";
/** Fri 2026-08-14, 10:00 in New York. */
const NOW = Date.parse("2026-08-14T14:00:00.000Z");

eq(countdownPhrase("2026-08-14T18:00:00.000Z", NOW, ZONE), "today", "later the same day");
eq(countdownPhrase("2026-08-15T13:00:00.000Z", NOW, ZONE), "tomorrow", "the next day");
eq(countdownPhrase("2026-08-17T13:00:00.000Z", NOW, ZONE), "in three days", "spelled out to ten");
eq(countdownPhrase("2026-08-24T13:00:00.000Z", NOW, ZONE), "in ten days", "ten is still a word");
eq(countdownPhrase("2026-08-28T13:00:00.000Z", NOW, ZONE), "in 14 days", "past ten it is figures");

// Counted in CALENDAR days in the viewer's zone, not in 24 hour blocks: a call
// at 9am tomorrow is "tomorrow" whether it is 8pm or 2am now, which is how a
// person reads their own diary.
{
  const lateEvening = Date.parse("2026-08-15T02:00:00.000Z"); // Fri 22:00 New York
  eq(
    countdownPhrase("2026-08-15T13:00:00.000Z", lateEvening, ZONE),
    "tomorrow",
    "eleven hours ahead but the next calendar day reads tomorrow",
  );
}
{
  // The viewer's zone genuinely decides. At this instant it is Fri 10:00 in New
  // York and Sat 02:00 in Auckland, and the call lands Sat 07:00 in New York but
  // Sat 23:00 in Auckland: the same booking is "tomorrow" to one viewer and
  // "today" to the other.
  const call = "2026-08-15T11:00:00.000Z";
  eq(countdownPhrase(call, NOW, ZONE), "tomorrow", "tomorrow for the Eastern viewer");
  eq(
    countdownPhrase(call, NOW, "Pacific/Auckland"),
    "today",
    "the same call is today for a viewer a day ahead",
  );
}

// A booking whose time has passed is still `confirmed` until the completion
// sweep runs, so this is reachable. Null, never "in minus two days": the caller
// drops the countdown and the heading carries just the advisor's name.
eq(countdownPhrase("2026-08-12T13:00:00.000Z", NOW, ZONE), null, "a past day has no countdown");
eq(
  countdownPhrase("not-a-timestamp", NOW, ZONE),
  null,
  "an unreadable stamp yields no phrase rather than a nonsense one",
);

// The countdown must track the booking, so the SAME clock with two different
// booking times must give two different answers. This is the assertion that
// would fail if the phrase were ever stamped at booking time.
assert(
  countdownPhrase("2026-08-15T13:00:00.000Z", NOW, ZONE) !==
    countdownPhrase("2026-08-17T13:00:00.000Z", NOW, ZONE),
  "moving the booking changes the phrase, so it cannot be a stored value",
);

eq(advisorFirstName("Aisha Bello"), "Aisha", "the greeting uses the first name");
eq(advisorFirstName("Aisha"), "Aisha", "a single name is used as-is");
eq(advisorFirstName("  Aisha   Bello "), "Aisha", "surrounding space is ignored");
eq(advisorFirstName(null), null, "no name resolves to no greeting, never a placeholder");
eq(advisorFirstName("   "), null, "a blank name resolves to no greeting");

finish();
