// The timezone picker's option list, and which option a stored zone selects.
//
// #172 and #219 built this the other way round: a curated list that GREW to hold
// whatever zone was detected or typed, plus a searchable full IANA fallback, so a
// travelling lead kept their own zone. #1849 reversed that to a fixed US list.
//
// The assertions that defended the old behaviour are DELETED rather than
// adjusted. A test whose whole content is a decision that has since been
// reversed stops being coverage and becomes the guard defending the rejected
// behaviour (L252), and there is no version of "the list grows by one" that is a
// smaller form of "the list is fixed".
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-timezones.ts
import {
  CURATED_ZONES,
  deviceTimeZone,
  humanizeZone,
  timezoneOptions,
  resolveZone,
} from "../src/lib/booking/timezones.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// --- deviceTimeZone ---------------------------------------------------------
{
  const detected = deviceTimeZone();
  assert(
    detected === Intl.DateTimeFormat().resolvedOptions().timeZone,
    "deviceTimeZone returns the Intl-resolved zone when Intl is available",
  );
  assert(detected.length > 0, "deviceTimeZone never returns an empty string");
}

// --- humanizeZone -----------------------------------------------------------
assert(humanizeZone("America/New_York") === "New York", "humanize strips the region and underscores");
assert(humanizeZone("UTC") === "UTC", "humanize passes through a bare id");

// --- the list is US only, and FIXED ------------------------------------------
{
  const NON_US = ["Europe/London", "Europe/Paris", "UTC", "Australia/Sydney"];
  for (const id of NON_US) {
    assert(
      !CURATED_ZONES.some((z) => z.id === id),
      `${id} is not offered: the list is US only (#1849)`,
    );
  }
  // The positive control on the four above. Without it a list that had somehow
  // become EMPTY would satisfy every one of them (L98).
  assert(CURATED_ZONES.length >= 5, `the list is a real list (${CURATED_ZONES.length} zones)`);
  for (const id of ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles"]) {
    assert(CURATED_ZONES.some((z) => z.id === id), `${id} is offered`);
  }

  // It does not grow for anybody. This is the reversal, asserted directly: the
  // old behaviour prepended a detected zone that was not curated, and that is
  // precisely what a fixed list must not do.
  eq(timezoneOptions().length, CURATED_ZONES.length, "the option list is exactly the curated zones");
}

// --- which option a stored or detected zone selects --------------------------
{
  // In the list: kept, and reported as kept.
  const denver = resolveZone("America/Denver");
  eq(denver.id, "America/Denver", "a zone in the list is kept");
  assert(!denver.wasOutsideList, "and is not reported as a fallback");

  // Outside the list: answered EXPLICITLY. Neither blank, which hides that a
  // choice is needed, nor whatever happens to be first, which would move
  // somebody's working hours without telling them.
  for (const outside of ["Europe/London", "Australia/Sydney", "America/Boise"]) {
    const r = resolveZone(outside);
    assert(
      CURATED_ZONES.some((z) => z.id === r.id),
      `${outside} resolves to a zone the list can actually show (${r.id})`,
    );
    assert(r.id.length > 0, `${outside} never resolves to an empty value`);
    assert(r.wasOutsideList, `${outside} is REPORTED as having fallen back, so a caller can say so`);
  }

  // Not chosen yet is a different thing from chosen and no longer offered, and
  // the flag has to tell them apart or a caller cannot phrase either honestly.
  for (const empty of [undefined, ""]) {
    const r = resolveZone(empty);
    assert(CURATED_ZONES.some((z) => z.id === r.id), "an unset zone still resolves to a real option");
    assert(
      !r.wasOutsideList,
      "an unset zone is a default, not a fallback: nobody's choice was taken away",
    );
  }
}

// --- the roster's own zones are all representable ----------------------------
//
// Measured against production on 2026-09-03 and then MIGRATED to match: 9
// schedules on America/Boise became America/Denver and 1 on
// America/Indiana/Indianapolis became America/New_York, both proven
// offset-identical across a full year including the daylight saving
// transitions. These are the zones the 138 live schedules actually hold, so a
// future edit to the list that stranded one of them fails here rather than in
// front of an agent.
for (const stored of [
  "America/New_York",
  "America/Phoenix",
  "America/Denver",
  "America/Los_Angeles",
  "America/Chicago",
]) {
  const r = resolveZone(stored);
  eq(r.id, stored, `a live agent on ${stored} keeps it`);
  assert(!r.wasOutsideList, `and ${stored} is not treated as a fallback`);
}

finish();
