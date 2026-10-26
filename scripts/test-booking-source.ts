// Where a booking came from (#2072).
//
// cal.com told the sources apart by WHICH event type took the booking: seven
// routing forms, each feeding its own event type. Slate collapses them into one
// flow, so the page a lead booked from rides on the link as `source` and is
// recorded on the booking row, validated against ONE vocabulary.
//
// The expected values in this file come from OUTSIDE the code on purpose (L70):
// the page to event type table is copied from Dan's decision on the issue
// (2026-09-24), read off the live cal.com routing forms for org 19474. A test
// that built its expectation from `SOURCE_DETAILS` itself would pass whatever the
// mapping said.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-booking-source.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import { BOOKING_API_CALLERS, CANCEL_ONLY_CALLERS, FULL_API_CALLERS } from "../src/lib/booking/api-callers.ts";
import {
  API_SOURCES,
  apiSourceFor,
  isApiSource,
  BOOKING_SOURCE_PARAM,
  BOOKING_SOURCES,
  PAGE_SOURCES,
  SOURCE_DETAILS,
  SOURCE_NOT_GIVEN,
  SOURCE_UNRECOGNISED,
  readBookingSource,
} from "../src/lib/booking/booking-source.ts";
import { latestCheckValues } from "./lib/scan-check-constraint.ts";
import { MIRROR_TABLES } from "../src/lib/snowflake/export-core.ts";

// --- the vocabulary and its mapping, pinned to the issue's table -------------
const DECIDED: Record<string, string | null> = {
  "my-offers-result": "review",
  booking: "review",
  "booking-agent-eligible": "connect",
  "booking-portal": "call",
  offerhub: "call",
  "rml-portal": "income",
  "email-booking": "terms",
  "guided-app": "apply",
  "agent-direct": "meet",
  // #2873: the trypennie surfaces that move to Slate with #2870, each mapped to the
  // routing form its booker opens today, read off trypennie main (3ff7b7b,
  // 2026-09-30): /pennie/[SO_ID] and /my-offers/result-2 open PRIMARY_BOOKING_LINK
  // (b839aed8, the review form), /review-terms/[SO_ID] opens 5022c0c9 (the terms
  // form), and the /portal-2 and /portal-3 calendar opens OFFERHUB_BOOKING_LINK
  // (255a083e, Income Verification, the call event type).
  pennie: "review",
  "review-terms": "terms",
  "my-offers-result-2": "review",
  "income-landing": "call",
  "not-given": null,
  unrecognised: null,
  // #2876: a booking API call that named no page records WHO called, one value per
  // caller holding a key (#2645). Typed out here rather than read off the constant,
  // so a rename of a caller has to be seen in this file too (L70).
  "api-regal": null,
  "api-trypennie": null,
  "api-canary": null,
  // #3543: a booking Marcia made through her booking MCP endpoint, one per MCP channel.
  "mcp-marcia": null,
  // #4200: the booking page scheduling coordinators use while on the phone with the
  // customer. A person's door, not a landing page, so no cal.com event type.
  coordinator: null,
};

eq(BOOKING_SOURCE_PARAM, "source", "the URL key a page sets is `source`");
eq(
  [...BOOKING_SOURCES].sort().join(","),
  Object.keys(DECIDED).sort().join(","),
  "the vocabulary is exactly the decided pages, not-given, unrecognised and one API source per caller",
);

// --- #2876: the API sources are DERIVED from the callers that hold a key -------
// A caller added to BOOKING_API_CALLERS gets its source by construction, so its
// bookings can never fall back to not-given and hide a dark page.
eq(
  [...API_SOURCES].sort().join(","),
  FULL_API_CALLERS.map((c) => `api-${c}`).sort().join(","),
  "there is exactly one API source per booking API caller that may book",
);
// #2940: a cancel only caller can never create a booking, so it has no source and the
// database CHECK needs no value for it. Positive half first, so the absence below is
// measured against a list that really does hold the cancel only caller.
assert(BOOKING_API_CALLERS.includes("marcia"), "Marcia is a booking API caller");
for (const caller of CANCEL_ONLY_CALLERS) {
  assert(!isApiSource(`api-${caller}`), `api-${caller} is not a source: ${caller} cannot book`);
}
for (const caller of FULL_API_CALLERS) {
  eq(apiSourceFor(caller), `api-${caller}`, `the ${caller} caller records api-${caller}`);
  assert(isApiSource(apiSourceFor(caller)), `api-${caller} is recognised as an API source`);
  assert(!(PAGE_SOURCES as readonly string[]).includes(apiSourceFor(caller)), `api-${caller} is not a page a link can name`);
}
for (const s of [...PAGE_SOURCES, SOURCE_NOT_GIVEN, SOURCE_UNRECOGNISED, null]) {
  assert(!isApiSource(s), `${s ?? "null"} is not an API source`);
}

