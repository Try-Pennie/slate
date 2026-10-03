// Post-deploy probe entry point (#1037).
//
// Run by the hand deploy, `pnpm cf:deploy:verified` (scripts/deploy-verified.ts),
// right after its `pnpm cf:deploy`. The CI deploy job no longer runs this file: since
// #3095 its gradual deploy (scripts/deploy-gradual.ts) and the Rollback workflow
// (scripts/rollback-production.ts) run the SAME probe in process, through the shared
// reads in scripts/lib/post-deploy-probe-http.ts. Confirms the live site is serving
// the commit that was just deployed, then that it is healthy and that the booker's
// read path answers. Exits non-zero on failure. It does NOT roll back: it makes a bad
// hand deploy loud within a couple of minutes.
//
// All decision logic lives in scripts/lib/post-deploy-probe.ts so it is unit
// tested; this file is only I/O and wiring.
//
// Run: node --experimental-strip-types scripts/post-deploy-probe.ts
//   env: APP_URL, PROBE_COMMIT (or GITHUB_SHA), BOOKING_API_KEY_CANARY, SMOKE_BUCKET
import {
  runProbe,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_VERSION_TIMEOUT_MS,
} from "./lib/post-deploy-probe.ts";
import { httpProbeDeps } from "./lib/post-deploy-probe-http.ts";
import { normalizeCommit } from "./stamp-build-info.ts";

const appUrl = (process.env.APP_URL ?? "https://slate.trypennie.app").replace(/\/$/, "");
const key = process.env.BOOKING_API_KEY_CANARY ?? "";
// Same env var name the existing smoke scripts use (scripts/smoke-create-resume.ts,
// scripts/smoke-booking-api.ts), so there is one name for one thing rather than a
// second convention to keep in sync. SMOKE is the isolated test bucket (#396), so
// this exercises the real read path without touching a real agent.
// env-ok: SMOKE_BUCKET (a local override only; CI wants the seeded SMOKE bucket)
const bucket = process.env.SMOKE_BUCKET ?? "SMOKE";

if (!key) {
  // Fail loud, never a green skip: this runs only on a real deploy, so a missing
  // key means the probe verified nothing while reporting success (#766).
  console.error(
    "::error title=post-deploy probe cannot run::BOOKING_API_KEY_CANARY is unset, so the deployed version could not be confirmed. Add it under Settings > Secrets and variables > Actions.",
  );
  process.exit(1);
}

// env-ok: PROBE_COMMIT (a hand-run override for probing a commit other than the
//   one being deployed; in CI the runner's own GITHUB_SHA is the real input)
const expectedCommit = normalizeCommit(process.env.PROBE_COMMIT ?? process.env.GITHUB_SHA);

// The three reads live in one shared module so the gradual deploy (#3095) and the
// rollback (#3094) judge a deployment by exactly these requests.
const deps = httpProbeDeps({ appUrl, key, bucket, versionOverride: null });

const outcome = await runProbe(deps, {
  // env-ok: PROBE_TIMEOUT_MS (a hand-run tuning knob; CI wants the pinned default,
  //   so that how long a deploy is given to propagate is decided in the repo)
  // env-ok: PROBE_POLL_MS (same, the poll interval while it propagates)
  expectedCommit,
  versionTimeoutMs: Number(process.env.PROBE_TIMEOUT_MS ?? DEFAULT_VERSION_TIMEOUT_MS),
  pollIntervalMs: Number(process.env.PROBE_POLL_MS ?? DEFAULT_POLL_INTERVAL_MS),
});

for (const step of outcome.steps) {
  console.log(`${step.ok ? "ok" : "FAIL"}: ${step.name} (${step.detail})`);
}

if (!outcome.ok) {
  console.error(`::error title=post-deploy probe failed::${outcome.summary}`);
  process.exit(1);
}
console.log(`post-deploy probe passed: ${outcome.summary}`);
