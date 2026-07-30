// Post-deploy probe logic (#1037).
//
// The probe fails the deploy job, and a failed job on a push to main posts a Slack
// alert (.github/workflows/deploy-alert.yml). So it has to be right in BOTH
// directions: it must catch a deploy that did not really go live, and it must not
// page on Cloudflare's normal propagation delay or on an empty slot list.
//
// Run: node --experimental-strip-types scripts/test-post-deploy-probe.ts
import {
  runProbe,
  waitForVersion,
  versionFailureDetail,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_VERSION_TIMEOUT_MS,
  type ProbeDeps,
} from "./lib/post-deploy-probe.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const SHA = "abc1234";

/** A fake clock that advances only when the code under test sleeps, so a 2-minute
 *  timeout is exercised without a 2-minute test. */
function clock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function deps(over: Partial<ProbeDeps> = {}): ProbeDeps {
  const c = clock();
  return {
    liveCommit: async () => SHA,
    health: async () => ({ status: 200, dbOk: true }),
    availability: async () => ({ status: 200, slotsPresent: true }),
    sleep: c.sleep,
    now: c.now,
    ...over,
  };
}

const cfg = {
  expectedCommit: SHA,
  versionTimeoutMs: DEFAULT_VERSION_TIMEOUT_MS,
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
};

// --- waitForVersion ----------------------------------------------------------
{
  const r = await waitForVersion(deps(), cfg);
  assert(r.matched && r.attempts === 1, "an already-live version matches on the first attempt");
}

// THE PROPAGATION CASE. The old version answers for a while, then the new one
// appears. This must be a PASS, or every deploy is a coin flip and the alert
// becomes noise.
{
  let n = 0;
  const r = await waitForVersion(
    deps({
      liveCommit: async () => {
        n++;
        return n < 4 ? "oldsha1" : SHA;
      },
    }),
    cfg,
  );
  assert(r.matched, "the new version appearing after several polls is a PASS, not a flake");
  eq(r.attempts, 4, "it kept polling until the new commit answered");
}

// The real failure: the upload succeeded but the old version keeps serving.
{
  const r = await waitForVersion(deps({ liveCommit: async () => "oldsha1" }), {
    ...cfg,
    versionTimeoutMs: 30_000,
  });
  assert(!r.matched, "a version that never changes is caught");
  eq(r.lastSeen, "oldsha1", "it remembers WHAT was serving, so the failure can say so");
  assert(r.attempts > 1, "it retried rather than giving up on one look");
}

// An unreachable endpoint is a different incident from a stale version, and the
// message must not conflate them (L11).
{
  const r = await waitForVersion(deps({ liveCommit: async () => null }), {
    ...cfg,
    versionTimeoutMs: 30_000,
  });
  assert(!r.matched && r.lastSeen === null, "an endpoint that never answers is caught");
  assert(
    versionFailureDetail(null, SHA, 3).includes("never answered"),
    "an unreachable endpoint reads as 'never answered', not as a stale version",
  );
  assert(
    versionFailureDetail("oldsha1", SHA, 3).includes("still serving oldsha1"),
    "a stale version names what IS serving and what was expected",
  );
}

// A zero timeout must still make one attempt. A probe that asks nothing and
// reports nothing is the failure mode this whole file exists to prevent.
{
  const r = await waitForVersion(deps({ liveCommit: async () => "oldsha1" }), {
    ...cfg,
    versionTimeoutMs: 0,
  });
  eq(r.attempts, 1, "a zero timeout still ASKS once rather than skipping the check");
  assert(!r.matched, "and still reports the mismatch");
}

// --- runProbe ----------------------------------------------------------------
{
  const r = await runProbe(deps(), cfg);
  assert(r.ok, "a healthy deploy of the expected commit passes");
  eq(r.steps.length, 3, "all three checks ran");
  assert(r.steps.every((s) => s.ok), "and all three passed");
}

