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
 * THREE OUTCOMES. A row with no stored id is recorded on this sign in, which is
 * what happened before this existed, so every row arms itself on its next sign
 * in rather than needing a backfill. A row whose id matches is the same person. A
 * row whose id differs is somebody else, and so is a sign in that carries no id
 * at all once the row has one: "I cannot tell who this is" must not be enough to
 * hand over an account that has said who it belongs to (fail closed, as every
 * other provisioning refusal does).
 *
 * A legitimate rehire on a NEW Google account is refused by the same rule, and is
 * let in by forgetting the stored id, after which their next sign in records the
 * new one ("A sign in was refused as a different person" in
 * `docs/alerts-runbook.md` says how).
 */

export type GoogleIdentityVerdict =
  | { kind: "same-person" }
  | { kind: "record" }
  | { kind: "different-person"; reason: GoogleMismatchReason };

/**
 * Why a sign in was judged to be somebody else. Two causes with two different
 * investigations behind them (L11): a different account is an address reused or a
 * person on a new account; no account id at all is Google or Supabase not handing
 * one over, which is a fault in the sign in path itself.
 */
export type GoogleMismatchReason = "different-account" | "no-account-id";

export function judgeGoogleIdentity(
  stored: string | null | undefined,
  signingIn: string | null | undefined,
): GoogleIdentityVerdict {
  const kept = stored?.trim() ? stored : null;
  const offered = signingIn?.trim() ? signingIn : null;
  if (kept === null) return { kind: "record" };
  if (offered === null) return { kind: "different-person", reason: "no-account-id" };
  return offered === kept ? { kind: "same-person" } : { kind: "different-person", reason: "different-account" };
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
