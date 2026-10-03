// #3082: does production's Supabase Auth accept anything but Google?
//
// Slate staff sign in with Google only, and the before_user_created hook (migration
// 0158) refuses any new account outside trypennie.com. Two settings in the Supabase
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
} from "@/lib/monitor/auth-sign-in-surface";

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

finish();
