// The host page class on the booking outcome tally (#2752). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-tally-host-class.ts
//
// The failing bookings alarm (#1313) and its un-park watch (#2513) read the daily
// tally, and the tally used to know only whether the BUCKET was a test one. A tester
// on a real Low code from a page that is not the production site was a lead to it,
// so ten test attempts un-parked the watch and a testing session could page.
//
// What this file pins:
//  - the tally's host class is the SAME verdict the off site page (#2715) and the
//    below tier exclusion (#2737) reach, through the one predicate, imported and
//    never copied (L342);
//  - the tally args carry it, defaulting nowhere;
//  - migration 0143 stores exactly those three classes, keys the upsert on them, and
//    its mix function leaves off site attempts out of the counts unless asked;
//  - the failure rate reading asks for off site attempts to be left out, so a tester
//    burst from an off site host moves neither the rate nor the attempt floor that
//    un-parks the watch, while a production burst still moves both;
//  - what was left out is counted and stated, never shown as a smaller number with
//    no word about it.
import { readFileSync } from "node:fs";
import {
  HOST_CLASSES,
  bookingHostClass,
  isTestSourceBooking,
  judgeBookingOrigin,
  type BookingOriginFacts,
} from "@/lib/monitor/offsite-origin";
import {
  outcomeTallyArgs,
  normalizeMix,
  excludedOffsiteTrafficNote,
} from "@/lib/monitor/booking-api-outcome";
import { assert, eq, finish } from "./lib/harness.ts";

const facts = (parentOrigin: string | null, referrer: string | null = null): BookingOriginFacts => ({
  prefill: parentOrigin === null ? null : { parentOrigin },
  referrer_origin: referrer,
});

// --- one predicate, three readers ---------------------------------------------------
const CASES: { f: BookingOriginFacts; want: string; why: string }[] = [
  { f: facts("https://www.trypennie.com"), want: "production", why: "the production site" },
  { f: facts("https://trypennie.com", "https://trypennie.com"), want: "production", why: "production both ways" },
  { f: facts("http://localhost:3000"), want: "offsite", why: "a partner's localhost page" },
  { f: facts("https://dev.trypennie.com"), want: "offsite", why: "the dev site" },
  { f: facts(null, "https://staging.example.com"), want: "offsite", why: "framed by a page that declared nothing" },
  { f: facts("https://trypennie.com", "http://localhost:3000"), want: "offsite", why: "declared production, framed elsewhere" },
  { f: facts("not a url"), want: "offsite", why: "an origin the real widget cannot produce" },
  { f: facts(null), want: "none", why: "no host recorded (the standalone page, the API, admin)" },
];
for (const c of CASES) {
  eq(bookingHostClass(c.f), c.want, `host class: ${c.why}`);
  eq(bookingHostClass(c.f), judgeBookingOrigin(c.f).kind, `the tally agrees with the off site page: ${c.why}`);
  eq(isTestSourceBooking(c.f), c.want === "offsite", `the tally agrees with the below tier exclusion: ${c.why}`);
}
eq([...HOST_CLASSES].sort(), ["none", "offsite", "production"], "exactly the three classes the issue names");

