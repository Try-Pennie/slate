import { supabaseAdmin } from "@/lib/supabase/admin";
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
  // the address as wildcards and could resolve the WRONG user — dangerous for a
  // deactivate call.
  const { data } = await db
    .from("users")
    .select("id, deactivated_at")
    .eq("email", email.trim())
    .maybeSingle();
  const user = data as { id: string; deactivated_at: string | null } | null;

  const plan = planLifecycleChange(user, action);
  if (plan.status === "not_found") return { status: "not_found" };
  if (plan.status === "noop") return { status: "noop", userId: user!.id };

  await db
    .from("users")
    .update({ deactivated_at: plan.deactivate ? new Date().toISOString() : null })
    .eq("id", user!.id);
  return { status: "applied", userId: user!.id, deactivate: plan.deactivate };
}
