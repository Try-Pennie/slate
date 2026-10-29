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
import { resolveHostedDomain } from "@/lib/auth/domain";
import { isLoadtest, loadtestPointedAtProduction } from "@/lib/loadtest-guard";
import type { BookingApiCaller, KeySlot } from "@/lib/booking/api-auth";

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
  // The CREDENTIAL refusal (#2335) is deliberately not here, though this is where a
  // reader looks for it: the list it judges against names every integration Slate
  // has, and this function is called by the browser Supabase client too, so putting
  // it here published that inventory in a public chunk. It lives on `supabaseAdmin`,
  // which is server only and is what every cron lane and API route reads through.
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

/**
 * The key the "view as" cookie is HMAC-signed with (#3113). It is the Supabase
 * secret key rather than a secret of its own, so signing needed nothing new set
 * in production: every deployment already holds it, nothing outside the Worker
 * does, and anyone holding it can already read and write every row, so a MAC
 * keyed on it grants nothing that key does not. The signed message carries its
 * own label, so the MAC cannot be confused with anything else keyed the same
 * way. Rotating that key ends every live "view as" session, which is the safe
 * direction.
 */
export const impersonationSigningSecret = (): string => supabaseSecretKey();

export const googleClientId = (): string => requireEnv("GOOGLE_CLIENT_ID");
export const googleClientSecret = (): string =>
  requireEnv("GOOGLE_CLIENT_SECRET");

/**
 * The Google Workspace domain sign-in is limited to. Throws
 * `HostedDomainMissingError` when unset (#3083); an empty string ("allow any
 * Google account") comes back only with an explicit ALLOW_ANY_GOOGLE_DOMAIN=1.
 */
export const googleHostedDomain = (): string => resolveHostedDomain(process.env);

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

// Rotation slots (#3110). Every machine bearer key below has a `_2` slot the routes
// accept beside the primary, so a caller can be moved to a new value before the old
// one is retired (the booking API keys' pattern, #2645). Unset slots are inert, and
// the primary alone decides whether an endpoint is configured. The procedure is in
// DEPLOY.md, "Rotating a credential"; scripts/test-bearer-rotation-slots.ts refuses a
// bearer check written against one value.
export const cronSecret = (): string => requireEnv("CRON_SECRET");
export const cronSecret2 = (): string => process.env.CRON_SECRET_2 ?? "";
export const googleChannelToken = (): string =>
  requireEnv("GOOGLE_CHANNEL_TOKEN");
// The channel token a rotation REPLACED (#3110). Every live watch channel carries
// the token it was registered with, so until each has renewed or expired Google
// keeps sending the old one; the push route accepts it while this is set. Unset
// outside a rotation.
export const googleChannelTokenPrevious = (): string => process.env.GOOGLE_CHANNEL_TOKEN_PREVIOUS ?? "";

// Bearer key for the agent-reassign API (POST /api/bookings/reassign). Empty = disabled.
export const reassignApiKey = (): string => process.env.REASSIGN_API_KEY ?? "";
export const reassignApiKey2 = (): string => process.env.REASSIGN_API_KEY_2 ?? "";

// Bearer key for the duplicate-cancel API (POST /api/bookings/cancel-duplicate, #2369),
// called by Regal's double-booking journeys. Its OWN key rather than the reassign one:
// one key per machine capability, so the journey that may cancel a call is not also
// handed the ability to move one. Empty = endpoint disabled (503).
export const duplicateCancelApiKey = (): string => process.env.DUPLICATE_CANCEL_API_KEY ?? "";
export const duplicateCancelApiKey2 = (): string => process.env.DUPLICATE_CANCEL_API_KEY_2 ?? "";

// Bearer key for the offboarding lifecycle API (POST /api/users/deactivate|reactivate),
// called by the existing offboarding automation. Empty = endpoints disabled (503).
export const offboardingApiKey = (): string => process.env.OFFBOARDING_API_KEY ?? "";
export const offboardingApiKey2 = (): string => process.env.OFFBOARDING_API_KEY_2 ?? "";

