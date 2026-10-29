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
 *   LOGINS. `auth_logins_by_provider` (migration 0212) reads auth.audit_log_entries:
 *   every login GoTrue recorded in the last day, by the provider it named. Anything but
 *   Google or Microsoft (email, a magic link, phone, anonymous) is a way in that should
 *   not exist, and expected zero. Independent of the session gate, which refuses such a
 *   session on its next request but cannot say it was ever made, and of the settings
 *   check (`auth-sign-in-surface.ts`), which sees a provider switched on, not used.
 *
 *   ACCOUNTS. The admin listing of auth users against the roster. An address outside
 *   trypennie.com belongs to a coordinator, so an outside auth user no ACTIVE coordinator
 *   row is linked to is a sign in that outlived its row: a removal whose delete failed
 *   (`removeCoordinator`), or a Microsoft sign in the hook let through and the callback
 *   then refused before linking. An auth user with no address at all counts as outside.
 *
 * THREE OUTCOMES PER HALF (L98). An audit read that found no entry of ANY kind in a day
 * is unmeasured, not clean: GoTrue writes an entry on every token refresh, so a silent
 * day means the log is not being written (hosted projects can switch it off), which
 * would otherwise read forever as nobody signing in another way. An incomplete account
 * listing, an unreadable roster or an unknown company domain is unmeasured too. Either
 * half's finding pages; the all clear hangs only off BOTH measured clean.
 *
 * ONCE AN HOUR, over a day. auth.audit_log_entries carries no index on its time
 * (measured on the platform image 2026-10-29: only the primary key and instance_id),
 * so each read scans the table. The first five minute tick of each hour reads; the
 * other eleven are not due and read nothing.
 */

import type { AlertResolve, ThrottledNotify } from "./alert-deps";
import { logAlertSendFailure, logResolveFailure } from "../notify/send-failure.ts";
import { isAllowedEmail } from "../auth/domain.ts";

/** alert_state key for the condition. */
export const AUTH_UNEXPECTED_SIGN_IN_KEY = "auth_unexpected_sign_in";

/** The providers a Slate login may name: Google for staff, Microsoft for coordinators. */
export const ALLOWED_LOGIN_PROVIDERS: readonly string[] = ["google", "azure"];

/** How often the check does its work (see the header). */
export const AUTH_UNEXPECTED_SIGN_IN_CADENCE_MS = 60 * 60_000;

/** How far back each read looks: a day, so a quiet night still proves the log is written. */
export const AUTH_LOGIN_WINDOW_MS = 24 * 60 * 60_000;

/** The window inside each hour whose monitor tick reads. One tick, since the lane ticks every five minutes. */
const DUE_WINDOW_MINUTES = 5;

/** At most this many addresses named per line of the page; the rest are counted. */
const NAMED_PER_LINE = 10;

/** True on the one five minute monitor tick an hour that runs this check. */
export function authUnexpectedSignInDue(nowMs: number): boolean {
  return new Date(nowMs).getUTCMinutes() < DUE_WINDOW_MINUTES;
}

export interface OffendingLogins {
  provider: string;
  logins: number;
  actors: string[];
}

export type LoginsVerdict =
  | { status: "unmeasured"; why: string }
  | { status: "measured"; entries: number; offending: OffendingLogins[] };

/** Judge `auth_logins_by_provider`'s answer. Any shape it cannot read is unmeasured (L50). */
export function judgeLogins(body: unknown): LoginsVerdict {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { status: "unmeasured", why: "the audit log read answered nothing readable" };
  }
  const b = body as { entries?: unknown; logins?: unknown };
  if (typeof b.entries !== "number" || !Number.isFinite(b.entries) || !Array.isArray(b.logins)) {
    return { status: "unmeasured", why: "the audit log read answered a shape this cannot judge" };
  }
  const rows: OffendingLogins[] = [];
  for (const raw of b.logins as unknown[]) {
    const r = raw as { provider?: unknown; logins?: unknown; actors?: unknown } | null;
    if (!r || typeof r.provider !== "string" || typeof r.logins !== "number" || !Array.isArray(r.actors)) {
      return { status: "unmeasured", why: "the audit log read answered a login row this cannot judge" };
    }
    rows.push({ provider: r.provider, logins: r.logins, actors: r.actors.filter((a): a is string => typeof a === "string") });
  }
  if (b.entries === 0) {
    return { status: "unmeasured", why: "the audit log recorded nothing at all in the last day, so it cannot say how anybody signed in" };
  }
  return {
    status: "measured",
    entries: b.entries,
    offending: rows.filter((r) => !ALLOWED_LOGIN_PROVIDERS.includes(r.provider) && r.logins > 0),
  };
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
    const by = o.provider ? `by ${o.provider}` : "naming no provider";
    lines.push(
      `- ${o.logins} sign in${o.logins === 1 ? "" : "s"} in the last day ${by} (${named(o.actors)}). ` +
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
    "outside trypennie.com without an active coordinator, read from the audit log and the account list."
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
  readLogins: (sinceIso: string) => Promise<unknown>;
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
    logins = judgeLogins(await deps.readLogins(new Date(deps.nowMs - AUTH_LOGIN_WINDOW_MS).toISOString()));
  } catch (err) {
    logins = { status: "unmeasured", why: `the audit log could not be read (${err instanceof Error ? err.name : "error"})` };
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
      ...offending.flatMap((o) => (o.actors.length > 0 ? o.actors : [""]).map((a) => `login:${o.provider}:${a}`)),
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
