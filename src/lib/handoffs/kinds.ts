import type { BookingHandoffKind } from "@/lib/db/types";

/**
 * What a booking can be waiting on a person for (#2367), and what each kind records.
 *
 * Two situations Slate cannot finish on its own:
 *
 *  - `duplicate-unresolved`: a caller asked Slate to cancel a duplicate booking and
 *    Slate could not establish that it was one (#2307 phase 3). Somebody has to look
 *    at the lead's calls and cancel the right one by hand.
 *  - `owner-reassign-refused`: a caller asked Slate to move a call to the lead's
 *    owner and Slate refused (#2307 phase 4). Somebody has to decide whether the
 *    owner should take it.
 *
 * `detail` is stored as jsonb, so it comes back from the database as whatever is
 * there, not as the type it was written with. The readers below are the only way the
 * rest of the code looks inside it, and each returns null for a shape it does not
 * recognise rather than guessing, so an old or malformed row renders a plainer
 * notice and resolves only on the rules that need no detail (L50).
 *
 * No kind records lead contact data. The lead is named at delivery time from the
 * booking itself, which keeps this table outside erasure.
 */

/**
 * Every kind, keyed so the type system enforces completeness (L113):
 * `Record<BookingHandoffKind, true>` fails `tsc` when the union gains a member this
 * does not list. The migration CHECK holds the same values, and
 * `scripts/test-booking-handoffs.ts` compares the two.
 */
const KIND_PRESENCE: Record<BookingHandoffKind, true> = {
  "duplicate-unresolved": true,
  "owner-reassign-refused": true,
};

export const HANDOFF_KINDS = Object.keys(KIND_PRESENCE) as BookingHandoffKind[];

export type HandoffKind = BookingHandoffKind;

export function isHandoffKind(value: string): value is HandoffKind {
  return Object.prototype.hasOwnProperty.call(KIND_PRESENCE, value);
}

/** What Slate measured when it declined to cancel a named duplicate. */
export const DUPLICATE_FINDINGS = ["no-other-call", "named-is-newest", "identity-conflict"] as const;
export type DuplicateFinding = (typeof DUPLICATE_FINDINGS)[number];

export interface DuplicateUnresolvedDetail {
  /**
   * `no-other-call`: Slate holds no other active call for this lead under a strong
   * match. `named-is-newest`: it holds other active calls, and every one was booked
   * before the named one. `identity-conflict`: another active call matches on email
   * and phone but the two carry different Salesforce ids.
   */
  finding: DuplicateFinding;
  /** A later active call Slate found on a WEAKER match only, stated as what it is. */
  weakerMatch: "phone-only" | "email-only" | null;
  /** When the caller reported the later booking starts, exactly as it sent it. */
  laterBookingStartsAt: string | null;
}

/** Why Slate refused to move a call to the lead's owner. */
export const OWNER_REFUSALS = ["owner-not-found", "owner-not-bookable", "owner-on-time-off"] as const;
export type OwnerRefusal = (typeof OWNER_REFUSALS)[number];

export interface OwnerReassignRefusedDetail {
  refusal: OwnerRefusal;
  /** Null when Slate has no user for the owner, which can then never match. */
  requestedOwnerUserId: string | null;
  /** The owner as the caller named them: an agent's work address, not a lead's. */
  requestedOwnerEmail: string;
}

export interface HandoffDetailByKind {
  "duplicate-unresolved": DuplicateUnresolvedDetail;
  "owner-reassign-refused": OwnerReassignRefusedDetail;
}

/** What a writer passes to `recordHandoff`: the detail is typed by the kind. */
export type HandoffInput = {
  [K in HandoffKind]: { bookingId: string; kind: K; detail: HandoffDetailByKind[K] };
}[HandoffKind];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === "string" && (list as readonly string[]).includes(v);

/** The stored detail of a duplicate handoff, or null for a shape this cannot read. */
export function readDuplicateDetail(detail: unknown): DuplicateUnresolvedDetail | null {
  if (!isRecord(detail) || !oneOf(DUPLICATE_FINDINGS, detail.finding)) return null;
  const weaker = detail.weakerMatch;
  const later = detail.laterBookingStartsAt;
  return {
    finding: detail.finding,
    weakerMatch: weaker === "phone-only" || weaker === "email-only" ? weaker : null,
    laterBookingStartsAt: typeof later === "string" && later.trim() ? later : null,
  };
}

/** The stored detail of an owner refusal, or null for a shape this cannot read. */
export function readOwnerDetail(detail: unknown): OwnerReassignRefusedDetail | null {
  if (!isRecord(detail) || !oneOf(OWNER_REFUSALS, detail.refusal)) return null;
  const email = detail.requestedOwnerEmail;
  if (typeof email !== "string" || !email.trim()) return null;
  const id = detail.requestedOwnerUserId;
  return {
    refusal: detail.refusal,
    requestedOwnerUserId: typeof id === "string" && id.trim() ? id : null,
    requestedOwnerEmail: email,
  };
}
