/**
 * Every package.json script that DEPLOYS must run the bundle env guard first (#3078).
 *
 * `scripts/check-bundle-env.ts` refuses a Worker bundle carrying the values of the
 * `.env*` files in the build tree (#2335). It was wired into `cf:build` only, while
 * `cf:deploy`, which is what the CI deploy job, DEPLOY.md and `cf:deploy:verified`
 * all run, built with `opennextjs-cloudflare build` directly. So the one path the
 * guard was written for, a hand deploy from a checkout holding `.env.local`, was the
 * one path it never stood in front of, while its header said every path was covered.
 *
 * The rule is stated over the scripts rather than over `cf:deploy` by name, so a
 * second deploying script is covered by construction (L247). A script deploys when
 * it runs `opennextjs-cloudflare deploy` or `wrangler deploy`. It is guarded when an
 * EARLIER segment of the same `&&` chain runs the check, either directly or through
 * another script that is itself guarded. Only `&&` counts: after `;` or `||` the
 * deploy runs whether or not the guard passed, which is no guard at all.
 */

const DEPLOY = /\b(opennextjs-cloudflare|wrangler)\s+deploy\b/;
const GUARD = /\bcheck-bundle-env(\.ts)?\b/;
/** `pnpm cf:build`, `pnpm run cf:build`, `npm run cf:build`: one script calling another. */
const CALLS_SCRIPT = /\b(?:pnpm|npm|yarn)\s+(?:run\s+)?([\w:.-]+)/;

export interface UnguardedDeploy {
  script: string;
  command: string;
  reason: "no-guard-before-deploy" | "not-an-and-chain";
}

/** Whether running `name` runs the guard and fails the command when it fails. */
function runsGuard(scripts: Record<string, string>, name: string, seen: Set<string>): boolean {
  if (seen.has(name)) return false;
  seen.add(name);
  const cmd = scripts[name];
  if (cmd === undefined) return false;
  if (/;|\|\|/.test(cmd)) return false;
  // The guard must FOLLOW the build it reads, and the last segment that matters is
  // the guard itself, so any segment running it fails the chain when it fails.
  return cmd.split("&&").some((seg) => segmentRunsGuard(scripts, seg, seen));
}

function segmentRunsGuard(scripts: Record<string, string>, seg: string, seen: Set<string>): boolean {
  if (GUARD.test(seg)) return true;
  const call = seg.trim().match(CALLS_SCRIPT);
  if (call && call[1] !== "install" && call[1] !== "exec") {
    return runsGuard(scripts, call[1]!, new Set(seen));
  }
  return false;
}

export function unguardedDeployScripts(scripts: Record<string, string>): UnguardedDeploy[] {
  const out: UnguardedDeploy[] = [];
  for (const [name, command] of Object.entries(scripts)) {
    if (!DEPLOY.test(command)) continue;
    if (/;|\|\|/.test(command)) {
      out.push({ script: name, command, reason: "not-an-and-chain" });
      continue;
    }
    const segments = command.split("&&");
    const at = segments.findIndex((s) => DEPLOY.test(s));
    const guarded = segments
      .slice(0, at)
      .some((seg) => segmentRunsGuard(scripts, seg, new Set([name])));
    if (!guarded) out.push({ script: name, command, reason: "no-guard-before-deploy" });
  }
  return out;
}

/** The scripts that deploy, so a caller can prove the scan saw at least one. */
export function deployingScripts(scripts: Record<string, string>): string[] {
  return Object.entries(scripts)
    .filter(([, c]) => DEPLOY.test(c))
    .map(([n]) => n);
}