// Reading a request from an authenticated caller.
eq(
  readBookingSource({ xbc: "411" }, "regal"),
  { source: "api-regal", unrecognisedRaw: null },
  "an API call naming no page records its caller, never not-given",
);
eq(
  readBookingSource({ source: "  " }, "trypennie"),
  { source: "api-trypennie", unrecognisedRaw: null },
  "a blank source from an API caller also records the caller",
);
eq(readBookingSource(null, "canary"), { source: "api-canary", unrecognisedRaw: null }, "no prefill at all from the canary records api-canary");
eq(
  readBookingSource({ source: "offerhub" }, "trypennie"),
  { source: "offerhub", unrecognisedRaw: null },
  "a page the API caller names wins over the caller, because the page is the finer fact",
);
eq(
  readBookingSource({ source: "offer-hub" }, "regal"),
  { source: "unrecognised", unrecognisedRaw: "offer-hub" },
  "an unknown value from an API caller stays unrecognised: it named a page, just a wrong one",
);
eq(
  readBookingSource({ source: "api-regal" }),
  { source: "unrecognised", unrecognisedRaw: "api-regal" },
  "a public link cannot claim to be the booking API",
);
eq(
  readBookingSource({ source: "api-regal" }, "trypennie"),
  { source: "unrecognised", unrecognisedRaw: "api-regal" },
  "one API caller cannot record itself as another",
);
for (const [source, legacy] of Object.entries(DECIDED)) {
  eq(
    SOURCE_DETAILS[source as keyof typeof SOURCE_DETAILS]?.legacyEventType ?? null,
    legacy,
    `${source} maps to the legacy cal.com event type ${legacy ?? "(none)"}`,
  );
}
assert(
  !PAGE_SOURCES.includes(SOURCE_NOT_GIVEN as never) && !PAGE_SOURCES.includes(SOURCE_UNRECOGNISED as never),
  "not-given and unrecognised are outcomes, not pages a link can name",
);
for (const s of BOOKING_SOURCES) {
  // Digits too (#2873): trypennie's own page is /my-offers/result-2, and a digit
  // travels in a URL unencoded exactly as a letter does. Uppercase, spaces and
  // punctuation are what this keeps out.
  assert(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(s), `${s} is a lowercase kebab value a URL can carry unencoded`);
  assert((SOURCE_DETAILS[s]?.page ?? "").trim().length > 0, `${s} has a description to show an admin`);
}

// --- reading a link ----------------------------------------------------------
eq(readBookingSource({ source: "offerhub" }), { source: "offerhub", unrecognisedRaw: null }, "a known page is recorded as itself");
eq(
  readBookingSource({ source: "  OfferHub " }),
  { source: "offerhub", unrecognisedRaw: null },
  "case and surrounding space on a link do not make a known page unknown",
);
for (const s of PAGE_SOURCES) {
  eq(readBookingSource({ source: s }).source, s, `every page source reads back as itself (${s})`);
}

// Absent is its OWN recorded value, not an empty string standing in for it.
eq(readBookingSource({}), { source: "not-given", unrecognisedRaw: null }, "no source on the link reads as not-given");
eq(readBookingSource({ xbc: "411" }), { source: "not-given", unrecognisedRaw: null }, "other params alone are still not-given");
eq(readBookingSource({ source: "" }), { source: "not-given", unrecognisedRaw: null }, "an empty source is not-given");
eq(readBookingSource({ source: "   " }), { source: "not-given", unrecognisedRaw: null }, "a blank source is not-given");
eq(readBookingSource(null), { source: "not-given", unrecognisedRaw: null }, "no prefill at all is not-given");
eq(readBookingSource(undefined), { source: "not-given", unrecognisedRaw: null }, "an undefined prefill is not-given");

