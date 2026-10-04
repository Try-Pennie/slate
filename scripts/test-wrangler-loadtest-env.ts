// The load test Worker environment, judged as WRANGLER RESOLVES IT (#2242).
//
// Resolved rather than read out of the file, because the whole hazard is
// inheritance and the file cannot show it: `env.loadtest` omitting `routes` reads
// as "no route" and MEANS "claim slate.trypennie.app", while omitting
// `ratelimits` reads the same way and means "deploy with no ceilings at all".
// Only wrangler can say which. This asks wrangler.
//
// It carries positive controls for every fault, because a judge that has only
// ever been seen to stay quiet over one config is satisfied by a judge that
// cannot speak (L1). Each control breaks the REAL resolved config one way and
// requires the fault to be named.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-wrangler-loadtest-env.ts
import { unstable_readConfig } from "wrangler";
import {
  loadtestEnvFaults,
  disabledLanesOf,
  FAULT_SWITCH_VARS,
  PER_RUN_SWITCH_VARS,
  type WranglerLike,
} from "./lib/scan-wrangler-loadtest-env.ts";
import { allLaneNames } from "../worker/lanes-disabled.ts";
import { assert, eq, fail, finish } from "./lib/harness.ts";

const CONFIG = "wrangler.jsonc";

function read(env?: string): WranglerLike {
  return unstable_readConfig({ config: CONFIG, env }) as unknown as WranglerLike;
}

/** A deep copy, so a control can break one field without touching the next control. */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

const top = read();
const env = read("loadtest");

// --- the real thing -----------------------------------------------------------

{
  const faults = loadtestEnvFaults(top, env);
  if (faults.length > 0) {
    for (const f of faults) fail(f);
  } else {
    assert(true, "the resolved env.loadtest is a safe load test environment");
  }
}

{
  // The env EXISTS. Without a section, wrangler falls back to the top level
  // wholesale and every assertion below would pass while describing production
  // (measured: with no section it resolves the production routes, vars and
  // namespace ids). So the two must differ where they are meant to.
  assert(env.name !== top.name, "env.loadtest resolves its own Worker name");
  eq(env.name, "slate-loadtest", "which is what --env loadtest deploys and tears down");
  assert(
    JSON.stringify(env.vars?.SLATE_LOADTEST) !== JSON.stringify(top.vars?.SLATE_LOADTEST),
    "and it carries a flag production does not",
  );
}

{
  // Inheritance, measured in BOTH directions on the same config, so this file
  // records what wrangler actually does rather than what its docs say.
  eq(
    JSON.stringify(env.triggers?.crons),
    JSON.stringify(top.triggers?.crons),
    "triggers INHERIT, so the load test env drives the same lanes",
  );
  eq(env.limits?.cpu_ms, top.limits?.cpu_ms, "and so does the CPU ceiling");
  assert(
    (top.routes ?? []).length > 0 && (env.routes ?? []).length === 0,
    "routes inherit too, which is why env.loadtest sets an explicit empty list",
  );
}

// --- the lanes it holds back --------------------------------------------------

{
  const disabled = disabledLanesOf(env);
  const known = new Set(allLaneNames());
  assert(disabled.length > 0, "env.loadtest names lanes to hold back");
  for (const name of disabled) {
    assert(known.has(name), `the held back lane "${name}" is a real cron lane`);
  }
  // The lanes the RUN is measuring must NOT be held back. Disabling recompute or
  // the outbox would leave the freshness sampler measuring a lane nobody drove,
  // which reads as a healthy run with nothing in it (L98).
  for (const measured of ["sync", "recompute", "outbox", "selfheal", "complete"]) {
    assert(!disabled.includes(measured), `the ${measured} lane is NOT held back: the run measures it`);
  }
  // And the lanes that reach outside the isolated branch MUST be.
  for (const outward of ["agents", "ooo-approvals", "ooo-digest", "snowflake-export", "monitor"]) {
    assert(
      disabled.includes(outward),
      `the ${outward} lane IS held back: it reaches a system the branch does not have`,
    );
  }
}

// --- positive controls --------------------------------------------------------

function control(label: string, needle: string, mutate: (e: WranglerLike) => void): void {
  const broken = clone(env);
  mutate(broken);
  const faults = loadtestEnvFaults(top, broken);
  const hit = faults.find((f) => f.includes(needle));
  assert(hit !== undefined, `a control catches ${label}`);
  if (hit === undefined && faults.length > 0) {
    console.error(`  (it said instead: ${faults.join(" | ")})`);
  }
}

