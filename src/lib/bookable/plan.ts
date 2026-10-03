export type BookablePlan =
  | { status: "not_found" }
  | { status: "noop" }
  | { status: "apply"; bookable: boolean };

/**
 * Pure, idempotent decision for the bookable-toggle API (#281). The roster
 * automation may retry, so the write to apply depends only on the current row:
 * setting an already-bookable agent bookable (or an already-unbookable one
 * unbookable) is a no-op, not an error. `bookable` is orthogonal to
 * `deactivated_at` (the offboarding axis) and this never touches it. Kept a
 * dependency-free leaf so the node test runner can import it directly.
 */
export function planBookableChange(
  user: { bookable: boolean } | null,
  target: boolean,
): BookablePlan {
  if (!user) return { status: "not_found" };
  if (user.bookable === target) return { status: "noop" };
  return { status: "apply", bookable: target };
}

export type ClearPendingPlan =
  | { status: "not_found" }
  | { status: "not_pending" }
  | { status: "clear"; pendingSince: string };

/**
 * Whether a person may settle a pending bookable flip by hand (#2078).
 *
 * `planBookableChange` above answers "not bookable" on somebody already not
 * bookable with a noop, which is right for the toggle and means the explicit write
 * that clears `bookable_pending_since` is never reached. So a flip the activation
 * gate refused stayed owed, retried hourly and re-alerted, with nothing on screen
 * able to say "do not flip this one". This is that decision: keyed on the MARK, not
 * on the bookable value, and it never moves `bookable`. The stamp it replaces comes
 * back so the audit entry can record the old value beside the new.
 */
export function planClearPendingFlip(
  user: { bookable: boolean; bookable_pending_since: string | null } | null,
): ClearPendingPlan {
  if (!user) return { status: "not_found" };
  if (!user.bookable_pending_since) return { status: "not_pending" };
  return { status: "clear", pendingSince: user.bookable_pending_since };
}