// Unknown is a DIFFERENT outcome from absent: a link that named a page Slate does
// not know is a broken link somebody should fix, and folding it into not-given
// would hide it among the older links that legitimately carry nothing.
eq(
  readBookingSource({ source: "offer-hub" }),
  { source: "unrecognised", unrecognisedRaw: "offer-hub" },
  "a typo is recorded as unrecognised and hands back the raw value for the log",
);
eq(
  readBookingSource({ source: "not-given" }),
  { source: "unrecognised", unrecognisedRaw: "not-given" },
  "a link cannot claim the not-given outcome by naming it",
);
eq(
  readBookingSource({ source: "unrecognised" }),
  { source: "unrecognised", unrecognisedRaw: "unrecognised" },
  "naming unrecognised is itself unrecognised",
);
eq(
  readBookingSource({ source: 42 } as unknown as Record<string, string>).source,
  "unrecognised",
  "a present non string value is unrecognised, not absent",
);
const long = "x".repeat(500);
assert(
  (readBookingSource({ source: long }).unrecognisedRaw ?? "").length <= 100,
  "the raw value handed to the log is bounded",
);

// --- the database constraint agrees with the constant ------------------------
const migrationsDir = join(process.cwd(), "supabase/migrations");
const migrations = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => ({ file: f, sql: readFileSync(join(migrationsDir, f), "utf8") }));
const allowed = latestCheckValues(migrations, "bookings_source_check");
assert(allowed != null, "a migration defines bookings_source_check");
eq(
  [...(allowed ?? [])].sort().join(","),
  [...BOOKING_SOURCES].sort().join(","),
  "bookings_source_check allows exactly the values in BOOKING_SOURCES",
);

// Positive controls for the constraint reader, so a parser that read nothing
// cannot pass the agreement check above by accident (L1).
eq(
  latestCheckValues(
    [
      { file: "a.sql", sql: "alter table t add constraint k check (c in ('x', 'y'));" },
      { file: "b.sql", sql: "alter table t drop constraint k;\nalter table t add constraint k\n  check (c is null or c in ('x','y','z'));" },
    ],
    "k",
  )?.join(","),
  "x,y,z",
  "the reader takes the LATEST definition of the constraint",
);
eq(latestCheckValues([{ file: "a.sql", sql: "select 1;" }], "k"), null, "no definition reads as null, not an empty list");

// --- the URL contract in the README lists what the code accepts --------------
// A page author reads the README, not the constant, so a source missing there is
// one nobody can use, and a stale row sends them to a value the server rejects.
const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");
const rows = [...readme.matchAll(/^\s*\|\s*`([a-z0-9-]+)`\s*\|[^|]*\|\s*([a-z]+)\s*\|\s*$/gm)].map((m) => [m[1], m[2]]);
eq(
  rows.map(([s]) => s).sort().join(","),
  [...PAGE_SOURCES].sort().join(","),
  "the README's source table lists exactly the page sources",
);
for (const [s, legacy] of rows) {
  eq(legacy, SOURCE_DETAILS[s as keyof typeof SOURCE_DETAILS]?.legacyEventType, `the README maps ${s} to the same cal.com event type`);
}

// --- the warehouse can answer "where did last month's bookings come from" -----
// The mirror is the reader the issue names, so the column has to reach it. The
// column-by-column agreement with the CREATE is scripts/test-snowflake-mirror-columns.ts;
// this pins the ALTER that adds it to the ALREADY provisioned warehouse, since
// every CREATE there is IF NOT EXISTS and would never add it.
const bookingsMirror = MIRROR_TABLES.find((t) => t.table === "bookings");
eq(
  bookingsMirror?.cols.find((c) => c.name === "source")?.type,
  "varchar",
  "the bookings mirror exports source as a varchar",
);
const setupSql = readFileSync(join(process.cwd(), "docs/snowflake-setup.sql"), "utf8");
assert(
  /ALTER TABLE IF EXISTS\s+bookings\s+ADD COLUMN IF NOT EXISTS\s+source\s+VARCHAR\s*;/i.test(setupSql),
  "the warehouse setup carries the ALTER that adds source to an existing bookings mirror",
);

finish();
