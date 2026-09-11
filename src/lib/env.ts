/**
 * Centralized environment access. Server-only secrets are read lazily through
 * `requireEnv` so that importing this module in a client bundle never throws —
 * only actually reading a server secret (which only runs server-side) does.
 *
 * WHERE TO SET EACH VAR IN PRODUCTION (Cloudflare Worker):
 * - Non-secret runtime config + launch flags (OOO_CALCOM_DUAL_WRITE,
 *   AGENT_SCHEDULING_LIVE (the console gate), CALCOM_BASE_URL, CALCOM_ORG_ID,
 *   calendar ids/emails):
 *   put them in `wrangler.jsonc` under `vars`. They're version-controlled and
 *   redeployed every time.
 * - Sensitive values (SUPABASE_SECRET_KEY, SLACK_BOT_TOKEN, CALCOM_API_KEY,
 *   GOOGLE_SA_*, SF_*): set them as Cloudflare SECRETS (`wrangler secret put`).
 *
 * GOTCHA: a plain variable set ONLY in the Cloudflare dashboard is NOT
 * version-controlled and gets WIPED on the next `wrangler deploy` — the config
 * is the source of truth for plain vars. Secrets survive deploys; dashboard
 * plain vars don't. So never rely on a dashboard-only plain var for anything
 * that must persist (this is exactly how the cal.com flag silently reverted).
 */