// When the version never went live, health must NOT be judged: a 200 from the
// PREVIOUS version would credit this deploy with someone else's result.
{
  let healthCalls = 0;
  const r = await runProbe(
    deps({
      liveCommit: async () => "oldsha1",
      health: async () => {
        healthCalls++;
        return { status: 200, dbOk: true };
      },
    }),
    { ...cfg, versionTimeoutMs: 10_000 },
  );
  assert(!r.ok, "a version that never went live fails the probe");
  eq(healthCalls, 0, "health is NOT checked against the old version");
  assert(
    r.summary.includes("previous version"),
    "the summary says why health was not judged, so the reader is not left guessing",
  );
}

// A 503 from health is the signal it exists to give: the database is unreachable
// or a cron lane is dead.
{
  const r = await runProbe(deps({ health: async () => ({ status: 503, dbOk: false }) }), cfg);
  assert(!r.ok, "a 503 from health fails the probe");
  const step = r.steps.find((s) => s.name === "health endpoint");
  assert(step !== undefined && !step.ok, "the health step is the one marked failed");
  assert(
    String(step?.detail).includes("database unreachable"),
    "and it names the database as the cause when that is what health reported",
  );
}

// A broken availability read is the booker's hot path: a lead would see no times.
{
  const r = await runProbe(
    deps({ availability: async () => ({ status: 500, slotsPresent: false }) }),
    cfg,
  );
  assert(!r.ok, "a failing availability read fails the probe");
  assert(
    r.summary.includes("availability read path"),
    "the summary names which check failed, not just that something did",
  );
}

// THE NON-FLAKE ASSERTION. An empty slot list is normal: the isolated test agents
// can be fully booked or outside working hours. Asserting on it would page on a
// perfectly good deploy, and an alert that cries wolf gets ignored.
{
  const r = await runProbe(
    deps({ availability: async () => ({ status: 200, slotsPresent: false }) }),
    cfg,
  );
  assert(r.ok, "an EMPTY slot list on a 200 is not a failure (would be a false page)");
  const step = r.steps.find((s) => s.name === "availability read path");
  assert(
    String(step?.detail).includes("not asserted"),
    "and the report says the empty list was deliberately not asserted on",
  );
}

// Both downstream checks are reported even when the first of them fails, so one
// deploy failure does not hide a second problem behind it.
{
  const r = await runProbe(
    deps({
      health: async () => ({ status: 503, dbOk: false }),
      availability: async () => ({ status: 500, slotsPresent: false }),
    }),
    cfg,
  );
  eq(r.steps.length, 3, "every step is still reported");
  eq(r.steps.filter((s) => !s.ok).length, 2, "both failures are surfaced, not just the first");
}

// The defaults have to be sane on their own terms: long enough for a real
// propagation, short enough that a broken deploy is known about quickly.
// Sized from a MEASURED propagation, not a guess. The first real run (merge
// 81b6598, 2026-07-30) needed 10 polls, about 50s, for the new version to go live.
// The window must leave real headroom above that, because falling short fails a
// perfectly good deploy and pages someone, and a gate that cries wolf gets ignored
// (L36). Four minutes is roughly 5x the observed figure. The floor below is what
// stops a future edit quietly trimming it back under that margin.
assert(
  DEFAULT_VERSION_TIMEOUT_MS >= 4 * 60_000 && DEFAULT_VERSION_TIMEOUT_MS <= 600_000,
  "the version timeout keeps ~5x headroom over the ~50s propagation actually observed, without delaying detection beyond a few minutes",
);
// Enough polls that a slow propagation is sampled repeatedly rather than being
// decided by one or two unlucky checks.
assert(
  DEFAULT_VERSION_TIMEOUT_MS / DEFAULT_POLL_INTERVAL_MS >= 20,
  "the window allows at least 20 attempts, so the verdict never rests on a couple of samples",
);
assert(
  DEFAULT_POLL_INTERVAL_MS >= 1_000 && DEFAULT_POLL_INTERVAL_MS < DEFAULT_VERSION_TIMEOUT_MS,
  "the poll interval is neither a hot loop nor longer than the whole window",
);

finish();
