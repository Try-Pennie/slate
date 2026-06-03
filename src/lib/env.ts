/**
 * Centralized environment access. Server-only secrets are read lazily through
 * `requireEnv` so that importing this module in a client bundle never throws —
 * only actually reading a server secret (which only runs server-side) does.
 */

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

export const googleRedirectUri = (): string => `${appUrl()}/api/auth/google/callback`;
export const googlePushUrl = (): string => `${appUrl()}/api/google/push`;
