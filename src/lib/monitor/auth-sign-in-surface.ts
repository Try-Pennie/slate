/**
 * Does production's Supabase Auth accept anything but Google, and Microsoft for invited
 * coordinators? (#3082, #4379)
 *
 * Slate staff sign in with Google only. The app refuses an outside Google account in
 * the OAuth callback, and the before_user_created hook (0159, replaced by 0212) refuses
 * any new account outside trypennie.com before it exists, except an invited coordinator
 * created through Microsoft (`azure`). Neither can see two settings that live only in
 * the Supabase dashboard:
 *
 *   - the Email provider, which opens /signup, /recover, password and magic link sign
 *     in to anybody holding the public key, and lets an EXISTING account in without
 *     going through Google (and so without Google's second factor, where one applies);
 *   - any other provider (phone, anonymous, SAML, another OAuth) while signup is on,
 *     which is another way for an account to be created at all.
 *
 * No deploy touches either, and the repository's supabase/config.toml describes only
 * the local stack, so the only witness is the hosted project's own
 * `GET /auth/v1/settings`, which answers with the public key. The monitor lane reads it.
 *
 * Three outcomes, never two, because "nothing is open" and "nothing was read" render
 * identically in silence (#1394, L98):
 *
 *   unmeasured - the read failed, or answered a shape this cannot judge. A flag that is
 *                missing or not a boolean is never read as off. Pages nobody, clears
 *                nothing.
 *   healthy    - Google is the only way in for staff, and Microsoft (`azure`) for
 *                invited coordinators (#4379), on or off.
 *   open       - email is on, or another provider can create an account. This pages.
 *
 * Google being OFF is deliberately not a finding here: that is nobody being able to
 * sign in, which the login page reports to the first person who tries, and this check is
 * about what is open beyond it.
 */

import type { AlertResolve, ThrottledNotify } from "./alert-deps";
import { logAlertSendFailure, logResolveFailure } from "../notify/send-failure.ts";

/** alert_state key for the condition. */
export const AUTH_SIGN_IN_SURFACE_KEY = "auth_sign_in_beyond_google";

/** The one provider Slate signs staff in with. */
export const ALLOWED_PROVIDER = "google";

/**
 * #4379: the providers that are part of the healthy state, on or off. Google for staff,
 * and Microsoft (`azure`) for invited scheduling coordinators, whose accounts the
 * before_user_created hook (migration 0212) lets be created only for an active,
 * unlinked coordinator row. Anything else that can create an account is open.
 */
export const ALLOWED_PROVIDERS: readonly string[] = [ALLOWED_PROVIDER, "azure"];

/**
 * How long the settings read may take before the tick calls it unmeasured. The
 * endpoint answers from GoTrue's memory, normally in well under a second, so five
 * seconds is generous for a slow day and still a small share of a five minute tick
 * whose invocation four cron lanes share (#1246). A stall past it is unmeasured, never
 * a hang that holds the lane.
 */
export const AUTH_SETTINGS_TIMEOUT_MS = 5_000;

/**
 * Read the hosted `/auth/v1/settings` with the public key. Null for every way of
 * learning nothing: a refusal, a stall past the timeout, a network error, or a body
 * that is not JSON. Never throws.
 *
 * Each of those logs its own message, and every one that has an error passes it
 * through, so a DNS failure is never read as a stall and a broken body is never read
 * as a refused key (L11). Only the timeout names the bound, because only the timeout
 * is about it.
 */
