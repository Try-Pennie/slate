import { supabaseServer } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { atLeast } from "@/lib/auth/roles";
import type { Role, User } from "@/lib/db/types";

/**
 * Resolves the signed-in Supabase auth user to a Slate `users` row (with org +
 * role). Returns null when not signed in or not provisioned. Uses the
 * service-role client to read the row after verifying the session.
 */
export async function currentUser(): Promise<User | null> {
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
