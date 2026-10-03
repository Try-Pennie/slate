// Which of production's own settings a load test deployment is carrying (#2335).
//
// **This file is deliberately NOT reachable from the browser bundle, and that is
// the reason it is not in `loadtest-guard.ts` beside the other two refusals.** The
// list below names every integration Slate has, and the first version of this
// enforced the refusal inside `publicSupabaseUrl()`, which the SSR and browser
// Supabase clients also call: measured against a real build, all twenty three names
// shipped in a public `_next/static` chunk served to every visitor of the booker. A
// guard against leaking credentials must not itself publish the inventory.
//
// `supabaseAdmin()` was tried next and leaks the same way: measured on a real build,
// its module graph is pulled into client chunks too. So the refusal lives in the
// WORKER ENTRY (`worker/index.ts`), which wrangler bundles separately and Next never
// sees, and which is also the only place that can ask the question completely. See
// `loadtestEntryRefusal` at the bottom of this file. The DATABASE question, which an
// SSR read also raises, is answered by `loadtestPointedAtProduction` where it
// always was.
//
// `scripts/check-bundle-env.ts` re-measures it after every build rather than
// trusting this comment, so a future import from a client component fails loudly
// instead of quietly republishing the list.
//
// No `@/` imports here: `scripts/check-bundle-env.ts` reads the list on bare node.

/**
 * The three secrets a load test deployment legitimately holds, and nothing else.
 *
 * `SUPABASE_SECRET_KEY` (which on a connector-created branch is really the
 * branch's PUBLISHABLE key, see the runbook), `CRON_SECRET` so the lanes can be
 * driven, and `BOOKING_API_KEY_CANARY` so the drivers can book AND the preflight can
 * ask `/api/smoke/version`, which accepts the canary's key and nothing else (#2854).
 * The drivers' value is the run's own, never production's canary key. Every other
 * name in the deployment's secret inventory belongs to production.
 */
export const LOADTEST_ALLOWED_SECRETS = [
  "SUPABASE_SECRET_KEY",
  "CRON_SECRET",
  "BOOKING_API_KEY_CANARY",
] as const;

/**
 * Everything else the deployment registry knows about, which a load test build
 * must never hold (#2335).
 *
 * This is `DEPLOY.md`'s `wrangler secret put` list minus the three above, and it
 * is checked against that file by `scripts/test-loadtest-secret-inventory.ts`
 * rather than maintained beside it: a secret added to the runbook and not
 * classified here fails the build, so a name can never be quietly exempt from the
 * guard written to catch it (L96).
 *
 * A few of these (`SLACK_ALERTS_CHANNEL`, `TWILIO_WORKSPACE_SID`,
 * `SF_INSTANCE_URL`, `MAIN_OOO_CAL_ID`) are not secrets in the strict sense. They
 * are still production's own configuration, none of them is in `env.loadtest`'s
 * vars block, and a load test deployment that has one has been handed production's
 * environment by something. Widening the list costs nothing and narrowing it would
 * mean two questions instead of one.
 */
