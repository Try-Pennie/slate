/**
 * What makes a load test Worker environment safe, judged over the RESOLVED
 * wrangler config rather than over the text of `wrangler.jsonc` (#2242).
 *
 * Resolved, because the whole hazard is inheritance. Half of wrangler's keys are
 * inherited by a named environment and half resolve EMPTY in one, and a reader of
 * the file cannot tell which is which: omitting `routes` reads as "no route" and
 * means "claim the production custom domain", while omitting `ratelimits` reads
 * the same way and means "ship with no ceilings at all". A check over the source
 * text would be asserting what somebody typed; this asserts what wrangler decided.
 *
 * Every fault is a sentence saying what is wrong and what it would cause, because
 * the reader of a red run here is somebody about to dispatch a ten minute run that
 * writes six hundred bookings.
 */
import { allLaneNames } from "../../worker/lanes-disabled.ts";

/** The per run switches, which a leg adds with --var and nothing commits: the fault
 *  switch's two settings (#3104), and the post confirm recompute arm (#3258), which
 *  production must never carry. */
export const FAULT_SWITCH_VARS = [
  "SLATE_LOADTEST_FAULT_PCT",
  "SLATE_LOADTEST_FAULT_TARGETS",
  "SLATE_LOADTEST_POST_CONFIRM_RECOMPUTE",
] as const;

export interface RateLimit {
  name?: string;
  namespace_id?: string;
  simple?: { limit?: number; period?: number };
}

export interface WranglerLike {
  name?: string | null;
  routes?: unknown[] | null;
  workers_dev?: boolean | null;
  preview_urls?: boolean | null;
  vars?: Record<string, unknown> | null;
  ratelimits?: RateLimit[] | null;
  durable_objects?: { bindings?: { name?: string; class_name?: string }[] } | null;
  migrations?: { tag?: string; new_sqlite_classes?: string[] }[] | null;
  triggers?: { crons?: string[] } | null;
  limits?: { cpu_ms?: number } | null;
}

/** Vars that must never be committed for either environment, with why. */
const BUILD_INLINED: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL:
    "it is inlined at build time, so a committed value is a lie the day the branch it names is thrown away",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "it is inlined at build time and belongs to whichever branch was built",
  NEXT_PUBLIC_APP_URL: "it is inlined at build time and also namespaces the L1 slot caches",
};

function limitOf(r: RateLimit): string {
  return `${r.simple?.limit ?? "?"}/${r.simple?.period ?? "?"}`;
}