// Bearer key noodge carries on its checks of /api/health and /api/health/availability
// (#1228), so each can stamp its own uptime heartbeat. Its OWN key: it can do
// nothing but stamp those two rows. Empty = neither endpoint ever stamps, so both
// heartbeats go stale and the lane watchdog pages; the health answers are unaffected.
export const uptimeHeartbeatKey = (): string => process.env.UPTIME_HEARTBEAT_KEY ?? "";
export const uptimeHeartbeatKey2 = (): string => process.env.UPTIME_HEARTBEAT_KEY_2 ?? "";

// Bearer key for the bookable-toggle API (POST /api/users/bookable, #281),
// called by the roster/onboarding automation to promote an agent into (or out
// of) the booking pool. Empty = endpoint disabled (503).
export const bookableApiKey = (): string => process.env.BOOKABLE_API_KEY ?? "";
export const bookableApiKey2 = (): string => process.env.BOOKABLE_API_KEY_2 ?? "";

// Bearer key Regal's reporting webhook carries on POST /api/regal/calls (#2090), the
// inbound call feed the "calling while not routable" detector reads. Its OWN secret,
// deliberately NOT `webhook_endpoints.auth_header` (the key Slate sends Regal): that
// one leaves Slate on every outbound delivery, and sharing it would couple the two
// rotations so rotating either takes both directions down. Empty = endpoint refuses
// every post with a 503 naming this variable.
export const regalInboundKey = (): string => process.env.REGAL_INBOUND_KEY ?? "";
export const regalInboundKey2 = (): string => process.env.REGAL_INBOUND_KEY_2 ?? "";

// The two OUTBOUND webhook credentials (#3091): the Regal API key sent as the
// Authorization header, and the HMAC secret the generic format signs with. Worker
// secrets so only the running Worker can read them; they used to live only in
// `webhook_endpoints.auth_header` and `.secret`. Empty = the delivery falls back
// to that column while it still holds a value (expand then contract,
// `src/lib/webhooks/credentials.ts`) and the monitor lane pages until it is set.
export const regalWebhookKey = (): string => process.env.REGAL_WEBHOOK_KEY ?? "";
export const webhookSigningSecret = (): string => process.env.WEBHOOK_SIGNING_SECRET ?? "";

// Bearer keys for the direct booking API (POST /api/bookings, #355). #2645: one
// key per caller, each with TWO slots so it rotates with zero downtime: add the new
// key as _2, point the caller at it, then retire the old primary. Every slot of
// every caller empty = endpoint disabled (503). The bare BOOKING_API_KEY pair the
// callers once shared is read by nothing (#2865). Literal
// reads on purpose: the deploy runbook guard only sees a name read literally, and
// `scripts/test-booking-api-auth.ts` holds each one to `bookingApiKeyEnvName`. The
// Record is over the caller type, so tsc refuses a caller added without its reads.
const BOOKING_API_KEYS: Record<BookingApiCaller, Record<KeySlot, () => string>> = {
  regal: {
    primary: () => process.env.BOOKING_API_KEY_REGAL ?? "",
    secondary: () => process.env.BOOKING_API_KEY_REGAL_2 ?? "",
  },
  trypennie: {
    primary: () => process.env.BOOKING_API_KEY_TRYPENNIE ?? "",
    secondary: () => process.env.BOOKING_API_KEY_TRYPENNIE_2 ?? "",
  },
  canary: {
    primary: () => process.env.BOOKING_API_KEY_CANARY ?? "",
    secondary: () => process.env.BOOKING_API_KEY_CANARY_2 ?? "",
  },
  // #2940: Marcia's key opens the cancel alone. Unset = Marcia is refused and no
  // other caller notices.
  marcia: {
    primary: () => process.env.BOOKING_API_KEY_MARCIA ?? "",
    secondary: () => process.env.BOOKING_API_KEY_MARCIA_2 ?? "",
  },
};
export const bookingApiKeyFor = (caller: BookingApiCaller, slot: KeySlot): string =>
  BOOKING_API_KEYS[caller][slot]();

