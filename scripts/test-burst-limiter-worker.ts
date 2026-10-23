// The burst limiter object is served by its own small Worker (#3555), as the confirm line
// is (#3500), judged as wrangler RESOLVES both configs.
//
// In Slate's own 21 MB Worker, waking a ceiling object loaded the whole app (a per address
// ceiling's first call took 0.8 to 1.15s against about 40ms after) and every Slate deploy
// restarted every object (the first confirm after one waited 1.5s on its key ceiling and
// 0.9s on its address ceiling, load run 37841835577). Slate binds BURST_LIMITER to the small
// Worker by script name, production to production's and the load test to the load test's.
// Slate's own copy of the class is deleted by its v3 migration (#4025), which
// scripts/test-retired-object-classes.ts holds in full.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-burst-limiter-worker.ts
import { unstable_readConfig } from "wrangler";
import { BURST_LIMITER_BINDING, BURST_LIMITER_CLASS } from "../src/lib/rate-limit-burst.ts";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import { walkWorkerImports } from "./lib/scan-local-import-graph.ts";

interface Resolved {
  name?: string;
  main?: string;
  workers_dev?: boolean;
  routes?: unknown[];
  durable_objects?: { bindings?: { name?: string; class_name?: string; script_name?: string }[] } | null;
  migrations?: { tag?: string; new_sqlite_classes?: string[]; deleted_classes?: string[] }[] | null;
}

const SCRIPT = { production: "slate-burst-limiter", loadtest: "slate-burst-limiter-loadtest" } as const;
for (const env of [undefined, "loadtest"] as const) {
  const label = env ?? "production";
  const slate = unstable_readConfig({ config: "wrangler.jsonc", env }) as unknown as Resolved;
  const binding = (slate.durable_objects?.bindings ?? []).find((b) => b.name === BURST_LIMITER_BINDING);
  eq(binding?.class_name, BURST_LIMITER_CLASS, `${label}: ${BURST_LIMITER_BINDING} is bound to ${BURST_LIMITER_CLASS}`);
  eq(binding?.script_name, SCRIPT[label], `${label}: ${BURST_LIMITER_BINDING} is served by the small burst limiter Worker, by script name`);
  assert(
    (slate.migrations ?? []).some((m) => (m.deleted_classes ?? []).includes(BURST_LIMITER_CLASS)),
    `${label}: Slate's migration history deletes its own ${BURST_LIMITER_CLASS}, leaving the small Worker's the only one`,
  );

  const own = unstable_readConfig({ config: "wrangler.burst-limiter.jsonc", env }) as unknown as Resolved;
  eq(own.name, SCRIPT[label], `${label}: the burst limiter Worker is named for its environment`);
  eq(own.main?.replace(/^.*?(worker\/)/, "$1"), "worker/burst-limiter/index.ts", `${label}: its entry is its own small module`);
  const hosted = (own.durable_objects?.bindings ?? []).find((b) => b.name === BURST_LIMITER_BINDING);
  assert(hosted?.class_name === BURST_LIMITER_CLASS && hosted.script_name === undefined, `${label}: it hosts ${BURST_LIMITER_CLASS} itself (got ${JSON.stringify(hosted ?? null)})`);
  assert(
    (own.migrations ?? []).some((m) => (m.new_sqlite_classes ?? []).includes(BURST_LIMITER_CLASS)),
    `${label}: its migration creates ${BURST_LIMITER_CLASS} as a SQLite class`,
  );
  assert(own.workers_dev === false && (own.routes ?? []).length === 0, `${label}: it has no address; only Slate's binding reaches it`);
}

// Loads nothing but the counter's own rules, so a wake costs what the object needs.
{
  const allowed = new Set(["worker/burst-limiter/index.ts", "worker/burst-limiter.ts", "src/lib/rate-limit-burst.ts", "src/lib/log.ts"]);
  const { seen, foreign } = walkWorkerImports(join(import.meta.dirname, ".."), "worker/burst-limiter/index.ts", allowed);
  assert(foreign.length === 0, `the burst limiter Worker reaches only its own files (got ${foreign.join(", ")})`);
  assert(seen.has("src/lib/rate-limit-burst.ts"), "the walk did reach the counter's rules (positive control)");
}

finish();
