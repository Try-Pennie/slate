// Refuse a Worker bundle carrying settings that belong to a deployment (#2335).
//
// Runs as the second half of `pnpm cf:build`. Wrangler has no predeploy hook, so the
// build is the last place a single check can stand in front of a deploy, and it only
// stands there for a deploy that BUILDS THROUGH `cf:build`: the pre-push gate, CI's
// build leg, the load run's fault leg, and since #3078 `pnpm cf:deploy` (which the CI
// deploy job, DEPLOY.md and `cf:deploy:verified` all run). Until #3078 `cf:deploy`
// called the adapter's build directly, so the hand deploy this exists for skipped it.
// `scripts/test-bundle-env-guard.ts` now fails any package.json script that deploys
// without running this first. A bare `opennextjs-cloudflare build` or `wrangler
// deploy` typed at a prompt is still outside its reach.
//
// It reads `.open-next/cloudflare/next-env.mjs`, which the adapter writes from every
// `.env*` file in the build tree and which ships inside the bundle. The decision
// lives in `scripts/lib/scan-bundle-env.ts` and is driven by fixtures in
// `scripts/test-bundle-env-guard.ts`, because this half needs a real build to have
// run and that suite runs alongside one.
//
// Dependency free on purpose (no `@/` alias, no package import): it has to work in a
// tree where `pnpm install` has just run and nothing else is assumed.
//
// Escape hatch: `ALLOW_ENV_IN_BUNDLE=1` for ONE command, to get a local build out of
// a tree that holds `.env.local`. It is never right for a build about to be
// deployed, and it says so every time it is used. It covers BOTH questions below,
// deliberately rather than by accident (L448): they are one family, something from
// the deployment's environment appearing in a bundle, and a second variable would be
// a second thing to remember at the moment somebody is already stuck.
//
// Run: node --experimental-strip-types scripts/check-bundle-env.ts
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  ADAPTER_ENV_FILES,
  BUNDLE_ENV_PATH,
  CLIENT_ASSET_DIR,
  judgeBundleEnv,
  judgeClientAssets,
} from "./lib/scan-bundle-env.ts";
import { PRODUCTION_ONLY_SECRETS } from "../src/lib/loadtest-secrets.ts";

/** Every javascript file under a directory, read. */
function readJsFiles(dir: string): { path: string; text: string }[] {
  if (!existsSync(dir)) return [];
  const out: { path: string; text: string }[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...readJsFiles(p));
    else if (p.endsWith(".js") || p.endsWith(".mjs")) out.push({ path: p, text: readFileSync(p, "utf8") });
  }
  return out;
}

const source = existsSync(BUNDLE_ENV_PATH)
  ? readFileSync(BUNDLE_ENV_PATH, "utf8")
  : null;
const envFiles = ADAPTER_ENV_FILES.filter((f) => existsSync(f));

// Two questions, and neither answers the other. The first is whether a VALUE was
// baked into the bundle; the second is whether the browser chunks NAME a deployment
// setting, which is how a server only list ends up published (#2335). Both are
// reported, so one failing does not hide the other.
const verdicts = [
  judgeBundleEnv({ source, envFiles }),
  judgeClientAssets({
    files: readJsFiles(CLIENT_ASSET_DIR),
    names: PRODUCTION_ONLY_SECRETS,
  }),
];

const failed = verdicts.filter((v) => !v.ok);
if (failed.length === 0) {
  for (const v of verdicts) console.log(`bundle env: ${v.message}`);
  process.exit(0);
}

for (const v of failed) console.error(`\nBUILD REFUSED: ${v.message}\n`);

if (process.env.ALLOW_ENV_IN_BUNDLE === "1") {
  console.error(
    `ALLOW_ENV_IN_BUNDLE=1 is set, so the build is being allowed through. This bundle must not ` +
      `be deployed: it carries the settings named above and the runtime will apply every one the ` +
      `Worker's bindings do not set.\n`,
  );
  process.exit(0);
}

process.exit(1);
