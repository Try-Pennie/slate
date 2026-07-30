// Post-deploy probe entry point (#1037).
//
// Run by the CI deploy job immediately after `pnpm cf:deploy`. Confirms the live
// site is serving the commit that was just deployed, then that it is healthy and
// that the booker's read path answers. Exits non-zero on failure, which fails the
// deploy job, which posts a Slack alert (.github/workflows/deploy-alert.yml). It
// does NOT roll back: it turns "broken for up to 30 minutes until the scheduled
// canary notices" into "broken and someone is told within a couple of minutes".
//
// All decision logic lives in scripts/lib/post-deploy-probe.ts so it is unit
// tested; this file is only I/O and wiring.
//
// Run: node --experimental-strip-types scripts/post-deploy-probe.ts
//   env: APP_URL, PROBE_COMMIT (or GITHUB_SHA), BOOKING_API_KEY, SMOKE_BUCKET
import {
  runProbe,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_VERSION_TIMEOUT_MS,
  type ProbeDeps,
} from "./lib/post-deploy-probe.ts";
import { normalizeCommit } from "./stamp-build-info.ts";

const appUrl = (process.env.APP_URL ?? "https://slate.trypennie.app").replace(/\/$/, "");
const key = process.env.BOOKING_API_KEY ?? "";
// Same env var name the existing smoke scripts use (scripts/smoke-create-resume.ts,
// scripts/smoke-booking-api.ts), so there is one name for one thing rather than a
// second convention to keep in sync. SMOKE is the isolated test bucket (#396), so
// this exercises the real read path without touching a real agent.
const bucket = process.env.SMOKE_BUCKET ?? "SMOKE";

if (!key) {
  // Fail loud, never a green skip: this runs only on a real deploy, so a missing
  // key means the probe verified nothing while reporting success (#766).
  console.error(
    "::error title=post-deploy probe cannot run::BOOKING_API_KEY is unset, so the deployed version could not be confirmed. Add it under Settings > Secrets and variables > Actions.",
  );
  process.exit(1);
}

const expectedCommit = normalizeCommit(process.env.PROBE_COMMIT ?? process.env.GITHUB_SHA);

const authed = { authorization: `Bearer ${key}` };

const deps: ProbeDeps = {
  // null means RETRY, not fail: during propagation the previous version answers,
  // and a transient network error here must not fail a good deploy.
  liveCommit: async () => {
    try {
      const res = await fetch(`${appUrl}/api/smoke/version`, { headers: authed });
      if (!res.ok) return null;
      const body = (await res.json()) as { commit?: unknown };
      return typeof body.commit === "string" ? body.commit : null;
    } catch {
      return null;
    }
  },
  health: async () => {
    try {
      const res = await fetch(`${appUrl}/api/health`);
      // The real contract (src/app/api/health/route.ts): `db` is the STRING
      // "ok" | "unreachable", not a boolean. Anything else maps to null, i.e.
      // "could not tell", so an unexpected shape never reads as healthy.
      const body = (await res.json().catch(() => ({}))) as { db?: unknown };
      const dbOk = body.db === "ok" ? true : body.db === "unreachable" ? false : null;
      return { status: res.status, dbOk };
    } catch {
      return { status: 0, dbOk: null };
    }
  },
  availability: async () => {
    try {
      const from = new Date().toISOString();
      const res = await fetch(
        `${appUrl}/api/availability?bucket=${encodeURIComponent(bucket)}&from=${encodeURIComponent(from)}`,
        { headers: authed },
      );
      const body = (await res.json().catch(() => ({}))) as { slots?: unknown };
      return { status: res.status, slotsPresent: Array.isArray(body.slots) && body.slots.length > 0 };
    } catch {
      return { status: 0, slotsPresent: false };
    }
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

const outcome = await runProbe(deps, {
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
