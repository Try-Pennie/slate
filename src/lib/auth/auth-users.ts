import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * Every Supabase auth user, through the admin API, for the readers that compare Auth's
 * own record with Slate's roster: the session convergence (#2459), which reads who is
 * banned, and the monitor's outside account check (#4379), which reads who exists.
 * One listing, so the two cannot come to page through it differently.
 *
 * GoTrue's own maximum page is 1,000 and the roster is a few hundred people, so this is
 * one call on an ordinary day. A listing longer than `AUTH_MAX_PAGES` pages is returned
 * as INCOMPLETE rather than walked for ever, and a reader must not read "not listed" as
 * "does not exist" from an incomplete one. A failed page throws.
 */
export const AUTH_PAGE_SIZE = 1000;
export const AUTH_MAX_PAGES = 5;

export interface AuthUserRow {
  id: string;
  email: string | null;
  banned_until: string | null;
}

export interface AuthUserListing {
  complete: boolean;
  users: AuthUserRow[];
}

export async function listAuthUsers(): Promise<AuthUserListing> {
  const users: AuthUserRow[] = [];
  for (let page = 1; page <= AUTH_MAX_PAGES; page++) {
    const { data, error } = await supabaseAdmin().auth.admin.listUsers({ page, perPage: AUTH_PAGE_SIZE });
    if (error) throw new Error(`could not list auth users: ${error.message}`);
    for (const u of data.users) users.push({ id: u.id, email: u.email ?? null, banned_until: u.banned_until ?? null });
    if (data.users.length < AUTH_PAGE_SIZE) return { complete: true, users };
  }
  return { complete: false, users };
}
