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
  sameClockListedZone,
  zonesKeepSameClock,
  FALLBACK_ZONE,
  ZONE_SAMPLE_HOURS,
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
  // America/Boise used to be on this list. #2687 reversed that: it keeps
  // Denver's clock, so it now SELECTS Denver (asserted below) rather than
  // falling back.
  for (const outside of ["Europe/London", "Australia/Sydney", "America/Regina"]) {
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

// --- a zone that keeps a listed clock under another name selects it (#2687) --
//
// Pinned to one instant so the named cases below do not walk with the calendar.
// The window it opens (400 days, hourly) covers both of 2026's and 2027's US
// clock changes.
const PINNED = Date.UTC(2026, 0, 15, 12);

// Every listed zone is its own clock, and selects itself.
for (const z of CURATED_ZONES) {
  eq(sameClockListedZone(z.id, PINNED), z.id, `${z.id} keeps its own clock`);
  const r = resolveZone(z.id, PINNED);
  eq(r.id, z.id, `${z.id} selects itself`);
  assert(!r.wasOutsideList, `${z.id} is not a fallback`);
}

// The named aliases from the issue, each on the clock it really keeps.
for (const [alias, listed] of [
  ["America/Boise", "America/Denver"],
  ["America/Indiana/Indianapolis", "America/New_York"],
  ["America/Kentucky/Louisville", "America/New_York"],
  ["America/Detroit", "America/New_York"],
  ["America/Juneau", "America/Anchorage"],
  ["America/Indiana/Knox", "America/Chicago"],
] as const) {
  const r = resolveZone(alias, PINNED);
  eq(r.id, listed, `${alias} selects ${listed}`);
  assert(!r.wasOutsideList, `${alias} is not a fallback: every time it shows reads the same`);
}

// Phoenix stays on its own row and is never folded into Denver, which it
// matches all winter and not in summer.
eq(resolveZone("America/Phoenix", PINNED).id, "America/Phoenix", "Phoenix stays Phoenix");
assert(!zonesKeepSameClock("America/Phoenix", "America/Denver", PINNED), "Phoenix is not Denver's clock");

// A zone matching a listed clock for only PART of the window must not map.
// Regina and Mexico City keep Chicago's clock all winter and an hour off it all
// summer; judged at one winter instant they would look identical.
for (const partial of ["America/Regina", "America/Mexico_City"]) {
  eq(sameClockListedZone(partial, PINNED), null, `${partial} matches Chicago only part of the year, so it maps nowhere`);
  const r = resolveZone(partial, PINNED);
  eq(r.id, FALLBACK_ZONE, `${partial} keeps the documented Eastern fallback`);
  assert(r.wasOutsideList, `${partial} is reported as a fallback`);
}

// A zone keeping no listed clock at all keeps the fallback, and so does one the
// runtime cannot read.
for (const none of ["Europe/London", "Asia/Tokyo", "Mars/Olympus"]) {
  const r = resolveZone(none, PINNED);
  eq(r.id, FALLBACK_ZONE, `${none} falls back to Eastern`);
  assert(r.wasOutsideList, `${none} is reported as a fallback`);
}
assert(!zonesKeepSameClock("Mars/Olympus", "Mars/Olympus", PINNED), "an unreadable zone is not even its own clock");

// Havana changes its clocks on New York's dates but at midnight rather than at
// 2am, so the two differ for THREE hours of the window and agree for every
// other. A daily sample at any hour but those would call them one clock; the
// hourly one must not.
assert(
  !zonesKeepSameClock("America/Havana", "America/New_York", PINNED),
  "Havana is not New York's clock, although they differ for only a few hours a year",
);
eq(resolveZone("America/Havana", PINNED).id, FALLBACK_ZONE, "so Havana keeps the fallback rather than mapping");

// The window really is a year and more: Denver and Phoenix agree for the first
// hours of a January window and must still be told apart.
assert(ZONE_SAMPLE_HOURS >= 366 * 24, `the window covers a whole year (${ZONE_SAMPLE_HOURS} hours)`);

// --- every America/ zone with a listed clock lands on it (#2687) -------------
//
// The oracle is written independently of the implementation: it reads each
// hour's offset as the runtime's own "GMT-07:00" label rather than by rebuilding
// the wall clock, so a fault in how the implementation turns parts into an
// offset cannot agree with itself here (L70).
{
  const labelFmt = new Map<string, Intl.DateTimeFormat>();
  const label = (zone: string, ms: number): string => {
    let f = labelFmt.get(zone);
    if (!f) {
      f = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" });
      labelFmt.set(zone, f);
    }
    return f.formatToParts(ms).find((p) => p.type === "timeZoneName")?.value ?? "";
  };
  const start = Math.floor(PINNED / 3_600_000) * 3_600_000;
  // Each listed zone's labels are read once for the whole window, not once per
  // zone compared against it, which halves what the sweep costs.
  const listedLabels = new Map<string, string[]>();
  for (const c of CURATED_ZONES) {
    const row: string[] = [];
    for (let h = 0; h < ZONE_SAMPLE_HOURS; h++) row.push(label(c.id, start + h * 3_600_000));
    listedLabels.set(c.id, row);
  }
  const oracleSame = (zone: string, listed: string): boolean => {
    const row = listedLabels.get(listed)!;
    for (let h = 0; h < ZONE_SAMPLE_HOURS; h++) {
      if (label(zone, start + h * 3_600_000) !== row[h]) return false;
    }
    return true;
  };

  const america = Intl.supportedValuesOf("timeZone").filter((z) => z.startsWith("America/"));
  // Add the IANA spellings a runtime's canonical list may omit, so the named
  // cases are checked by the oracle whichever spelling this runtime lists.
  for (const extra of ["America/Indiana/Indianapolis", "America/Kentucky/Louisville", "America/Boise"]) {
    if (!america.includes(extra)) america.push(extra);
  }
  assert(america.length > 100, `the runtime lists the America zones (${america.length})`);

  let mapped = 0;
  const byListed = new Map<string, string[]>();
  for (const zone of america) {
    const oracleMatches = CURATED_ZONES.filter((c) => oracleSame(zone, c.id)).map((c) => c.id);
    const expected = oracleMatches.length === 1 ? oracleMatches[0] : FALLBACK_ZONE;
    const r = resolveZone(zone, PINNED);
    eq(r.id, expected, `${zone} selects ${expected}`);
    if (oracleMatches.length === 1) {
      mapped++;
      byListed.set(expected, [...(byListed.get(expected) ?? []), zone]);
      assert(!r.wasOutsideList, `${zone} keeps ${expected}'s clock, so it is not a fallback`);
    } else {
      assert(r.wasOutsideList, `${zone} keeps no listed clock, so it is reported as a fallback`);
    }
  }
  // Positive control: an oracle that matched nothing would make every assertion
  // above a comparison of two fallbacks (L98). Each US mainland clock has
  // aliases, so each must have gathered some.
  assert(mapped > 20, `a real number of America zones keep a listed clock (${mapped})`);
  for (const listed of ["America/New_York", "America/Chicago", "America/Denver", "America/Anchorage"]) {
    assert((byListed.get(listed)?.length ?? 0) > 1, `${listed} gathers aliases beyond itself`);
  }
}

finish();
