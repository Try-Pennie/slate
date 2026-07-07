import { cookies } from "next/headers";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { atLeast, canImpersonate } from "@/lib/auth/roles";
import {
  IMPERSONATE_COOKIE,
  resolveEffectiveUserId,
} from "@/lib/auth/impersonation";
import { devPreviewUser } from "@/lib/auth/dev-preview";
import { NotAuthorizedError } from "@/lib/auth/http";
import type { Role, User } from "@/lib/db/types";

/**
 * The signed-in Slate user from the Supabase session, IGNORING impersonation.
 * Use this for the security gate (only a real admin may impersonate) and for
 * stopping impersonation — never for "who am I acting as" (that's currentUser).
 */
export async function realCurrentUser(): Promise<User | null> {
  // Dev-only localhost preview (inert in production). Lets you act as any user
  // without OAuth so the internal surfaces can be iterated on quickly.
  const preview = await devPreviewUser();
  if (preview) return preview;

  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await supabaseAdmin()
    .from("users")
    .select("*")
    .eq("auth_user_id", user.id)
    .maybeSingle();

  return (data as User | null) ?? null;
}

/**
 * The user `real` is impersonating, or null when they aren't (no cookie, cookie
 * points at self, or the real session isn't admin+). Single place the whole
 * feature's gates live, so `currentUser` and `getImpersonation` can't drift:
 *   - FLOOR: only admin+ sessions honor the cookie (resolveEffectiveUserId).
 *   - Target must be in the actor's org, ACTIVE, and still exist — fall back
 *     (null) if it vanished (removed by a sync) or was deactivated (offboarded);
 *     never act as a departed user.
 *   - CEILING (#588): never act as someone who outranks-or-equals you, even if
 *     the cookie says so. Blocks a rank-3 admin from inheriting a super_admin's
 *     powers; also re-checked live here in case the target was promoted mid-session.
 */
async function resolveImpersonationTarget(real: User): Promise<User | null> {
  const cookieStore = await cookies();
  const effectiveId = resolveEffectiveUserId(
    real.role,
    real.id,
    cookieStore.get(IMPERSONATE_COOKIE)?.value,
    Date.now(),
  );
  if (effectiveId === real.id) return null;

  const { data } = await supabaseAdmin()
    .from("users")
    .select("*")
    .eq("id", effectiveId)
    .eq("org_id", real.org_id)
    .is("deactivated_at", null)
    .maybeSingle();
  const target = data as User | null;
  if (!target || !canImpersonate(real.role, target.role)) return null;
  return target;
}

/**
 * The user the request should ACT AS. Equal to the signed-in user, except when
 * an admin+ is impersonating someone below them (gated in
 * resolveImpersonationTarget): then it returns the target. Everything downstream
 * — page rendering, requireRole, server actions, the OOO actor — flows through
 * here, so impersonation transparently changes who "you" are.
 */
export async function currentUser(): Promise<User | null> {
  const real = await realCurrentUser();
  if (!real) return null;
  return (await resolveImpersonationTarget(real)) ?? real;
}

/**
 * When an admin+ is impersonating, returns both the real actor and the target
 * (for the persistent banner). Null otherwise.
 */
export async function getImpersonation(): Promise<{
  real: User;
  target: User;
} | null> {
  const real = await realCurrentUser();
  if (!real) return null;
  const target = await resolveImpersonationTarget(real);
  return target ? { real, target } : null;
}

/** Resolves the signed-in user and asserts they hold at least `min` rank. */
export async function requireRole(min: Role): Promise<User> {
  const user = await currentUser();
  if (!user || !atLeast(user.role, min)) {
    // Typed so the HTTP layer maps this to a 403, not a generic 500 (#606).
    throw new NotAuthorizedError();
  }
  return user;
}

export const requireManager = (): Promise<User> => requireRole("manager");
export const requireAdmin = (): Promise<User> => requireRole("admin");
export const requireSuperAdmin = (): Promise<User> => requireRole("super_admin");

/**
 * Gate at manager+ AND resolve who is accountable for an admin booking action
 * (#549). The REAL signed-in user is the actor; when an admin is impersonating,
 * the impersonated user is recorded as `actingAsUserId`. Shape is structurally a
 * `BookingActor` (kept dependency-free of the booking domain).
 */
export async function requireBookingActor(): Promise<{ userId: string; actingAsUserId: string | null }> {
  const me = await requireManager();
  const imp = await getImpersonation();
  return imp
    ? { userId: imp.real.id, actingAsUserId: imp.target.id }
    : { userId: me.id, actingAsUserId: null };
}
