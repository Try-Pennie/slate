/**
 * The reads behind the Coordinator booking page's list (#4264, D10, D14).
 *
 * Two reads: the org's coordinators from `users`, then each one's last sign in from
 * Supabase Auth, which is the only place that time is kept. A failed `users` read is the
 * failure the page draws as its own state, never an empty list (D14): an empty list over
 * a failed read would tell a super admin nobody can book. One person's sign in time that
 * cannot be read is said in their own cell, so one lookup cannot hide everybody.
 *
 * Org scoped: only the caller's own org's coordinators, and only those still with access
 * (a removed coordinator is departed, `deactivated_at` set, and leaves the list).
 */
import { supabaseAdmin } from "@/lib/supabase/admin";
import { log } from "@/lib/log";
import { BUSINESS_ZONE } from "@/lib/booking/business-hours";
import { coordinatorRows, type CoordinatorUser, type CoordinatorsRead, type SignIn } from "@/lib/admin/coordinators";

export interface CoordinatorsLoadDeps {
  /** The org's active coordinators. Throws when the read fails. */
  readCoordinators(orgId: string): Promise<CoordinatorUser[]>;
  /** When this sign in account last signed in, or null if it never has. Throws when unreadable. */
  readLastSignIn(authUserId: string): Promise<string | null>;
  now(): number;
}

async function readCoordinators(orgId: string): Promise<CoordinatorUser[]> {
  // cap-safe: users is roster bounded (SAFE_TABLES), and coordinators are a handful of it.
  // any-advisor-ok: reads the coordinators themselves, who are never advisors; the real
  // advisor rule exists to leave exactly these rows out.
  const { data, error } = await supabaseAdmin()
    .from("users")
    .select("id, name, email, auth_user_id")
    .eq("org_id", orgId)
    .eq("role", "coordinator")
    .is("deactivated_at", null);
  if (error) throw new Error(`coordinators read failed: ${error.message}`);
  return (data ?? []) as CoordinatorUser[];
}

async function readLastSignIn(authUserId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin().auth.admin.getUserById(authUserId);
  if (error) throw new Error(`sign in lookup failed: ${error.message}`);
  return data.user?.last_sign_in_at ?? null;
}

export const defaultCoordinatorsLoadDeps: CoordinatorsLoadDeps = {
  readCoordinators,
  readLastSignIn,
  now: () => Date.now(),
};

export async function loadCoordinators(
  orgId: string,
  deps: CoordinatorsLoadDeps = defaultCoordinatorsLoadDeps,
): Promise<CoordinatorsRead> {
  let users: CoordinatorUser[];
  try {
    users = await deps.readCoordinators(orgId);
  } catch (err) {
    log.error("coordinator-booking", { msg: "coordinators read failed" }, err);
    return { ok: false };
  }
  const signIns = new Map<string, SignIn>();
  await Promise.all(
    users.map(async (u) => {
      if (!u.auth_user_id) return;
      try {
        const at = await deps.readLastSignIn(u.auth_user_id);
        signIns.set(u.auth_user_id, at ? { kind: "at", iso: at } : { kind: "never" });
      } catch (err) {
        log.warn("coordinator-booking", { msg: "last sign in unreadable", user_id: u.id }, err);
        signIns.set(u.auth_user_id, { kind: "unreadable" });
      }
    }),
  );
  return { ok: true, rows: coordinatorRows(users, signIns, deps.now(), BUSINESS_ZONE) };
}
