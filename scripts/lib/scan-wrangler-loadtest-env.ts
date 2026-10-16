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
import { parseSharedLineDefault } from "../../src/lib/booking/shared-line-switch-core.ts";
import { SELF_BINDING } from "../../worker/lane-run.ts";

/** The fault switch's two settings (#3104), which the fault leg adds with --var and
 *  nothing commits. */
export const FAULT_SWITCH_VARS = ["SLATE_LOADTEST_FAULT_PCT", "SLATE_LOADTEST_FAULT_TARGETS"] as const;

/**
 * Every per run switch a leg adds with --var and nothing commits, each with its OWN
 * refusal (#3269 review): the two fault settings, and the post confirm recompute arm
 * (#3258), which is not fault injection and must not be described as it (L11).
 */
const PER_RUN_SWITCH_REASONS: Record<string, { topLevel: string; committed: string }> = {
  SLATE_LOADTEST_FAULT_PCT: faultReasons("SLATE_LOADTEST_FAULT_PCT"),
  SLATE_LOADTEST_FAULT_TARGETS: faultReasons("SLATE_LOADTEST_FAULT_TARGETS"),
  SLATE_LOADTEST_POST_CONFIRM_RECOMPUTE: {
    topLevel:
      "the top level sets SLATE_LOADTEST_POST_CONFIRM_RECOMPUTE, the load run's post confirm " +
      "recompute arm. Production ignores it, and it has no business existing there: it belongs " +
      "to the load workflow's arm job alone.",
    committed:
      "env.loadtest commits SLATE_LOADTEST_POST_CONFIRM_RECOMPUTE, so every run would measure " +
      "that post confirm recompute arm whatever it was dispatched for, and a run dispatched for " +
      "another arm would be refused at preflight. The arm job sets it with --var.",
  },
  // #3490: the Google stand in's delay, which is a rig choice and not fault injection.
  SLATE_LOADTEST_GOOGLE_DELAY: {
    topLevel:
      "the top level sets SLATE_LOADTEST_GOOGLE_DELAY, the load run's Google delay. Production " +
      "never reads it (it acts only inside the Google stand in), and it has no business existing " +
      "there: it belongs to the load workflow's arm job alone.",
    committed:
      "env.loadtest commits SLATE_LOADTEST_GOOGLE_DELAY, so every run would put that Google delay " +
      "into its confirms whatever it was dispatched for, and a run dispatched without it would be " +
      "refused at preflight. The arm job sets it with --var.",
  },
};

/** The switches whose refusals `loadtestEnvFaults` words one by one. */
export const PER_RUN_SWITCH_VARS = Object.keys(PER_RUN_SWITCH_REASONS);

function faultReasons(key: string): { topLevel: string; committed: string } {
  return {
    topLevel:
      `the top level sets ${key}, the load run's fault switch. It belongs to the fault leg's ` +
      `deploy alone and never to production.`,
    committed:
      `env.loadtest commits ${key}, so every leg of every run would inject faults and the ` +
      `steady pass would count them as the path's own 5xx. The fault leg sets it with --var.`,
  };
}

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
  services?: { binding?: string; service?: string; entrypoint?: string }[] | null;
}

/**
 * Vars the load test is MEANT to set differently from production, each held to the
 * value the run needs rather than exempted from the check (#3325).
 *
 * The reason an entry belongs here: the var is a deployment DEFAULT for a capability the
 * load run proves before production turns it on, so the run must exercise the
 * capability while production does not yet. Every other var must match production,
 * because the run is meant to exercise production's configuration.
 */
const LOADTEST_DIFFERS: Record<
  string,
  {
    /** The value env.loadtest must resolve. */
    loadtest: string;
    /** Whether production's value is one the app reads, judged by the app's own parser. */
    readable: (value: string) => boolean;
    /** What production's value must be, in words. */
    vocabulary: string;
    /** What a wrong load test value would do to the run. */
    why: string;
  }
> = {
  SHARED_CONFIRM_LINE_DEFAULT: {
    loadtest: "on",
    readable: (value) => parseSharedLineDefault(value).problem === null,
    vocabulary: "on or off",
    why:
      "it is the shared confirm line's answer before an isolate has read the stored switch, " +
      "so cold isolates would read the shared line as off and the burst would be measured on " +
      "the per isolate line the run exists to replace",
  },
};

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
    if (key in LOADTEST_DIFFERS) continue;
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
  for (const [key, want] of Object.entries(LOADTEST_DIFFERS)) {
    if (envVars[key] !== want.loadtest) {
      faults.push(
        `env.loadtest sets ${key} to ${JSON.stringify(envVars[key])} where the load run needs ` +
          `${JSON.stringify(want.loadtest)} (vars do NOT inherit): ${want.why}.`,
      );
    }
    if (!(key in topVars)) {
      faults.push(
        `the top level does not set ${key}, so production reports it missing on every cold ` +
          `isolate and treats it as off. Set it explicitly, to ${want.vocabulary}.`,
      );
    } else if (!want.readable(String(topVars[key]))) {
      faults.push(
        `the top level sets ${key} to ${JSON.stringify(topVars[key])}, which is not ` +
          `${want.vocabulary}, so production reports it on every cold isolate and treats it as off.`,
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
  // The post confirm recompute arm (#3258) is held to the same rule for its own
  // reason, worded beside it above.
  for (const [key, reason] of Object.entries(PER_RUN_SWITCH_REASONS)) {
    if (key in topVars) faults.push(reason.topLevel);
    if (key in envVars) faults.push(reason.committed);
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

  faults.push(...selfBindingFaults(top, env));
  return faults;
}

/**
 * The Worker's binding to itself (#3693), judged in BOTH environments: the cron lanes go
 * over it to run as placed fetches near the database. `services` do not inherit, so each
 * environment names its own, and the load test's must name the load test Worker: one
 * naming `slate` would run the load run's lanes, under the load test's ticks, on
 * production.
 */
function selfBindingFaults(top: WranglerLike, env: WranglerLike): string[] {
  const faults: string[] = [];
  const sides: [string, WranglerLike][] = [
    ["the top level", top],
    ["env.loadtest", env],
  ];
  for (const [label, cfg] of sides) {
    const self = (cfg.services ?? []).find((b) => b.binding === SELF_BINDING);
    if (!self) {
      faults.push(
        `${label} has no ${SELF_BINDING} service binding, so every cron lane runs in process ` +
          `wherever Cloudflare ran the cron rather than as a placed fetch near the database. ` +
          `services do NOT inherit.`,
      );
      continue;
    }
    if (self.service !== cfg.name) {
      const production = cfg === env && self.service === top.name;
      faults.push(
        `${label} binds ${SELF_BINDING} to ${String(self.service)}, not to its own Worker ` +
          `${String(cfg.name)}` +
          (production ? `, so the load run's lanes would run on PRODUCTION.` : `.`),
      );
    }
    if (self.entrypoint) {
      faults.push(
        `${label} binds ${SELF_BINDING} to the ${self.entrypoint} entrypoint. Placement does not ` +
          `apply to a named entrypoint, so the lanes would not be placed.`,
      );
    }
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
