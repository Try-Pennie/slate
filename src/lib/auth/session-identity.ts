/**
 * May this session act as this row? (#4379)
 *
 * The judge `realCurrentUser` (`src/lib/auth.ts`) runs on every request once the row
 * has passed the departure and placeholder gate. Since #4379 a session can be a
 * coordinator's Microsoft sign in as well as a staff Google one, so it answers two
 * questions, each from something the session holder cannot write:
 *
 * HOW THE SESSION WAS MADE, from the VERIFIED claims' `amr` (`getClaims`). Every Slate
 * sign in is OAuth, Google or Microsoft, and nothing else: the Email provider stays off,
 * so a password, magic link, one time code or anonymous session is a way in that should
 * not exist, and is refused whoever it belongs to. Unknown or unreadable is refused too.
 *
 * WHOSE ACCOUNT IT IS, from the identities GoTrue keeps on the auth user (never
 * `user_metadata`). Which rule applies is decided by the ROW, not the session:
 *
 *  - a row that records a Microsoft account (`microsoft_sub`, written only by
 *    `linkCoordinator`) is a coordinator's Microsoft row: the auth user must hold
 *    exactly that Microsoft account and NO Google one. This is the tested exception to
 *    the Google check, which on its own refuses any session with no Google account;
 *  - every other row is a Google row, judged as before (#3526), and the auth user must
 *    hold no Microsoft account: GoTrue links accounts by address, and a session cannot
 *    say which of two accounts it came through, so holding both is refused.
 *
 * A coordinator on a Pennie Google account (the #4205 shape) records no Microsoft
 * account and keeps signing in with Google under the second rule.
 *
 * Pure: `scripts/test-session-identity.ts` drives every branch.
 */
import { accountIdsOf, judgeAccountIdentity, type AuthUserIdentities } from "./account-identity.ts";
import type { AccountMismatchReason } from "./account-identity.ts";
import type { Role } from "../db/types.ts";

/** The only sign in method Slate issues sessions for. */
export const ALLOWED_AMR_METHOD = "oauth";

/**
 * Whether the session's `amr` says OAuth and nothing else. Both forms supabase-js
 * types are read (RFC 8176 strings, and the detailed `{ method, timestamp }` entries);
 * anything else, an empty list, or no claim at all is not OAuth only.
 */
export function amrIsOauthOnly(amr: unknown): boolean {
  if (!Array.isArray(amr) || amr.length === 0) return false;
  return amr.every((entry) => {
    const method = typeof entry === "string" ? entry : (entry as { method?: unknown } | null)?.method;
    return method === ALLOWED_AMR_METHOD;
  });
}

export type SessionIdentityRefusal =
  /** The session was not made by an OAuth sign in alone. */
  | { admit: false; reason: "not-oauth" }
  /** A Google row's Google check refused it (#3526): the reason the alert names. */
  | { admit: false; reason: "google"; google: AccountMismatchReason }
  /** A Google row whose auth user also, or only, holds a Microsoft account. */
  | { admit: false; reason: "microsoft-on-google-row" }
  /** A Microsoft row whose auth user holds a Google account. */
  | { admit: false; reason: "google-on-microsoft-row" }
  /** A Microsoft row reached without exactly the Microsoft account it recorded. */
  | { admit: false; reason: "microsoft-account" }
  /** A row recording a Microsoft account that is not a coordinator's. */
  | { admit: false; reason: "not-a-coordinator" };

export type SessionIdentityVerdict = { admit: true } | SessionIdentityRefusal;

export interface SessionIdentityInput {
  row: { role: Role; google_sub: string | null; microsoft_sub?: string | null };
  /** The verified claims' `amr`, exactly as `getClaims` returned it. */
  amr: unknown;
  user: AuthUserIdentities;
}

export function judgeSessionIdentity(input: SessionIdentityInput): SessionIdentityVerdict {
  if (!amrIsOauthOnly(input.amr)) return { admit: false, reason: "not-oauth" };
  const googleIds = accountIdsOf(input.user, "google");
  const microsoftIds = accountIdsOf(input.user, "azure");
  const recordedMicrosoft = input.row.microsoft_sub?.trim() ? input.row.microsoft_sub : null;

  if (recordedMicrosoft !== null) {
    if (input.row.role !== "coordinator") return { admit: false, reason: "not-a-coordinator" };
    if (googleIds.length > 0) return { admit: false, reason: "google-on-microsoft-row" };
    const verdict = judgeAccountIdentity(recordedMicrosoft, microsoftIds);
    return verdict.kind === "same-person" ? { admit: true } : { admit: false, reason: "microsoft-account" };
  }

  if (microsoftIds.length > 0) return { admit: false, reason: "microsoft-on-google-row" };
  const verdict = judgeAccountIdentity(input.row.google_sub, googleIds);
  if (verdict.kind === "different-person") return { admit: false, reason: "google", google: verdict.reason };
  return { admit: true };
}
