// The catch-all behind a lead whose routing code is blank or unreadable (#1908).
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-routing-catchall.ts
//
// WHAT WAS WRONG. Slate refused any `xbc` outside the sixty valid codes, and
// `/book` with no `xbc` at all rendered "This booking link is missing its
// configuration". The recorded assumption was that such leads never receive a
// booking link. Measured on 2026-09-04 across 6,000 cal.com routing form
// responses, 105 carried a code Slate cannot route and 55 of them booked; the
// bulk was a completely BLANK code from the portal and offerhub form, 73 of 2,000
// there, 44 of which booked, a 60 percent booking rate.
//
// cal.com catches every one with an explicit catch all route and sends them to
// the Low pool, so the rule our notes called a malformed code safety net is
// carrying roughly 2 percent of all bookings. At cutover, Slate's refusal turns
// that 2 percent into a dead end.
//
// RE-MEASURED 2026-09-07: the newest 200 responses on the portal form carry 196
// valid codes, 4 blank and ZERO malformed. The malformed half was a September 2025
// problem and was fixed then, so the live case is a blank code. Both are handled
// here, because a malformed code costs nothing to handle and its absence today is
// not a guarantee about tomorrow.
//
// THE TWO CAUSES STAY APART. Absent and unreadable land on the same pool and are
// recorded as different reasons, because they send different people to different
// places: absent is the portal page dropping the parameter when Salesforce has no
// value, unreadable is a code that was mangled on the way. One reason answering
// for the other is how somebody spends a day on the wrong system (L11).
import {
  resolveRequestedCode,
  catchallRecord,
  CATCHALL_CODE,
  type CodeResolution,
} from "@/lib/routing/catchall";
import { bucketSpecForXbc, seederOwnsCode } from "@/lib/xbc";
import {
  HIDDEN_TEST_BUCKET_CODES,
  PUBLIC_TEST_BUCKET_CODES,
} from "@/lib/embed/public-test-bucket";
import { assert, eq, finish } from "./lib/harness.ts";

const PUBLIC_TEST = PUBLIC_TEST_BUCKET_CODES[0];

// --- the catch-all target has to be real ----------------------------------------
{
  // If the code this falls back to is not itself a code Slate can route, every
  // rescued lead lands on the same dead end by a longer path, and the tests below
  // would all pass while the feature did nothing (L1).
  assert(bucketSpecForXbc(CATCHALL_CODE) !== null, `the catch-all code ${CATCHALL_CODE} is a routable code`);
  assert(
    seederOwnsCode(CATCHALL_CODE),
    "and the seeder owns it, so the bucket exists in every environment rather than depending on somebody having created it",
  );
  const spec = bucketSpecForXbc(CATCHALL_CODE);
  eq(spec?.criteria.debt_team, "low", "it is the Low pool, which is where cal.com's own catch all sends these leads");
  assert(
    spec !== null && spec.criteria.backend_service === undefined,
    "with no backend constraint, because a lead with no code told us nothing about their backend",
  );
}

// --- a real code is passed straight through --------------------------------------
{
  for (const code of ["111", "100", "532", "412", "220"]) {
    const r = resolveRequestedCode(code);
    eq(r.kind, "valid", `${code} is routed as itself`);
    eq(r.code, code, `${code} keeps its own code`);
  }
}
{
  // Padding is real: a code copied out of Salesforce or a spreadsheet arrives with
  // spaces, and treating it as unreadable would send a perfectly good Ultra High
  // lead to the Low pool.
  const r = resolveRequestedCode("  412  ");
  eq(r.kind, "valid", "a padded code is trimmed, not rescued");
  eq(r.code, "412", "and keeps its own value");
}

// --- absent, which is the live case ----------------------------------------------
{
  for (const [label, raw] of [["undefined", undefined], ["null", null], ["empty", ""], ["spaces", "   "]] as const) {
    const r = resolveRequestedCode(raw);
    eq(r.kind, "catchall", `${label} is rescued rather than refused`);
    eq(r.code, CATCHALL_CODE, `${label} lands on the Low pool`);
    if (r.kind === "catchall") eq(r.reason, "absent", `${label} is recorded as absent`);
  }
}

