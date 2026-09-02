import { supabaseAdmin } from "@/lib/supabase/admin";
import { isUniqueViolation, unwrap } from "@/lib/db/result";
import { log } from "@/lib/log";
import { normalizeEmail } from "@/lib/auth/email";
import type { Organization, User } from "@/lib/db/types";

const DEFAULT_ORG_NAME = "Pennie";

/**
 * Provisioning runs on the login path, and every write in here used to be a read
 * then insert whose read swallowed its error (#1648). That is two separate
 * defects wearing one shape, and fixing either alone fixes nothing:
 *
 *   - a read that FAILED fell through to the insert, because a swallowed error
 *     makes "there is no org yet" and "I could not tell" the same answer. Every
 *     read here now goes through `unwrap`, so a failure REFUSES the sign in;
 *   - a read that CORRECTLY returned nothing is still not protection, because two
 *     concurrent first logins both pass it. Only a database key can make the
 *     second write impossible, so each insert now leans on one
 *     (`organizations_single_default_idx` from migration 0110, `users_email_key`
 *     and `users_auth_user_id_key` for the users row) and treats a unique
 *     violation as "a concurrent login won", resolving to the row that won.
 *
 * The refusal is visible to a person signing in, so the callback route turns it
 * into a retryable sign in error and clears the half made session rather than
 * letting them in as a second identity (src/app/api/auth/callback/route.ts).
 */

/** The one row flagged `is_default`, or null when the table has none yet. */
async function readDefaultOrg(context: string): Promise<Organization | null> {
  const row = unwrap(
    await supabaseAdmin()
      .from("organizations")
      .select("*")
      .eq("is_default", true)
      .maybeSingle(),
    context,
  );
  return (row as Organization | null) ?? null;
}

/** Returns the single org for the PoC, creating it on first sign-in. */
export async function ensureDefaultOrg(): Promise<Organization> {
  const existing = await readDefaultOrg("default org");
  if (existing) return existing;

  const { data: created, error } = await supabaseAdmin()
    .from("organizations")
    .insert({ name: DEFAULT_ORG_NAME, is_default: true })
    .select("*")
    .maybeSingle();
  if (created) return created as Organization;

  if (isUniqueViolation(error)) {
    // organizations_single_default_idx refused a second default org, so another
    // login created it between the read above and this insert. The winner's row is
    // the default org; ours never existed.
    const winner = await readDefaultOrg("default org after a conflicting insert");
    if (winner) return winner;
  }
  throw new Error(
    `could not provision the default organization${error ? `: ${error.message}` : ""}`,
  );
}

interface ProvisionInput {
  authUserId: string;
  email: string;
  name: string | null;
  googleSub: string | null;
  avatarUrl: string | null;
}

/** A single row matched on one column, refusing rather than degrading on error. */
async function readUserBy(
  column: "auth_user_id" | "email",
  value: string,
  context: string,
): Promise<User | null> {
  const row = unwrap(
    await supabaseAdmin().from("users").select("*").eq(column, value).maybeSingle(),
    context,
  );
  return (row as User | null) ?? null;
}

/**
 * Either the person's row, or the news that a unique key refused our insert
 * because a concurrent login created it first.
 */
type Resolution =
  | { kind: "user"; user: User }
  | { kind: "conflict"; reason: string };

