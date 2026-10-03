/**
 * How long a staff sign in may last (#3084).
 *
 * Dan, 2026-10-03: a staff sign in lasts at most 30 DAYS in total, and ends after 7 DAYS
 * without use. Before this nothing ended one: middleware refreshed the session on every
 * staff request, the refresh token has no absolute expiry, and a lost laptop belonging
 * to a current employee kept the roster and every lead's contact details for as long as
 * it kept its cookies.
 *
 * TWO LAYERS, deliberately. Supabase's hosted Auth settings carry a session time box and
 * an inactivity timeout (recorded in DEPLOY.md and supabase/config.toml), and they are
 * the stronger control because they kill the refresh token itself. But the Worker cannot
 * read those settings back, so a dashboard value that was never set, or was later
 * cleared, would be invisible from here. So the same two limits are enforced in code too,
 * from two httpOnly cookies the server writes:
 *
 *  - `SESSION_STARTED_COOKIE`, stamped once at the sign in callback and never moved, so
 *    the 30 days are counted from the sign in rather than from the latest refresh;
 *  - `SESSION_SEEN_COOKIE`, restamped by middleware on every staff page request, and
 *    given a maxAge of the idle limit, so the browser drops it after 7 quiet days.
 *
 * FAIL CLOSED (L42). A session with no sign in stamp, or one this cannot read, is
 * refused rather than stamped now. Restamping would let anyone holding the session reset
 * the clock by deleting a cookie, which is the same as having no time box; the cost is
 * that every staff session that predates this change signs in once more.
 *
 * WHAT IT DOES NOT DO. The stamps are not signed, so somebody who already holds the
 * device and edits its cookies by hand can extend them. That is the case the hosted
 * settings cover, and why both layers exist.
 *
 * Pure apart from nothing: the clock is passed in, so scripts/test-session-age.ts drives
 * every boundary from both sides (L524).
 */

const DAY_MS = 24 * 60 * 60_000;

/** The most a sign in can last, however much it is used. */
export const SESSION_TIME_BOX_MS = 30 * DAY_MS;

/** How long a sign in survives with no staff request. */
export const SESSION_IDLE_MS = 7 * DAY_MS;

/** When this browser signed in, as epoch milliseconds. Written only by the callback. */
export const SESSION_STARTED_COOKIE = "slate-signed-in-at";

/** When this browser last made a staff request, as epoch milliseconds. */
export const SESSION_SEEN_COOKIE = "slate-last-seen-at";

/** Both stamps, for whatever clears a session. */
export const SESSION_STAMP_COOKIES = [SESSION_STARTED_COOKIE, SESSION_SEEN_COOKIE] as const;

/** How far ahead of the clock a stamp may sit before it is treated as unreadable. Covers
 *  nothing but clock disagreement between two Worker isolates. */
const FUTURE_SKEW_MS = 5 * 60_000;

export type SessionAgeRefusal = "time-box" | "idle" | "unstamped";

export type SessionAgeVerdict = { admit: true } | { admit: false; reason: SessionAgeRefusal };

/** A stamp as it is written into its cookie. */
export function stampValue(ms: number): string {
  return String(Math.trunc(ms));
}

/** A stamp read back, or null for anything that is not a plain count of milliseconds. */
function readStamp(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d{1,15}$/.test(raw)) return null;
  return Number(raw);
}

/**
 * May this session go on? The time box is judged first, because a session past it is
 * over however recently it was used, and its message says so.
 */
export function judgeSessionAge(input: {
  started: string | undefined;
  seen: string | undefined;
  nowMs: number;
}): SessionAgeVerdict {
  const started = readStamp(input.started);
  if (started === null || started > input.nowMs + FUTURE_SKEW_MS) {
    return { admit: false, reason: "unstamped" };
  }
  if (input.nowMs - started >= SESSION_TIME_BOX_MS) return { admit: false, reason: "time-box" };

  // An absent last use stamp is the browser having dropped it at its maxAge, which is
  // the idle limit, so absence reads as idle. A malformed one cannot have come from us.
  if (input.seen === undefined) return { admit: false, reason: "idle" };
  const seen = readStamp(input.seen);
  if (seen === null || seen > input.nowMs + FUTURE_SKEW_MS) return { admit: false, reason: "unstamped" };
  if (input.nowMs - seen >= SESSION_IDLE_MS) return { admit: false, reason: "idle" };
  return { admit: true };
}

/** The `?error=` a refused session lands on /login with. One per reason (L11). */
export function sessionRefusalLoginError(reason: SessionAgeRefusal): string {
  switch (reason) {
    case "time-box":
      return "session_expired";
    case "idle":
      return "session_idle";
    case "unstamped":
      return "session_ended";
  }
}

/** Whole days, for the sentences the login page shows. */
export const SESSION_TIME_BOX_DAYS = SESSION_TIME_BOX_MS / DAY_MS;
export const SESSION_IDLE_DAYS = SESSION_IDLE_MS / DAY_MS;

/**
 * The attributes a stamp is written with: the auth cookies' own hardening, and a lifetime
 * equal to the limit it stands for. `Secure` follows the same production rule.
 */
export function sessionStampCookieOptions(kind: "started" | "seen") {
  return {
    httpOnly: true as const,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: (kind === "started" ? SESSION_TIME_BOX_MS : SESSION_IDLE_MS) / 1000,
  };
}

/**
 * Whether a request carries a Supabase session at all. The session cookie is
 * `sb-<ref>-auth-token`, chunked as `.0`, `.1` when long; the PKCE verifier beside it
 * during sign in is not a session. Used so somebody who never signed in is sent to sign
 * in the ordinary way, and not told they were signed out.
 */
export function hasSupabaseSessionCookie(names: Iterable<string>): boolean {
  for (const name of names) {
    if (/^sb-.+-auth-token(\.\d+)?$/.test(name)) return true;
  }
  return false;
}

/** Every cookie a refused session must lose: its Supabase cookies and both stamps. */
export function sessionCookiesToClear(names: Iterable<string>): string[] {
  const out = new Set<string>(SESSION_STAMP_COOKIES);
  for (const name of names) if (name.startsWith("sb-")) out.add(name);
  return [...out];
}
