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
  avatarUrl: string | null;
}

/**
 * Resolves the logged-in user to a Slate users row, linking by auth_user_id,
 * else by email (e.g. a synced agent who now logs in), else creating a new row.
 * A brand-new row is always role 'agent'; admin is never granted at login (#599).
 * Calendar access is via domain-wide delegation, so no OAuth tokens are stored.
 */
export async function provisionUser(input: ProvisionInput): Promise<User> {
  const db = supabaseAdmin();
  const org = await ensureDefaultOrg();

  // Already linked? Refresh the avatar in case it changed.
  const { data: linked } = await db
    .from("users")
    .select("*")
    .eq("auth_user_id", input.authUserId)
    .maybeSingle();
  if (linked) {
    const u = linked as User;
    if (input.avatarUrl && u.avatar_url !== input.avatarUrl) {
      const { data: refreshed } = await db
        .from("users")
        .update({ avatar_url: input.avatarUrl })
        .eq("id", u.id)
        .select("*")
        .single();
      return refreshed as User;
    }
    return u;
  }

  // Existing row by email (e.g. a Salesforce-synced agent now logging in).
  const { data: byEmail } = await db
    .from("users")
    .select("*")
    .eq("email", input.email)
    .maybeSingle();
  if (byEmail) {
    const existing = byEmail as User;
    const { data: updated } = await db
      .from("users")
      .update({
        auth_user_id: input.authUserId,
        google_sub: input.googleSub,
        avatar_url: input.avatarUrl,
        // Backfill a display name only when the row has none (e.g. a pre-seeded
        // admin); never clobber a Salesforce-provided name.
        ...(existing.name ? {} : { name: input.name }),
      })
      .eq("id", existing.id)
      .select("*")
      .single();
    return updated as User;
  }

  // Brand new — always provisioned as 'agent'. We deliberately do NOT auto-grant
  // admin to the first login on an empty-admin state (#599): a data condition
  // (no admins) must never mint an admin, or a normal login becomes a silent
  // privilege escalation. Admins are seeded deliberately by promoting an existing
  // user (role management) or, to bootstrap from scratch, a direct DB write —
  // there is no login-time bootstrap path.
  const { data: created } = await db
    .from("users")
    .insert({
      org_id: org.id,
      auth_user_id: input.authUserId,
      email: input.email,
      name: input.name,
      google_sub: input.googleSub,
      avatar_url: input.avatarUrl,
      role: "agent",
      // Never bookable on arrival (#1266). Adding an account must not put someone
      // in the round-robin pool: an agent live before anyone approved them may
      // have no working hours set, no calendar connected, or not be meant to take
      // bookings at all, and the booker will still offer their time to real leads.
      // Stated here as well as defaulted in the schema, so the intent is readable
      // at the insert rather than inferred from a migration.
      bookable: false,
    })
    .select("*")
    .single();

  return created as User;
}