// --- unreadable, kept as its own cause --------------------------------------------
{
  // Every shape that is not one of the sixty. `999` and `600` fail the tier digit,
  // `150` the third digit, `1111` the length, and `abc` everything.
  for (const raw of ["999", "600", "150", "1111", "11", "abc", "1a1", "0" , "-11"]) {
    const r = resolveRequestedCode(raw);
    eq(r.kind, "catchall", `${JSON.stringify(raw)} is rescued`);
    eq(r.code, CATCHALL_CODE, `${JSON.stringify(raw)} lands on the Low pool`);
    if (r.kind === "catchall") eq(r.reason, "unreadable", `${JSON.stringify(raw)} is recorded as unreadable, not absent`);
  }
}
{
  // The two-digit shape that really occurred, in September 2025, before it was
  // fixed upstream. Kept as a case because its absence today is not a promise.
  for (const raw of ["12", "22", "31"]) {
    const r = resolveRequestedCode(raw);
    eq(r.kind, "catchall", `the two digit code ${raw} is rescued rather than refused`);
    if (r.kind === "catchall") eq(r.reason, "unreadable", `${raw} is unreadable, since something was intended and arrived mangled`);
  }
}

// --- the public test bucket survives resolution (#2660) ----------------------------
{
  // The code is not an XBC, so without this branch it was rescued to the Low
  // pool BEFORE the page ever read the bucket row: a partner opening the embed
  // with the test code was shown the live Low booker and booked a real advisor
  // (red team finding 1). The exemption lives in this ONE resolver, which the
  // page and the booking service both call, rather than on the page.
  const r = resolveRequestedCode(PUBLIC_TEST);
  eq(r.kind, "valid", "the public test code passes through as itself");
  eq(r.code, PUBLIC_TEST, "and keeps its own code");
  const padded = resolveRequestedCode(`  ${PUBLIC_TEST}  `);
  eq(padded.kind, "valid", "a padded spelling is trimmed like any other code");
  eq(padded.code, PUBLIC_TEST, "and resolves to the same bucket");
  eq(
    resolveRequestedCode(PUBLIC_TEST.toLowerCase()).kind,
    "catchall",
    "a lower case spelling is not the test bucket and is rescued like any other unreadable code",
  );
  eq(
    resolveRequestedCode(`${PUBLIC_TEST}2`).kind,
    "catchall",
    "a near miss is rescued, never served",
  );
  // The HIDDEN test buckets are NOT let through. The page cannot know is_test
  // without a read, and answering the canary's code differently from a near miss
  // would tell a stranger it exists, which is what #601 keeps hidden on the API.
  // They keep going to the catch-all Low pool exactly as they did before.
  for (const hidden of HIDDEN_TEST_BUCKET_CODES) {
    const h = resolveRequestedCode(hidden);
    eq(h.kind, "catchall", `the hidden test code ${hidden} is still rescued to the Low pool`);
    eq(h.code, CATCHALL_CODE, `${hidden} lands on the Low pool like any unreadable code`);
    const near = resolveRequestedCode(`${hidden}Y`);
    eq(near.kind, "catchall", `and its near miss ${hidden}Y resolves the same way, so the two are indistinguishable`);
  }
  // Never counted as a rescue: a partner testing the embed is not a lead whose
  // routing input went missing, and the catch-all rate alert must not page on
  // a test.
  const rec = catchallRecord(PUBLIC_TEST, PUBLIC_TEST, undefined);
  eq(rec.catchallApplied, false, "a test booking is never recorded as a catch-all rescue");
  eq(rec.requestedCode, PUBLIC_TEST, "though what arrived is still recorded");
}

// --- what gets recorded ------------------------------------------------------------
{
  // The raw value travels VERBATIM, because it is the only evidence of what the
  // upstream page actually sent, and normalising it would erase the difference
  // between a blank field and a mangled one at exactly the point somebody is
  // trying to chase the cause.
  const r = resolveRequestedCode("  99z ");
  if (r.kind === "catchall") eq(r.requested, "  99z ", "the requested value is kept exactly as it arrived");
  const absent = resolveRequestedCode(undefined);
  if (absent.kind === "catchall") eq(absent.requested, "", "an absent code is recorded as empty rather than as the word undefined");
}

