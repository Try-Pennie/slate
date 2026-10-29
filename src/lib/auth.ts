import { cookies } from "next/headers";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { atLeast, canImpersonate, canUseCoordinatorDesk, opensStaffConsole } from "@/lib/auth/roles";
import {
  IMPERSONATE_COOKIE,
  impersonationCookieOutcome,
} from "@/lib/auth/impersonation";
import { devPreviewUser } from "@/lib/auth/dev-preview";
import { impersonationSigningSecret } from "@/lib/env";
import { gateSessionRow } from "@/lib/auth/active-session";
import { GoogleAccountMismatchError, type GoogleMismatchReason } from "@/lib/auth/google-identity";
import { judgeSessionIdentity } from "@/lib/auth/session-identity";
import { reportGoogleAccountRefusal } from "@/lib/auth/google-account-refusal";
import { SESSION_SEEN_COOKIE, SESSION_STARTED_COOKIE, judgeSessionAge } from "@/lib/auth/session-age";
import { NotAuthorizedError } from "@/lib/auth/http";
import { log } from "@/lib/log";
import type { Role, User } from "@/lib/db/types";

/**
 * The signed-in Slate user from the Supabase session, IGNORING impersonation.
 * Use this for the security gate (only a real admin may impersonate) and for
 * stopping impersonation — never for "who am I acting as" (that's currentUser).
 *
 * #2378: the row is now put through `gateSessionRow`, the same judge the Slack
 * actor and the sign in use, so somebody who has been DEACTIVATED stops being an
 * actor on their very next request. Before this, the impersonation target a few
 * lines below was filtered on `deactivated_at` and the actor was not: offboarding
 * a manager took nothing away from the manager, whose laptop kept a session
 * cookie that middleware refreshed on every request, and the roster, every lead's
 * contact details, cancel, reassign, reschedule and time off approval all went on
 * working until their refresh token died, which by default never does (L137).
 *
 * All three refusals resolve to `null`, which is what every caller already
 * handles, but they are TOLD APART first so the one worth knowing about (a live
 * session refused because the person left) leaves a log line, and an unreadable
 * row is not filed as a stale cookie.
 */
export async function realCurrentUser(): Promise<User | null> {
  // Dev-only localhost preview (inert in production). Lets you act as any user
  // without OAuth so the internal surfaces can be iterated on quickly. Deliberately
  // NOT put through the gate below: previewing what a departed agent's own screens
  // look like is a reason this exists, and it cannot grant anything in production.
  const preview = await devPreviewUser();
  if (preview) return preview;

  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  // #3084: a sign in lasts at most 30 days and ends after 7 without use. Middleware
  // enforces it on every staff page and sends the person to sign in again; this is the
  // same judge for everything the middleware does not reach, the /api routes above
  // all, so an aged session cannot go on acting through them. Judged before the row
  // read, since an aged session is refused whoever it belongs to.
  const store = await cookies();
  const age = judgeSessionAge({
    started: store.get(SESSION_STARTED_COOKIE)?.value,
    seen: store.get(SESSION_SEEN_COOKIE)?.value,
    nowMs: Date.now(),
  });
  if (!age.admit) {
    log.warn("auth", { msg: "refused a session past its age limit", reason: age.reason, auth_user_id: user.id });
    return null;
  }

  // #4379: HOW the session was made, from the VERIFIED claims (`getClaims` checks the
  // signature, or asks Auth when it cannot). Judged with the account below, but read
  // here so an unreadable claim refuses before the row is fetched. An unreadable claim
  // may be a passing fault, so it refuses this request without ending the session; a
  // readable one that is not an OAuth sign in ends it below.
  const { data: claimData, error: claimError } = await supabase.auth.getClaims();
  const claims = claimData?.claims;
  if (claimError || !claims || claims.sub !== user.id) {
    log.warn("auth", { msg: "session claims unreadable, refusing", auth_user_id: user.id }, claimError ?? undefined);
    return null;
  }

  const { data, error } = await supabaseAdmin()
    .from("users")
    .select("*")
    .eq("auth_user_id", user.id)
    .maybeSingle();

  const gate = gateSessionRow(data as User | null, error);
  if (gate.admit) {
    // #3526: the Google account check, on every request, the way the deactivation
    // gate is. The sign in callback makes the same check, but a session does not
    // have to come through the callback: whoever holds a sign in code can exchange
    // it with Supabase directly and set the cookies, and every request would then
    // resolve their auth user to this row. The accounts are read from the
    // identities GoTrue returns for the auth user, which the session holder cannot
    // write, and every Google identity counts, so an auth user GoTrue linked a
    // newcomer's account onto is refused even though the old account is there too.
    // Read only: an unarmed row (no account recorded) records it at its next sign in.
    //
    // #4379: the same judge now also holds the session to an OAuth sign in alone, and
    // knows a coordinator's Microsoft row, which must hold exactly the Microsoft account
    // it recorded and no Google one: the tested exception to the Google check, which
    // on its own refuses any session with no Google account (`session-identity.ts`).
    const verdict = judgeSessionIdentity({ row: gate.user, amr: claims.amr, user });
    if (verdict.admit) return gate.user;
    if (verdict.reason === "google") {
      await refuseSessionAsSomebodyElse(supabase, gate.user, verdict.google, user.id);
      return null;
    }
    // A way in that should not exist, or an account the row does not own. Logged as an
    // error, since no ordinary sign in makes either, and the session is ended.
    log.error("auth", { msg: "refused a session", reason: verdict.reason, auth_user_id: user.id, user_id: gate.user.id });
    await endRefusedSession(supabase, user.id);
    return null;
  }
  if (gate.reason === "deactivated") {
    log.warn("auth", { msg: "refused a deactivated session", auth_user_id: user.id });
  } else if (gate.reason === "placeholder") {
    // #4205: nobody signs in as the placeholder advisor, and the sign in callback
    // refuses it too; reaching here means a session got to its row another way.
    log.warn("auth", { msg: "refused a session on the placeholder advisor", auth_user_id: user.id });
  } else if (gate.reason === "unreadable") {
    // Fails CLOSED (L42): "I could not tell whether they still work here" refuses.
    // It is a warning rather than silence because a sustained one signs everybody
    // out and would otherwise look like people simply not being logged in.
    log.warn("auth", { msg: "session row unreadable, refusing", auth_user_id: user.id }, error);
  }
  return null;
}

