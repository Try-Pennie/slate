import { supabaseAdmin } from "@/lib/supabase/admin";
import type { Organization, User } from "@/lib/db/types";

const DEFAULT_ORG_NAME = "Pennie";

/** Returns the single org for the PoC, creating it on first sign-in. */
export async function ensureDefaultOrg(): Promise<Organization> {
  const db = supabaseAdmin();
  const { data: existing } = await db
    .from("organizations")
    .select("*")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (existing) return existing as Organization;

  const { data: created } = await db
    .from("organizations")
    .insert({ name: DEFAULT_ORG_NAME })
    .select("*")
    .single();
  return created as Organization;
}

interface ProvisionInput {
  authUserId: string;
  email: string;
  name: string | null;
  googleSub: string | null;
}

/**
 * Resolves the logged-in (admin) user to a Slate users row, linking by
 * auth_user_id, else by email (e.g. a synced agent who now logs in), else
 * creating a new row. First admin to log in becomes role 'admin'. Calendar
 * access is via domain-wide delegation, so no OAuth tokens are stored.
 */
export async function provisionUser(input: ProvisionInput): Promise<User> {
  const db = supabaseAdmin();
  const org = await ensureDefaultOrg();

  // Already linked?
  const { data: linked } = await db
    .from("users")
    .select("*")
    .eq("auth_user_id", input.authUserId)
    .maybeSingle();
  if (linked) return linked as User;

  // Existing row by email (e.g. a Salesforce-synced agent now logging in).
  const { data: byEmail } = await db
    .from("users")
    .select("*")
    .eq("email", input.email)
    .maybeSingle();
  if (byEmail) {
    const { data: updated } = await db
      .from("users")
      .update({ auth_user_id: input.authUserId, google_sub: input.googleSub })
      .eq("id", (byEmail as User).id)
      .select("*")
      .single();
    return updated as User;
  }

  // Brand new — first person to log in with no admin yet becomes admin.
  const { count } = await db
    .from("users")
    .select("id", { count: "exact", head: true })
    .eq("role", "admin");
  const role = (count ?? 0) === 0 ? "admin" : "agent";

  const { data: created } = await db
    .from("users")
    .insert({
      org_id: org.id,
      auth_user_id: input.authUserId,
      email: input.email,
      name: input.name,
      google_sub: input.googleSub,
      role,
    })
    .select("*")
    .single();

  return created as User;
}
