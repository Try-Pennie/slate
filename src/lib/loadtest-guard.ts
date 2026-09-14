/**
 * The two facts that keep a load test deployment away from production (#2242).
 *
 * The load run creates six hundred bookings against a throwaway Supabase branch on
 * a second Worker. Everything that makes that safe is configuration: a build
 * pointed at the branch, an environment with no route onto the production
 * hostname, and `SLATE_LOADTEST` set. Configuration is exactly what gets copied
 * wrong, and the failure is silent in the worst direction: a loadtest build
 * pointed at production reads and writes real leads' rows while every log line,
 * every metric and the run's own report read as a healthy isolated run.
 *
 * So there are two refusals here, and NEITHER can answer for the other:
 *
 *   `loadtestPointedAtProduction` is about the DATABASE, and it is the one with
 *   teeth. It is called from `publicSupabaseUrl()` (`@/lib/env`), which is the one
 *   place every Supabase client in the app reads its address from: the secret key
 *   client the cron lanes and API routes use, the SSR client, and the browser one.
 *   A refusal there stops every request and every cron tick that would touch
 *   production data, at the moment it would touch it.
 *
 *   `loadtestServingProductionHost` is about the ADDRESS, and it is checked in the
 *   Worker entry (`worker/index.ts`) where the request's own hostname is the only
 *   thing available. It catches the opposite accident: a loadtest build deployed
 *   onto the production route, where the database check would be perfectly happy.
 *
 * **Why the database half is not in the Worker entry**, which is where a reader
 * looks for it first: `NEXT_PUBLIC_SUPABASE_URL` is INLINED at build time by Next
 * (`src/lib/env.ts` reads it by its literal name for exactly that reason), so its
 * value lives in the bundle Next produced. `worker/index.ts` is bundled separately
 * by wrangler's esbuild, with no such inlining, and it is not a Cloudflare var
 * either, so the entry reads `undefined` there. A guard written in the entry would
 * therefore see nothing in production AND nothing under load test: it could only
 * ever be silent, which is the shape of a check that has never once concluded
 * (L98). Putting it behind the literal read is what makes it able to answer.
 *
 * The production project ref is a CONSTANT shared with the seed and the judge
 * (`scripts/loadtest/*`), never re-typed beside each one (L2, L41): those scripts
 * already refuse to run against it, and a second spelling is how one of the two
 * ends up pointing somewhere else.
 */

/** The production Supabase project. Every load test refusal is keyed on this one value. */
export const PRODUCTION_SUPABASE_REF = "drukfvgaynzrralbzkzj";

/** The production hostname. The load test environment deliberately has no route onto it. */
export const PRODUCTION_HOST = "slate.trypennie.app";

/** Whether this process is running as a load test, read at CALL time.
 *
 *  Deliberately not a module-scope const like `LOADTEST` in the Google stub: on
 *  Workers the Cloudflare vars are assigned into `process.env` by the OpenNext
 *  wrapper, and a module-scope read can run before that. Reading per call costs
 *  nothing and cannot be early.
 */
export function isLoadtest(): boolean {
  return process.env.SLATE_LOADTEST === "true";
}

/**
 * Why a load test build must not be allowed to reach this database, or null.
 *
 * Three outcomes rather than two, because "I cannot tell which database this is"
 * and "this is production" send different people to different places (L11), and
 * both must refuse. An absent address under load test is not a reason to serve:
 * the run is about to write six hundred bookings, and the one thing that decides
 * whether that lands on a throwaway branch is the value that is missing.
 *
 * Not under load test, this is always null. Production never consults the ref at
 * all, so a wrong constant here can only ever refuse a load run, never break a
 * real request.
 */
export function loadtestPointedAtProduction(args: {
  loadtest: boolean;
  supabaseUrl: string | undefined;
}): string | null {
  if (!args.loadtest) return null;
  const url = args.supabaseUrl?.trim() ?? "";
  if (url === "") {
    return (
      "SLATE_LOADTEST is set and NEXT_PUBLIC_SUPABASE_URL is empty, so which database this " +
      "build would write to cannot be established. Refused rather than served: a load run " +
      "writes hundreds of bookings and this is the value that decides where they land."
    );
  }
  if (url.includes(PRODUCTION_SUPABASE_REF)) {
    return (
      `SLATE_LOADTEST is set and NEXT_PUBLIC_SUPABASE_URL points at the PRODUCTION project ` +
      `(${PRODUCTION_SUPABASE_REF}). A load run against it would write hundreds of bookings ` +
      `into real leads' rows. Rebuild against the isolated branch.`
    );
  }
  return null;
}

/**
 * Why a load test deployment must not answer on this hostname, or null.
 *
 * The static half of this lives in `wrangler.jsonc`: `env.loadtest` sets
 * `routes: []` because routes INHERIT, so omitting it would hand the production
 * custom domain to the load test Worker (wrangler says so in its own words when
 * the key is left out). This is the runtime half, and it is worth having as well
 * as the config: the config decides what a correct deploy does, and this decides
 * what a deploy somebody pointed by hand does.
 *
 * Judged on the host ONLY, never a substring of the whole URL: a path or a query
 * carrying the production hostname is not a request that arrived on it.
 */
export function loadtestServingProductionHost(args: {
  loadtest: boolean;
  url: string;
}): string | null {
  if (!args.loadtest) return null;
  let host: string;
  try {
    host = new URL(args.url).host.toLowerCase();
  } catch {
    // Fail CLOSED, with its own message (L11). A Worker's `request.url` is always
    // an absolute URL, so this branch should be unreachable; that is exactly why
    // refusing costs nothing. Returning null here would let a parse failure read
    // as a clean bill of health, and the reach of that mistake is asymmetric:
    // refusing can only ever stop a load run, because production never reaches
    // this function at all.
    return (
      "SLATE_LOADTEST is set and this request's URL could not be read, so which hostname it " +
      "arrived on cannot be established. Refused."
    );
  }
  if (host !== PRODUCTION_HOST) return null;
  return (
    `SLATE_LOADTEST is set and this Worker is answering on ${PRODUCTION_HOST}, the production ` +
    `hostname. The load test environment is configured with no route onto it, so something ` +
    `deployed a load test build over production. Refused.`
  );
}

/**
 * What a client says when it will not call an outside system because this is a
 * load test. ONE wording, built here, so the four call sites cannot drift (L41).
 */
export function loadtestRefusal(system: string): string {
  return (
    `This deployment is running as a load test (SLATE_LOADTEST), so the call to ${system} was ` +
    `refused. The run's roster is synthetic and ${system} is not: whatever it was about to send ` +
    `or read would be the real thing, about people this run invented.`
  );
}

/**
 * Refuse to call an outside system under load test (#2335).
 *
 * Keyed on the FLAG, never on whether a credential happens to be absent, which is
 * what the load run relied on until 2026-09-14. "No token" and "production's token"
 * reach an unguarded client from opposite directions and it cannot tell them apart,
 * so the only thing standing between a load run and the real Slack workspace was a
 * sentence in the runbook (L27, L407).
 *
 * Throws, and the callers that must never throw (the Slack notifier) catch it into
 * their own no-op. Silence is the wrong default for the rest: a Salesforce read that
 * quietly returned nothing is indistinguishable from an empty Salesforce, and the
 * roster sync would write that emptiness back.
 */
export function refuseUnderLoadtest(system: string): void {
  if (isLoadtest()) throw new Error(loadtestRefusal(system));
}