/**
 * End THIS refused session only (`scope: "local"`), never every session on the auth
 * user. Two ways it can fail, and both are logged: supabase-js RETURNS `{ error }` for
 * a sign out the server refused, and the cookie write THROWS where cookies are read
 * only. Either way the refusal stands, and the next request is refused again.
 */
async function endRefusedSession(
  supabase: Awaited<ReturnType<typeof supabaseServer>>,
  authUserId: string,
): Promise<void> {
  let failure: unknown = null;
  try {
    const { error } = await supabase.auth.signOut({ scope: "local" });
    failure = error;
  } catch (err) {
    failure = err;
  }
  if (failure) log.warn("auth", { msg: "could not end a refused session", auth_user_id: authUserId }, failure);
}

/**
 * End a session judged to be somebody other than the row's owner, and say so
 * (#3526). Only THIS session is ended (`scope: "local"`): a global sign out would
 * also end every session on the auth user, and on an auth user GoTrue linked by
 * address that includes the real owner's. The sign out can fail where cookies are
 * read only (a server component render); refusing the row is what protects it, and
 * that already happened by returning null, so a failed sign out is logged and the
 * next request is refused again.
 */
async function refuseSessionAsSomebodyElse(
  supabase: Awaited<ReturnType<typeof supabaseServer>>,
  row: User,
  reason: GoogleMismatchReason,
  authUserId: string,
): Promise<void> {
  await endRefusedSession(supabase, authUserId);
  await reportGoogleAccountRefusal(
    new GoogleAccountMismatchError({ userId: row.id, email: row.email, reason }),
    "auth",
    authUserId,
  );
}

/**
 * The user `real` is impersonating, or null when they aren't (no cookie, cookie
 * points at self, or the real session isn't admin+). Single place the whole
 * feature's gates live, so `currentUser` and `getImpersonation` can't drift:
 *   - FLOOR: only admin+ sessions honor the cookie (resolveEffectiveUserId).
 *   - Target must be in the actor's org, ACTIVE, and still exist — fall back
 *     (null) if it vanished (removed by a sync) or was deactivated (offboarded);
 *     never act as a departed user.
 *   - CEILING (#588): never act as someone who outranks-or-equals you, even if
 *     the cookie says so. Blocks a rank-3 admin from inheriting a super_admin's
 *     powers; also re-checked live here in case the target was promoted mid-session.
 */
/**
 * Full impersonation state for `real`, the single computation every accessor
 * derives from (#652). `dropped` means a cookie was present but is no longer
 * honored: either the session timed out / went stale (`expired`), or the target
 * became ineligible mid-session: vanished, deactivated, or promoted past the
 * ceiling (`unavailable`). Callers use this to notify + clear, instead of the old
 * silent fall-back that was indistinguishable from having no cookie at all.
 */
type ImpersonationState =
  | { status: "active"; target: User }
  | { status: "dropped"; reason: "expired" | "unavailable" }
  | { status: "none" };

