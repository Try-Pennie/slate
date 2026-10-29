import { NextResponse, type NextRequest } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { linkCoordinator, provisionUser } from "@/lib/provision";
import { DeactivatedAccountError, PlaceholderAccountError } from "@/lib/auth/active-session";
import {
  GoogleAccountMismatchError,
  SeveralGoogleAccountsError,
  googleAccountIdsOf,
} from "@/lib/auth/google-identity";
import {
  GOOGLE_ACCOUNT_CHANGED_LOGIN_ERROR,
  SEVERAL_GOOGLE_ACCOUNTS_LOGIN_ERROR,
} from "@/lib/auth/google-identity-copy";
import {
  CoordinatorNotInvitedError,
  MICROSOFT_ACCOUNT_CHANGED_LOGIN_ERROR,
  MICROSOFT_NOT_INVITED_LOGIN_ERROR,
  MicrosoftAccountMismatchError,
  microsoftAccountIdsOf,
} from "@/lib/auth/microsoft-identity";
import { reportGoogleAccountRefusal } from "@/lib/auth/google-account-refusal";
import {
  SESSION_SEEN_COOKIE,
  SESSION_STARTED_COOKIE,
  sessionStampCookieOptions,
  stampValue,
} from "@/lib/auth/session-age";
import { ensureWatches } from "@/lib/google/sync";
import { landingPathFor, PLACEHOLDER_ACCOUNT_LOGIN_ERROR } from "@/lib/auth/landing";
import { isAllowedEmail } from "@/lib/auth/domain";
import { googleHostedDomain } from "@/lib/env";
import { log } from "@/lib/log";
import {
  DEFAULT_THEME_PREFERENCE,
  THEME_COOKIE,
  THEME_COOKIE_MAX_AGE,
} from "@/lib/theme/boot";
import type { User } from "@/lib/db/types";
import {
  SIGN_IN_FROM_COOKIE,
  signInPageFromCookie,
  signInPathFor,
  type SignInPage,
} from "@/lib/auth/sign-in-page";

export const dynamic = "force-dynamic";

type Supabase = Awaited<ReturnType<typeof supabaseServer>>;

/**
 * Back to a sign in page with a code that page maps to plain copy: /login for staff, the
 * partner page for a coordinator's Microsoft sign in (#4379), so the reason is read beside
 * the button that person can use.
 */
function bounce(origin: string, page: SignInPage, code: string): NextResponse {
  return NextResponse.redirect(`${origin}${signInPathFor(page)}?error=${code}`);
}

/**
 * End the session the code exchange just set, and send the person back to sign in
 * with a code the page maps to plain copy. One helper for every refusal, so
 * none of them can forget the sign out. `local` ends only THIS sign in's session,
 * never every session on the auth user (#3526).
 */
async function refuse(
  supabase: Supabase,
  origin: string,
  code: string,
  scope?: "local",
  page: SignInPage = "staff",
): Promise<NextResponse> {
  await (scope ? supabase.auth.signOut({ scope }) : supabase.auth.signOut());
  return bounce(origin, page, code);
}

/**
 * A sign in that completed, whichever provider it came through: the person lands
 * where their role opens, their theme follows them onto this device, and the session
 * age stamps start (#3084). Shared by Google and Microsoft (#4379), so a coordinator's
 * session is held to the same 30 and 7 day limits as staff.
 */