export const PRODUCTION_ONLY_SECRETS = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_SA_CLIENT_EMAIL",
  "GOOGLE_SA_PRIVATE_KEY",
  "SF_CLIENT_ID",
  "SF_CLIENT_SECRET",
  "SF_INSTANCE_URL",
  "GOOGLE_CHANNEL_TOKEN",
  "MAIN_OOO_CAL_ID",
  "SLACK_BOT_TOKEN",
  "SLACK_ALERTS_CHANNEL",
  "SLACK_INFO_CHANNEL",
  "SLACK_SIGNING_SECRET",
  "CALCOM_API_KEY",
  "TWILIO_API_KEY_SID",
  "TWILIO_API_KEY_SECRET",
  "TWILIO_WORKSPACE_SID",
  "REASSIGN_API_KEY",
  "DUPLICATE_CANCEL_API_KEY",
  "OFFBOARDING_API_KEY",
  "BOOKABLE_API_KEY",
  "REGAL_INBOUND_KEY",
  // #3091: the outbound Regal key and the generic signing secret. A load run never
  // posts to a real subscriber (SLATE_LOADTEST short circuits the send).
  "REGAL_WEBHOOK_KEY",
  "WEBHOOK_SIGNING_SECRET",
  "BOOKING_API_KEY_REGAL",
  "BOOKING_API_KEY_REGAL_2",
  "BOOKING_API_KEY_TRYPENNIE",
  "BOOKING_API_KEY_TRYPENNIE_2",
  "BOOKING_API_KEY_CANARY_2",
  // #2940: Marcia's cancel only key. The load run never cancels as Marcia.
  "BOOKING_API_KEY_MARCIA",
  "BOOKING_API_KEY_MARCIA_2",
  // #2879: production's record of which keys it retired. Not a credential, still
  // production's own configuration, so a load test deployment never carries it.
  "BOOKING_API_RETIRED_KEY_HASHES",
  "GITHUB_CANARY_TOKEN",
  // #1228: noodge's heartbeat key for the two health endpoints. The load run has no
  // noodge polling it, so a load test Worker holding it was handed production's.
  "UPTIME_HEARTBEAT_KEY",
  "SNOWFLAKE_PRIVATE_KEY",
  // #2666: signs the public test bucket's pass. Production's; the load run never
  // books the public test bucket, so without it the test path is simply off there.
  "EMBED_TEST_PASS_SECRET",
] as const;

/** Which production-only names this environment is carrying. Names, never values. */
export function productionSecretsPresent(env: Record<string, unknown>): string[] {
  return PRODUCTION_ONLY_SECRETS.filter((name) => {
    const value = env[name];
    // A STRING with something in it, which is exactly what the runtime treats as a
    // setting: `populateProcessEnv` copies only string bindings, and every reader in
    // the app takes "" as not configured (`slackConfigured()` is `length > 0`). This
    // is also read over the Worker's raw `env`, where a value can be a KV namespace
    // or a Durable Object rather than a string, so the type is checked rather than
    // assumed.
    return typeof value === "string" && value.trim() !== "";
  });
}

/**
 * Why a load test build must not be allowed to serve with the credentials it is
 * holding, or null (#2335).
 *
 * The third refusal, and neither of the two above could have caught what it
 * catches. On 2026-09-14 a load test Worker was built in a worktree holding a copy
 * of production's `.env.local`; the Cloudflare adapter bakes every `.env*` value
 * into the bundle and `populateProcessEnv` fills in every name the Worker's own
 * bindings did NOT set. So the deployment was pointed at the throwaway branch and
 * answering on a workers.dev address, both guards correctly silent, while holding
 * production's Slack token. It paged the real alerts channel about a synthetic
 * roster for six minutes.
 *
 * Keyed on the NAMES being present rather than on any behaviour downstream,
 * because the point is to refuse before anything is reached: what the run does
 * with a credential is a long list nobody can enumerate, and holding one at all is
 * a single measurable fact.
 *
 * The message carries the names and never the values. It is logged, and answered
 * to the caller, and a refusal that printed the credential would put it in the
 * transcript it is read from (L222).
 *
 * Not under load test, this is always null: production holds every one of these by
 * design and runs this on every request.
 */
export function loadtestCarryingProductionSecrets(args: {
  loadtest: boolean;
  env: Record<string, unknown>;
}): string | null {
  if (!args.loadtest) return null;
  const present = productionSecretsPresent(args.env);
  if (present.length === 0) return null;
  return (
    `SLATE_LOADTEST is set and this deployment is carrying ${present.length} of production's ` +
    `own settings: ${present.join(", ")}. A load test must hold only ` +
    `${LOADTEST_ALLOWED_SECRETS.join(", ")}. The usual cause is a build tree containing a ` +
    `copy of .env.local: the Cloudflare adapter writes every .env* value into the bundle ` +
    `(.open-next/cloudflare/next-env.mjs) and the runtime fills in every name the Worker's ` +
    `bindings did not set. Rebuild in a tree with no .env files. Refused rather than served: ` +
    `the run would reach real Slack, Salesforce, Twilio and cal.com with production's credentials.`
  );
}

