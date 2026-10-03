// Which Worker a deploy or rollback is about to touch, said out loud and refused when
// it is not the one the environment names (#3165).
//
// A rehearsal against the load test Worker differs from a production deploy by ONE
// environment variable. Drop it, and wrangler targets the top level config, which is
// production: the gradual deploy would then split real traffic, and the rollback would
// re-point it, with nothing saying so. So both commands resolve the target through
// wrangler's own config reader, print it, and refuse a mismatch, and under an
// environment every message names that Worker rather than saying "production".
//
// Run: node --experimental-strip-types scripts/test-wrangler-target.ts
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { judgeTarget, retarget } from "./lib/wrangler-target.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");

// --- the decision ------------------------------------------------------------------
{
  const prod = judgeTarget(undefined, { name: "slate", routes: [{ pattern: "slate.trypennie.app", custom_domain: true }] });
  assert(prod.ok && prod.production && prod.workerName === "slate", "no environment, Worker slate: production, allowed");
  const rehearsal = judgeTarget("loadtest", { name: "slate-loadtest", routes: [] });
  assert(rehearsal.ok && !rehearsal.production && rehearsal.workerName === "slate-loadtest", "the load test environment resolving to slate-loadtest with no routes is allowed");
}
{
  // The failure this exists for: an environment was meant, and what resolves is not it.
  const wrongName = judgeTarget("loadtest", { name: "slate", routes: [] });
  assert(!wrongName.ok, "an environment that resolves to the production Worker name is refused");
  const routed = judgeTarget("loadtest", { name: "slate-loadtest", routes: [{ pattern: "slate.trypennie.app", custom_domain: true }] });
  assert(!routed.ok, "a non-production environment holding a route is refused (it would claim a real address)");
  assert(!routed.ok && routed.reason.includes("slate.trypennie.app"), "and the refusal names the route");
  const prodWrong = judgeTarget(undefined, { name: "slate-loadtest", routes: [] });
  assert(!prodWrong.ok, "no environment resolving to anything but slate is refused");
  const unresolved = judgeTarget("loadtest", null);
  assert(!unresolved.ok, "a target that could not be resolved is refused, never assumed");
}

// --- the wording -------------------------------------------------------------------
{
  const t = judgeTarget("loadtest", { name: "slate-loadtest", routes: [] });
  const sample =
    "Not deploying: could not read which version production is serving. Production was already split. production may still be split.";
  const out = retarget(sample, t);
  assert(!/production/i.test(out), `under an environment no message says production (got ${JSON.stringify(out)})`);
  assert(out.includes("the slate-loadtest Worker") && out.includes("The slate-loadtest Worker"), "it names the Worker instead, with the capital kept");
  const p = judgeTarget(undefined, { name: "slate", routes: [] });
  eq(retarget(sample, p), sample, "in production the wording is unchanged");
}

// --- the resolver reads wrangler's own config, positive control both ways ----------
//
// The judgement above is only as good as what it is handed, so the resolver is run for
// real against the repo's wrangler.jsonc: the top level must resolve to slate with its
// route, and the load test environment to slate-loadtest with none.
function resolve(env: string | undefined) {
  const res = spawnSync("node", [join(ROOT, "scripts", "resolve-wrangler-target.mjs")], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, WRANGLER_ENV: env ?? "" },
  });
  try {
    return JSON.parse(res.stdout) as { name: string; routes: unknown[] };
  } catch {
    return null;
  }
}
{
  const top = resolve(undefined);
  eq(top?.name, "slate", "the top level config resolves to the production Worker");
  assert((top?.routes.length ?? 0) > 0, "with its route");
  const lt = resolve("loadtest");
  eq(lt?.name, "slate-loadtest", "the load test environment resolves to slate-loadtest");
  eq(lt?.routes.length, 0, "with no route");
  assert(judgeTarget("loadtest", lt).ok && judgeTarget(undefined, top).ok, "and both pass the judgement");
  assert(!judgeTarget("loadtest", top).ok, "positive control: the production resolution is refused for a load test run");
}

finish();