function completeSignIn(origin: string, slateUser: User): NextResponse {
  // Managers + admins get the admin console; agents land on their own page, and a
  // coordinator on the coordinator page (#4205).
  const res = NextResponse.redirect(`${origin}${landingPathFor(slateUser.role)}`);
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

/**
 * OAuth callback for Supabase sign in: Google for staff, and Microsoft for invited
 * scheduling coordinators (#4379). Exchanges the code for a session, resolves the
 * Slate user, and sets the session stamps.
 *
 * Which path a sign in takes is read from the identities GoTrue keeps on the auth
 * user, never from anything the browser sent: an auth user holding a Microsoft
 * account and no Google one is a coordinator's Microsoft sign in, and one holding
 * both is refused outright.
 *
 * Redirects use the REQUEST origin, not NEXT_PUBLIC_APP_URL: the session
 * cookies are set on the host that served this callback, so bouncing to the
 * canonical app URL from a different host (local dev) would strand the
 * fresh session on an origin the user never lands on (#40).
 */
export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin;
  // #4379: which sign in page the redirect started from, by the mark that page set. Read
  // only where nothing better can say: before the exchange, and for an auth user whose
  // identities name both providers. Once the identities are known, they decide.
  const startedOn = signInPageFromCookie(req.cookies.get(SIGN_IN_FROM_COOKIE)?.value);
  const code = req.nextUrl.searchParams.get("code");
  if (!code) {
    // No code is also what a cancelled or refused consent comes back as.
    return bounce(origin, startedOn, "missing_code");
  }

  const supabase = await supabaseServer();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.session) {
    return bounce(origin, startedOn, "exchange_failed");
  }

  const { user } = data.session;
  const meta = user.user_metadata ?? {};
  const email = user.email ?? (meta.email as string) ?? "";

  // #3526, #4379: the accounts come from the identities GoTrue keeps for this auth
  // user, never from `user_metadata`, which whoever holds the session can rewrite and
  // which GoTrue does not refresh when it links a second identity.
  const googleSubs = googleAccountIdsOf(user);
  const microsoftSubs = microsoftAccountIdsOf(user);

  // #4379: one auth user holding a Google account AND a Microsoft one is what GoTrue's
  // linking by address makes of a Microsoft sign in on a staff address (or a Google one
  // on a coordinator's). The session cannot say which of the two it came through, so
  // neither is let in: an admin removes the sign in ("Link a new Google account"),
  // which is why this is an error log and the message points at an admin.
  if (googleSubs.length > 0 && microsoftSubs.length > 0) {
    log.error("auth-callback", { msg: "sign in carried both a google and a microsoft account", auth_user_id: user.id });
    return refuse(supabase, origin, "sign_in_unavailable", "local", startedOn);
  }

  // Both halves fail CLOSED (#3083): an unconfigured domain refuses every
  // sign-in rather than reading as "allow any account", and only a claim that
  // is exactly true counts as verified, so an ABSENT claim is refused too.
  let hostedDomain: string;
  try {
    hostedDomain = googleHostedDomain();
  } catch (err) {
    log.error("auth-callback", { msg: "sign-in domain not configured", auth_user_id: user.id }, err);
    // A Microsoft sign in hears it on the partner page, as every other refusal of one does.
    return refuse(supabase, origin, "sign_in_unavailable", undefined, microsoftSubs.length > 0 ? "partner" : "staff");
  }

  if (microsoftSubs.length > 0) {
    return microsoftSignIn(supabase, origin, {
      authUserId: user.id,
      email,
      emailVerified: meta.email_verified,
      hostedDomain,
      microsoftSubs,
    });
  }

  // Enforce the Google Workspace domain server-side (#589). The `hd` hint on the
  // login page is browser-supplied and bypassable; this is the real gate. Reject
  // unverified or out-of-domain emails BEFORE provisioning so an outside account
  // never gets a live users row. Sign out first to clear the session cookies the
  // code exchange just set.
  if (meta.email_verified !== true || !isAllowedEmail(email, hostedDomain)) {
    return refuse(supabase, origin, "domain_not_allowed");
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
  // #3526: a sign in with no Google account at all cannot say who it is, which is a
  // fault in the sign in path rather than anything the person did, so it is refused
  // before anything is written and told as sign in being unavailable.
  if (googleSubs.length === 0) {
    log.error("auth-callback", { msg: "sign in carried no google identity", auth_user_id: user.id });
    // Local: only this sign in's session, never the auth user's others.
    return refuse(supabase, origin, "sign_in_unavailable", "local");
  }
  let slateUser: User;
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
      return refuse(supabase, origin, "account_deactivated");
    }
    // #4205: the address is the placeholder advisor's, which holds real customers'
    // calls and belongs to nobody. Settled like a deactivation, so its own message.
    if (err instanceof PlaceholderAccountError) {
      log.warn("auth-callback", { msg: "refused a sign in on the placeholder advisor", auth_user_id: user.id });
      return refuse(supabase, origin, PLACEHOLDER_ACCOUNT_LOGIN_ERROR);
    }
    // #3526: the Google account is not the one this Slate account belongs to, so
    // this is a different person on that address (or the same person on a new
    // account). Settled like a deactivation, so it gets its own message rather
    // than a retry, and Pennie is told: an address handed to somebody new without
    // the departure recorded is how the old row's role and bookings would have
    // been handed over, and only a person can tell a rehire from a mistake.
    if (err instanceof GoogleAccountMismatchError) {
      // Local: on an auth user GoTrue linked by address, a global sign out would
      // also end the real owner's sessions.
      await supabase.auth.signOut({ scope: "local" });
      await reportGoogleAccountRefusal(err, "auth-callback", user.id);
      // Two accounts on one sign in gets its own sentence: "link your new account"
      // is the wrong advice when the old one is still attached too.
      const refusal =
        err.reason === "several-accounts" ? SEVERAL_GOOGLE_ACCOUNTS_LOGIN_ERROR : GOOGLE_ACCOUNT_CHANGED_LOGIN_ERROR;
      return NextResponse.redirect(`${origin}/login?error=${refusal}`);
    }
    // The same refusal with no Slate account yet, so there is no account to name in
    // an alert; logged as an error, since two Google accounts on one auth user with
    // no row is not a shape an ordinary sign in makes.
    if (err instanceof SeveralGoogleAccountsError) {
      log.error("auth-callback", { msg: "refused several google accounts on a new sign in", auth_user_id: user.id });
      return refuse(supabase, origin, SEVERAL_GOOGLE_ACCOUNTS_LOGIN_ERROR, "local");
    }
    log.error("auth-callback", { msg: "provisioning refused", auth_user_id: user.id }, err);
    return refuse(supabase, origin, "provision_failed");
  }

  // Register/refresh this user's calendar push channels (reachable via
  // domain-wide delegation by email). We do NOT run the event sync here: a
  // large calendar's first bootstrap is heavy, and awaiting it is exactly what
  // hung first logins. The watch registered here + the 1-min cron backstop warm
  // the busy-block cache within a minute, off the login hot path.
  await ensureWatches(slateUser.id); // never throws; returns a status

  return completeSignIn(origin, slateUser);
}