export async function readAuthSettings(deps: {
  url: string;
  key: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  log?: (msg: string, fields: Record<string, unknown>, err?: unknown) => void;
}): Promise<unknown> {
  // deadline-ok: the read below carries AbortSignal.timeout(timeoutMs)
  const doFetch = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? AUTH_SETTINGS_TIMEOUT_MS;
  const timedOut = (err: unknown) => err instanceof Error && err.name === "TimeoutError";

  let res: Response;
  try {
    res = await doFetch(`${deps.url}/auth/v1/settings`, {
      headers: { apikey: deps.key },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (timedOut(err)) deps.log?.("settings read timed out", { timeout_ms: timeoutMs }, err);
    else deps.log?.("settings read failed", {}, err);
    return null;
  }
  if (!res.ok) {
    deps.log?.("settings read refused", { status: res.status });
    return null;
  }
  try {
    return (await res.json()) as unknown;
  } catch (err) {
    // The same signal still bounds the body, so a body that stalls is a timeout too.
    if (timedOut(err)) deps.log?.("settings read timed out", { timeout_ms: timeoutMs }, err);
    else deps.log?.("settings body was not JSON", {}, err);
    return null;
  }
}

/** What /auth/v1/settings says, reduced to the facts the verdict rests on. */
export interface AuthSignInSettings {
  /** Every provider flag the endpoint reported, by its own name. */
  external: Record<string, boolean>;
  disableSignup: boolean;
  samlEnabled: boolean;
}

export type AuthSignInSurfaceHealth =
  | { status: "unmeasured"; why: string }
  | { status: "healthy"; providersOn: string[] }
  | {
      status: "open";
      emailOn: boolean;
      /** Providers other than Google and email that can create an account, sorted. */
      signupProviders: string[];
      samlSignup: boolean;
      providersOn: string[];
    };

/** Parse the endpoint's JSON, or explain why it cannot be judged. */
function parse(body: unknown): AuthSignInSettings | string {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return "the auth settings could not be read this tick";
  }
  const b = body as Record<string, unknown>;
  const ext = b.external;
  if (ext === null || typeof ext !== "object" || Array.isArray(ext)) {
    return "the auth settings answered with no provider list";
  }
  if (typeof (ext as Record<string, unknown>).email !== "boolean") {
    return "the auth settings did not say whether email sign in is on";
  }
  // Every flag must be a boolean, or the reading is not judged at all (L50). Skipping
  // an odd one would score it as off, so a provider that creates accounts and arrives
  // as "true" or 1 would read as closed, which is the one wrong answer this exists to
  // prevent.
  const external: Record<string, boolean> = {};
  for (const [name, on] of Object.entries(ext as Record<string, unknown>)) {
    if (typeof on !== "boolean") {
      return `the auth settings reported the ${name} provider as something other than on or off`;
    }
    external[name] = on;
  }
  if (typeof b.disable_signup !== "boolean") {
    return "the auth settings did not say whether signup is enabled";
  }
  return {
    external,
    disableSignup: b.disable_signup,
    // Absent on a project that has never had SAML; only an explicit true opens it.
    samlEnabled: b.saml_enabled === true,
  };
}

/** The verdict. Pure, so every branch, the silent ones included, is driven offline. */
export function authSignInSurfaceHealth(body: unknown): AuthSignInSurfaceHealth {
  const parsed = parse(body);
  if (typeof parsed === "string") return { status: "unmeasured", why: parsed };

  const providersOn = Object.keys(parsed.external)
    .filter((name) => parsed.external[name])
    .sort();
  const emailOn = parsed.external.email === true;
  const signupProviders = parsed.disableSignup
    ? []
    : providersOn.filter((name) => !ALLOWED_PROVIDERS.includes(name) && name !== "email");
  const samlSignup = !parsed.disableSignup && parsed.samlEnabled;

  if (emailOn || signupProviders.length > 0 || samlSignup) {
    return { status: "open", emailOn, signupProviders, samlSignup, providersOn };
  }
  return { status: "healthy", providersOn };
}

/** A provider's flag name as somebody reading Slack would say it. */
function spoken(name: string): string {
  if (name === "anonymous_users") return "anonymous sign in";
  return name.replace(/_/g, " ");
}

function listed(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The page. One line per way in, then where the switch is. */
export function formatAuthSignInOpenAlert(
  health: Extract<AuthSignInSurfaceHealth, { status: "open" }>,
): string {
  const lines: string[] = [];
  if (health.emailOn) {
    lines.push(
      "- email: password, magic link, signup and recovery are reachable with the public key, " +
        "and an existing account can sign in without going through Google",
    );
  }
  if (health.signupProviders.length > 0) {
    lines.push(`- new accounts can be created through ${listed(health.signupProviders.map(spoken))}`);
  }
  if (health.samlSignup) lines.push("- SAML single sign on can create new accounts");
  return (
    `Supabase Auth in production accepts more than Google and invited coordinators' Microsoft sign in:\n` +
    lines.join("\n") +
    `\nTurn ${lines.length === 1 ? "it" : "each"} off in the Supabase dashboard under ` +
    `Authentication, Sign In / Providers, leaving Google and Microsoft (Azure) on. Slate staff sign in with Google only (#3082), and invited coordinators with Microsoft (#4379).`
  );
}

/** The all clear. */
export function formatAuthSignInClearedAlert(
  _health: Extract<AuthSignInSurfaceHealth, { status: "healthy" }>,
): string {
  return (
    "Supabase Auth in production is back to Google sign in, and Microsoft for invited coordinators: " +
    "email is off and no other provider can create an account, read from the live auth settings."
  );
}

/**
 * The lane's step. A throwing read is caught HERE so the check returns a typed verdict
 * rather than the step boundary's fallback, and an unmeasured tick returns before it can
 * notify or resolve anything.
 */
export async function runAuthSignInSurfaceCheck(deps: {
  read: () => Promise<unknown>;
  notify: ThrottledNotify;
  resolve: AlertResolve<unknown>;
  cooldownMs: number;
  log?: (msg: string) => void;
}): Promise<AuthSignInSurfaceHealth> {
  let body: unknown;
  try {
    body = await deps.read();
  } catch {
    body = null;
  }

  const health = authSignInSurfaceHealth(body);

  if (health.status === "unmeasured") {
    deps.log?.(`monitor auth-sign-in: unmeasured, ${health.why}`);
    return health;
  }

  if (health.status === "open") {
    await deps
      .notify(AUTH_SIGN_IN_SURFACE_KEY, deps.cooldownMs, formatAuthSignInOpenAlert(health))
      .catch(logAlertSendFailure(AUTH_SIGN_IN_SURFACE_KEY));
    deps.log?.(
      `monitor auth-sign-in: OPEN email=${health.emailOn} signup_providers=${health.signupProviders.join("|") || "none"} ` +
        `saml_signup=${health.samlSignup} providers_on=${health.providersOn.join("|") || "none"}`,
    );
    return health;
  }

  // The all clear hangs off this MEASURED healthy result, never off "we did not alert this
  // tick" (#1134, #1152): the unmeasured branch above returns before reaching it.
  await deps
    .resolve(AUTH_SIGN_IN_SURFACE_KEY, formatAuthSignInClearedAlert(health))
    .catch(logResolveFailure(AUTH_SIGN_IN_SURFACE_KEY));
  deps.log?.(`monitor auth-sign-in: healthy providers_on=${health.providersOn.join("|") || "none"}`);
  return health;
}
