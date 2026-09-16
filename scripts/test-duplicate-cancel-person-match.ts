// #2369: the database's notion of "the same person" and the booker's must not drift.
//
// `findPersonMatch` (src/lib/booking/person-dedupe.ts) is what decides, on the
// booking hot path, whether an incoming booking belongs to somebody who already has
// one. Migration 0124's `cancel_duplicate_booking` asks the same question in SQL, to
// decide whether a call Regal named is really a duplicate. Two implementations of one
// rule drift, and the drift here is silent in the worst direction: a cancel
// authorised by a match the rest of Slate would not make (L26, L263).
//
// So both are driven over ONE fixture table and required to agree, through the model
// of the SQL in scripts/lib/duplicate-cancel-rules.ts. What is executed here is the
// real `findPersonMatch` and that model; the PL/pgSQL itself is held against the
// model by the SQL assertions in scripts/test-duplicate-cancel.ts.
//
// THE TABLE INCLUDES THE ROWS THEY DISAGREE ABOUT, and the disagreement set is
// asserted exactly rather than left out of the fixtures (L48). There are two, both
// measured against libphonenumber on 2026-09-15, and both are a consequence of
// `toE164` handing back the raw string for a number it will not validate:
//
//   * a fictional 555 number written two ways is one number to the database and two
//     to `toE164`, so the database grades a two signal match medium where the booker
//     grades it weak;
//   * an international number written with spaces is one number to `toE164` and two
//     to the database, so the database grades it weak where the booker grades it
//     medium.
//
// Neither can turn ONE signal into two, which is the only direction that could cancel
// a stranger's call, and the assertion below is what holds that.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-duplicate-cancel-person-match.ts
import { assert, eq, finish } from "./lib/harness.ts";
import { decideDuplicateCancel, type DuplicateRow } from "./lib/duplicate-cancel-rules.ts";
import { findPersonMatch, type PersonIdentity } from "@/lib/booking/person-dedupe";
import type { Booking } from "@/lib/db/types";

const NOW = Date.parse("2026-09-16T12:00:00.000Z");
const NAMED_CREATED = "2026-09-10T10:00:00.000Z";
const OTHER_CREATED = "2026-09-12T10:00:00.000Z";
const STARTS = "2026-09-17T15:00:00.000Z";

/** One row of the shared table: a named booking and one other booking. */
interface Pair {
  name: string;
  named: Partial<DuplicateRow>;
  other: Partial<DuplicateRow>;
  /** True when the two implementations are known to differ, and why. */
  knownDifference?: string;
}

const namedRow = (over: Partial<DuplicateRow>): DuplicateRow => ({
  id: "bk-named",
  createdAt: NAMED_CREATED,
  startsAt: STARTS,
  status: "confirmed",
  isTestBucket: false,
  salesforceId: null,
  externalId: null,
  attendeeEmail: null,
  attendeePhone: null,
  ...over,
});

const otherRow = (over: Partial<DuplicateRow>): DuplicateRow =>
  namedRow({ id: "bk-other", createdAt: OTHER_CREATED, ...over });

/** The booking shape `findPersonMatch` reads. Only these fields are consulted. */
const asBooking = (r: DuplicateRow): Booking =>
  ({
    id: r.id,
    external_id: r.externalId,
    salesforce_id: r.salesforceId,
    attendee_email: r.attendeeEmail,
    attendee_phone: r.attendeePhone,
    starts_at: r.startsAt,
  }) as unknown as Booking;

/** The identity the booker would carry for the NAMED booking's lead. */
const asIdentity = (r: DuplicateRow): PersonIdentity => ({
  externalId: r.externalId,
  salesforceId: r.salesforceId,
  email: r.attendeeEmail,
  phone: r.attendeePhone,
});

const E164 = "+12035615295";
const TYPED = "(203) 561-5295";
const BARE = "2035615295";
const OTHER_NUMBER = "+16465550123";
const FICTIONAL_E164 = "5555555555";
const FICTIONAL_TYPED = "(555) 555-5555";
const INTL_TIGHT = "+442071838750";
const INTL_SPACED = "+44 20 7183 8750";

