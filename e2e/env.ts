/**
 * What the browser checks run against, and the refusals that keep them off
 * production (#3079, #3100).
 *
 * The suite drives a PRODUCTION build of the app (`next build` then `next start`)
 * against a throwaway local Supabase, so the one thing that must never happen is
 * the build, the server or the browser reaching a real system. Three layers stand
 * in the way, and each is blind where another looks:
 *
 *   1. the ENVIRONMENT the server is started with is built here from nothing,
 *      never copied from the shell, so a developer's exported `SLACK_BOT_TOKEN` or
 *      a CI secret cannot ride along; and the runner refuses to build at all while
 *      a `.env*` file sits in the checkout, because Next loads those on its own and
 *      `.env.local` points at the live project (the dev server memory, 2026-08-17);
 *   2. `SLATE_LOADTEST=true`, which is the app's own switch for "every outside
 *      system is synthetic": Google answers from `src/lib/google/loadtest-stub.ts`,
 *      webhooks short circuit, and Slack, Salesforce, cal.com and Twilio REFUSE
 *      (`refuseUnderLoadtest`). It also arms `loadtestPointedAtProduction`, which
 *      throws on the first database call if the address is the production project;
 *   3. the egress guard (`e2e/egress-guard.mjs`), loaded into the server process,
 *      which refuses and records every TCP connection to a host that is not this
 *      machine. The runner fails the run on any record, so a leak nobody thought
 *      of is a red run rather than a write somewhere real.
 *
 * Pure, so `scripts/test-e2e-isolation.ts` can drive every refusal without a stack.
 */
import { PRODUCTION_SUPABASE_REF } from "../src/lib/loadtest-guard.ts";
import { liveEnvFiles } from "../scripts/lib/live-env-files.ts";

/**
 * Where the app under test listens. Matches `e2e/supabase.config.toml` site_url.
 *
 * `localhost` and not `127.0.0.1`, because `next start` reports its own origin as
 * localhost: the sign in callback redirects to the REQUEST origin, so a browser
 * that arrived on 127.0.0.1 was sent on to localhost, a different cookie host, and
 * lost the session it had just been given.
 */
export const E2E_APP_PORT = 3100;
export const E2E_APP_ORIGIN = `http://localhost:${E2E_APP_PORT}`;

/**
 * The address inlined into manage links and webhook payloads.
 *
 * `next.config.ts` refuses a production build whose public URL is localhost, so
 * this cannot be the real origin. `.invalid` is reserved (RFC 2606) and can never
 * resolve, so a link built from it that something tried to follow goes nowhere.
 */
export const E2E_PUBLIC_APP_URL = "http://slate-e2e.invalid";

/** The Workspace domain the sign in gate admits. Reserved, so it is nobody's mail. */
export const E2E_EMAIL_DOMAIN = "slate-e2e.test";

/** The throwaway stack, as `supabase status -o json` reports it. */
export interface LocalStack {
  apiUrl: string;
  dbUrl: string;
  publishableKey: string;
  secretKey: string;
  mailpitUrl: string;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** True for an address that can only be this machine. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Why this stack must not be used, or null.
 *
 * Every address has to be loopback, and no value may name the production
 * project. A reading that cannot be parsed refuses too: "I cannot tell where this
 * is" is not a reason to go ahead (L42).
 */
export function localStackRefusal(stack: LocalStack): string | null {
  for (const [name, url] of [
    ["the API", stack.apiUrl],
    ["the database", stack.dbUrl],
    ["Mailpit", stack.mailpitUrl],
  ] as const) {
    const host = hostOf(url);
    if (host === null) return `The local stack reported an unreadable address for ${name}: "${url}".`;
    if (!isLoopbackHost(host)) {
      return `The local stack's address for ${name} is ${host}, which is not this machine. The browser checks only run against a local Supabase.`;
    }
  }
  for (const value of Object.values(stack)) {
    if (value.includes(PRODUCTION_SUPABASE_REF)) {
      return `A local stack value names the production Supabase project (${PRODUCTION_SUPABASE_REF}). Refusing.`;
    }
  }
  if (!stack.publishableKey || !stack.secretKey) {
    return "The local stack reported no API keys, so the app could not reach it.";
  }
  return null;
}

/**
 * A checkout holding any file of live settings refuses the run (see layer 1
 * above): every `.env*` file Next loads by itself, and `.dev.vars*`. Which files
 * count is one rule, `liveEnvFiles`, shared with `pnpm cf:preview` (#3694), so the
 * two refusals cannot drift apart. `.env.example` is a committed template nothing
 * reads.
 */
export function envFileRefusal(fileNames: readonly string[]): string | null {
  const loaded = liveEnvFiles(fileNames);
  if (loaded.length === 0) return null;
  return (
    `Refusing to build: ${loaded.join(", ")} hold live settings the build could load and use to reach ` +
    `real systems. Run the browser checks from a checkout without them (a git worktree has none).`
  );
}

/**
 * The ONLY variables the build and the server see. Built from nothing: the
 * parent's environment contributes PATH and the few process basics node needs,
 * never a value that configures the app.
 */
export function e2eServerEnv(
  stack: LocalStack,
  basics: { PATH?: string; HOME?: string; TMPDIR?: string },
  extra: Record<string, string> = {},
): Record<string, string> {
  const refusal = localStackRefusal(stack);
  if (refusal) throw new Error(refusal);
  const env: Record<string, string> = {
    NEXT_TELEMETRY_DISABLED: "1",
    NEXT_PUBLIC_APP_URL: E2E_PUBLIC_APP_URL,
    NEXT_PUBLIC_SUPABASE_URL: stack.apiUrl,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: stack.publishableKey,
    NEXT_PUBLIC_GOOGLE_HOSTED_DOMAIN: E2E_EMAIL_DOMAIN,
    SUPABASE_SECRET_KEY: stack.secretKey,
    GOOGLE_HOSTED_DOMAIN: E2E_EMAIL_DOMAIN,
    SLATE_LOADTEST: "true",
    // #3936: lets /admin/team-capacity?frame=<id> render a frame of the settled design from its
    // fixture, so the design match score can compare the page with the design. Loopback only.
    SLATE_DESIGN_FIXTURES: "1",
    ...extra,
  };
  for (const key of ["PATH", "HOME", "TMPDIR"] as const) {
    const value = basics[key];
    if (value) env[key] = value;
  }
  return env;
}