async function resolveImpersonationState(real: User): Promise<ImpersonationState> {
  const cookieStore = await cookies();
  const cookie = cookieStore.get(IMPERSONATE_COOKIE)?.value;
  // Only an admin's cookie is ever verified, so the secret is read for nobody else.
  const outcome = await impersonationCookieOutcome({
    realRole: real.role,
    realId: real.id,
    cookie,
    nowMs: Date.now(),
    secret: cookie && atLeast(real.role, "admin") ? impersonationSigningSecret() : "",
  });
  if (outcome.kind === "none") return { status: "none" };
  if (outcome.kind === "ended") return { status: "dropped", reason: "expired" };

  const { data, error } = await supabaseAdmin()
    .from("users")
    .select("*")
    .eq("id", outcome.targetId)
    .eq("org_id", real.org_id)
    .is("deactivated_at", null)
    .maybeSingle();
  // A transient query error is NOT a real drop: don't permanently clear a valid
  // session over a DB blip. Revert to self for this request only (as before) and
  // let it resume once the lookup succeeds. Only an actual empty result or a
  // ceiling failure means the target genuinely became ineligible.
  if (error) return { status: "none" };
  const target = data as User | null;
  if (!target || !canImpersonate(real.role, target.role)) {
    return { status: "dropped", reason: "unavailable" };
  }
  return { status: "active", target };
}

async function resolveImpersonationTarget(real: User): Promise<User | null> {
  const state = await resolveImpersonationState(real);
  return state.status === "active" ? state.target : null;
}

/**
 * The user the request should ACT AS. Equal to the signed-in user, except when
 * an admin+ is impersonating someone below them (gated in
 * resolveImpersonationTarget): then it returns the target. Everything downstream
 * — page rendering, requireRole, server actions, the OOO actor — flows through
 * here, so impersonation transparently changes who "you" are.
 */
export async function currentUser(): Promise<User | null> {
  const real = await realCurrentUser();
  if (!real) return null;
  // #4205: a scheduling coordinator opens no staff page, so to every one of them
  // (and every server action and API route behind them, all of which resolve the
  // session here) they are nobody. Refused HERE rather than page by page, so a page
  // added tomorrow cannot forget; their one page asks `coordinatorDeskUser`.
  if (!opensStaffConsole(real.role)) return null;
  return (await resolveImpersonationTarget(real)) ?? real;
}

/**
 * The signed in person, when they may use the coordinator booking page (#4205): a
 * coordinator, or an admin (`canUseCoordinatorDesk`). Null for everybody else and for
 * a signed out request.
 *
 * The REAL session, never an impersonation target: a coordinator cannot be viewed as
 * (`canImpersonate`), and an admin viewing as an advisor who opens this page is still
 * the admin, who is who a placed call must record as having placed it.
 */
export async function coordinatorDeskUser(): Promise<User | null> {
  const real = await realCurrentUser();
  if (!real || !canUseCoordinatorDesk(real.role)) return null;
  return real;
}

/** `coordinatorDeskUser`, or a `NotAuthorizedError` (a 403 at the HTTP layer). */
export async function requireCoordinatorDesk(): Promise<User> {
  const user = await coordinatorDeskUser();
  if (!user) throw new NotAuthorizedError();
  return user;
}

/**
 * The impersonation state for the current request, for the header to render both
 * the active "viewing as" banner AND the dropped-session notice (#652) from one
 * lookup: `active` (real + target), `dropped` (with the reason), or `none`.
 */
export type ImpersonationView =
  | { status: "active"; real: User; target: User }
  | { status: "dropped"; reason: "expired" | "unavailable" }
  | { status: "none" };

export async function getImpersonationView(): Promise<ImpersonationView> {
  const real = await realCurrentUser();
  if (!real) return { status: "none" };
  const state = await resolveImpersonationState(real);
  if (state.status === "active") return { status: "active", real, target: state.target };
  if (state.status === "dropped") return { status: "dropped", reason: state.reason };
  return { status: "none" };
}

/**
 * When an admin+ is impersonating, returns both the real actor and the target
 * (for the persistent banner). Null otherwise. Thin projection of
 * `getImpersonationView` so booking-actor resolution can't drift from the header.
 */
export async function getImpersonation(): Promise<{
  real: User;
  target: User;
} | null> {
  const view = await getImpersonationView();
  return view.status === "active" ? { real: view.real, target: view.target } : null;
}

/** Resolves the signed-in user and asserts they hold at least `min` rank. */
export async function requireRole(min: Role): Promise<User> {
  const user = await currentUser();
  if (!user || !atLeast(user.role, min)) {
    // Typed so the HTTP layer maps this to a 403, not a generic 500 (#606).
    throw new NotAuthorizedError();
  }
  return user;
}

export const requireManager = (): Promise<User> => requireRole("manager");
export const requireAdmin = (): Promise<User> => requireRole("admin");
export const requireSuperAdmin = (): Promise<User> => requireRole("super_admin");

/**
 * Gate at manager+ AND resolve who is accountable for an admin booking action
 * (#549). The REAL signed-in user is the actor; when an admin is impersonating,
 * the impersonated user is recorded as `actingAsUserId`. Shape is structurally a
 * `BookingActor` (kept dependency-free of the booking domain).
 */
export async function requireBookingActor(): Promise<{ userId: string; actingAsUserId: string | null }> {
  const me = await requireManager();
  const imp = await getImpersonation();
  return imp
    ? { userId: imp.real.id, actingAsUserId: imp.target.id }
    : { userId: me.id, actingAsUserId: null };
}
