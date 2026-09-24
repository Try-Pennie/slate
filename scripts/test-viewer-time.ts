// The one formatter for a booking time shown to staff (#1916).
//
// Six surfaces used to render booking times in Eastern, unlabelled, on the
// premise that the whole roster was Eastern, which #1739 measured false. Dan's
// decision (2026-09-24): the viewer's zone, labelled. So the formatter takes the
// zone as a REQUIRED argument (the caller is the device reading it) and always
// carries the zone abbreviation, which is what makes a time on a multi zone
// roster readable at all.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-viewer-time.ts
import { formatViewerTime, zoneAbbreviation } from "../src/lib/booking/viewer-time.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// 18:00 UTC on 3 Jul 2026: 11:00 in Phoenix (MST all year), 14:00 in New York (EDT).
const ISO = "2026-07-03T18:00:00Z";

eq(formatViewerTime(ISO, "America/Phoenix"), "Fri, Jul 3, 11:00am MST", "Phoenix viewer sees MST");
eq(formatViewerTime(ISO, "America/New_York"), "Fri, Jul 3, 2:00pm EDT", "New York viewer sees EDT");
eq(formatViewerTime(ISO, "America/Los_Angeles"), "Fri, Jul 3, 11:00am PDT", "Los Angeles viewer sees PDT");
// The server has no viewer, so it renders UTC, and says so.
eq(formatViewerTime(ISO, "UTC"), "Fri, Jul 3, 6:00pm UTC", "UTC is labelled UTC");

// The label follows the INSTANT, not the zone: New York in January is EST.
eq(zoneAbbreviation("2026-01-15T18:00:00Z", "America/New_York"), "EST", "winter New York is EST");
eq(zoneAbbreviation(ISO, "America/New_York"), "EDT", "summer New York is EDT");

// The day moves with the zone: 02:30 UTC on 4 Jul is still 3 Jul in Phoenix.
eq(
  formatViewerTime("2026-07-04T02:30:00Z", "America/Phoenix"),
  "Fri, Jul 3, 7:30pm MST",
  "the weekday and date are the viewer's, not UTC's",
);

// Seconds sit beside the minutes (#1943), so the stamp still reads as one time.
eq(
  formatViewerTime("2026-07-03T18:03:41Z", "America/Phoenix", { seconds: true }),
  "Fri, Jul 3, 11:03:41am MST",
  "seconds go beside the minutes",
);
eq(
  formatViewerTime("2026-07-03T18:03:05Z", "America/Phoenix", { seconds: true }),
  "Fri, Jul 3, 11:03:05am MST",
  "seconds are padded",
);

// An unreadable instant is null, never a plausible time (L67), and an unreadable
// zone is null too rather than silently falling back to one.
eq(formatViewerTime("not a time", "America/Phoenix"), null, "unreadable instant -> null");
eq(formatViewerTime(ISO, "Not/AZone"), null, "unreadable zone -> null");
assert(zoneAbbreviation("nope", "America/Phoenix") === null, "unreadable instant has no abbreviation");

finish();