/**
 * A scheduling coordinator's Microsoft sign in (#4379). It only ever LINKS the row
 * Team access granted (`linkCoordinator`), never creates one, and every refusal ends
 * this sign in's session alone (`local`): on an auth user GoTrue linked by address a
 * global sign out would also end somebody else's. Every refusal lands on the partner
 * sign in page, whose one button is Microsoft, never on /login (#4379).
 *
 * No calendar is warmed: a coordinator's mailbox is their own company's, which
 * Pennie's Google delegation cannot read, and they take no calls.
 */
async function microsoftSignIn(
  supabase: Supabase,
  origin: string,
  input: {
    authUserId: string;
    email: string;
    emailVerified: unknown;
    hostedDomain: string;
    microsoftSubs: string[];
  },
): Promise<NextResponse> {
  const { authUserId } = input;
  // Only a claim that is exactly true counts (#3083). Supabase marks a Microsoft
  // address verified only when the tenant vouches for it (the xms_edov claim), so an
  // unverified one here is the app registration missing that claim, which nobody
  // signing in can fix: sign in is unavailable, and the log says why.
  if (input.emailVerified !== true) {
    log.error("auth-callback", { msg: "microsoft sign in carried an unverified address", auth_user_id: authUserId });
    return refuse(supabase, origin, "sign_in_unavailable", "local", "partner");
  }
  // Staff sign in with Google. A trypennie.com address through Microsoft is refused
  // with the same words the Google gate uses for the wrong account (#4379, step 5).
  if (isAllowedEmail(input.email, input.hostedDomain)) {
    log.warn("auth-callback", { msg: "refused a company address through microsoft", auth_user_id: authUserId });
    return refuse(supabase, origin, "domain_not_allowed", "local", "partner");
  }
  if (input.microsoftSubs.length !== 1) {
    log.error("auth-callback", { msg: "sign in carried several microsoft accounts", auth_user_id: authUserId });
    return refuse(supabase, origin, "sign_in_unavailable", "local", "partner");
  }

  let slateUser: User;
  try {
    slateUser = await linkCoordinator({ authUserId, email: input.email, microsoftSub: input.microsoftSubs[0]! });
  } catch (err) {
    if (err instanceof CoordinatorNotInvitedError) {
      log.warn("auth-callback", { msg: "refused a microsoft sign in no coordinator holds", auth_user_id: authUserId });
      return refuse(supabase, origin, MICROSOFT_NOT_INVITED_LOGIN_ERROR, "local", "partner");
    }
    if (err instanceof DeactivatedAccountError) {
      log.warn("auth-callback", { msg: "refused a removed coordinator", auth_user_id: authUserId });
      return refuse(supabase, origin, "account_deactivated", "local", "partner");
    }
    if (err instanceof PlaceholderAccountError) {
      log.warn("auth-callback", { msg: "refused a sign in on the placeholder advisor", auth_user_id: authUserId });
      return refuse(supabase, origin, PLACEHOLDER_ACCOUNT_LOGIN_ERROR, "local", "partner");
    }
    // A different person on a coordinator's address, or a second sign in on their
    // row: an error, because only a person can tell a new account from a takeover.
    if (err instanceof MicrosoftAccountMismatchError) {
      log.error("auth-callback", { msg: "refused a different microsoft account", auth_user_id: authUserId, user_id: err.userId });
      return refuse(supabase, origin, MICROSOFT_ACCOUNT_CHANGED_LOGIN_ERROR, "local", "partner");
    }
    log.error("auth-callback", { msg: "coordinator link refused", auth_user_id: authUserId }, err);
    return refuse(supabase, origin, "provision_failed", "local", "partner");
  }
  return completeSignIn(origin, slateUser);
}