/**
 * The mode's object out of the adapter's baked env file, or an empty one.
 *
 * `.open-next/cloudflare/next-env.mjs` exports `production`, `development` and
 * `test`, and the runtime applies whichever `NEXTJS_ENV` names, defaulting to
 * production. Anything unreadable is treated as empty HERE, on purpose: this half
 * is a second source beside the bindings rather than the measurement itself, and the
 * build already refuses a file it cannot read (`scripts/check-bundle-env.ts`).
 */
export function bakedSettingsForMode(
  baked: unknown,
  mode: string | undefined,
): Record<string, unknown> {
  if (typeof baked !== "object" || baked === null) return {};
  const chosen = (baked as Record<string, unknown>)[mode && mode.trim() !== "" ? mode : "production"];
  if (typeof chosen !== "object" || chosen === null) return {};
  return chosen as Record<string, unknown>;
}

/**
 * The paths a contaminated deployment may still answer, and why (#2335).
 *
 * `/api/smoke/version` is how the load run learns WHAT is wrong. It is key authed,
 * reads no data and makes no outbound call, so answering it costs nothing; refusing
 * it would leave the preflight reporting "the deployment answered 503" about the one
 * request that could have named the settings instead (L11). Everything else refuses.
 */
export const LOADTEST_DIAGNOSTIC_PATHS = ["/api/smoke/version"];

/** Repeated and trailing slashes collapsed, so a base URL with a trailing slash still
 *  reaches the one path that can say what is wrong. It does NOT resolve `..`: a path
 *  that climbs out of the exempt one is a different path and stays refused. */
function normalisePath(pathname: string): string {
  const collapsed = pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  return collapsed === "" ? "/" : collapsed;
}

/**
 * Why this Worker must refuse to serve, or null (#2335).
 *
 * Asked in the Worker ENTRY (`worker/index.ts`), which is the only place that can
 * ask it completely:
 *
 *   it sees BOTH sources. A production credential reaches a load test deployment
 *   two ways: baked into the bundle by the build (the 2026-09-14 incident) or put on
 *   the environment by hand, and neither can answer for the other. The entry holds
 *   the bindings AND can import the baked file, so it reads both.
 *
 *   it sees them from the FIRST request. `populateProcessEnv` runs inside the
 *   generated handler, so anything reading `process.env` in front of it is empty on
 *   the first invocation of each isolate, which is exactly the request a guard must
 *   not miss.
 *
 *   and it is never bundled for the browser. That is not a nicety: the first version
 *   of this refusal lived in `publicSupabaseUrl()`, and measured against a real build
 *   all twenty three names below shipped in a public `_next/static` chunk, because
 *   `supabaseAdmin`'s module graph is pulled into client chunks. wrangler bundles the
 *   entry separately and Next never sees it.
 */
export function loadtestEntryRefusal(args: {
  loadtest: boolean;
  /** The request's path, or undefined for a scheduled tick, which has none. */
  pathname: string | undefined;
  /** The Worker's own bindings. */
  bindings: Record<string, unknown>;
  /** The adapter's baked env file, whatever it turned out to be. */
  baked: unknown;
}): string | null {
  if (!args.loadtest) return null;
  if (args.pathname !== undefined && LOADTEST_DIAGNOSTIC_PATHS.includes(normalisePath(args.pathname))) {
    return null;
  }
  const mode = args.bindings.NEXTJS_ENV;
  const carried = {
    ...bakedSettingsForMode(args.baked, typeof mode === "string" ? mode : undefined),
    // Bindings win, exactly as `populateProcessEnv` applies them: a name set BOTH
    // ways is one setting, and counting it twice would say two.
    ...args.bindings,
  };
  return loadtestCarryingProductionSecrets({ loadtest: true, env: carried });
}
