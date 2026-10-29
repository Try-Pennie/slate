// #3082: does production's Supabase Auth accept anything but Google?
//
// Slate staff sign in with Google only, and the before_user_created hook (migration
// 0159) refuses any new account outside trypennie.com. Two settings in the Supabase
// dashboard sit outside both of those and outside the repository: the Email
// provider, which opens password, magic link and recovery routes to anybody holding
// the public key (and lets an existing account in without Google's own checks), and
// any other provider that can create an account. Nothing in a deploy touches either,
// so the monitor lane reads the live /auth/v1/settings and pages while either is on.
//
// This drives the pure verdict and the step offline. The three outcomes, each
// asserted below, because "nothing is open" and "nothing was read" render the same
// in silence (L98, #1394):
//
//   unmeasured - the read failed, or answered a shape this cannot judge. Pages
//                nobody and clears nothing.
//   healthy    - Google is the only way in.
//   open       - email is on, or another provider can create an account.
import { assert, eq, finish } from "./lib/harness.ts";
import {
  AUTH_SIGN_IN_SURFACE_KEY,
  authSignInSurfaceHealth,
  formatAuthSignInOpenAlert,
  formatAuthSignInClearedAlert,
  runAuthSignInSurfaceCheck,
  readAuthSettings,
  AUTH_SETTINGS_TIMEOUT_MS,
} from "@/lib/monitor/auth-sign-in-surface";
import {
  AUTH_SIGN_IN_VERDICT_LANE,
  authSignInReachedVerdict,
} from "@/lib/monitor/verdict-freshness";
import { VERDICT_STALE_BOUNDS_MS } from "@/lib/monitor/health";

/** Production as read on 2026-10-03, with the public key: Google and Email on, signup open. */
const MEASURED_2026_10_03 = {
  external: {
    anonymous_users: false, apple: false, azure: false, bitbucket: false, discord: false,
    facebook: false, snapchat: false, figma: false, fly: false, github: false, gitlab: false,
    google: true, keycloak: false, kakao: false, linkedin: false, linkedin_oidc: false,
    notion: false, spotify: false, slack: false, slack_oidc: false, workos: false,
    twitch: false, twitter: false, email: true, phone: false, zoom: false,
  },
  disable_signup: false,
  mailer_autoconfirm: false,
  phone_autoconfirm: false,
  sms_provider: "twilio",
  saml_enabled: false,
  saml_private_key_next_configured: true,
  passkeys_enabled: false,
};

function settings(over: { external?: Record<string, unknown>; [k: string]: unknown } = {}) {
  const { external, ...rest } = over;
  return { ...MEASURED_2026_10_03, ...rest, external: { ...MEASURED_2026_10_03.external, ...external } };
}

// --- unmeasured -----------------------------------------------------------------------
{
  eq(authSignInSurfaceHealth(null).status, "unmeasured", "a failed read is unmeasured");
  eq(authSignInSurfaceHealth("not json").status, "unmeasured", "a body that is not an object is unmeasured");
  eq(authSignInSurfaceHealth({ disable_signup: false }).status, "unmeasured", "no external map is unmeasured");
  eq(
    authSignInSurfaceHealth(settings({ external: { email: "yes" } })).status,
    "unmeasured",
    "an email flag that is not a boolean is unmeasured, never read as off",
  );
  eq(
    authSignInSurfaceHealth({ ...MEASURED_2026_10_03, disable_signup: undefined }).status,
    "unmeasured",
    "a missing disable_signup is unmeasured, since whether a provider can create accounts rests on it",
  );
  // L50: a provider flag that is not a boolean is not "off". Read as off, a phone flag
  // arriving as the string "true" would score a provider that creates accounts as closed.
  for (const odd of ["true", 1, null, {}]) {
    eq(
      authSignInSurfaceHealth(settings({ external: { email: false, phone: odd } })).status,
      "unmeasured",
      `a provider flag of ${JSON.stringify(odd)} is unmeasured, never read as off`,
    );
  }
  eq(
    authSignInSurfaceHealth(settings({ external: { email: false, google: "yes" } })).status,
    "unmeasured",
    "even the Google flag: an unreadable flag anywhere means the reading is not trusted",
  );
}

// --- open: production as it stood when this shipped ----------------------------------
{
  const h = authSignInSurfaceHealth(MEASURED_2026_10_03);
  eq(h.status, "open", "the measured production settings are open: Email is on");
  assert(h.status === "open" && h.emailOn, "and email is the reason");
  eq(h.status === "open" ? h.signupProviders.join(",") : "x", "", "and no other provider is blamed");
}

