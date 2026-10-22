/**
 * The Lead id an advisor link booking is saved under when its link carried none
 * (#3739).
 *
 * An advisor sends their own link (`/book/advisor/<name>`, #2073) bare, with
 * nothing after the name, so the confirm arrives with no Salesforce id even when
 * Slate already holds earlier bookings for the same lead under that id. Every
 * reader that joins a booking to its Lead by `salesforce_id` (reporting, the
 * warehouse copy, the pilot comparisons, the Lead's booking history) then cannot
 * see it.
 *
 * ## The match is strict on purpose
 *
 * The one call per person dedupe (#357, `person-dedupe.ts`) accepts email alone or
 * phone alone, which is right for a conservative action like declining a double
 * booking. Saving a Lead id is not conservative: a wrong one files this booking
 * under somebody else's Lead in every report. So only the strictest grade the
 * dedupe has without an id counts here, its `medium`: the SAME email (case
 * insensitive) AND the SAME phone (as E.164) on one earlier booking. An earlier
 * booking with this same advisor is the strongest evidence of all and is recorded
 * as such, but it never relaxes the match.
 *
 * ## Never a guess
 *
 * Earlier bookings carrying two DIFFERENT Lead ids (two leads sharing one address
 * and number, or a Lead merged in Salesforce) save none, and the caller logs it.
 * Ids are compared by their 15 character key, so a 15 and an 18 character spelling
 * of one Lead are one Lead, never a conflict. Only a real Lead id (`00Q`, 15 or 18
 * characters) is taken: an API caller's own external id is not a Salesforce id.
 *
 * ## Where the id came from is recorded
 *
 * `prefill.leadIdFrom` says `link` or `earlier-booking` on every advisor link
 * booking that carries an id, so a reader can tell an inferred id from one the
 * link carried. The key is the server's alone: `withLeadIdFrom` drops any value a
 * client posted under it on every confirm, so it can never be forged.
 */
import { isLeadId, leadIdKey, leadIdSpellings } from "../salesforce/lead-xbc.ts";
import { toE164 } from "../phone.ts";
import { strongIdsOf } from "./lookup-identity.ts";

/** The prefill key recording where an advisor link booking's Lead id came from. */
export const LEAD_ID_FROM_KEY = "leadIdFrom";

export type LeadIdFrom = "link" | "earlier-booking";

/** The columns of an earlier booking the inference reads. */
export interface EarlierLeadBookingRow {
  id: string;
  created_at: string;
  salesforce_id: string | null;
  external_id: string | null;
  attendee_email: string | null;
  attendee_phone: string | null;
  assigned_user_id: string | null;
}

export type LeadIdInference =
  | {
      kind: "found";
      /** The 18 character spelling where any earlier booking holds it. */
      leadId: string;
      /** An earlier booking with the advisor this link books carries it. */
      sameAdvisor: boolean;
      /** The earlier bookings that carry it, for the log line. */
      bookingIds: string[];
    }
  /** No earlier booking matches on both email and phone with a Lead id. */
  | { kind: "none" }
  /** Earlier matching bookings disagree about the Lead: nothing is saved. */
  | { kind: "conflict"; leadIdCount: number; bookingIds: string[] };

const normEmail = (e: string | null | undefined): string | null => {
  const v = (e ?? "").trim().toLowerCase();
  return v.length > 0 ? v : null;
};

/**
 * The one Lead id the lead's earlier bookings agree on, or why there is none.
 *
 * The read that supplies `rows` already asks for both the email and the phone; the
 * match is judged again HERE, so a looser read can never widen what is accepted.
 */
export function leadIdFromEarlierBookings(
  contact: { email: string | null | undefined; phone: string | null | undefined },
  advisorId: string,
  rows: readonly EarlierLeadBookingRow[],
): LeadIdInference {
  const email = normEmail(contact.email);
  const phone = toE164(contact.phone ?? null);
  if (!email || !phone) return { kind: "none" };

  // The Lead each matching row names, by its 15 character key.
  const byKey = new Map<string, { spellings: Set<string>; bookingIds: string[]; sameAdvisor: boolean }>();
  for (const r of rows) {
    if (normEmail(r.attendee_email) !== email) continue;
    if (toE164(r.attendee_phone) !== phone) continue;
    for (const id of strongIdsOf([r.salesforce_id, r.external_id])) {
      if (!isLeadId(id)) continue;
      const key = leadIdKey(id);
      const entry = byKey.get(key) ?? { spellings: new Set<string>(), bookingIds: [], sameAdvisor: false };
      entry.spellings.add(id);
      if (!entry.bookingIds.includes(r.id)) entry.bookingIds.push(r.id);
      if (r.assigned_user_id === advisorId) entry.sameAdvisor = true;
      byKey.set(key, entry);
    }
  }

  if (byKey.size === 0) return { kind: "none" };
  if (byKey.size > 1) {
    const bookingIds = [...new Set([...byKey.values()].flatMap((e) => e.bookingIds))].sort();
    return { kind: "conflict", leadIdCount: byKey.size, bookingIds };
  }
  const [entry] = [...byKey.values()];
  const held = [...entry.spellings].sort();
  const leadId = held.find((s) => s.length === 18) ?? leadIdSpellings(held[0]).long;
  return { kind: "found", leadId, sameAdvisor: entry.sameAdvisor, bookingIds: [...entry.bookingIds].sort() };
}

/**
 * The prefill a booking is saved with: whatever the client posted, minus any
 * `leadIdFrom` it sent, plus the server's own record of where the id came from
 * when there is one. Never mutates the prefill it is given.
 */
export function withLeadIdFrom(
  prefill: Record<string, string> | undefined,
  from: LeadIdFrom | null,
): Record<string, string> {
  const { [LEAD_ID_FROM_KEY]: _posted, ...rest } = prefill ?? {};
  return from === null ? rest : { ...rest, [LEAD_ID_FROM_KEY]: from };
}
