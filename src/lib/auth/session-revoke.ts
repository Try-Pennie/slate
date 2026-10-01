import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * Take away, and give back, somebody's ability to hold a Supabase session
 * (#2378).
 *
 * The second half of offboarding's security story, and it is a SEPARATE control
 * from the first (L397). `gateSessionRow` refuses a departed person on their very
 * next request, which is what closes the hole; this stops them minting fresh
 * tokens at all, and stops a fresh Google sign in reaching the callback while
 * their Workspace account is still alive. Each half is blind where the other
 * looks, so both are checked and neither is allowed to report the other's work as
 * its own.
 *
 * WHY A BAN AND NOT A SIGN OUT. `auth.admin.signOut(jwt)` is the only sign out
 * `@supabase/auth-js` offers and it takes the PERSON'S OWN access token, which an
 * offboarding call made by an automation (or by an admin on the roster page)
 * never has and must never be able to get. There is no admin keyed per user
 * logout endpoint on GoTrue: the admin surface is create, read, update, delete
 * and MFA. `updateUserById(id, { ban_duration })` is the admin keyed lever that
 * exists, it is keyed on `auth_user_id` exactly as the issue asks, and GoTrue
 * refuses both the refresh token grant and a fresh sign in for a banned user.
 *
 * WHAT IT DOES NOT DO, said plainly so nobody reads more into it: an access token
 * ALREADY ISSUED stays cryptographically valid until it expires (one hour by
 * default, set in the Supabase dashboard rather than in this repo). Nothing
 * server side can shorten that, which is what JWTs are. The app layer gate is what
 * covers that window, and it covers it on the very next request.
 *
 * IDEMPOTENT BY CONSTRUCTION. Banning an already banned user writes the same
 * `banned_until` again and answers the same way, so an offboarding automation that
 * retries, or two deactivations racing each other, cost one extra write and change
 * nothing. That matters because the row write and this call are two steps with no
 * transaction between them: the caller runs this whenever the END STATE is
 * "deactivated", not only on the transition, so a crash in the gap converges on a
 * retry instead of stranding the revoke forever (CLAUDE.md, "Assume it runs
 * twice").
 *
 * IT THROWS. The error from the admin call is bound and raised rather than
 * swallowed, because a failed revoke that reported success would leave the
 * offboarding automation recording that access was removed when it was not. What
 * the caller then does with the throw is the caller's decision, and
 * `offboarding/service.ts` explains the one it made.
 *
 * WHERE IT IS CALLED, stated so this module is not read as broader or narrower
 * coverage than it has (L400). `offboarding/service.ts` calls it for one person
 * at the moment of the lifecycle change, which covers the lifecycle endpoints and
 * the admin roster page. The hourly Salesforce roster reap departs people with a
 * batch write that never comes through there, so they are banned by
 * `offboarding/session-convergence.ts` (#2459), which runs after the reap on
 * every roster run and bans every departed person Supabase Auth does not already
 * hold as banned. That also retries a ban the single person path failed to make.
 */

/**
 * One hundred years, as the Go duration string GoTrue parses. There is no
 * "forever" in that API; this is the value Supabase's own documentation uses for
 * a permanent ban, and it is lifted by name rather than by waiting it out.
 */
const REVOKE_BAN_DURATION = "876000h";

/** The value that clears a ban. Not "0h": GoTrue reads that as a zero length ban. */
const RESTORE_BAN_DURATION = "none";

/**
 * What a revoke or restore actually met.
 *
 * `no-auth-account` is a users row nobody has ever signed in as, so there is no
 * Supabase auth user to key on and nothing to revoke. It is reported separately
 * rather than as a success, because "there was nothing to take away" and "I took
 * it away" are different facts and a reader of an offboarding result is entitled
 * to tell them apart (L11).
 */
export type SessionRevokeOutcome = "revoked" | "restored" | "no-auth-account";

async function setBan(authUserId: string, banDuration: string): Promise<void> {
  const { error } = await supabaseAdmin().auth.admin.updateUserById(authUserId, {
    ban_duration: banDuration,
  });
  if (error) {
    throw new Error(
      `could not change Supabase session access for auth user ${authUserId}: ${error.message}`,
    );
  }
}

/** Stop this person holding or renewing a Supabase session. Throws on failure. */
export async function revokeSupabaseSessions(
  authUserId: string | null,
): Promise<SessionRevokeOutcome> {
  if (!authUserId) return "no-auth-account";
  await setBan(authUserId, REVOKE_BAN_DURATION);
  return "revoked";
}

/**
 * Let this person sign in again, for a rehire.
 *
 * Reactivation would otherwise be inert: the row would go back to active while
 * GoTrue went on refusing every sign in, with nothing on any screen saying why,
 * and the admin lockout runbook's own promotion steps would hand somebody a role
 * they could not use. It grants nothing the app layer does not already grant, and
 * it runs on the same authorization the reactivate path already carries.
 */
export async function restoreSupabaseSessions(
  authUserId: string | null,
): Promise<SessionRevokeOutcome> {
  if (!authUserId) return "no-auth-account";
  await setBan(authUserId, RESTORE_BAN_DURATION);
  return "restored";
}

/** The durations, exported so a test asserts the values that actually ship. */
export const SESSION_BAN_DURATIONS = {
  revoke: REVOKE_BAN_DURATION,
  restore: RESTORE_BAN_DURATION,
} as const;