const PAIRS: Pair[] = [
  // --- strong ids -------------------------------------------------------------
  {
    name: "the same Salesforce id and nothing else",
    named: { salesforceId: "SF-1" },
    other: { salesforceId: "SF-1" },
  },
  {
    name: "different Salesforce ids and nothing else",
    named: { salesforceId: "SF-1" },
    other: { salesforceId: "SF-2" },
  },
  {
    name: "the same external id and nothing else",
    named: { externalId: "EXT-1" },
    other: { externalId: "EXT-1" },
  },
  {
    name: "different external ids and nothing else",
    named: { externalId: "EXT-1" },
    other: { externalId: "EXT-2" },
  },
  {
    name: "a Salesforce id on one side only",
    named: { salesforceId: "SF-1" },
    other: { salesforceId: null },
  },

  // --- email and phone together ------------------------------------------------
  {
    name: "the same address and the same number, both E.164",
    named: { attendeeEmail: "lead@example.com", attendeePhone: E164 },
    other: { attendeeEmail: "lead@example.com", attendeePhone: E164 },
  },
  {
    name: "the same address, the number stored E.164 on one side and as typed on the other",
    named: { attendeeEmail: "lead@example.com", attendeePhone: E164 },
    other: { attendeeEmail: "lead@example.com", attendeePhone: TYPED },
  },
  {
    name: "the same address, the number stored E.164 on one side and bare digits on the other",
    named: { attendeeEmail: "lead@example.com", attendeePhone: E164 },
    other: { attendeeEmail: "lead@example.com", attendeePhone: BARE },
  },
  {
    name: "the same address differing only in case and surrounding space",
    named: { attendeeEmail: " Lead@Example.com ", attendeePhone: E164 },
    other: { attendeeEmail: "lead@example.com", attendeePhone: TYPED },
  },
  {
    name: "the same address and a different number",
    named: { attendeeEmail: "lead@example.com", attendeePhone: E164 },
    other: { attendeeEmail: "lead@example.com", attendeePhone: OTHER_NUMBER },
  },
  {
    name: "the same number and a different address",
    named: { attendeeEmail: "lead@example.com", attendeePhone: E164 },
    other: { attendeeEmail: "someone.else@example.com", attendeePhone: TYPED },
  },
  {
    name: "the same number and no address on the other side",
    named: { attendeeEmail: "lead@example.com", attendeePhone: E164 },
    other: { attendeeEmail: null, attendeePhone: E164 },
  },
  {
    name: "a blank address on both sides is not an address they share",
    named: { attendeeEmail: "   ", attendeePhone: E164 },
    other: { attendeeEmail: "", attendeePhone: E164 },
  },
  {
    name: "neither side carries anything at all",
    named: {},
    other: {},
  },
  {
    name: "the same address and no number anywhere",
    named: { attendeeEmail: "lead@example.com" },
    other: { attendeeEmail: "lead@example.com" },
  },

  // --- the two known differences ----------------------------------------------
  {
    name: "a fictional 555 number written two ways, with a shared address",
    named: { attendeeEmail: "lead@example.com", attendeePhone: FICTIONAL_E164 },
    other: { attendeeEmail: "lead@example.com", attendeePhone: FICTIONAL_TYPED },
    knownDifference:
      "toE164 will not validate a 555 number and hands the raw string back, so the booker sees two numbers where the database sees one",
  },
  {
    name: "an international number written tight on one side and spaced on the other",
    named: { attendeeEmail: "lead@example.com", attendeePhone: INTL_TIGHT },
    other: { attendeeEmail: "lead@example.com", attendeePhone: INTL_SPACED },
    knownDifference:
      "toE164 normalises a valid international number and the database's digit rule leaves it as written, so the booker sees one number where the database sees two",
  },
  {
    name: "the same fictional 555 number written the same way",
    named: { attendeeEmail: "lead@example.com", attendeePhone: FICTIONAL_TYPED },
    other: { attendeeEmail: "lead@example.com", attendeePhone: FICTIONAL_TYPED },
  },
  {
    name: "the same international number written the same way",
    named: { attendeeEmail: "lead@example.com", attendeePhone: INTL_TIGHT },
    other: { attendeeEmail: "lead@example.com", attendeePhone: INTL_TIGHT },
  },
];