import { atLeast, isRole } from "@/lib/auth/roles";
import { isLoadtest, loadtestPointedAtProduction } from "@/lib/loadtest-guard";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function present(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const appUrl = (): string =>
  (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");

// NEXT_PUBLIC_* vars must be read by their literal name (not via process.env[dynamic])
// so Next.js can inline them into the client bundle.
//
// This is also where the load test refusal lives (#2242), and the placement is the
// whole point of it: this is the ONE function every Supabase client in the app
// takes its address from (the secret key client the cron lanes and API routes use,
// the SSR client, the browser one), so a refusal here reaches every request and
// every cron tick that would touch a database. It cannot live in `worker/index.ts`
// where a reader looks for it first, because the literal read below is what lets
// Next INLINE the value at build time, and wrangler's own esbuild pass over the
// Worker entry does no such thing: a guard written there would read `undefined`
// in production and under load test alike, and could only ever stay silent (L98).
//
// Production never reaches the comparison at all: `isLoadtest()` is false, so a
// wrong constant here can refuse a load run and can never break a real request.
export const publicSupabaseUrl = (): string => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const refusal = loadtestPointedAtProduction({ loadtest: isLoadtest(), supabaseUrl: url });
  if (refusal) throw new Error(refusal);
  return present(url, "NEXT_PUBLIC_SUPABASE_URL");
};

// New-style Supabase API keys (sb_publishable_… / sb_secret_…), replacing the
// legacy anon / service_role JWTs. Publishable is client-safe; secret bypasses RLS.
export const publicSupabasePublishableKey = (): string =>
  present(
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  );

export const supabaseSecretKey = (): string =>
  requireEnv("SUPABASE_SECRET_KEY");

export const googleClientId = (): string => requireEnv("GOOGLE_CLIENT_ID");
export const googleClientSecret = (): string =>
  requireEnv("GOOGLE_CLIENT_SECRET");

/** Empty string means "allow any Google account". */
export const googleHostedDomain = (): string =>
  process.env.GOOGLE_HOSTED_DOMAIN ?? "";

// Google service account for domain-wide delegation (impersonate agent calendars).
export const googleSaClientEmail = (): string =>
  requireEnv("GOOGLE_SA_CLIENT_EMAIL");
export const googleSaPrivateKey = (): string =>
  // Stored with literal \n (as in the JSON key); restore real newlines.
  requireEnv("GOOGLE_SA_PRIVATE_KEY").replace(/\\n/g, "\n");

// Salesforce External Client App (client-credentials) for the agent sync.
export const sfClientId = (): string => requireEnv("SF_CLIENT_ID");
export const sfClientSecret = (): string => requireEnv("SF_CLIENT_SECRET");
export const sfInstanceUrl = (): string =>
  requireEnv("SF_INSTANCE_URL").replace(/\/$/, "");

export const cronSecret = (): string => requireEnv("CRON_SECRET");
export const googleChannelToken = (): string =>
  requireEnv("GOOGLE_CHANNEL_TOKEN");

// Bearer key for the agent-reassign API (POST /api/bookings/reassign). Empty = disabled.
export const reassignApiKey = (): string => process.env.REASSIGN_API_KEY ?? "";

// Bearer key for the offboarding lifecycle API (POST /api/users/deactivate|reactivate),
// called by the existing offboarding automation. Empty = endpoints disabled (503).
export const offboardingApiKey = (): string => process.env.OFFBOARDING_API_KEY ?? "";

// Bearer key for the bookable-toggle API (POST /api/users/bookable, #281),
// called by the roster/onboarding automation to promote an agent into (or out
// of) the booking pool. Empty = endpoint disabled (503).
export const bookableApiKey = (): string => process.env.BOOKABLE_API_KEY ?? "";

// Bearer keys for the direct booking API (POST /api/bookings), called by
// the external AI auto-booker (#355). TWO slots so the secret rotates with zero
// downtime: add the new key as _2, point the caller at it, then retire the old
// primary. Both empty = endpoint disabled (503).
export const bookingApiKeyPrimary = (): string => process.env.BOOKING_API_KEY ?? "";
export const bookingApiKeySecondary = (): string => process.env.BOOKING_API_KEY_2 ?? "";

// Fine-grained GitHub token (Actions: read/write on Try-Pennie/slate) so the
// monitor lane can trigger the smoke-canary workflow when GitHub's own schedule
// drops a run (#525 follow-up). Empty = gap-filler is a quiet no-op (GitHub's
// schedule alone still runs it), so this is safe to deploy before the secret.
export const githubCanaryToken = (): string => process.env.GITHUB_CANARY_TOKEN ?? "";

// Slack notifier (optional). Empty = notifications are no-ops.
export const slackBotToken = (): string => process.env.SLACK_BOT_TOKEN ?? "";
export const slackAlertsChannel = (): string =>
  process.env.SLACK_ALERTS_CHANNEL ?? "";
// Low-priority / informational Slack channel (#567): visibility-only signals
// (e.g. a thin tier the tier-drop fallback is quietly covering) that should NOT
// page the alerts channel. Falls back to the alerts channel when unset so the
// signal is never silently lost; set it to a quieter channel to separate them.
export const slackInfoChannel = (): string =>
  process.env.SLACK_INFO_CHANNEL ?? process.env.SLACK_ALERTS_CHANNEL ?? "";
// Slack app signing secret — verifies inbound interaction requests (#77).
// Empty = the /api/slack/interactions endpoint rejects everything.
export const slackSigningSecret = (): string =>
  process.env.SLACK_SIGNING_SECRET ?? "";

export const googlePushUrl = (): string => `${appUrl()}/api/google/push`;

// OOO workflow. The main OOO calendar doubles as the default DWD actor for
// manager-calendar writes (the Apps Script ran as ooo@trypennie.com).
export const mainOooCalendarId = (): string => requireEnv("MAIN_OOO_CAL_ID");
export const oooCalendarActorEmail = (): string =>
  process.env.OOO_CALENDAR_ACTOR_EMAIL ?? mainOooCalendarId();

// Phased launch: until the console goes live, everyone below super admin is
// held out of /admin. Default off = console hidden; set "true" to open it.
export const agentSchedulingLive = (): boolean =>
  process.env.AGENT_SCHEDULING_LIVE === "true";

/**
 * Whether the CONSOLE is hidden from this person: every /admin route, and the
 * sidebar that lists them. Until the flag is flipped only super admins reach it,
 * and anyone else arriving at a console route is sent to `/admin/ooo`, the one
 * page they do have there.
 *
 * IT NO LONGER REACHES `/me`, and that is the point of the rename (2026-09-08).
 * It was `oooOnlyFor`, and it hid an agent's OWN working hours from them: the
 * form, the two reset controls and the bookable pill were built, tested and
 * unreachable for 112 agents. The reason given was that the scheduling tool was
 * not ready, which stopped being true long before anybody re-read the flag. The
 * old name asserted the consequence ("this person only gets the OOO tool") and
 * would have gone on asserting it after it became false, which is how a name
 * recruits the next person into keeping a rule nobody still believes (L263).
 *
 * What it governs now is one live decision: the console is about OTHER people
 * (the roster, buckets, tiers, routing, bookings), and opening that to the
 * managers and admins who cannot see it today is a separate call from letting
 * somebody read their own hours.
 *
 * Used by the admin route guards and the header nav so they cannot drift apart.
 */
export const consoleHiddenFor = (role: string | undefined): boolean => {
  if (agentSchedulingLive()) return false;
  const r = role ?? "";
  return !(isRole(r) && atLeast(r, "super_admin"));
};

// Daily OOO-approvals digest email (set as wrangler vars). Empty TO = the
// digest no-ops. Sent from the OOO actor mailbox; replies route to REPLY_TO.
const csvEnv = (name: string): string[] =>
  (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
export const oooApprovalsRecipients = (): string[] => csvEnv("OOO_APPROVALS_TO");
export const oooApprovalsBcc = (): string[] => csvEnv("OOO_APPROVALS_BCC");
export const oooApprovalsReplyTo = (): string =>
  process.env.OOO_APPROVALS_REPLY_TO ?? "";

// Cal.com dual-write during the cutover transition. Flag off = no-op.
export const oooCalcomDualWrite = (): boolean =>
  process.env.OOO_CALCOM_DUAL_WRITE === "true";
export const calcomBaseUrl = (): string =>
  (process.env.CALCOM_BASE_URL ?? "https://api.cal.com/v2").replace(/\/$/, "");
export const calcomOrgId = (): string => process.env.CALCOM_ORG_ID ?? "";
export const calcomApiKey = (): string => process.env.CALCOM_API_KEY ?? "";

// Twilio TaskRouter, the source of the `Redistribute` tag and of legal eligibility
// (#2097). Empty is a REFUSAL rather than a default: the read throws by name when
// any of the three is unset, because a Twilio half that quietly does nothing has
// every symptom of a healthy run (see src/lib/twilio/client.ts).
export const twilioApiKeySid = (): string => process.env.TWILIO_API_KEY_SID ?? "";
export const twilioApiKeySecret = (): string => process.env.TWILIO_API_KEY_SECRET ?? "";
export const twilioWorkspaceSid = (): string => process.env.TWILIO_WORKSPACE_SID ?? "";
