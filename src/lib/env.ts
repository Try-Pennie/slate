/**
 * Centralized environment access. Server-only secrets are read lazily through
 * `requireEnv` so that importing this module in a client bundle never throws —
 * only actually reading a server secret (which only runs server-side) does.
 *
 * WHERE TO SET EACH VAR IN PRODUCTION (Cloudflare Worker):
 * - Non-secret runtime config + launch flags (OOO_CALCOM_DUAL_WRITE,
 *   AGENT_SCHEDULING_LIVE, CALCOM_BASE_URL, CALCOM_ORG_ID, calendar ids/emails):
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
export const publicSupabaseUrl = (): string =>
  present(process.env.NEXT_PUBLIC_SUPABASE_URL, "NEXT_PUBLIC_SUPABASE_URL");

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

// Slack notifier (optional). Empty = notifications are no-ops.
export const slackBotToken = (): string => process.env.SLACK_BOT_TOKEN ?? "";
export const slackAlertsChannel = (): string =>
  process.env.SLACK_ALERTS_CHANNEL ?? "";

export const googlePushUrl = (): string => `${appUrl()}/api/google/push`;

// OOO workflow. The main OOO calendar doubles as the default DWD actor for
// manager-calendar writes (the Apps Script ran as ooo@trypennie.com).
export const mainOooCalendarId = (): string => requireEnv("MAIN_OOO_CAL_ID");
export const oooCalendarActorEmail = (): string =>
  process.env.OOO_CALENDAR_ACTOR_EMAIL ?? mainOooCalendarId();

// Phased launch: until agent scheduling self-service goes live, agents see
// only the OOO tool (request time off) and nothing about availability/bookings.
// Default off = OOO-only phase; set "true" to reveal the scheduling UI.
export const agentSchedulingLive = (): boolean =>
  process.env.AGENT_SCHEDULING_LIVE === "true";

/**
 * The single OOO-only launch gate: until agent scheduling goes live, everyone
 * below super admin sees just the time-off tool, not the booking/availability/
 * roster surfaces. Only super admins keep full access in this pre-launch phase
 * (the scheduling tool isn't ready). Used by /me, the header nav, and the admin
 * route guards so they can't drift apart. Flip AGENT_SCHEDULING_LIVE to restore
 * role-appropriate access for everyone at launch.
 */
export const oooOnlyFor = (role: string | undefined): boolean => {
  if (agentSchedulingLive()) return false;
  const r = role ?? "";
  return !(isRole(r) && atLeast(r, "super_admin"));
};

// Cal.com dual-write during the cutover transition. Flag off = no-op.
export const oooCalcomDualWrite = (): boolean =>
  process.env.OOO_CALCOM_DUAL_WRITE === "true";
export const calcomBaseUrl = (): string =>
  (process.env.CALCOM_BASE_URL ?? "https://api.cal.com/v2").replace(/\/$/, "");
export const calcomOrgId = (): string => process.env.CALCOM_ORG_ID ?? "";
export const calcomApiKey = (): string => process.env.CALCOM_API_KEY ?? "";