// Marcia's booking MCP endpoint (#3543). The two slots of the secret Marcia signs her
// lead tokens with (decision 19's two slot rotation, the same move as the booking API
// keys: fill the empty slot, point Marcia at it, empty the old one), and the secret
// `McpBookingGateway` puts on its inner request so the internal route can tell the
// gateway from anything else. A missing one refuses every call it governs and pages:
// no gateway secret as `marcia_gateway_refused`, no token key as
// `marcia_token_refused:token_keys_unconfigured`. Not created yet: the endpoint is not
// deployed.
export const marciaTokenKeySlots = (): [string, string] => [
  process.env.MARCIA_TOKEN_KEY_A ?? "",
  process.env.MARCIA_TOKEN_KEY_B ?? "",
];
export const mcpBookingGatewaySecret = (): string => process.env.MCP_BOOKING_GATEWAY_SECRET ?? "";

// Hashes of RETIRED booking API keys (#2879), as `label:sha256:<hex>` entries separated by
// commas, never the keys. A refused request presenting one pages, naming its host and
// route (`src/lib/booking/retired-keys.ts`). Empty = the check is inert. A Worker
// secret, so even the hash stays out of the repo; `pnpm hash:retired-key` computes it.
export const bookingApiRetiredKeyHashes = (): string => process.env.BOOKING_API_RETIRED_KEY_HASHES ?? "";

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

// The Google Workspace account the advisor photo refresh reads the directory as
// (#3027). A committed wrangler.jsonc var rather than a secret: it is an address,
// not a credential, and the delegation it rides on is the service account's.
// Returned raw so the refresh can refuse a missing or blank value BY NAME.
export const directoryAdminSubject = (): string | undefined => process.env.DIRECTORY_ADMIN_SUBJECT;

// The public test bucket's two halves (#2666). The origin list is a COMMITTED
// wrangler.jsonc var, so a deploy can never quietly widen it; the secret signs the
// short lived pass `/book` hands an approved page. Either empty turns the test
// path OFF, and the page says which one in its own words.
export const embedTestOrigins = (): string[] => csvEnv("EMBED_TEST_ORIGINS");
export const embedTestPassSecret = (): string => process.env.EMBED_TEST_PASS_SECRET ?? "";

// Signs the program lead token (#4389): the texted booking page and its manage page hand
// it to a recognised program lead, and the times, booking and move routes trust only it.
// Its OWN secret, not the test pass's: that one's docs give it the test bucket alone, and
// emptying it switches the test path off, which must never also switch programs off.
// Empty = no program lead is recognised anywhere and every lead gets the ordinary booker.
export const programLeadTokenSecret = (): string => process.env.PROGRAM_LEAD_TOKEN_SECRET ?? "";

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

/**
 * Pennie's automations service, asked for the texting line a lead can message after
 * Call me now (#3718). OPTIONAL and fails closed: unset, nothing is asked and the
 * card shows no Text us (Dan, 2026-10-14).
 */
export const automationsApiUrl = (): string => process.env.AUTOMATIONS_API_URL ?? "";

/**
 * Sendblue's API key, used only to ask whether a lead's saved texting line is still
 * alive (#3718). OPTIONAL: unset, a saved line is always kept, because Sendblue is the
 * only thing that may call a line dead (Dan, 2026-10-15).
 */
export const sendblueApiKeyId = (): string => process.env.SENDBLUE_API_KEY_ID ?? "";
export const sendblueApiSecretKey = (): string => process.env.SENDBLUE_API_SECRET_KEY ?? "";