// --- imported, never copied ---------------------------------------------------------
// The two recording modules must reach the class through the shared predicate, and
// neither may hold a production host of its own: a second list is how the three
// checks would come to disagree about a host.
for (const path of ["src/lib/monitor/test-traffic.ts", "src/app/booking/route.ts"]) {
  const src = readFileSync(path, "utf8");
  assert(/from "@\/lib\/monitor\/offsite-origin"/.test(src), `${path} imports the shared predicate`);
  assert(!src.includes("trypennie.com"), `${path} holds no production host of its own`);
  assert(!/classifyOrigin\(|new URL\(/.test(src), `${path} does not parse origins itself`);
}

// --- the tally args -----------------------------------------------------------------
const at = Date.parse("2026-09-25T15:00:00Z");
for (const hostClass of HOST_CLASSES) {
  const args = outcomeTallyArgs({ outcome: "error", bucketCode: "100", errorCode: "slot_unavailable", isTest: false, hostClass, atMs: at });
  eq(args.p_host_class, hostClass, `the args carry host class ${hostClass}`);
}

// --- migration 0143 -----------------------------------------------------------------
const sql = readFileSync("supabase/migrations/0143_booking_api_outcome_host_class.sql", "utf8");
const code = sql
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");
const checkList = /check\s*\(\s*host_class\s+in\s*\(([^)]*)\)\s*\)/i.exec(code)?.[1] ?? "";
eq(
  checkList.split(",").map((s) => s.trim().replace(/'/g, "")).sort(),
  [...HOST_CLASSES].sort(),
  "the column's CHECK names exactly HOST_CLASSES",
);
const keyCols = /add constraint booking_api_outcome_daily_key\s+unique\s*\(([^)]*)\)/i.exec(code)?.[1] ?? "";
const conflictCols = /on conflict\s*\(([^)]*)\)/i.exec(code)?.[1] ?? "";
const cols = (s: string) => s.split(",").map((c) => c.trim()).filter(Boolean);
assert(cols(keyCols).includes("host_class"), "the unique key includes host_class, so classes never collapse onto one row");
eq(cols(conflictCols), cols(keyCols), "the upsert's conflict target is exactly the FULL unique key (a partial index cannot back one, 42P10)");
assert(/drop constraint booking_api_outcome_daily_key\s*;/i.test(code), "the old key is dropped by its exact name, with no if exists");
assert(/p_host_class\s+text\s+default\s+'none'/i.test(code), "the bump's new argument defaults, so the Worker still deployed keeps writing");
assert(/p_include_offsite\s+boolean\s+default\s+false/i.test(code), "a caller that forgets gets off site attempts left out");
// Both counted slices must carry the exclusion; a filter on one alone would move the
// share while the error codes still counted the tester.
const mixBody = code.slice(code.search(/create or replace function booking_api_outcome_mix/i));
const filters = mixBody.match(/p_include_offsite\s+or\s+host_class\s*<>\s*'offsite'/gi) ?? [];
eq(filters.length, 2, "by_outcome and by_error both leave off site attempts out");
assert(/'offsite_total'/.test(mixBody), "the mix says how many off site attempts it left out");

// --- the failure rate reading asks for them to be left out --------------------------
const store = readFileSync("src/lib/monitor/booking-failure-rate-store.ts", "utf8");
assert(/rpc\("booking_api_outcome_mix", \{[^}]*p_include_offsite:\s*false/.test(store), "the failure rate window reads without off site attempts, explicitly");
const panel = readFileSync("src/app/admin/booking-outcomes/page.tsx", "utf8");
eq((panel.match(/rpc\("booking_api_outcome_mix", \{[^}]*p_include_offsite:\s*false/g) ?? []).length, 2, "the outcome panel measures the same population as the rate page");

// --- what was left out is stated -----------------------------------------------------
eq(normalizeMix({ by_outcome: { created: 3 }, offsite_total: 10 }).offsiteTotal, 10, "the mix carries the off site count");
eq(normalizeMix({ by_outcome: { created: 3 } }).offsiteTotal, null, "an absent count is unknown, never zero");
const notes = [excludedOffsiteTrafficNote(10), excludedOffsiteTrafficNote(0), excludedOffsiteTrafficNote(null)];
assert(notes[0].includes("10"), `ten excluded says ten: ${notes[0]}`);
eq(new Set(notes).size, 3, "excluded, none and unknown are three different sentences");
assert(!/\b0\b/.test(notes[2]), `an unknown count never reads as zero: ${notes[2]}`);
assert(excludedOffsiteTrafficNote(1).includes("1 call "), "singular for one call");

finish();
