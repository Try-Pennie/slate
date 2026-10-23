import { NextResponse, type NextRequest } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { provisionUser } from "@/lib/provision";
import { DeactivatedAccountError } from "@/lib/auth/active-session";
import { GoogleAccountMismatchError, googleAccountIdsOf } from "@/lib/auth/google-identity";
import { GOOGLE_ACCOUNT_CHANGED_LOGIN_ERROR } from "@/lib/auth/google-identity-copy";
import { reportGoogleAccountRefusal } from "@/lib/auth/google-account-refusal";
import {
  SESSION_SEEN_COOKIE,
  SESSION_STARTED_COOKIE,
  sessionStampCookieOptions,
  stampValue,
} from "@/lib/auth/session-age";
import { ensureWatches } from "@/lib/google/sync";
import { canManageAgents } from "@/lib/auth/roles";
import { isAllowedEmail } from "@/lib/auth/domain";
import { googleHostedDomain } from "@/lib/env";
import { log } from "@/lib/log";
import { ME_TABS } from "@/lib/me/nav";
import {
  DEFAULT_THEME_PREFERENCE,
  THEME_COOKIE,
  THEME_COOKIE_MAX_AGE,
} from "@/lib/theme/boot";

export const dynamic = "force-dynamic";

/**
 * OAuth callback for Supabase Google SSO (admin login). Exchanges the code for
 * a session, provisions the Slate user, and warms their calendar cache.
 *
 * Redirects use the REQUEST origin, not NEXT_PUBLIC_APP_URL: the session
 * cookies are set on the host that served this callback, so bouncing to the
 * canonical app URL from a different host (local dev) would strand the
 * fresh session on an origin the user never lands on (#40).
 */
export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin;
  const code = req.nextUrl.searchParams.get("code");
  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=missing_code`);
  }

  const supabase = await supabaseServer();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.session) {
    return NextResponse.redirect(`${origin}/login?error=exchange_failed`);
  }

  const { user } = data.session;
  const meta = user.user_metadata ?? {};
  const email = user.email ?? (meta.email as string) ?? "";

  // Enforce the Google Workspace domain server-side (#589). The `hd` hint on the
  // login page is browser-supplied and bypassable; this is the real gate. Reject
  // unverified or out-of-domain emails BEFORE provisioning so an outside account
  // never gets a live users row. Sign out first to clear the session cookies the
  // code exchange just set.
  //
  // Both halves fail CLOSED (#3083): an unconfigured domain refuses every
  // sign-in rather than reading as "allow any account", and only a claim that
  // is exactly true counts as verified, so an ABSENT claim is refused too.
  let hostedDomain: string;
  try {
    hostedDomain = googleHostedDomain();
  } catch (err) {
    log.error("auth-callback", { msg: "sign-in domain not configured", auth_user_id: user.id }, err);
    await supabase.auth.signOut();
    return NextResponse.redirect(`${origin}/login?error=sign_in_unavailable`);
  }
  if (meta.email_verified !== true || !isAllowedEmail(email, hostedDomain)) {
    await supabase.auth.signOut();
    return NextResponse.redirect(`${origin}/login?error=domain_not_allowed`);
  }

  // Provisioning REFUSES rather than degrading (#1648): an unreadable users or
  // organizations read, or a race it lost that it still could not resolve, throws
  // instead of falling through to an insert that would create a second
  // organization or a duplicate users row. That refusal lands on a person signing
  // in, so it has to read as a retryable sign-in failure rather than a stack
  // trace, and the session the code exchange just set has to go with it: leaving
  // it would put them on an internal page with no Slate row behind it, where every
  // request resolves the session by auth_user_id and finds nothing. The detail is
  // kept server-side in the logs, keyed on the auth user rather than the email.
  //
  // #3526: the Google account ids come from the identities GoTrue keeps for this
  // auth user, never from `user_metadata`, which whoever holds the session can
  // rewrite and which GoTrue does not refresh when it links a second identity. A
  // sign in with none at all cannot say who it is, which is a fault in the sign in
  // path rather than anything the person did, so it is refused before anything is
  // written and told as sign in being unavailable.
  const googleSubs = googleAccountIdsOf(user);
  if (googleSubs.length === 0) {
    log.error("auth-callback", { msg: "sign in carried no google identity", auth_user_id: user.id });
    await supabase.auth.signOut();
    return NextResponse.redirect(`${origin}/login?error=sign_in_unavailable`);
  }
  let slateUser;
  try {
    slateUser = await provisionUser({
      authUserId: user.id,
      email,
      name: (meta.full_name as string) ?? (meta.name as string) ?? null,
      googleSubs,
      avatarUrl: (meta.avatar_url as string) ?? (meta.picture as string) ?? null,
    });
  } catch (err) {
    // #2378: a DEACTIVATED account is refused too, and it is told apart here
    // because the two need opposite advice. The #1648 refusals above are
    // retryable ("a read failed, try again"); this one is settled, and telling
    // somebody who has left to try again is advice that can never work (L111).
    if (err instanceof DeactivatedAccountError) {
      log.warn("auth-callback", { msg: "refused a deactivated account", auth_user_id: user.id });
      await supabase.auth.signOut();
      return NextResponse.redirect(`${origin}/login?error=account_deactivated`);
    }
    // #3526: the Google account is not the one this Slate account belongs to, so
    // this is a different person on that address (or the same person on a new
    // account). Settled like a deactivation, so it gets its own message rather
    // than a retry, and Pennie is told: an address handed to somebody new without
    // the departure recorded is how the old row's role and bookings would have
    // been handed over, and only a person can tell a rehire from a mistake.
    if (err instanceof GoogleAccountMismatchError) {
      await supabase.auth.signOut();
      await reportGoogleAccountRefusal(err, "auth-callback", user.id);
      return NextResponse.redirect(`${origin}/login?error=${GOOGLE_ACCOUNT_CHANGED_LOGIN_ERROR}`);
    }
    log.error("auth-callback", { msg: "provisioning refused", auth_user_id: user.id }, err);
    await supabase.auth.signOut();
    return NextResponse.redirect(`${origin}/login?error=provision_failed`);
  }

  // Register/refresh this user's calendar push channels (reachable via
  // domain-wide delegation by email). We do NOT run the event sync here: a
  // large calendar's first bootstrap is heavy, and awaiting it is exactly what
  // hung first logins. The watch registered here + the 1-min cron backstop warm
  // the busy-block cache within a minute, off the login hot path.
  await ensureWatches(slateUser.id); // never throws; returns a status

  // Managers + admins get the admin console; agents land on their own page.
  const dest = canManageAgents(slateUser.role) ? "/admin" : ME_TABS[0].href;
  const res = NextResponse.redirect(`${origin}${dest}`);
  // Seed the theme cookie from the account so the preference follows the user
  // onto this device (the boot script reads it before first paint).
  res.cookies.set(THEME_COOKIE, slateUser.theme_preference ?? DEFAULT_THEME_PREFERENCE, {
    path: "/",
    maxAge: THEME_COOKIE_MAX_AGE,
    sameSite: "lax",
  });
  // #3084: the sign in is when the 30 day clock starts, and it is also the first use.
  // Stamped here and only here, on a sign in that completed, so no refused attempt
  // can hand the browser a fresh clock. Middleware moves the last use stamp forward on
  // every staff request and never touches the sign in one.
  const signedInAt = stampValue(Date.now());
  res.cookies.set(SESSION_STARTED_COOKIE, signedInAt, sessionStampCookieOptions("started"));
  res.cookies.set(SESSION_SEEN_COOKIE, signedInAt, sessionStampCookieOptions("seen"));
  return res;
}
