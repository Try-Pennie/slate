// Test for the booker timezone-picker option list (#172).
// Run: node --experimental-strip-types scripts/test-timezones.ts
import {
  CURATED_ZONES,
  humanizeZone,
  timezoneOptions,
} from "../src/lib/booking/timezones.ts";
import { assert, finish } from "./lib/harness.ts";

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

finish();
