/**
 * Whether a sign in is the same PERSON as the Slate row it found, for any provider
 * whose accounts carry a permanent id (#3526, #4379).
 *
 * The rule was written for Google (`google-identity.ts`, which explains it in full)
 * and is the same rule for Microsoft: the address only FINDS a row, and the
 * provider's permanent account id, once stored, says whose it is. One judge for
 * both, so the two sign ins cannot come to differ about what "the same person" means.
 *
 * THREE OUTCOMES. A stored id that matches the one account offered is the same
 * person. No stored id records the one account offered. Anything else is somebody
 * else: a different account, no account at all, or two accounts of that provider on
 * one auth user.
 */

export type AccountIdentityVerdict =
  | { kind: "same-person" }
  | { kind: "record"; sub: string }
  | { kind: "different-person"; reason: AccountMismatchReason };

/** Why a sign in was judged to be somebody else (see `google-identity.ts`). */
export type AccountMismatchReason = "different-account" | "no-account-id" | "several-accounts";

/** The providers Slate signs anybody in with: Google for staff, Microsoft for coordinators. */
export type SignInProvider = "google" | "azure";

export function judgeAccountIdentity(
  stored: string | null | undefined,
  offered: readonly string[],
): AccountIdentityVerdict {
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
 * Every account id of one provider on an auth user, read from its identities, which
 * GoTrue writes and the session holder cannot. `user_metadata` is deliberately never
 * read: whoever holds a session can rewrite it with `updateUser`.
 */
export function accountIdsOf(user: AuthUserIdentities, provider: SignInProvider): string[] {
  const ids: string[] = [];
  for (const identity of user.identities ?? []) {
    if (identity.provider !== provider) continue;
    const sub = identity.identity_data?.sub;
    if (typeof sub === "string" && sub.trim() !== "") ids.push(sub);
  }
  return ids;
}
