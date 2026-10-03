// Which Worker a deploy or rollback is about to touch (#3165). Pure, dependency free:
// the resolution itself (wrangler's own config reader) is scripts/resolve-wrangler-target.mjs.
//
// A rehearsal against the load test Worker differs from a production deploy by one
// environment variable. Dropping it makes wrangler target the top level config, which is
// production, with nothing saying so. So the target is resolved, printed, and refused
// when it is not the Worker the environment names.

import { WORKER_NAME, workerNameFor } from "./gradual-deploy.ts";

export interface ResolvedWorker {
  name: string;
  routes: unknown[];
}

export type TargetJudgement =
  | { ok: true; workerName: string; production: boolean; label: string }
  | { ok: false; reason: string };

/** Allow only the Worker the environment names: `slate` with no environment, and
 *  `slate-<env>` holding no route under one. */
export function judgeTarget(wranglerEnv: string | undefined, resolved: ResolvedWorker | null): TargetJudgement {
  const env = (wranglerEnv ?? "").trim();
  const expected = workerNameFor(env);
  if (resolved === null) {
    return { ok: false, reason: `could not resolve which Worker wrangler would target${env ? ` for env ${env}` : ""}` };
  }
  if (resolved.name !== expected) {
    return {
      ok: false,
      reason: env
        ? `WRANGLER_ENV=${env} should target the Worker ${expected}, and wrangler resolves ${resolved.name}`
        : `with no WRANGLER_ENV the target should be the production Worker ${WORKER_NAME}, and wrangler resolves ${resolved.name}`,
    };
  }
  if (env && resolved.routes.length > 0) {
    return {
      ok: false,
      reason: `WRANGLER_ENV=${env} resolves the Worker ${resolved.name} holding routes (${JSON.stringify(resolved.routes)}); a non-production environment must hold none, or it claims a real address`,
    };
  }
  return env
    ? { ok: true, workerName: resolved.name, production: false, label: `the ${resolved.name} Worker` }
    : { ok: true, workerName: resolved.name, production: true, label: `production (the ${resolved.name} Worker)` };
}

/** Under an environment, name its Worker wherever a message says "production". */
export function retarget(text: string, target: TargetJudgement): string {
  if (!target.ok || target.production) return text;
  return text
    .replace(/\bProduction\b/g, `The ${target.workerName} Worker`)
    .replace(/\bproduction\b/g, `the ${target.workerName} Worker`);
}