// --- healthy: the state the hosted flip produces --------------------------------------
{
  const h = authSignInSurfaceHealth(settings({ external: { email: false } }));
  eq(h.status, "healthy", "Google alone, signup still enabled, is healthy");
  eq(
    authSignInSurfaceHealth(settings({ external: { email: false, google: false } })).status,
    "healthy",
    "this check is about what is open beyond Google, so Google off is not its finding",
  );
  // #4379: invited coordinators sign in with Microsoft (the azure provider), and the
  // before_user_created hook decides who may be created through it. On or off, it is
  // part of the healthy state: off before the rollout switches it on, on after.
  const withMicrosoft = authSignInSurfaceHealth(settings({ external: { email: false, azure: true } }));
  eq(withMicrosoft.status, "healthy", "Google plus Microsoft, with email off, is healthy");
  eq(withMicrosoft.status === "healthy" ? withMicrosoft.providersOn.join(",") : "", "azure,google", "and both are reported as on");
  const msAndEmail = authSignInSurfaceHealth(settings({ external: { email: true, azure: true } }));
  assert(msAndEmail.status === "open" && msAndEmail.emailOn && msAndEmail.signupProviders.length === 0, "email still opens it, and Microsoft is not named as a finding");
  const msAndGithub = authSignInSurfaceHealth(settings({ external: { email: false, azure: true, github: true } }));
  eq(msAndGithub.status === "open" ? msAndGithub.signupProviders.join(",") : "", "github", "a third provider beside them is open, named alone");
}

// --- another provider that can create accounts ----------------------------------------
{
  const h = authSignInSurfaceHealth(settings({ external: { email: false, phone: true, anonymous_users: true } }));
  eq(h.status, "open", "phone or anonymous sign in with signup enabled is open");
  eq(h.status === "open" ? h.signupProviders.join(",") : "", "anonymous_users,phone", "naming each, in a stable order");

  const closed = authSignInSurfaceHealth(
    settings({ external: { email: false, phone: true }, disable_signup: true }),
  );
  eq(closed.status, "healthy", "with signup disabled another provider cannot create an account");

  const saml = authSignInSurfaceHealth(settings({ external: { email: false }, saml_enabled: true }));
  eq(saml.status, "open", "SAML with signup enabled is open");

  const emailEvenClosed = authSignInSurfaceHealth(settings({ disable_signup: true }));
  eq(
    emailEvenClosed.status,
    "open",
    "email is open even with signup disabled: an existing account can still sign in by password or link",
  );
}

// --- copy -----------------------------------------------------------------------------
{
  const open = authSignInSurfaceHealth(settings({ external: { phone: true } }));
  if (open.status !== "open") throw new Error("fixture should be open");
  const text = formatAuthSignInOpenAlert(open);
  assert(/email/i.test(text) && /phone/.test(text), "the page names email and the other provider");
  assert(/Authentication, Sign In \/ Providers/.test(text), "and says where the switch is");
  assert(!/[\u2014\u2013]/.test(text), "and carries no dash");

  const healthy = authSignInSurfaceHealth(settings({ external: { email: false } }));
  if (healthy.status !== "healthy") throw new Error("fixture should be healthy");
  assert(/Google/.test(formatAuthSignInClearedAlert(healthy)), "the all clear says Google is the only way in");
  assert(/Microsoft/.test(formatAuthSignInClearedAlert(healthy)), "and that Microsoft, for invited coordinators, is the other");
  assert(/Microsoft/.test(text), "the page says which two ways in are expected");
}

// --- the step: pages on open, clears on healthy, does neither on unmeasured -------------
async function drive(read: () => Promise<unknown>) {
  const sent: string[] = [];
  const resolved: string[] = [];
  const health = await runAuthSignInSurfaceCheck({
    read,
    notify: async (key) => {
      sent.push(key);
    },
    resolve: async (key) => {
      resolved.push(key);
      return undefined;
    },
    cooldownMs: 1,
  });
  return { health, sent, resolved };
}

{
  const open = await drive(async () => MEASURED_2026_10_03);
  eq(open.sent, [AUTH_SIGN_IN_SURFACE_KEY], "open pages on its key");
  eq(open.resolved, [], "and clears nothing");

  const healthy = await drive(async () => settings({ external: { email: false } }));
  eq(healthy.resolved, [AUTH_SIGN_IN_SURFACE_KEY], "healthy clears its key");
  eq(healthy.sent, [], "and pages nothing");

  const threw = await drive(async () => {
    throw new Error("network down");
  });
  eq(threw.health.status, "unmeasured", "a read that throws is unmeasured");
  eq(threw.sent.length, 0, "and pages nothing");
  eq(threw.resolved.length, 0, "and clears nothing, because it measured nothing");

  const unread = await drive(async () => null);
  eq(unread.sent.length, 0, "a read that answered nothing pages nothing");
  eq(unread.resolved.length, 0, "and clears nothing");
}

