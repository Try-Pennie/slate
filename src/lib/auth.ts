import { cookies } from "next/headers";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { atLeast } from "@/lib/auth/roles";
import {
  IMPERSONATE_COOKIE,
  resolveEffectiveUserId,
} from "@/lib/auth/impersonation";
import { devPreviewUser } from "@/lib/auth/dev-preview";
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
 * The user the request should ACT AS. Equal to the signed-in user, except when
 * an admin is impersonating someone (admin-only, gated in resolveEffectiveUserId):
 * then it returns the target. Everything downstream — page rendering,
 * requireRole, server actions, the OOO actor — flows through here, so
 * impersonation transparently changes who "you" are.
 */
export async function currentUser(): Promise<User | null> {
  const real = await realCurrentUser();
  if (!real) return null;

  const cookieStore = await cookies();
  const effectiveId = resolveEffectiveUserId(
    real.role,
    real.id,
    cookieStore.get(IMPERSONATE_COOKIE)?.value,
  );
  if (effectiveId === real.id) return real;

  // Resolve the impersonated user, constrained to the admin's org. Fall back to
  // the real admin if the target vanished (e.g. removed by a sync).
  const { data } = await supabaseAdmin()
    .from("users")
    .select("*")
    .eq("id", effectiveId)
    .eq("org_id", real.org_id)
    .maybeSingle();
  return (data as User | null) ?? real;
}

/**
 * When an admin is impersonating, returns both the real admin and the target
 * (for the persistent banner). Null otherwise.
 */
export async function getImpersonation(): Promise<{
  real: User;
  target: User;
} | null> {
  const real = await realCurrentUser();
  if (!real || real.role !== "admin") return null;
  const cookieStore = await cookies();
  const effectiveId = resolveEffectiveUserId(
    real.role,
    real.id,
    cookieStore.get(IMPERSONATE_COOKIE)?.value,
  );
  if (effectiveId === real.id) return null;
  const { data } = await supabaseAdmin()
    .from("users")
    .select("*")
    .eq("id", effectiveId)
    .eq("org_id", real.org_id)
    .maybeSingle();
  const target = data as User | null;
  return target ? { real, target } : null;
}

/** Resolves the signed-in user and asserts they hold at least `min` rank. */
export async function requireRole(min: Role): Promise<User> {
  const user = await currentUser();
  if (!user || !atLeast(user.role, min)) {
    throw new Error("Not authorized");
  }
  return user;
}

export const requireManager = (): Promise<User> => requireRole("manager");
export const requireAdmin = (): Promise<User> => requireRole("admin");
export const requireSuperAdmin = (): Promise<User> => requireRole("super_admin");