// --- it cannot rescue its own rescue -------------------------------------------------
{
  // Feeding the result back in must be a no-op. A resolver that re-rescued would
  // report a catch-all on a lead who legitimately asked for the Low pool, which
  // is precisely the population the alert counts.
  const once = resolveRequestedCode("");
  const twice = resolveRequestedCode(once.code);
  eq(twice.kind, "valid", "resolving the catch-all code is not itself a catch-all");
  eq(twice.code, CATCHALL_CODE, "and it stays put");
}
{
  // The distinction the alert rests on: a lead who genuinely carries the Low code
  // is NOT a catch-all, even though they end up in the same pool. Collapsing the
  // two would make the rate meaningless, since 100 is a heavily used real code.
  const genuine = resolveRequestedCode(CATCHALL_CODE);
  eq(genuine.kind, "valid", "a lead who really asked for 100 is not counted as rescued");
}

// --- the type is exhaustive ------------------------------------------------------------
{
  // Every resolution carries a code that is routable, whichever branch it took, so
  // no caller has to check before using it.
  const all: CodeResolution[] = [
    resolveRequestedCode("311"),
    resolveRequestedCode(""),
    resolveRequestedCode("nope"),
  ];
  for (const r of all) {
    assert(bucketSpecForXbc(r.code) !== null, `every resolution yields a routable code (${r.code})`);
  }
  // The one exception is stated rather than left implicit: the public test code
  // (#2660) is routable by its seeded bucket row, not by the XBC matrix, so it is
  // the one valid resolution `bucketSpecForXbc` does not know.
  const test = resolveRequestedCode(PUBLIC_TEST);
  assert(
    test.kind === "valid" && bucketSpecForXbc(test.code) === null,
    "the public test code is the one valid resolution outside the XBC matrix, routable by its seeded row",
  );
}

// --- what actually gets written against a booking ------------------------------------
{
  // The ordinary rescue: no code arrived, the booking landed in the Low pool.
  const r = catchallRecord("", CATCHALL_CODE, undefined);
  eq(r.catchallApplied, true, "a rescued booking is recorded as one");
  eq(r.requestedCode, "", "and keeps what arrived");
}
{
  const r = catchallRecord("311", "311", undefined);
  eq(r.catchallApplied, false, "a lead with a real code is not a catch-all");
  eq(r.requestedCode, "311", "though the raw value is still recorded");
}
{
  // An older embed sitting in a cached page sends nothing for this field. That is
  // NOT a lead who arrived with no code, and counting it as one would inflate the
  // very rate the alert watches with bookings that were routed perfectly well.
  const r = catchallRecord(undefined, "412", undefined);
  eq(r.catchallApplied, false, "a caller that did not say is not a catch-all");
  eq(r.requestedCode, null, "and records nothing rather than an empty string");
}
{
  // The guard. The raw value arrives from the client, so an unreadable code
  // alongside a bucket the rescue would never have chosen must not be recorded as
  // a rescue: the rate the alert watches is precisely the number that would be
  // wrong, and it would be wrong in the direction that pages somebody.
  const r = catchallRecord("999", "522", undefined);
  eq(r.catchallApplied, false, "a rescue that does not match the booked bucket is not recorded as one");
  eq(r.requestedCode, "999", "but what arrived is still kept, because it is evidence either way");
}
{
  // And the same shape when it IS consistent.
  const r = catchallRecord("999", CATCHALL_CODE, undefined);
  eq(r.catchallApplied, true, "an unreadable code that really did land in the Low pool is a rescue");
}
{
  // A lead who genuinely asked for the Low pool books into the same bucket a
  // rescue does. They must not be counted, or the rate becomes meaningless: 100
  // is one of the most used real codes on the roster.
  const r = catchallRecord(CATCHALL_CODE, CATCHALL_CODE, undefined);
  eq(r.catchallApplied, false, "a genuine Low lead is never counted as rescued, though they share the bucket");
}

finish();
