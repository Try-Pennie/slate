// Test for the booker timezone-picker option list (#172).
// Run: node --experimental-strip-types scripts/test-timezones.ts
import {
  CURATED_ZONES,
  deviceTimeZone,
  humanizeZone,
  timezoneOptions,
  allTimeZones,
  isKnownTimeZone,
  ensureZonePresent,
} from "../src/lib/booking/timezones.ts";
import { assert, finish } from "./lib/harness.ts";

// deviceTimeZone reports the runtime's resolved IANA zone when Intl is present,
// matching what the booker and manage-booking screen previously computed inline.
{
  const detected = deviceTimeZone();
  assert(
    detected === Intl.DateTimeFormat().resolvedOptions().timeZone,
    "deviceTimeZone returns the Intl-resolved zone when Intl is available",
  );
  assert(detected.length > 0, "deviceTimeZone never returns an empty string");
}

// When Intl is unavailable (SSR or a runtime without the Intl API) it falls back
// to the canonical default zone instead of throwing.
{
  const savedIntl = globalThis.Intl;
  // @ts-expect-error deliberately removing the global to exercise the fallback
  delete globalThis.Intl;
  try {
    assert(
      deviceTimeZone() === "America/New_York",
      "deviceTimeZone falls back to America/New_York when Intl is unavailable",
    );
  } finally {
    globalThis.Intl = savedIntl;
  }
}

// humanizeZone strips the region and underscores
assert(humanizeZone("America/New_York") === "New York", "humanize strips region + underscore");
assert(humanizeZone("Pacific/Honolulu") === "Honolulu", "humanize single-segment city");
assert(humanizeZone("UTC") === "UTC", "humanize passes through a bare id");

// every curated zone is a real, resolvable IANA id (Intl won't throw)
for (const z of CURATED_ZONES) {
  let ok = true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: z.id });
  } catch {
    ok = false;
  }
  assert(ok, `curated zone ${z.id} is a valid IANA id`);
  assert(z.label.trim().length > 0, `curated zone ${z.id} has a label`);
}

// a detected zone already in the curated list does not get duplicated
const ny = timezoneOptions("America/New_York");
assert(
  ny.filter((o) => o.id === "America/New_York").length === 1,
  "curated detected zone is not duplicated",
);
assert(ny.length === CURATED_ZONES.length, "curated detected zone adds no extra row");

// a detected zone NOT in the list (traveling lead) is prepended so they can keep it
const sydney = timezoneOptions("Australia/Sydney");
assert(sydney[0].id === "Australia/Sydney", "uncurated detected zone is prepended");
assert(sydney[0].label === "Sydney", "prepended zone gets a humanized label");
assert(sydney.length === CURATED_ZONES.length + 1, "prepended zone adds exactly one row");
assert(
  sydney.filter((o) => o.id === "Australia/Sydney").length === 1,
  "prepended zone appears once",
);

// every returned option list always contains the detected zone (the invariant
// the <select value> depends on — otherwise the control renders blank)
for (const detected of ["America/New_York", "Australia/Sydney", "Europe/Paris"]) {
  assert(
    timezoneOptions(detected).some((o) => o.id === detected),
    `options always include the detected zone (${detected})`,
  );
}

// undefined/empty (SSR or a device with no resolvable zone) falls back, never throws
const fallback = timezoneOptions(undefined);
assert(fallback.length === CURATED_ZONES.length, "undefined detected falls back to curated only");
assert(
  timezoneOptions("").some((o) => o.id === "America/New_York"),
  "empty detected falls back to a real default zone",
);

// --- full-IANA fallback for the "more zones" combobox (#219) ---

// allTimeZones returns the full deduped IANA set, and never throws.
const all = allTimeZones();
assert(Array.isArray(all) && all.length > 100, "allTimeZones returns the full IANA set");
assert(
  all.includes("America/New_York") && all.includes("Australia/Sydney"),
  "allTimeZones includes both common and uncommon zones",
);
assert(new Set(all).size === all.length, "allTimeZones has no duplicates");

// Guarded when Intl.supportedValuesOf is unavailable (older runtime): returns []
// rather than throwing, so the booker degrades to the curated list.
{
  const saved = (Intl as { supportedValuesOf?: unknown }).supportedValuesOf;
  // @ts-expect-error deliberately removing to exercise the guard
  delete (Intl as { supportedValuesOf?: unknown }).supportedValuesOf;
  try {
    assert(allTimeZones().length === 0, "allTimeZones degrades to [] when supportedValuesOf is missing");
  } finally {
    (Intl as { supportedValuesOf?: unknown }).supportedValuesOf = saved;
  }
}

// isKnownTimeZone gates free-text combobox input so a typo can't apply a bad zone.
assert(isKnownTimeZone("Australia/Sydney"), "isKnownTimeZone accepts a real zone");
assert(!isKnownTimeZone("Not/AZone"), "isKnownTimeZone rejects an unknown zone");
assert(!isKnownTimeZone(""), "isKnownTimeZone rejects empty input");

// ensureZonePresent keeps the <select value> from blanking when the applied zone
// (picked from the full list) is not in the curated options.
const curatedOnly = timezoneOptions("America/New_York");
assert(!curatedOnly.some((o) => o.id === "Australia/Sydney"), "precondition: sydney not curated");
const withSydney = ensureZonePresent(curatedOnly, "Australia/Sydney");
assert(
  withSydney[0].id === "Australia/Sydney" && withSydney[0].label === "Sydney",
  "ensureZonePresent prepends an out-of-list zone with a humanized label",
);
assert(
  ensureZonePresent(curatedOnly, "America/New_York").length === curatedOnly.length,
  "ensureZonePresent adds nothing when the zone is already present",
);

finish();