async function resolveOrCreateUser(
  input: ProvisionInput,
  orgId: string,
  pass: string,
): Promise<Resolution> {
  const db = supabaseAdmin();

  // Already linked? Refresh the avatar in case it changed.
  const linked = await readUserBy(
    "auth_user_id",
    input.authUserId,
    `user by auth_user_id (${pass})`,
  );
  if (linked) {
    if (input.avatarUrl && linked.avatar_url !== input.avatarUrl) {
      const { data: refreshed, error } = await db
        .from("users")
        .update({ avatar_url: input.avatarUrl })
        .eq("id", linked.id)
        .select("*")
        .maybeSingle();
      // error-ok: the avatar is cosmetic and this is the login hot path, so a
      // failed refresh signs them in with the picture already on the row rather
      // than refusing the sign in. Nothing downstream reads the empty result as a
      // fact: the identity returned is the SAME row we just read, the next login
      // retries, and the failure is logged rather than swallowed.
      if (error || !refreshed) {
        log.warn("provision", { msg: "avatar refresh failed", user_id: linked.id }, error);
        return { kind: "user", user: linked };
      }
      return { kind: "user", user: refreshed as User };
    }
    return { kind: "user", user: linked };
  }

  // Existing row by email (e.g. a Salesforce-synced agent now logging in).
  //
  // The NORMALISED address, on the read as well as the write (#1663). `users.email`
  // is unique but case sensitive and Google addresses are not, so asking for the
  // exact string Google handed us is asking the wrong question: the read correctly
  // returns nothing, provisioning treats the person as new, and the insert then
  // passes users_email_key because the two spellings genuinely differ. That is one
  // person with two identities, and nothing reports it.
  const email = normalizeEmail(input.email);
  const byEmail = await readUserBy("email", email, `user by email (${pass})`);
  if (byEmail) {
    const updated = unwrap(
      await db
        .from("users")
        .update({
          auth_user_id: input.authUserId,
          google_sub: input.googleSub,
          avatar_url: input.avatarUrl,
          // Backfill a display name only when the row has none (e.g. a pre-seeded
          // admin); never clobber a Salesforce-provided name.
          ...(byEmail.name ? {} : { name: input.name }),
        })
        .eq("id", byEmail.id)
        .select("*")
        .maybeSingle(),
      `link user by email (${pass})`,
    );
    // A matched row that came back empty means it was deleted underneath us. That
    // must refuse: returning the pre-update row would hand back an identity whose
    // auth_user_id was never written, and every later request resolves the session
    // by auth_user_id, so they would be signed in to nothing.
    if (!updated) {
      return { kind: "conflict", reason: "the matching account disappeared mid sign in" };
    }
    return { kind: "user", user: updated as User };
  }

  // Brand new — always provisioned as 'agent'. We deliberately do NOT auto-grant
  // admin to the first login on an empty-admin state (#599): a data condition
  // (no admins) must never mint an admin, or a normal login becomes a silent
  // privilege escalation. Admins are seeded deliberately by promoting an existing
  // user (role management) or, to bootstrap from scratch, a direct DB write —
  // there is no login-time bootstrap path.
  const { data: created, error } = await db
    .from("users")
    .insert({
      org_id: orgId,
      auth_user_id: input.authUserId,
      // The same normalised value the read above asked for, so the row that gets
      // created is the row the next login will find.
      email,
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
    .maybeSingle();
  if (created) return { kind: "user", user: created as User };

  if (isUniqueViolation(error)) {
    return { kind: "conflict", reason: error?.message ?? "a unique key refused the insert" };
  }
  throw new Error(
    `could not create a users row for this sign in${error ? `: ${error.message}` : ""}`,
  );
}

/**
 * Resolves the logged-in user to a Slate users row, linking by auth_user_id,
 * else by email (e.g. a synced agent who now logs in), else creating a new row.
 * A brand-new row is always role 'agent'; admin is never granted at login (#599).
 * Calendar access is via domain-wide delegation, so no OAuth tokens are stored.
 */
export async function provisionUser(input: ProvisionInput): Promise<User> {
  const org = await ensureDefaultOrg();

  const first = await resolveOrCreateUser(input, org.id, "first pass");
  if (first.kind === "user") return first.user;

  // A unique key refused our insert, so a concurrent login created this person's
  // row between our reads and it. Resolve once more rather than retrying the
  // insert: the second pass takes the already-linked branch (or links the row it
  // finds by email), so they sign in as the ONE identity that exists instead of a
  // second one. One extra pass only, so a conflict that is not a lost race cannot
  // spin.
  // Warn, not info: a lost race is EXPECTED and handled, but "expected" says
  // nothing about volume (L77). One a month is two people signing in at the same
  // instant; a burst of them is a real fault (a broken read making every caller
  // think the row is missing), and the two arrive on the same path. The level plus
  // the `tag=provision` key is what makes the rate countable in the logs.
  log.warn("provision", { msg: "lost a provisioning race, resolving the winner" });
  const second = await resolveOrCreateUser(input, org.id, "second pass");
  if (second.kind === "user") return second.user;

  throw new Error(`could not provision a users row for this sign in: ${second.reason}`);
}
