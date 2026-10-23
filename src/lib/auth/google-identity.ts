/**
 * Whether a sign in is the same PERSON as the Slate row it found (#3526).
 *
 * Slate finds a person's row by their email address, and an address is not an
 * identity: Pennie can hand a departed advisor's address to a new hire, and if
 * the departure was never recorded the new hire's first sign in found the old
 * row and inherited it, with its role, its bookings and its calendar. Google's
 * `sub` is the account's permanent id and Google never reuses it, so once a row
 * holds one it is the thing that says who the row belongs to, and the address is
 * only how the row was found.
 *
 * THREE OUTCOMES. A row with no stored id records the one Google account on this
 * sign in, which is what happened before this existed, so every row arms itself
 * on its next sign in rather than needing a backfill. A row whose id matches is
 * the same person. Anything else is somebody else: a different account; no Google
 * account at all ("I cannot tell who this is" must not be enough to hand over an
 * account, fail closed as every other provisioning refusal does); or two Google
 * accounts on one auth user, which is what GoTrue's linking by address makes of a
 * newcomer signing in over the old owner's auth user, refused even on an unarmed row.
 *
 * WHERE IT RUNS. At sign in (`provision.ts`) and on every request
 * (`realCurrentUser` in `src/lib/auth.ts`), because a session can reach a row
 * without the sign in callback ever running (security review of #4169).
 *
 * A legitimate rehire on a NEW Google account is refused by the same rule, and an
 * admin lets them in with "Link a new Google account" on their page
 * (`relinkGoogleAccount` in `src/app/admin/actions.ts`), which forgets the stored
 * id and deletes the old auth user, after which their next sign in records the new
 * account on a fresh one.
 */

export type GoogleIdentityVerdict =
  | { kind: "same-person" }
  | { kind: "record"; sub: string }
  | { kind: "different-person"; reason: GoogleMismatchReason };

/**
 * Why a sign in was judged to be somebody else. Three causes with three different
 * investigations behind them (L11): a different account is an address reused or a
 * person on a new account; no account id at all is Google or Supabase not handing
 * one over, which is a fault in the sign in path itself; two accounts on one auth
 * user is what GoTrue's linking by address makes of a newcomer signing in over the
 * old owner's auth user.
 */
export type GoogleMismatchReason = "different-account" | "no-account-id" | "several-accounts";

/**
 * WHICH accounts are offered comes from the Google identities GoTrue keeps for the
 * auth user (`googleAccountIdsOf`), never from `user_metadata`: whoever holds a
 * session can rewrite their own metadata with `updateUser`, and GoTrue does not
 * refresh it when it links a second identity. Every Google identity counts, so an
 * auth user holding two cannot pass by having one of them match.
 */
export function judgeGoogleIdentity(
  stored: string | null | undefined,
  offered: readonly string[],
): GoogleIdentityVerdict {
  const kept = stored?.trim() ? stored : null;
  const accounts = [...new Set(offered.filter((s) => s.trim() !== ""))];
  if (accounts.length === 0) return { kind: "different-person", reason: "no-account-id" };
  if (accounts.length > 1) return { kind: "different-person", reason: "several-accounts" };
  const [only] = accounts as [string];
  if (kept === null) return { kind: "record", sub: only };
  return only === kept ? { kind: "same-person" } : { kind: "different-person", reason: "different-account" };
}

/** The shape of a Supabase auth user this module reads, and nothing more. */
export interface AuthUserIdentities {
  identities?: readonly { provider?: string; identity_data?: Record<string, unknown> | null }[] | null;
}

/**
 * Every Google account id on an auth user, read from its identities, which GoTrue
 * writes and the session holder cannot. `user_metadata` is deliberately not read.
 */
export function googleAccountIdsOf(user: AuthUserIdentities): string[] {
  const ids: string[] = [];
  for (const identity of user.identities ?? []) {
    if (identity.provider !== "google") continue;
    const sub = identity.identity_data?.sub;
    if (typeof sub === "string" && sub.trim() !== "") ids.push(sub);
  }
  return ids;
}

/**
 * A sign in refused because its Google account is not the one this Slate account
 * belongs to.
 *
 * Its own type, like `DeactivatedAccountError`, because the sign in callback has
 * to tell it apart from a retryable refusal: retrying never helps, the person
 * needs an admin, and Pennie needs to be told (`sign_in_google_account_mismatch`).
 * It carries the row's id and address for that alert, and never either account
 * id, which is not something anybody reading the alert can use.
 */
export class GoogleAccountMismatchError extends Error {
  readonly userId: string;
  readonly email: string;
  readonly reason: GoogleMismatchReason;

  constructor(args: { userId: string; email: string; reason: GoogleMismatchReason }) {
    super(`this sign in is not the Google account the Slate account belongs to (${args.reason})`);
    this.name = "GoogleAccountMismatchError";
    this.userId = args.userId;
    this.email = args.email;
    this.reason = args.reason;
  }
}

/**
 * A sign in refused because it carries two or more Google accounts and no Slate
 * account exists for it yet, so there is no row to name in an alert. Its own type
 * so the callback tells the person something other than "try again", which can
 * never work: the two accounts stay attached to that sign in until an admin acts.
 */
export class SeveralGoogleAccountsError extends Error {
  constructor() {
    super("this sign in carries more than one Google account and no Slate account exists for it");
    this.name = "SeveralGoogleAccountsError";
  }
}

/** The alert family, one key per Slate account, which the roster bounds. */
export const GOOGLE_ACCOUNT_MISMATCH_ALERT_PREFIX = "sign_in_google_account_mismatch";

export function googleAccountMismatchAlertKey(userId: string): string {
  return `${GOOGLE_ACCOUNT_MISMATCH_ALERT_PREFIX}:${userId}`;
}

/**
 * How often one account's refusals may page. Somebody refused tends to try again
 * at once, and every attempt is the same news, so the first page carries it and
 * the rest wait out the hour. Every refusal is still logged.
 */
export const GOOGLE_ACCOUNT_MISMATCH_COOLDOWN_MS = 60 * 60 * 1000;
