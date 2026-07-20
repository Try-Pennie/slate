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
