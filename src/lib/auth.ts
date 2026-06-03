import { supabaseServer } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { User } from "@/lib/db/types";

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

export async function requireAdmin(): Promise<User> {
  const user = await currentUser();
  if (!user || user.role !== "admin") {
    throw new Error("Not authorized");
  }
  return user;
}
