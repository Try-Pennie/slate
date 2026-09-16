// A MODEL of the rules migration 0124's `cancel_duplicate_booking` applies, and
// nothing that ships (#2369, #2307 phase 3).
//
// Slate has no database in its test suite, so the decision that actually runs is
// PL/pgSQL nothing here executes. Two guards stand in for that, and each is blind
// where the other looks:
//
//  - `scripts/test-duplicate-cancel.ts` drives THIS model through every outcome the
//    route can report, and separately reads the migration's SQL text and requires it
//    to carry each rule the model implements. A model that agreed with itself would
//    prove nothing (L52), so the SQL assertions are what tie it to the shipped
//    function, and a mutation control proves those assertions can fail.
//  - `scripts/test-duplicate-cancel-person-match.ts` drives this model and the
//    booker's own `findPersonMatch` over ONE fixture table and requires them to
//    agree about who is the same person, so the two notions of identity cannot
//    drift apart in silence (L26, L263).
//
// What it is NOT: this is not a second implementation anything calls. Nothing in
// `src/` imports it. If you change the SQL, change this, and the SQL assertions in
// the suite will tell you if you changed only one.
//
// THE PHONE RULE IS DELIBERATELY NOT `toE164`. `toE164` is libphonenumber, which
// reads real NANP number ranges (measured 2026-09-15: area code 500 is valid, 200
// and 999 are not), and no SQL expression can reproduce that. So the database judges
// a phone by its DIGITS: ten digits, or eleven beginning with 1, become `+1` plus the
// last ten; anything else is compared as the trimmed text it is. Measured against
// `toE164` over every format Slate actually stores, the two agree on real numbers;
// they part only where libphonenumber refuses to validate a number and hands the raw
// string back, and then this rule still sees two renderings of the same digits as one
// number. That can only turn a TWO signal match that `findPersonMatch` happens to
// grade weak into a medium one. It can never turn one signal into two, which is the
// direction that would cancel a stranger's call.

/** A booking as the decision needs to see it. Field for field the SQL's columns. */
export interface DuplicateRow {
  id: string;
  /** ISO. The SQL orders by `created_at`; "booked after" is the whole newest test. */
  createdAt: string;
  startsAt: string;
  status: string;
  /** `buckets.is_test` for this booking's bucket. `bookings` carries no such column. */
  isTestBucket: boolean;
  salesforceId: string | null;
  externalId: string | null;
  attendeeEmail: string | null;
  attendeePhone: string | null;
}

export type DuplicateOutcomeModel =
  | "not-found"
  | "already-cancelled"
  | "not-active"
  | "started"
  | "identity-conflict"
  | "named-is-newest"
  | "no-other-call"
  | "cancelled";

export type WeakerMatchModel = "phone-only" | "email-only" | null;

export interface DuplicateDecisionModel {
  outcome: DuplicateOutcomeModel;
  /** The candidates judged to be the same person, in id order. */
  candidateIds: string[];
  weakerMatch: WeakerMatchModel;
}

/** The active statuses, the same pair `CANCELLABLE_STATUSES` holds. */
export const ACTIVE_STATUSES = ["confirmed", "rescheduled"];

/** `nullif(lower(btrim(x)), '')`, exactly. */
export function emailMatchKey(raw: string | null): string | null {
  if (raw === null || raw === undefined) return null;
  const v = raw.trim().toLowerCase();
  return v.length > 0 ? v : null;
}

/** The digit rule the SQL applies. See the header for why it is not `toE164`. */
export function phoneMatchKey(raw: string | null): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const digits = trimmed.replace(/[^0-9]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return trimmed;
}

export interface DuplicateDecisionInput {
  /** The booking the caller named, or null when Slate holds none. */
  named: DuplicateRow | null;
  /** Whether Slate's own record says this booking was already cancelled AS a
   *  duplicate: the cancel outbox row, or the cancelled history event, carrying
   *  reason `double_booking`. The SQL asks the database; here the caller states it. */
  namedCancelledAsDuplicate?: boolean;
  /** Every other booking in the database. The model filters exactly as the SQL does,
   *  so a fixture can hand it rows that must NOT be considered. */
  others: DuplicateRow[];
  nowMs: number;
}

