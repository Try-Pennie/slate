/**
 * Does Supabase Auth in production hold a sign in, or an account, Slate does not allow?
 * (#4379)
 *
 * Since invited scheduling coordinators sign in with their own company Microsoft
 * account, Slate's ways in are exactly two: Google for staff, Microsoft (`azure`) for
 * coordinators. Three controls hold that (the before_user_created hook, the sign in
 * callback, the session gate), and this check watches what got past them from Auth's
 * OWN record, never from anything Slate wrote about itself (L58). Two halves:
 *
 *   LOGINS. `auth_sign_in_methods` (migration 0212) reads auth.mfa_amr_claims, one row per
 *   session per method, the record a session's `amr` claim is built from: how every
 *   session made in the last day was signed in. Every Slate sign in is OAuth (Google or
 *   Microsoft), so any other method (password, otp, magic link, anonymous) is a way in
 *   that should not exist, and expected zero. NOT auth.audit_log_entries: production
 *   holds 0 rows there (measured 2026-10-29, the hosted project does not write auth
 *   audit logs to the database), which would have made this half blind for ever.
 *   Independent of the session gate, which refuses such a session on its next request but
 *   cannot say it was ever made, and of the settings check (`auth-sign-in-surface.ts`),
 *   which sees a provider switched on, not used.
 *
 *   ACCOUNTS. The admin listing of auth users against the roster. An address outside
 *   trypennie.com belongs to a coordinator, so an outside auth user no ACTIVE coordinator
 *   row is linked to is a sign in that outlived its row: a removal whose delete failed
 *   (`removeCoordinator`), or a Microsoft sign in the hook let through and the callback
 *   then refused before linking. An auth user with no address at all counts as outside.
 *
 * THREE OUTCOMES PER HALF (L98). The logins half carries a POSITIVE CONTROL (L557): a
 * week with no OAuth sign in at all is unmeasured, not clean, since staff sign in every
 * day, and an empty table would otherwise read for ever as nobody signing in another
 * way. Findings come from the last day only, so production's old one time code sessions
 * (June 2026) never page. An incomplete account listing, an unreadable roster or an
 * unknown company domain is unmeasured too. Either half's finding pages; the all clear
 * hangs only off BOTH measured clean.
 *
 * ONCE AN HOUR. The claims table is small (198 rows on 2026-10-29) but has no index on
 * its time, and the account listing is an admin API call, so the first five minute tick
 * of each hour reads and the other eleven are not due and read nothing.
 */

import type { AlertResolve, ThrottledNotify } from "./alert-deps";
import { logAlertSendFailure, logResolveFailure } from "../notify/send-failure.ts";
import { isAllowedEmail } from "../auth/domain.ts";

/** alert_state key for the condition. */
export const AUTH_UNEXPECTED_SIGN_IN_KEY = "auth_unexpected_sign_in";

/** How often the check does its work (see the header). */
export const AUTH_UNEXPECTED_SIGN_IN_CADENCE_MS = 60 * 60_000;

/** How far back a finding is looked for: a day, so old sessions never page. */
export const AUTH_LOGIN_WINDOW_MS = 24 * 60 * 60_000;

/** How far back the positive control looks for an OAuth sign in: a week, past any quiet weekend. */
export const AUTH_LOGIN_CONTROL_WINDOW_MS = 7 * 24 * 60 * 60_000;

/** The one sign in method Slate issues sessions for (`judgeSessionIdentity`). */
const ALLOWED_METHOD = "oauth";

/** The window inside each hour whose monitor tick reads. One tick, since the lane ticks every five minutes. */
const DUE_WINDOW_MINUTES = 5;

/** At most this many addresses named per line of the page; the rest are counted. */
const NAMED_PER_LINE = 10;

/** True on the one five minute monitor tick an hour that runs this check. */
export function authUnexpectedSignInDue(nowMs: number): boolean {
  return new Date(nowMs).getUTCMinutes() < DUE_WINDOW_MINUTES;
}

export interface OffendingLogins {
  /** The amr method the sessions were made by, as GoTrue records it. */
  method: string;
  sessions: number;
  actors: string[];
}

export type LoginsVerdict =
  | { status: "unmeasured"; why: string }
  | { status: "measured"; oauthControl: number; offending: OffendingLogins[] };