control("an inherited production route", "reassign the production custom domain", (e) => {
  e.routes = clone(top.routes ?? []);
});
control("workers.dev left off", "no address at all", (e) => {
  e.workers_dev = false;
});
control("preview URLs left on", "preview_urls", (e) => {
  e.preview_urls = true;
});
control("a missing rate limiter", "fails OPEN", (e) => {
  e.ratelimits = (e.ratelimits ?? []).filter((r) => r.name !== "BOOKINGAPI_IP_RATE_LIMITER");
});
control("a limiter set to a different ceiling", "measures a ceiling", (e) => {
  const r = (e.ratelimits ?? []).find((x) => x.name === "BOOKINGAPI_IP_RATE_LIMITER")!;
  r.simple = { limit: 600, period: 60 };
});
control("a namespace id shared with production", "ACCOUNT scoped", (e) => {
  const r = (e.ratelimits ?? []).find((x) => x.name === "AVAIL_RATE_LIMITER")!;
  r.namespace_id = (top.ratelimits ?? []).find((x) => x.name === "AVAIL_RATE_LIMITER")!.namespace_id;
});
control("two limiters sharing one namespace id", "share one count", (e) => {
  const list = e.ratelimits ?? [];
  list[1]!.namespace_id = list[0]!.namespace_id;
});
control("the missing burst counter", "Durable Object binding", (e) => {
  e.durable_objects = { bindings: [] };
});
control("a missing Durable Object migration", "is never created", (e) => {
  e.migrations = [];
});
control("a var that did not inherit", "vars do NOT inherit", (e) => {
  delete e.vars!.CALCOM_ORG_ID;
});
control("a var set to a different value", "is meant to exercise", (e) => {
  e.vars!.CALCOM_ORG_ID = "99999";
});
control("the load test flag left off", "six hundred REAL calendar events", (e) => {
  delete e.vars!.SLATE_LOADTEST;
});
control("no lanes held back", "SLATE_LANES_DISABLED", (e) => {
  delete e.vars!.SLATE_LANES_DISABLED;
});
control("a lane name that matches nothing", "is no cron lane", (e) => {
  e.vars!.SLATE_LANES_DISABLED = `${String(e.vars!.SLATE_LANES_DISABLED)},ooo-aprovals`;
});
control("a committed build inlined address", "inlined at build time", (e) => {
  e.vars!.NEXT_PUBLIC_SUPABASE_URL = "https://somebranch.supabase.co";
});
control("crons that stopped inheriting", "measures recompute freshness", (e) => {
  e.triggers = { crons: [] };
});
control("a different CPU ceiling", "a different ceiling", (e) => {
  e.limits = { cpu_ms: 30000 };
});

{
  // The other direction on the two settings that must exist ONLY here (L159): the
  // judge has to notice them at the TOP level too, or production could quietly
  // acquire the flag and nothing here would say so.
  const brokenTop = clone(top);
  brokenTop.vars!.SLATE_LOADTEST = "true";
  assert(
    loadtestEnvFaults(brokenTop, env).some((f) => f.includes("Production would stub Google")),
    "a control catches SLATE_LOADTEST set on production",
  );
  const brokenTop2 = clone(top);
  brokenTop2.vars!.SLATE_LANES_DISABLED = "monitor";
  assert(
    loadtestEnvFaults(brokenTop2, env).some((f) => f.includes("production would hold lanes back")),
    "a control catches SLATE_LANES_DISABLED set on production",
  );
}

// --- the fault switch can never be turned on in production (#3104) -------------
//
// Asserted against the PRODUCTION block as wrangler resolves it, not against the
// file's text: the fault switch needs SLATE_LOADTEST AND a percentage, and neither
// may exist there. The gate itself (a percentage with no flag faults nothing) is
// driven in real processes by scripts/test-loadtest-fault-targets.ts; this is the
// configuration half, so the two together are the structural claim.
{
  const prodVars = top.vars ?? {};
  assert(!("SLATE_LOADTEST" in prodVars), "production resolves no SLATE_LOADTEST, so no injector can fire");
  for (const key of PER_RUN_SWITCH_VARS) {
    assert(!(key in prodVars), `production resolves no ${key}`);
    assert(!(key in (env.vars ?? {})), `and env.loadtest does not commit ${key}: only a leg's --var deploy adds it`);
  }
  for (const key of PER_RUN_SWITCH_VARS) {
    const brokenTop = clone(top);
    brokenTop.vars![key] = "100";
    assert(
      loadtestEnvFaults(brokenTop, env).some((f) => f.includes(`the top level sets ${key}`)),
      `a control catches ${key} set on production`,
    );
    const brokenEnv = clone(env);
    brokenEnv.vars![key] = "10";
    assert(
      loadtestEnvFaults(top, brokenEnv).some((f) => f.includes(`env.loadtest commits ${key}`)),
      `a control catches ${key} committed in env.loadtest`,
    );
  }
}

// #3269 review: each per run switch is refused in its OWN words. The recompute arm
// is not fault injection, and a refusal calling it that would send somebody hunting
// for faults a committed arm never injects (L11).
{
  const recompute = "SLATE_LOADTEST_POST_CONFIRM_RECOMPUTE";
  assert((PER_RUN_SWITCH_VARS as readonly string[]).includes(recompute), "the recompute arm is a per run switch");
  for (const key of PER_RUN_SWITCH_VARS) {
    const brokenTop = clone(top);
    brokenTop.vars![key] = "off";
    const brokenEnv = clone(env);
    brokenEnv.vars![key] = "off";
    const said = [
      ...loadtestEnvFaults(brokenTop, env).filter((f) => f.startsWith(`the top level sets ${key}`)),
      ...loadtestEnvFaults(top, brokenEnv).filter((f) => f.startsWith(`env.loadtest commits ${key}`)),
    ];
    eq(said.length, 2, `${key} is refused at the top level and in env.loadtest`);
    const isFault = (FAULT_SWITCH_VARS as readonly string[]).includes(key);
    for (const f of said) {
      if (isFault) assert(/fault/.test(f), `${key}'s refusal speaks of faults: ${f}`);
      else {
        assert(!/fault/i.test(f), `${key}'s refusal does not call it fault injection: ${f}`);
        assert(/post confirm recompute/.test(f), `${key}'s refusal names the post confirm recompute: ${f}`);
      }
    }
  }
}

finish();
