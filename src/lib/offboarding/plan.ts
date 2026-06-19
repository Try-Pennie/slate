export type LifecycleAction = "deactivate" | "reactivate";

export type LifecyclePlan =
  | { status: "not_found" }
  | { status: "noop" }
  | { status: "apply"; deactivate: boolean };

/**
 * Pure, idempotent decision for the deactivate/reactivate endpoints (#264/#265).
 * The offboarding automation may retry, so the write to apply must depend only
 * on the current row: deactivating an already-deactivated user (or reactivating
 * an already-active one) is a no-op, not an error. `deactivate: true` means set
 * `deactivated_at`; `false` means clear it (the caller stamps/clears the time).
 */
export function planLifecycleChange(
  user: { deactivated_at: string | null } | null,
  action: LifecycleAction,
): LifecyclePlan {
  if (!user) return { status: "not_found" };
  // active === deactivated_at is null (mirrors isActive(); kept inline so this
  // stays a dependency-free leaf module the node test runner can import).
  const active = user.deactivated_at == null;
  if (action === "deactivate") {
    return active ? { status: "apply", deactivate: true } : { status: "noop" };
  }
  return active ? { status: "noop" } : { status: "apply", deactivate: false };
}