/**
 * The decision, in the order the SQL takes it.
 *
 * The identity conflict is a HARD VETO rather than a per candidate exclusion, and
 * that is a choice rather than a detail: this endpoint exists so a wrong id can never
 * cancel somebody's only call, so when two upcoming calls carry the same email and
 * phone under different Salesforce ids, the safe answer is to refuse and let a person
 * look, even if a third call would otherwise have authorised the cancel.
 *
 * A strong id that MATCHES settles identity before the conflict is asked, so a lead
 * whose two calls share a Salesforce id and differ on an external id is one person.
 */
export function decideDuplicateCancel(input: DuplicateDecisionInput): DuplicateDecisionModel {
  const none = { candidateIds: [] as string[], weakerMatch: null as WeakerMatchModel };
  const named = input.named;
  if (!named) return { outcome: "not-found", ...none };

  if (named.status === "cancelled") {
    return {
      outcome: input.namedCancelledAsDuplicate ? "already-cancelled" : "not-active",
      ...none,
    };
  }
  if (!ACTIVE_STATUSES.includes(named.status)) return { outcome: "not-active", ...none };
  if (Date.parse(named.startsAt) <= input.nowMs) return { outcome: "started", ...none };

  const namedEmail = emailMatchKey(named.attendeeEmail);
  const namedPhone = phoneMatchKey(named.attendeePhone);
  const namedCreated = Date.parse(named.createdAt);

  const same: string[] = [];
  const newer: string[] = [];
  let conflict = false;
  let weakEmail = false;
  let weakPhone = false;

  const candidates = input.others
    .filter((b) => b.id !== named.id)
    .filter((b) => ACTIVE_STATUSES.includes(b.status))
    .filter((b) => Date.parse(b.startsAt) > input.nowMs)
    .filter((b) => b.isTestBucket === named.isTestBucket)
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (const c of candidates) {
    const sfHit = named.salesforceId !== null && c.salesforceId === named.salesforceId;
    const extHit = named.externalId !== null && c.externalId === named.externalId;
    const strong = sfHit || extHit;
    const emailHit = namedEmail !== null && emailMatchKey(c.attendeeEmail) === namedEmail;
    const phoneHit = namedPhone !== null && phoneMatchKey(c.attendeePhone) === namedPhone;
    const medium = emailHit && phoneHit;
    if (!strong && !emailHit && !phoneHit) continue;

    const clash =
      (!sfHit && named.salesforceId !== null && c.salesforceId !== null) ||
      (!extHit && named.externalId !== null && c.externalId !== null);

    if (strong) {
      same.push(c.id);
      if (Date.parse(c.createdAt) > namedCreated) newer.push(c.id);
      continue;
    }
    if (medium) {
      if (clash) {
        conflict = true;
        continue;
      }
      same.push(c.id);
      if (Date.parse(c.createdAt) > namedCreated) newer.push(c.id);
      continue;
    }
    // One signal only. It never authorises a cancel; it is reported so the notice can
    // say what Slate did see rather than only what it did not (L11).
    if (emailHit) weakEmail = true;
    else if (phoneHit) weakPhone = true;
  }

  // An address identifies a person better than a line a household shares, so when
  // both kinds of near miss exist the address is the one a reader is told about.
  const weakerMatch: WeakerMatchModel = weakEmail ? "email-only" : weakPhone ? "phone-only" : null;

  if (conflict) return { outcome: "identity-conflict", candidateIds: same, weakerMatch };
  if (same.length === 0) return { outcome: "no-other-call", candidateIds: [], weakerMatch };
  if (newer.length === 0) return { outcome: "named-is-newest", candidateIds: same, weakerMatch };
  return { outcome: "cancelled", candidateIds: same, weakerMatch };
}
