// #3084: a staff sign in lasts at most 30 days in total, and ends after 7 days without a
// staff request. These drive the pure judge with an injected clock (L524), on BOTH sides
// of each boundary, so a judge hard wired to one answer cannot pass.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-session-age.ts
import {
  SESSION_TIME_BOX_MS,
  SESSION_IDLE_MS,
  SESSION_STARTED_COOKIE,
  SESSION_SEEN_COOKIE,
  judgeSessionAge,
  sessionRefusalLoginError,
  sessionStampCookieOptions,
  hasSupabaseSessionCookie,
  stampValue,
} from "../src/lib/auth/session-age.ts";
import { AUTH_COOKIE_MAX_AGE_SECONDS } from "../src/lib/supabase/cookie-options.ts";
import { readFileSync } from "node:fs";
import { assert, eq, finish } from "./lib/harness.ts";

const DAY = 24 * 60 * 60_000;
const T0 = Date.UTC(2026, 9, 3, 12, 0, 0);
const judge = (startedMs: number | null, seenMs: number | null, nowMs: number) =>
  judgeSessionAge({
    started: startedMs === null ? undefined : stampValue(startedMs),
    seen: seenMs === null ? undefined : stampValue(seenMs),
    nowMs,
  });

eq(SESSION_TIME_BOX_MS, 30 * DAY, "the time box is 30 days (Dan, 2026-10-03)");
eq(SESSION_IDLE_MS, 7 * DAY, "the idle limit is 7 days (Dan, 2026-10-03)");
eq(
  AUTH_COOKIE_MAX_AGE_SECONDS * 1000,
  SESSION_IDLE_MS,
  "the auth cookie's maxAge is aligned with the idle limit, so the browser drops an idle session too",
);
assert(SESSION_STARTED_COOKIE !== SESSION_SEEN_COOKIE, "the two stamps are separate cookies");

// A fresh sign in is admitted.
assert(judge(T0, T0, T0).admit, "a session signed in this instant is admitted");

// The time box, on both sides of the boundary, with the session in constant use.
{
  const atLimit = T0 + SESSION_TIME_BOX_MS;
  const before = judge(T0, atLimit - 1, atLimit - 1);
  assert(before.admit, "one millisecond inside 30 days is admitted");
  const at = judge(T0, atLimit, atLimit);
  assert(!at.admit && at.reason === "time-box", "exactly 30 days after signing in is refused as time-box");
  const after = judge(T0, atLimit + DAY, atLimit + DAY);
  assert(!after.admit && after.reason === "time-box", "past 30 days is refused, however recent the last use");
}

// The idle limit, on both sides, well inside the time box.
{
  const seen = T0 + 5 * DAY;
  const before = judge(T0, seen, seen + SESSION_IDLE_MS - 1);
  assert(before.admit, "one millisecond short of 7 idle days is admitted");
  const at = judge(T0, seen, seen + SESSION_IDLE_MS);
  assert(!at.admit && at.reason === "idle", "exactly 7 days without use is refused as idle");
}

// Absent and unreadable stamps fail CLOSED (L42). A missing start stamp is refused rather
// than restamped, because restamping would let anybody holding the session reset its
// clock by deleting a cookie, which is the time box not existing.
{
  const noStart = judge(null, T0, T0);
  assert(!noStart.admit && noStart.reason === "unstamped", "no sign in stamp is refused");
  const noSeen = judge(T0, null, T0 + DAY);
  assert(!noSeen.admit && noSeen.reason === "idle", "no last use stamp reads as idle: the browser dropped it after 7 days");
  for (const bad of ["", "abc", "12.5", "-5", "1e12", " 123"]) {
    const r = judgeSessionAge({ started: bad, seen: stampValue(T0), nowMs: T0 });
    assert(!r.admit && r.reason === "unstamped", `an unreadable sign in stamp ${JSON.stringify(bad)} is refused`);
  }
  const future = judge(T0 + DAY, T0, T0);
  assert(!future.admit && future.reason === "unstamped", "a sign in stamp in the future is refused, not trusted");
  const futureSeen = judge(T0, T0 + DAY, T0);
  assert(!futureSeen.admit && futureSeen.reason === "unstamped", "a last use stamp in the future is refused");
}

// Each refusal sends the person to its own sentence (L11), and every one is a key the
// login page knows.
{
  const codes = (["time-box", "idle", "unstamped"] as const).map(sessionRefusalLoginError);
  eq(new Set(codes).size, 3, "three refusals, three login errors");
}

// The stamp cookies carry the same hardening as the auth cookies, and each lives
// exactly as long as the limit it stands for.
{
  const started = sessionStampCookieOptions("started");
  const seen = sessionStampCookieOptions("seen");
  assert(started.httpOnly && seen.httpOnly, "both stamps are httpOnly");
  eq(started.sameSite, "lax", "SameSite=Lax");
  eq(started.path, "/", "path /");
  eq(started.maxAge * 1000, SESSION_TIME_BOX_MS, "the sign in stamp lives 30 days");
  eq(seen.maxAge * 1000, SESSION_IDLE_MS, "the last use stamp lives 7 days");
}

// Only a real session cookie counts as somebody being signed in, so a visitor who never
// signed in is not told they were signed out.
assert(hasSupabaseSessionCookie(["sb-abc-auth-token"]), "the session cookie counts");
assert(hasSupabaseSessionCookie(["theme", "sb-abc-auth-token.0", "sb-abc-auth-token.1"]), "a chunked one counts");
assert(!hasSupabaseSessionCookie(["sb-abc-auth-token-code-verifier"]), "the PKCE verifier alone does not");
assert(!hasSupabaseSessionCookie(["slate-theme"]), "no Supabase cookie at all does not");

// The local stack's hosted-equivalent settings carry the same two limits as the code,
// read out of the file rather than restated, so one cannot move without the other.
{
  const toml = readFileSync(new URL("../supabase/config.toml", import.meta.url), "utf8");
  const section = /^\[auth\.sessions\]\n([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(toml)?.[1] ?? "";
  const hours = (key: string) => {
    const m = new RegExp(`^${key}\\s*=\\s*"(\\d+)h"`, "m").exec(section);
    return m ? Number(m[1]) * 60 * 60_000 : null;
  };
  eq(hours("timebox"), SESSION_TIME_BOX_MS, "config.toml [auth.sessions] timebox matches the code's time box");
  eq(hours("inactivity_timeout"), SESSION_IDLE_MS, "config.toml [auth.sessions] inactivity_timeout matches the idle limit");
}

finish();