// --- the read: a stall is unmeasured, within a stated bound ----------------------------
{
  // A fetch that answers only when its signal aborts: the shape of a server that
  // accepted the connection and never replied.
  const stalled = ((_url: string, init?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    })) as unknown as typeof fetch;
  const started = Date.now();
  // Node unrefs AbortSignal.timeout's timer, so with nothing else pending the process
  // would exit before it fires. This holds the loop open; it is not the deadline.
  // Each way of learning nothing logs its OWN message and carries its real cause, so a
  // DNS failure is never read as a stall, nor a broken body as a refused key (L11).
  const logged: { msg: string; fields: Record<string, unknown>; err: unknown }[] = [];
  const log = (msg: string, fields: Record<string, unknown>, err?: unknown) => {
    logged.push({ msg, fields, err });
  };

  const keepAlive = setTimeout(() => {}, 5_000);
  const body = await readAuthSettings({ url: "https://x.supabase.co", key: "k", fetchImpl: stalled, timeoutMs: 20, log });
  clearTimeout(keepAlive);
  eq(body, null, "a read that never answers resolves to null (unmeasured)");
  assert(Date.now() - started < 2000, "and gives up near its timeout rather than hanging the lane");
  eq(authSignInSurfaceHealth(body).status, "unmeasured", "which the verdict scores as unmeasured");
  eq(logged.at(-1)?.msg, "settings read timed out", "a stall logs as a timeout");
  eq(logged.at(-1)?.fields.timeout_ms, 20, "naming the bound it ran out of");

  const dnsError = new TypeError("fetch failed: getaddrinfo ENOTFOUND x.supabase.co");
  const unreachable = (async () => {
    throw dnsError;
  }) as unknown as typeof fetch;
  eq(await readAuthSettings({ url: "https://x", key: "k", fetchImpl: unreachable, log }), null, "an unreachable host is null");
  eq(logged.at(-1)?.msg, "settings read failed", "a network failure is not called a timeout");
  assert(logged.at(-1)?.err === dnsError, "and the real error is passed through to the log");
  assert(!("timeout_ms" in (logged.at(-1)?.fields ?? {})), "without a timeout field that would mislead the reader");

  const refused = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
  eq(await readAuthSettings({ url: "https://x", key: "k", fetchImpl: refused, log }), null, "a refused read is null");
  eq(logged.at(-1)?.msg, "settings read refused", "a refusal logs as one");
  eq(logged.at(-1)?.fields.status, 401, "with its status");

  const notJson = (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
  eq(await readAuthSettings({ url: "https://x", key: "k", fetchImpl: notJson, log }), null, "a body that is not JSON is null");
  eq(logged.at(-1)?.msg, "settings body was not JSON", "an unreadable body logs as one, not as a failed read");
  assert(logged.at(-1)?.err instanceof Error, "carrying the parse error");

  let seenUrl = "";
  let seenKey = "";
  const answering = (async (url: string, init?: { headers?: Record<string, string> }) => {
    seenUrl = url;
    seenKey = init?.headers?.apikey ?? "";
    return new Response(JSON.stringify(MEASURED_2026_10_03), { status: 200 });
  }) as unknown as typeof fetch;
  const read = await readAuthSettings({ url: "https://x.supabase.co", key: "pub", fetchImpl: answering });
  eq(seenUrl, "https://x.supabase.co/auth/v1/settings", "it reads the settings endpoint");
  eq(seenKey, "pub", "with the public key");
  eq(authSignInSurfaceHealth(read).status, "open", "and a real answer is judged");

  assert(
    AUTH_SETTINGS_TIMEOUT_MS > 0 && AUTH_SETTINGS_TIMEOUT_MS <= 10_000,
    `the shipped timeout is a stated bound well inside one monitor tick (${AUTH_SETTINGS_TIMEOUT_MS}ms)`,
  );
}

// --- the verdict stamp: only a MEASURED reading proves the detector alive (L557) -------
{
  assert(authSignInReachedVerdict(authSignInSurfaceHealth(MEASURED_2026_10_03)), "open is a verdict");
  assert(
    authSignInReachedVerdict(authSignInSurfaceHealth(settings({ external: { email: false } }))),
    "healthy is a verdict",
  );
  assert(!authSignInReachedVerdict(authSignInSurfaceHealth(null)), "unmeasured is NOT a verdict");
  assert(!authSignInReachedVerdict(null), "a step that threw is NOT a verdict");
  eq(AUTH_SIGN_IN_VERDICT_LANE, "verdict:auth-sign-in", "the stamp lives in the verdict family");
  eq(
    VERDICT_STALE_BOUNDS_MS[AUTH_SIGN_IN_VERDICT_LANE],
    6 * 60 * 60_000,
    "and is watched with a six hour bound, like the other every tick checks with no legitimate silence",
  );
}

finish();
