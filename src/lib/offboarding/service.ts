import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { planLifecycleChange, type LifecycleAction } from "@/lib/offboarding/plan";

export type LifecycleResult =
  | { status: "not_found" }
  | { status: "noop"; userId: string }
  | { status: "applied"; userId: string; deactivate: boolean };

/**
 * Deactivate or reactivate a user by email (#264/#265). Idempotent: the write
 * to apply is decided by the pure `planLifecycleChange` from the current row, so
 * a retrying offboarding automation that calls deactivate twice is harmless.
 * Deactivate SETS `deactivated_at`; reactivate CLEARS it — the row is never
 * deleted, so history (bookings, OOO) and a future rehire stay intact.
 */
export async function applyLifecycleByEmail(
  email: string,
  action: LifecycleAction,
): Promise<LifecycleResult> {
  const db = supabaseAdmin();
  // Exact match, consistent with every other user-by-email lookup in the app
  // (booking/service.ts, provision.ts). NOT ilike: ilike would treat `_`/`%` in
  // the address as wildcards and could resolve the WRONG user, dangerous for a
  // deactivate call.
  const data = unwrap(
    await db
      // cap-safe: an exact-email lookup returns at most one row.
      .from("users")
      .select("id, deactivated_at")
      .eq("email", email.trim())
      .maybeSingle(),
    "offboarding-lookup-by-email",
  );
  return flipLifecycle(data as LifecycleRow | null, action);
}

/**
 * Same idempotent flip, keyed by user id, for the admin UI action (#278) where
 * the caller already has the row's id (RBAC-checked). Shares `flipLifecycle`
 * with the by-email path so both write identically.
 */
export async function applyLifecycleByUserId(
  userId: string,
  action: LifecycleAction,
): Promise<LifecycleResult> {
  const data = unwrap(
    await supabaseAdmin()
      // cap-safe: single-row primary-key lookup.
      .from("users")
      .select("id, deactivated_at")
      .eq("id", userId)
      .maybeSingle(),
    "offboarding-lookup-by-id",
  );
  return flipLifecycle(data as LifecycleRow | null, action);
}

type LifecycleRow = { id: string; deactivated_at: string | null };

/**
 * The shared decision + write: plan from the current row (idempotent), then
 * stamp/clear `deactivated_at` only when a change is due.
 *
 * Fails loud on the write. `status: "applied"` is a claim every caller believes:
 * the admin page repaints the agent as deactivated, and the offboarding automation
 * records the offboarding as finished and never looks again, while the agent keeps
 * taking bookings. A swallowed update error made that claim off a write that never
 * happened, and both callers already surface a throw (the server action shows the
 * message, the API route returns a 500).
 */
async function flipLifecycle(
  user: LifecycleRow | null,
  action: LifecycleAction,
): Promise<LifecycleResult> {
  const plan = planLifecycleChange(user, action);
  if (plan.status === "not_found") return { status: "not_found" };
  if (plan.status === "noop") return { status: "noop", userId: user!.id };

  const { error } = await supabaseAdmin()
    .from("users")
    .update({ deactivated_at: plan.deactivate ? new Date().toISOString() : null })
    .eq("id", user!.id);
  if (error) {
    throw new Error(
      `offboarding ${action} failed for user ${user!.id}: ${error.message}`,
    );
  }
  return { status: "applied", userId: user!.id, deactivate: plan.deactivate };
}
