/**
 * What Salesforce holds for one email address, and the ONE reading of it (#2387).
 * Pure.
 *
 * An address can answer to more than one Salesforce User. That is not a corner
 * case: measured against the live org on 2026-08-31, two addresses were shared by
 * more than one ACTIVE record, and the shape that hurts is ordinary. A rehire is
 * given a fresh Salesforce user with the old record left inactive on the same
 * address, or a new hire is given an address a departed colleague once had.
 *
 * Before this module there were TWO readings of that state, either side of a
 * module boundary, and they said opposite things about the same address in the
 * same run: the reap deactivated on ANY inactive record, and the roster reconcile
 * counted the address as somebody Salesforce still holds. So the hourly sync both
 * wrote the person's row from the active record and set `deactivated_at` on it,
 * reported `deactivated: 1` as an ordinary departure, and did it again at the top
 * of the next hour to anybody who reactivated them. Two same named readings either
 * side of a boundary implement different rules for as long as nobody puts them
 * next to each other (L263), so there is one of them now and both callers come
 * through it.
 *
 * ## The rules
 *
 * **The stored key decides when there is one.** `users.salesforce_user_id` is the
 * stable cross system key (#1587), and it is the only thing that can say WHICH of
 * two records for one address a Slate row is about. When it names one of the
 * address's records, that record's own `IsActive` is the whole answer and the
 * other record is somebody else's.
 *
 * **Many records and nothing to choose between them is a REFUSAL** (L521). A
 * lookup that requires exactly one match must treat many as its own refusal, never
 * as absence and never as a verdict. #1587 already decided that shape for the id
 * column itself (`salesforceIdAmbiguous`); this is the same state reaching a
 * different decision, so it refuses the same way and is reported beside it.
 *
 * **Absence stays absence.** An address Salesforce returned no record for is
 * `absent`, never `departed`: the reap acts on a POSITIVE inactive record and
 * always has, because a person can be active in Salesforce and simply not be in
 * the slice of the org a given query asked about.
 */
import { normalizeEmail } from "@/lib/auth/email";

/**
 * What Salesforce holds for one address, kept as the RECORDS rather than as one
 * verdict.
 *
 * The ids are here because a boolean pair cannot answer "which of these is this
 * Slate row". They are Salesforce `User.Id` values; a record that arrives without
 * one still contributes its activity to the two flags, so a response missing the
 * id column degrades to the address wide reading rather than to silence.
 */
export interface SalesforcePresence {
  anyActive: boolean;
  anyInactive: boolean;
  /** Salesforce record ids for this address reported ACTIVE. */
  activeIds: string[];
  /** Salesforce record ids for this address reported INACTIVE. */
  inactiveIds: string[];
}

/**
 * Where one Slate roster row stands with Salesforce, once the shared address
 * question has been answered.
 *
 * Four outcomes and not three, because a refusal is a different thing from every
 * verdict and must never be told as one (L11). Each caller maps them to its own
 * vocabulary, and no caller may re-derive them.
 */
export type SalesforceStanding =
  /** Salesforce returned no record at all for the address. */
  | "absent"
  /** The record that speaks for this row is ACTIVE. */
  | "held"
  /** The record that speaks for this row is INACTIVE: they have left. */
  | "departed"
  /**
   * The address answers to records that disagree and nothing says which is this
   * row's. Not a verdict: a refusal, reported so a person settles it.
   */
  | "ambiguous";

/** One Salesforce record, as this module needs to see it. */
export interface SalesforceRecord {
  email: string;
  isActive: boolean;
  /** Salesforce `User.Id`, when the query that produced this row asked for it. */
  recordId?: string | null;
}

function normalizeRecordId(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed : null;
}

/**
 * Fold Salesforce's answer about a set of addresses into a presence map.
 *
 * An address MISSING from the result is missing from the map, which is what lets
 * "Salesforce has no record for them" stay a distinct finding rather than
 * collapsing into "not active".
 */
export function presenceFromRecords(
  records: SalesforceRecord[],
): Map<string, SalesforcePresence> {
  const out = new Map<string, SalesforcePresence>();
  for (const record of records) {
    const email = normalizeEmail(record.email ?? "");
    if (!email) continue;
    const current = out.get(email) ?? {
      anyActive: false,
      anyInactive: false,
      activeIds: [],
      inactiveIds: [],
    };
    const active = record.isActive === true;
    const id = normalizeRecordId(record.recordId);
    const bucket = active ? current.activeIds : current.inactiveIds;
    // Deduplicated, because the same record legitimately arrives twice: the
    // presence query is chunked and an address can sit in more than one chunk.
    if (id && !bucket.includes(id)) bucket.push(id);
    out.set(email, {
      anyActive: current.anyActive || active,
      anyInactive: current.anyInactive || !active,
      activeIds: current.activeIds,
      inactiveIds: current.inactiveIds,
    });
  }
  return out;
}

/**
 * Where one Slate row stands with Salesforce. The ONE reading of a shared address.
 *
 * @param held         what Salesforce holds for the row's address, or undefined
 *                     when it returned nothing for it.
 * @param storedRecordId the row's stored Salesforce User Id, or null when it has
 *                     none. Null is an ordinary state, not an error: the id is
 *                     filled in by the same hourly sync and a fresh row has none
 *                     yet, which is why this refuses rather than throwing the way
 *                     an outward action naming a rep does.
 *
 * A stored id that names NONE of the address's records falls through to the
 * address wide reading deliberately. Salesforce returning a different record for
 * the address than the one Slate stores is its own finding (`salesforceIdDisagreements`
 * and `salesforceIdClaimed` both report it), and reading it here as proof of
 * anything would let one unexplained state answer for another.
 */
export function readSalesforceStanding(
  held: SalesforcePresence | undefined,
  storedRecordId: string | null,
): SalesforceStanding {
  if (!held || (!held.anyActive && !held.anyInactive)) return "absent";

  const id = normalizeRecordId(storedRecordId);
  if (id) {
    if (held.activeIds.includes(id)) return "held";
    if (held.inactiveIds.includes(id)) return "departed";
  }

  // No key, or a key naming none of these records. Many records that disagree is
  // a refusal in its own right (L521): choosing one of them is a coin toss nobody
  // would know had been tossed, and the wrong side of it takes somebody
  // Salesforce still holds out of the roster.
  if (held.anyActive && held.anyInactive) return "ambiguous";
  return held.anyActive ? "held" : "departed";
}