/** Judge `auth_sign_in_methods`'s answer. Any shape it cannot read is unmeasured (L50). */
export function judgeLogins(body: unknown): LoginsVerdict {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { status: "unmeasured", why: "the sign in method read answered nothing readable" };
  }
  const b = body as { oauth_control?: unknown; methods?: unknown };
  if (typeof b.oauth_control !== "number" || !Number.isFinite(b.oauth_control) || !Array.isArray(b.methods)) {
    return { status: "unmeasured", why: "the sign in method read answered a shape this cannot judge" };
  }
  const rows: OffendingLogins[] = [];
  for (const raw of b.methods as unknown[]) {
    const r = raw as { method?: unknown; sessions?: unknown; actors?: unknown } | null;
    if (!r || typeof r.method !== "string" || typeof r.sessions !== "number" || !Array.isArray(r.actors)) {
      return { status: "unmeasured", why: "the sign in method read answered a row this cannot judge" };
    }
    rows.push({ method: r.method, sessions: r.sessions, actors: r.actors.filter((a): a is string => typeof a === "string") });
  }
  const offending = rows.filter((r) => r.method !== ALLOWED_METHOD && r.sessions > 0);
  // A finding stands on its own; only a CLEAN answer needs the control behind it.
  if (b.oauth_control === 0 && offending.length === 0) {
    return { status: "unmeasured", why: "no OAuth sign in was recorded in the last week, so the claims cannot say how anybody signed in" };
  }
  return { status: "measured", oauthControl: b.oauth_control, offending };
}

export interface OrphanAccount {
  authUserId: string;
  email: string | null;
}

export type AccountsVerdict =
  | { status: "unmeasured"; why: string }
  | { status: "measured"; complete: boolean; orphans: OrphanAccount[] };

/** Judge the auth user listing against the active coordinators' links. */
export function judgeOutsideAccounts(input: {
  listing: { complete: boolean; users: readonly { id: string; email: string | null }[] };
  activeCoordinatorAuthIds: ReadonlySet<string>;
  hostedDomain: string;
}): AccountsVerdict {
  // An empty domain is the open mode in which every address is inside, so nothing
  // could ever be judged outside it; that is not a clean reading.
  if (!input.hostedDomain.trim()) return { status: "unmeasured", why: "no company domain is configured to judge addresses against" };
  const orphans = input.listing.users
    .filter((u) => !(u.email && isAllowedEmail(u.email, input.hostedDomain)))
    .filter((u) => !input.activeCoordinatorAuthIds.has(u.id))
    .map((u) => ({ authUserId: u.id, email: u.email }));
  if (!input.listing.complete && orphans.length === 0) {
    return { status: "unmeasured", why: "the auth user listing did not reach its end" };
  }
  return { status: "measured", complete: input.listing.complete, orphans };
}