/** Does the booker consider them one person for the purpose of moving a booking? */
function bookerSaysSamePerson(named: DuplicateRow, other: DuplicateRow): boolean {
  const match = findPersonMatch(asIdentity(named), [asBooking(other)]);
  return match !== null && (match.strength === "strong" || match.strength === "medium");
}

/** Does the booker see ANY signal at all, however weak? */
function bookerSawSomething(named: DuplicateRow, other: DuplicateRow): boolean {
  return findPersonMatch(asIdentity(named), [asBooking(other)]) !== null;
}

/**
 * Does the database consider them one person? The other row is booked AFTER the
 * named one and starts later, so a cancel means yes and a refusal means no; an
 * identity conflict is the database declining to call them one person.
 */
function databaseSaysSamePerson(named: DuplicateRow, other: DuplicateRow): boolean {
  return decideDuplicateCancel({ named, others: [other], nowMs: NOW }).outcome === "cancelled";
}

const differed: string[] = [];
let agreed = 0;

for (const pair of PAIRS) {
  const named = namedRow(pair.named);
  const other = otherRow(pair.other);
  const booker = bookerSaysSamePerson(named, other);
  const database = databaseSaysSamePerson(named, other);
  if (booker === database) {
    agreed++;
    if (pair.knownDifference) {
      assert(false, `"${pair.name}" is listed as a known difference and the two now AGREE: remove the note`);
    }
  } else {
    differed.push(pair.name);
    assert(
      !!pair.knownDifference,
      `"${pair.name}": the booker and the database disagree about who is the same person`,
    );
  }

  // The safety direction, asserted on EVERY row including the ones they differ on:
  // the database may never call two bookings one person when the booker saw nothing
  // at all. A difference over HOW STRONG a two signal match is, is not the same thing
  // as inventing a match.
  if (database) {
    assert(
      bookerSawSomething(named, other),
      `"${pair.name}": the database calls them one person only where the booker sees a signal too`,
    );
  }
}

// Comparing nothing is never a pass (L98).
assert(PAIRS.length >= 15, `the shared table has ${PAIRS.length} pairs to compare`);
assert(agreed > 0, `the two agree on ${agreed} of ${PAIRS.length} pairs`);

// The disagreement set is pinned exactly, so a NEW one fails rather than joining an
// allowlist nobody re-reads.
eq(
  differed.sort().join(" | "),
  PAIRS.filter((p) => p.knownDifference)
    .map((p) => p.name)
    .sort()
    .join(" | "),
  "the only differences are the two measured ones, and both are still real",
);

// Both halves of the table do real work: the fixtures must produce BOTH answers, or a
// function hard wired to one of them would pass (L1).
{
  const yes = PAIRS.filter((p) => databaseSaysSamePerson(namedRow(p.named), otherRow(p.other))).length;
  assert(yes > 0 && yes < PAIRS.length, `the table produces both answers (${yes} same person, ${PAIRS.length - yes} not)`);
}

// Positive controls. A comparison that cannot report a disagreement is not a
// comparison, so a WRONG database is substituted and the same loop must catch it.
{
  // A database that accepted ONE signal, which is the mistake this whole endpoint
  // exists to avoid.
  const tooPermissive = (named: DuplicateRow, other: DuplicateRow) => bookerSawSomething(named, other);
  const caught = PAIRS.filter((pair) => {
    const named = namedRow(pair.named);
    const other = otherRow(pair.other);
    return bookerSaysSamePerson(named, other) !== tooPermissive(named, other);
  });
  assert(
    caught.length > 0,
    `control: a database that accepted a single signal is caught on ${caught.length} pairs`,
  );
}
{
  // A database that ignored the phone entirely would call a shared address alone a
  // match, and both sides must refuse that pair today.
  const named = namedRow({ attendeeEmail: "lead@example.com", attendeePhone: E164 });
  const other = otherRow({ attendeeEmail: "lead@example.com", attendeePhone: OTHER_NUMBER });
  assert(
    !databaseSaysSamePerson(named, other) && !bookerSaysSamePerson(named, other),
    "control: a shared address with a different number is one signal to both sides, and never a cancel",
  );
}

finish();
