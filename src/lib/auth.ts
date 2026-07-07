import { cookies } from "next/headers";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { atLeast, canImpersonate } from "@/lib/auth/roles";
import {
  IMPERSONATE_COOKIE,
  impersonationCookieOutcome,
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
/**
 * Full impersonation state for `real`, the single computation every accessor
 * derives from (#652). `dropped` means a cookie was present but is no longer
 * honored: either the session timed out / went stale (`expired`), or the target
 * became ineligible mid-session: vanished, deactivated, or promoted past the
 * ceiling (`unavailable`). Callers use this to notify + clear, instead of the old
 * silent fall-back that was indistinguishable from having no cookie at all.
 */
type ImpersonationState =
  | { status: "active"; target: User }
  | { status: "dropped"; reason: "expired" | "unavailable" }
  | { status: "none" };

async function resolveImpersonationState(real: User): Promise<ImpersonationState> {
  const cookieStore = await cookies();
  const outcome = impersonationCookieOutcome(
    real.role,
    real.id,
    cookieStore.get(IMPERSONATE_COOKIE)?.value,
    Date.now(),
  );
  if (outcome.kind === "none") return { status: "none" };
  if (outcome.kind === "ended") return { status: "dropped", reason: "expired" };

  const { data, error } = await supabaseAdmin()
    .from("users")
    .select("*")
    .eq("id", outcome.targetId)
    .eq("org_id", real.org_id)
    .is("deactivated_at", null)
    .maybeSingle();
  // A transient query error is NOT a real drop: don't permanently clear a valid
  // session over a DB blip. Revert to self for this request only (as before) and
  // let it resume once the lookup succeeds. Only an actual empty result or a
  // ceiling failure means the target genuinely became ineligible.
  if (error) return { status: "none" };
  const target = data as User | null;
  if (!target || !canImpersonate(real.role, target.role)) {
    return { status: "dropped", reason: "unavailable" };
  }
  return { status: "active", target };
}

async function resolveImpersonationTarget(real: User): Promise<User | null> {
  const state = await resolveImpersonationState(real);
  return state.status === "active" ? state.target : null;
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
 * The impersonation state for the current request, for the header to render both
 * the active "viewing as" banner AND the dropped-session notice (#652) from one
 * lookup: `active` (real + target), `dropped` (with the reason), or `none`.
 */
export type ImpersonationView =
  | { status: "active"; real: User; target: User }
  | { status: "dropped"; reason: "expired" | "unavailable" }
  | { status: "none" };

export async function getImpersonationView(): Promise<ImpersonationView> {
  const real = await realCurrentUser();
  if (!real) return { status: "none" };
  const state = await resolveImpersonationState(real);
  if (state.status === "active") return { status: "active", real, target: state.target };
  if (state.status === "dropped") return { status: "dropped", reason: state.reason };
  return { status: "none" };
}

/**
 * When an admin+ is impersonating, returns both the real actor and the target
 * (for the persistent banner). Null otherwise. Thin projection of
 * `getImpersonationView` so booking-actor resolution can't drift from the header.
 */
export async function getImpersonation(): Promise<{
  real: User;
  target: User;
} | null> {
  const view = await getImpersonationView();
  return view.status === "active" ? { real: view.real, target: view.target } : null;
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