function named(addresses: readonly string[]): string {
  const shown = addresses.slice(0, NAMED_PER_LINE).map((a) => a || "no address");
  const rest = addresses.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

/** The page. One line per finding, each with what to do about it. */
export function formatAuthUnexpectedSignInAlert(found: {
  offending: readonly OffendingLogins[];
  orphans: readonly OrphanAccount[];
}): string {
  const lines: string[] = [];
  for (const o of found.offending) {
    const by = o.method ? `by ${o.method}` : "naming no method";
    lines.push(
      `- ${o.sessions} sign in${o.sessions === 1 ? "" : "s"} in the last day ${by} (${named(o.actors)}). ` +
        "Check Authentication, Sign In / Providers in the Supabase dashboard, then who these are.",
    );
  }
  if (found.orphans.length > 0) {
    const n = found.orphans.length;
    lines.push(
      `- ${n} account${n === 1 ? "" : "s"} outside trypennie.com with no active coordinator behind ${n === 1 ? "it" : "them"} ` +
        `(${named(found.orphans.map((o) => o.email ?? ""))}). Delete ${n === 1 ? "it" : "them"} in the Supabase dashboard under ` +
        "Authentication, Users, unless the address should be granted as a coordinator on Team access.",
    );
  }
  return (
    "Supabase Auth in production holds sign ins or accounts beyond Google for staff and Microsoft for invited coordinators:\n" +
    lines.join("\n")
  );
}

/** The all clear. */
export function formatAuthUnexpectedSignInCleared(): string {
  return (
    "Supabase Auth in production shows no sign in in the last day by anything but Google or Microsoft, and no account " +
    "outside trypennie.com without an active coordinator, read from the sessions' sign in methods and the account list."
  );
}

export type AuthUnexpectedSignInResult =
  | { status: "not-due" }
  | { status: "unmeasured" | "healthy" | "found"; logins: LoginsVerdict; accounts: AccountsVerdict };

/**
 * The lane's step. Each read that throws is caught HERE, as its own half's unmeasured
 * answer, so one half failing never hides the other's finding.
 */
export async function runAuthUnexpectedSignInCheck(deps: {
  nowMs: number;
  hostedDomain: string;
  readLogins: (sinceIso: string, controlSinceIso: string) => Promise<unknown>;
  readAccounts: () => Promise<{ complete: boolean; users: readonly { id: string; email: string | null }[] }>;
  readActiveCoordinatorAuthIds: () => Promise<readonly string[]>;
  notify: ThrottledNotify;
  resolve: AlertResolve<unknown>;
  cooldownMs: number;
  log?: (msg: string) => void;
}): Promise<AuthUnexpectedSignInResult> {
  if (!authUnexpectedSignInDue(deps.nowMs)) return { status: "not-due" };

  let logins: LoginsVerdict;
  try {
    logins = judgeLogins(
      await deps.readLogins(
        new Date(deps.nowMs - AUTH_LOGIN_WINDOW_MS).toISOString(),
        new Date(deps.nowMs - AUTH_LOGIN_CONTROL_WINDOW_MS).toISOString(),
      ),
    );
  } catch (err) {
    logins = { status: "unmeasured", why: `the sign in methods could not be read (${err instanceof Error ? err.name : "error"})` };
  }

  let accounts: AccountsVerdict;
  try {
    const [listing, linked] = await Promise.all([deps.readAccounts(), deps.readActiveCoordinatorAuthIds()]);
    accounts = judgeOutsideAccounts({ listing, activeCoordinatorAuthIds: new Set(linked), hostedDomain: deps.hostedDomain });
  } catch (err) {
    accounts = { status: "unmeasured", why: `the accounts or the roster could not be read (${err instanceof Error ? err.name : "error"})` };
  }

  const offending = logins.status === "measured" ? logins.offending : [];
  const orphans = accounts.status === "measured" ? accounts.orphans : [];
  if (offending.length > 0 || orphans.length > 0) {
    const subjects = [
      ...offending.flatMap((o) => (o.actors.length > 0 ? o.actors : [""]).map((a) => `login:${o.method}:${a}`)),
      ...orphans.map((o) => `account:${o.authUserId}`),
    ];
    await deps
      .notify(AUTH_UNEXPECTED_SIGN_IN_KEY, deps.cooldownMs, formatAuthUnexpectedSignInAlert({ offending, orphans }), { subjects })
      .catch(logAlertSendFailure(AUTH_UNEXPECTED_SIGN_IN_KEY));
    deps.log?.(`monitor auth-unexpected-sign-in: FOUND logins=${offending.length} orphans=${orphans.length}`);
    return { status: "found", logins, accounts };
  }

  const clean = logins.status === "measured" && accounts.status === "measured" && accounts.complete;
  if (!clean) {
    const why = [logins, accounts].flatMap((v) => (v.status === "unmeasured" ? [v.why] : [])).join("; ");
    deps.log?.(`monitor auth-unexpected-sign-in: unmeasured, ${why}`);
    return { status: "unmeasured", logins, accounts };
  }

  // The all clear hangs off BOTH halves measured clean, never off "nothing was found
  // this tick" (#1134): every unmeasured branch above returns before reaching it.
  await deps
    .resolve(AUTH_UNEXPECTED_SIGN_IN_KEY, formatAuthUnexpectedSignInCleared())
    .catch(logResolveFailure(AUTH_UNEXPECTED_SIGN_IN_KEY));
  deps.log?.("monitor auth-unexpected-sign-in: healthy");
  return { status: "healthy", logins, accounts };
}
