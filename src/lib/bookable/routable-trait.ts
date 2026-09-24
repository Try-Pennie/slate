import { isRoutable } from "@/lib/routing/staffing-depth";

/**
 * Whether a write to `users` owes Regal a bookable trait (#2085). Pure.
 *
 * The trait is the DERIVED value routing itself uses, `isRoutable` (bookable AND
 * not deactivated), never the raw `bookable` column: sending the column would
 * tell Regal `true` about somebody who has been offboarded. Dan's rule,
 * 2026-09-08: offboarding, deactivation and being flipped unbookable all send
 * false; in Slate and bookable sends true.
 *
 * It is computed from the row BEFORE the write and the row AFTER it, and a trait
 * is owed only when the two differ. That one comparison covers every
 * combination without any caller reasoning about them, including the two that
 * must stay silent: a reactivation (which clears `deactivated_at` and
 * deliberately leaves `bookable` false, #1324) and a bookable flip on a
 * deactivated row. It also makes a retrying automation harmless, since a repeat
 * of a write that already landed changes nothing.
 */

/** The columns the decision and the delivery need, read before and after. */
export interface RoutableStateRow {
  id: string;
  org_id: string;
  email: string;
  bookable: boolean;
  deactivated_at: string | null;
  is_test: boolean;
}

/** The select list that produces a `RoutableStateRow`. */
export const ROUTABLE_STATE_COLUMNS = "id, org_id, email, bookable, deactivated_at, is_test";

/** One trait owed to Regal. */
export interface TraitEmission {
  orgId: string;
  userId: string;
  email: string;
  slateBookable: boolean;
  /** A smoke test agent (#396): recorded, never POSTed (#459's rule). */
  suppressed: boolean;
}

/**
 * The traits a write owes, one per row whose derived value moved.
 *
 * A row present BEFORE and absent AFTER was not written (a compare and swap that
 * lost, say), so it owes nothing. A row present after with no before reading is
 * sent, because telling Regal the current value is the harmless direction and
 * silence would leave it holding nothing.
 */
export function planTraitEmissions(
  before: RoutableStateRow[],
  after: RoutableStateRow[],
): TraitEmission[] {
  const was = new Map(before.map((r) => [r.id, isRoutable(r)]));
  return after
    .filter((r) => !(was.has(r.id) && was.get(r.id) === isRoutable(r)))
    .map(traitFor);
}

/**
 * The trait one row states right now. Shared by the change path above and the
 * backfill, which sends every row's current value, so the two cannot disagree
 * about what "bookable" means to Regal.
 */
export function traitFor(r: RoutableStateRow): TraitEmission {
  return {
    orgId: r.org_id,
    userId: r.id,
    email: r.email,
    slateBookable: isRoutable(r),
    suppressed: r.is_test === true,
  };
}