/** Every reason this pair of resolved configs is not a safe load test setup (empty = safe). */
export function loadtestEnvFaults(top: WranglerLike, env: WranglerLike): string[] {
  const faults: string[] = [];

  // --- the address it answers on ---------------------------------------------
  const routes = env.routes ?? [];
  if (routes.length > 0) {
    faults.push(
      `env.loadtest resolves ${routes.length} route(s), so deploying it would reassign the ` +
        `production custom domain away from the top level Worker. It needs an explicit "routes": [].`,
    );
  }
  if (env.workers_dev !== true) {
    faults.push(
      `env.loadtest resolves workers_dev=${String(env.workers_dev)}. The top level turned ` +
        `workers.dev off (#1052) and it INHERITS, so without an explicit true the load test ` +
        `Worker has no address at all and nothing can drive it.`,
    );
  }
  if (env.preview_urls !== false) {
    faults.push(
      `env.loadtest resolves preview_urls=${String(env.preview_urls)}. A preview URL serves a ` +
        `real version with these bindings on a public address and emits no observability events.`,
    );
  }
  if (env.name === top.name) {
    faults.push(`env.loadtest resolves the same Worker name as production (${String(top.name)}).`);
  }

  // --- the bindings that do not inherit --------------------------------------
  const topLimiters = top.ratelimits ?? [];
  const envLimiters = env.ratelimits ?? [];
  const byName = new Map(envLimiters.map((r) => [r.name ?? "", r]));
  for (const want of topLimiters) {
    const got = byName.get(want.name ?? "");
    if (!got) {
      faults.push(
        `env.loadtest is missing the ${want.name} rate limiter. ratelimits do NOT inherit, and a ` +
          `missing binding fails OPEN in src/lib/rate-limit.ts (nativeWithinLimit alerts and ` +
          `returns true), so the run would measure a deployment with no ceiling while the judge ` +
          `attributed its 429s to one.`,
      );
      continue;
    }
    if (limitOf(got) !== limitOf(want)) {
      faults.push(
        `env.loadtest's ${want.name} is ${limitOf(got)} where production is ${limitOf(want)}. The ` +
          `run sits deliberately ON the per address write ceiling, so a different one measures a ` +
          `ceiling nothing in production enforces.`,
      );
    }
    if (got.namespace_id && got.namespace_id === want.namespace_id) {
      faults.push(
        `env.loadtest's ${want.name} reuses production's namespace id ${want.namespace_id}. A ` +
          `namespace id is ACCOUNT scoped, so the run's writes would count against the ceiling ` +
          `real leads are judged by.`,
      );
    }
  }
  const seen = new Map<string, string>();
  for (const r of envLimiters) {
    const id = r.namespace_id ?? "";
    if (id === "") {
      faults.push(`env.loadtest's ${r.name} has no namespace id.`);
      continue;
    }
    const other = seen.get(id);
    if (other) {
      faults.push(
        `env.loadtest gives ${other} and ${r.name} the same namespace id ${id}, so two endpoints ` +
          `share one count.`,
      );
    }
    seen.set(id, r.name ?? "?");
  }

  const topDo = top.durable_objects?.bindings ?? [];
  const envDo = env.durable_objects?.bindings ?? [];
  for (const want of topDo) {
    const got = envDo.find((b) => b.name === want.name);
    if (!got) {
      faults.push(
        `env.loadtest is missing the ${want.name} Durable Object binding. durable_objects do NOT ` +
          `inherit, and this one is the burst ceiling behind every limiter above (#1536).`,
      );
    } else if (got.class_name !== want.class_name) {
      faults.push(
        `env.loadtest binds ${want.name} to ${got.class_name} where production binds ` +
          `${want.class_name}.`,
      );
    }
  }
  for (const want of top.migrations ?? []) {
    const got = (env.migrations ?? []).find((m) => m.tag === want.tag);
    if (!got) {
      faults.push(
        `env.loadtest is missing Durable Object migration ${want.tag}, so the class the binding ` +
          `names is never created.`,
      );
    }
  }

  // --- vars ------------------------------------------------------------------
  const topVars = top.vars ?? {};
  const envVars = env.vars ?? {};
  for (const [key, value] of Object.entries(topVars)) {
    if (!(key in envVars)) {
      faults.push(
        `env.loadtest is missing the ${key} var. vars do NOT inherit, so it resolves absent and ` +
          `whatever reads it takes its own fallback.`,
      );
    } else if (envVars[key] !== value) {
      faults.push(
        `env.loadtest sets ${key} to ${JSON.stringify(envVars[key])} where production sets ` +
          `${JSON.stringify(value)}. The load run is meant to exercise production's configuration.`,
      );
    }
  }
  for (const [key, why] of Object.entries(BUILD_INLINED)) {
    for (const [label, vars] of [["the top level", topVars], ["env.loadtest", envVars]] as const) {
      if (key in vars) faults.push(`${label} sets ${key} as a var, but ${why}.`);
    }
  }

  // --- the two settings that exist only here ---------------------------------
  if (envVars.SLATE_LOADTEST !== "true") {
    faults.push(
      `env.loadtest does not set SLATE_LOADTEST="true" (got ${JSON.stringify(envVars.SLATE_LOADTEST)}). ` +
        `Without it the Google stub, the webhook short circuit and both refusals in ` +
        `src/lib/loadtest-guard.ts are inert, and the run would make six hundred REAL calendar ` +
        `events and send six hundred real invitations.`,
    );
  }
  if ("SLATE_LOADTEST" in topVars) {
    faults.push(
      `the top level sets SLATE_LOADTEST. Production would stub Google, suppress every webhook ` +
        `and echo the caller's address.`,
    );
  }

  const disabled = String(envVars.SLATE_LANES_DISABLED ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (disabled.length === 0) {
    faults.push(
      `env.loadtest sets no SLATE_LANES_DISABLED. The cron triggers INHERIT, so every lane would ` +
        `run against the branch: /api/cron/ooo-approvals emails salesmanagers@trypennie.com about ` +
        `a synthetic roster, /api/cron/agents rewrites it from Salesforce, and the Snowflake lanes ` +
        `write the warehouse.`,
    );
  }
  if ("SLATE_LANES_DISABLED" in topVars) {
    faults.push(`the top level sets SLATE_LANES_DISABLED, so production would hold lanes back.`);
  }

  // --- the fault switch is committed NOWHERE (#3104) -------------------------
  // It is added at deploy time by the fault leg (`wrangler deploy --var`) and taken
  // away by the restore step, which deploys the vars block as written. On the top
  // level it is production's own setting, which the injectors' SLATE_LOADTEST gate
  // makes inert but which has no business existing; in the committed env.loadtest
  // block it would fault EVERY leg of every run, so the steady pass's "no 5xx" bar
  // would be measuring faults the run injected on purpose.
  for (const key of FAULT_SWITCH_VARS) {
    if (key in topVars) {
      faults.push(
        `the top level sets ${key}, the load run's fault switch. It belongs to the fault leg's ` +
          `deploy alone and never to production.`,
      );
    }
    if (key in envVars) {
      faults.push(
        `env.loadtest commits ${key}, so every leg of every run would inject faults and the ` +
          `steady pass would count them as the path's own 5xx. The fault leg sets it with --var.`,
      );
    }
  }
  const known = new Set(allLaneNames());
  for (const name of disabled) {
    if (!known.has(name)) {
      faults.push(
        `env.loadtest's SLATE_LANES_DISABLED names "${name}", which is no cron lane. The Worker ` +
          `refuses every tick rather than running the lane somebody meant to hold back, so the ` +
          `run would produce no lanes at all.`,
      );
    }
  }

  // --- what SHOULD have inherited --------------------------------------------
  const topCrons = top.triggers?.crons ?? [];
  const envCrons = env.triggers?.crons ?? [];
  if (JSON.stringify(topCrons) !== JSON.stringify(envCrons)) {
    faults.push(
      `env.loadtest resolves ${envCrons.length} cron triggers where production has ` +
        `${topCrons.length}. They are inherited on purpose: the run measures recompute freshness ` +
        `and the outbox drain UNDER the booking load.`,
    );
  }
  if ((env.limits?.cpu_ms ?? null) !== (top.limits?.cpu_ms ?? null)) {
    faults.push(
      `env.loadtest resolves limits.cpu_ms=${String(env.limits?.cpu_ms)} where production has ` +
        `${String(top.limits?.cpu_ms)}, so a CPU reading from the run is about a different ceiling.`,
    );
  }

  return faults;
}

/** The lanes a resolved env holds back, in the order the setting names them. */
export function disabledLanesOf(env: WranglerLike): string[] {
  return String(env.vars?.SLATE_LANES_DISABLED ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}
