// The gradual deploy's decisions (#3095): which percentage, when to promote, when to
// restore the old version, and that no path ever leaves production split.
//
// Every operation is a hand written fake that records what it was asked to do and
// keeps a simulated deployment, so the assertion that matters most is made against
// the STATE a run leaves behind rather than against the calls it happened to make:
// every combination of outcomes is driven, and each must end at 100% of one version
// or say, in its own exit code, that it could not.
//
// Run: node --experimental-strip-types scripts/test-gradual-deploy.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CANARY_PERCENT,
  CRON_STANDBY_VAR,
  EXIT,
  RESTORE_ATTEMPTS,
  SPLIT_BUDGET_MS,
  CRON_MARGIN_MS,
  cronFiresAt,
  cronsFromWranglerConfig,
  isFrequentCron,
  maxCronWaitMs,
  msUntilSplitWindowClear,
  overrideValue,
  planSettle,
  planStart,
  readDeploymentStatus,
  runGradualDeploy,
  splitSpecs,
  uploadArgs,
  readSplitRecords,
  settleDecision,
  versionIdFromUploadOutput,
  workerNameFor,
  type GradualOps,
  type GradualResult,
  type VersionShare,
} from "./lib/gradual-deploy.ts";
import type { ProbeFault, ProbeOutcome } from "./lib/post-deploy-probe.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");

const OLD = "11111111-1111-4111-8111-111111111111";
const CANARY = "22222222-2222-4222-8222-222222222222";
const RELEASE = "33333333-3333-4333-8333-333333333333";
const THEIRS = "44444444-4444-4444-8444-444444444444";

function outcome(fault: ProbeFault): ProbeOutcome {
  return {
    ok: fault === "none",
    fault,
    steps: [{ name: "serving the deployed commit", ok: fault !== "version", detail: fault }],
    summary: fault === "none" ? "every probe passed" : `fault ${fault}`,
  };
}

interface Scenario {
  start: VersionShare[] | null;
  canaryUpload: boolean;
  releaseUpload: boolean;
  split: boolean;
  canaryProbe: ProbeFault;
  promote: boolean;
  finalProbe: ProbeFault;
  triggers: boolean;
  /** How many restore calls fail before one succeeds (RESTORE_ATTEMPTS or more = all fail). */
  restoreFailures: number;
  /** What the version view says about cron standby; default: only CANARY is in standby. */
  standby?: Record<string, boolean | null>;
  /** An operation that THROWS rather than reporting failure. */
  throwAt?: "upload" | "probe:canary" | "promote" | "probe:promoted" | "triggers";
  /** How many restore calls THROW (rather than return false) before one works. */
  restoreThrows?: number;
  /** The split call reports failure but Cloudflare applied it anyway. */
  splitAppliesAnyway?: boolean;
  /** Somebody else (a rollback) puts this version at 100% during that step. */
  interfereDuring?: "upload" | "probe:canary";
}

const HAPPY: Scenario = {
  start: [{ versionId: OLD, percentage: 100 }],
  canaryUpload: true,
  releaseUpload: true,
  split: true,
  canaryProbe: "none",
  promote: true,
  finalProbe: "none",
  triggers: true,
  restoreFailures: 0,
};

interface Run {
  result: GradualResult;
  calls: string[];
  /** The deployment as the fake Cloudflare holds it at the end. */
  deployment: VersionShare[];
  probes: { stage: string; canaryId: string | null }[];
  restoreCalls: number;
  /** What the run recorded about the split, in order. */
  records: string[];
}

function parseSpecs(specs: string[]): VersionShare[] {
  return specs.map((s) => {
    const [versionId, pct] = s.split("@");
    return { versionId, percentage: Number(pct.replace("%", "")) };
  });
}

async function drive(s: Scenario): Promise<Run> {
  const calls: string[] = [];
  const probes: Run["probes"] = [];
  let deployment: VersionShare[] = s.start ?? [{ versionId: OLD, percentage: 100 }];
  let restoreCalls = 0;
  const records: string[] = [];
  const boom = (at: Scenario["throwAt"]) => {
    if (s.throwAt === at) throw new Error(`planted throw at ${at}`);
  };
  const ops: GradualOps = {
    status: async () => {
      // Recorded once, so the order assertions read the run's actions, not its re-reads.
      if (!calls.includes("status")) calls.push("status");
      return s.start === null ? null : deployment;
    },
    upload: async (kind) => {
      calls.push(`upload:${kind}`);
      boom("upload");
      if (s.interfereDuring === "upload") deployment = [{ versionId: THEIRS, percentage: 100 }];
      if (kind === "canary") return s.canaryUpload ? CANARY : null;
      return s.releaseUpload ? RELEASE : null;
    },
    deploy: async (specs) => {
      calls.push(`deploy:${specs.join(" ")}`);
      const next = parseSpecs(specs);
      const isRestore = next.length === 1 && next[0].versionId === OLD;
      const isSplit = next.length === 2;
      const isPromote = next.length === 1 && next[0].versionId !== OLD;
      if (isRestore) {
        restoreCalls++;
        if (restoreCalls <= (s.restoreThrows ?? 0)) throw new Error("planted restore throw");
        if (restoreCalls <= s.restoreFailures) return false;
      }
      if (isSplit && !s.split) {
        if (s.splitAppliesAnyway) deployment = next;
        return false;
      }
      if (isPromote) boom("promote");
      if (isPromote && !s.promote) return false;
      deployment = next;
      return true;
    },
    probe: async (stage, canaryId) => {
      calls.push(`probe:${stage}`);
      probes.push({ stage, canaryId });
      if (s.interfereDuring === `probe:${stage}`) deployment = [{ versionId: THEIRS, percentage: 100 }];
      boom(`probe:${stage}` as Scenario["throwAt"]);
      return outcome(stage === "canary" ? s.canaryProbe : s.finalProbe);
    },
    triggers: async () => {
      calls.push("triggers");
      boom("triggers");
      return s.triggers;
    },
    waitForCronWindow: async () => {
      calls.push("wait");
    },
    isCronStandby: async (id) => {
      const table = s.standby ?? { [CANARY]: true };
      return id in table ? table[id] : false;
    },
    record: (event) => {
      records.push(event);
    },
    log: () => {},
  };
  let result: GradualResult;
  try {
    result = await runGradualDeploy(ops);
  } catch (err) {
    // A throw before the split opens propagates (nothing changed); record it as such.
    result = { exit: -1, end: "unchanged", message: String(err) };
  }
  return { result, calls, deployment, probes, restoreCalls, records };
}

// --- the happy path, in order -------------------------------------------------
{
  const r = await drive(HAPPY);
  eq(r.result.exit, EXIT.promoted, "a release that passes at 10% and at 100% is promoted");
  eq(r.result.end, "new", "and ends on the new version");
  eq(
    r.calls.join(" | "),
    [
      "status",
      "upload:canary",
      "upload:release",
      "wait",
      `deploy:${CANARY}@10% ${OLD}@90%`,
      "probe:canary",
      `deploy:${RELEASE}@100%`,
      "probe:promoted",
      "triggers",
    ].join(" | "),
    "the order: read what serves, upload both, wait out the cron window, split 10/90, probe the canary, promote, probe, apply triggers",
  );
  eq(r.probes[0].canaryId, CANARY, "the canary probe is pinned to the CANARY version, by its id");
  eq(r.probes[1].canaryId, null, "the promotion probe is not pinned: it asks production as a whole");
  eq(JSON.stringify(r.deployment), JSON.stringify([{ versionId: RELEASE, percentage: 100 }]), "production ends on the release at 100%");
}

// --- what is promoted is never the canary ----------------------------------------
{
  const r = await drive(HAPPY);
  assert(
    !r.calls.some((c) => c === `deploy:${CANARY}@100%`),
    "the canary (which runs no cron lane) is never put at 100%; the release build without cron standby is",
  );
}

// --- refusals that change nothing --------------------------------------------------
{
  const r = await drive({ ...HAPPY, start: null });
  eq(r.result.exit, EXIT.unreadable, "an unreadable deployment is refused");
  eq(r.result.end, "unchanged", "and nothing changed");
  assert(!r.calls.some((c) => c.startsWith("upload") || c.startsWith("deploy")), "nothing was uploaded or deployed");
}
{
  const r = await drive({ ...HAPPY, canaryUpload: false });
  eq(r.result.exit, EXIT.uploadFailed, "a failed canary upload is its own ending");
  assert(!r.calls.some((c) => c.startsWith("deploy")), "and no deployment was touched");
  assert(r.result.message.includes("Durable Object"), "the message names the Durable Object migration case, which is the upload Cloudflare refuses by design");
}
{
  const r = await drive({ ...HAPPY, releaseUpload: false });
  eq(r.result.exit, EXIT.uploadFailed, "a failed release upload refuses before any split");
  assert(!r.calls.some((c) => c.startsWith("deploy")), "and no deployment was touched");
}

// --- the canary fails: the old version is restored, the release never ships ------
for (const fault of ["release", "version"] as const) {
  const r = await drive({ ...HAPPY, canaryProbe: fault });
  eq(r.result.exit, EXIT.canaryFailed, `a canary ${fault} fault ends at the canary`);
  eq(r.result.end, "old", "on the old version");
  eq(r.calls[r.calls.length - 1], `deploy:${OLD}@100%`, "the last thing it did was put the old version back at 100%");
  assert(!r.calls.includes(`deploy:${RELEASE}@100%`), "the release was never promoted");
  assert(!r.calls.includes("triggers"), "and the cron triggers were never touched");
}

// --- a stale lane is the fleet's, not the release's -------------------------------
{
  const r = await drive({ ...HAPPY, canaryProbe: "fleet" });
  eq(r.result.exit, EXIT.promoted, "a stale lane seen at 10% does not hold back a release that is otherwise clean (it may be the fix)");
}
{
  const r = await drive({ ...HAPPY, finalProbe: "fleet" });
  eq(r.result.exit, EXIT.promotedFleetCondition, "a stale lane at 100% fails the job, so somebody is told");
  eq(r.result.end, "new", "but the release stays: restoring the old version would not change a fact read from the shared database");
  assert(r.calls.includes("triggers"), "and the triggers are applied for the code that is serving");
}

// --- failures after the split -----------------------------------------------------
{
  const r = await drive({ ...HAPPY, finalProbe: "release" });
  eq(r.result.exit, EXIT.promotedFailed, "a release fault at 100% is its own ending");
  eq(r.result.end, "old", "and the old version is restored");
  assert(!r.calls.includes("triggers"), "the cron triggers are not applied for code that was rolled back");
}
{
  const r = await drive({ ...HAPPY, split: false });
  eq(r.result.exit, EXIT.splitFailed, "a split that could not be opened is its own ending");
  eq(JSON.stringify(r.deployment), JSON.stringify([{ versionId: OLD, percentage: 100 }]), "and production is whole on the old version");
  const applied = await drive({ ...HAPPY, split: false, splitAppliesAnyway: true });
  eq(applied.result.exit, EXIT.splitFailed, "a split call that failed but applied anyway is the same ending");
  eq(applied.calls[applied.calls.length - 1], `deploy:${OLD}@100%`, "and the restore it reads as needed is made");
  eq(JSON.stringify(applied.deployment), JSON.stringify([{ versionId: OLD, percentage: 100 }]), "so production is whole on the old version");
}

// --- somebody else changed production mid-run: never undo it -------------------------
//
// A rollback runs on its own and never waits for a deploy (DEPLOY.md). So the deploy
// re-reads what is serving before each change it makes, and stops, leaving production
// as it found it, when that is not a state this run produced.
for (const during of ["upload", "probe:canary"] as const) {
  const r = await drive({ ...HAPPY, interfereDuring: during });
  eq(r.result.exit, EXIT.interfered, `a change made by somebody else during ${during} stops the run`);
  eq(JSON.stringify(r.deployment), JSON.stringify([{ versionId: THEIRS, percentage: 100 }]), "and their change stands");
  assert(!r.calls.includes(`deploy:${RELEASE}@100%`), "the release is not promoted over it");
  assert(!r.calls.includes(`deploy:${OLD}@100%`), "and the old version is not restored over it");
  eq(r.records[r.records.length - 1] ?? "", during === "upload" ? "" : "ended", "and the settle step is told to leave it alone once a split was attempted");
}
{
  const r = await drive({ ...HAPPY, promote: false });
  eq(r.result.exit, EXIT.promoteFailed, "a failed promotion is its own ending");
  eq(r.result.end, "old", "on the old version");
}
{
  const r = await drive({ ...HAPPY, triggers: false });
  eq(r.result.exit, EXIT.triggersFailed, "a failed triggers call is its own ending");
  eq(r.result.end, "new", "and the code is NOT rolled back for it: it passed its probes and the call is safe to repeat");
}
{
  const r = await drive({ ...HAPPY, canaryProbe: "release", restoreFailures: 1 });
  eq(r.result.exit, EXIT.canaryFailed, "a restore that fails once and then succeeds still ends on the old version");
  eq(r.restoreCalls, 2, "it retried the restore");
}
{
  const r = await drive({ ...HAPPY, canaryProbe: "release", restoreFailures: 99 });
  eq(r.result.exit, EXIT.restoreFailed, "a restore that never succeeds is its own ending");
  eq(r.result.end, "unknown", "which says production may still be split");
  eq(r.restoreCalls, RESTORE_ATTEMPTS, `after ${RESTORE_ATTEMPTS} attempts`);
  assert(r.result.message.includes("Rollback workflow"), "and names the remedy");
}

// --- a split left behind by a run that died ----------------------------------------
{
  const r = await drive({
    ...HAPPY,
    start: [
      { versionId: CANARY, percentage: 10 },
      { versionId: OLD, percentage: 90 },
    ],
  });
  eq(r.calls[1], `deploy:${OLD}@100%`, "a leftover split is settled on its larger share before anything else");
  eq(r.result.exit, EXIT.promoted, "and the run then proceeds normally");
}

// --- a leftover split whose larger share is a cron standby canary is NOT healed ---
//
// Healing puts the larger share at 100%. If that share is a canary (uploaded in cron
// standby), healing would serve it to everyone with every cron lane switched off, so
// the run refuses instead and changes nothing.
{
  const split = [
    { versionId: CANARY, percentage: 90 },
    { versionId: OLD, percentage: 10 },
  ];
  const r = await drive({ ...HAPPY, start: split });
  eq(r.result.exit, EXIT.healRefused, "a leftover split led by a standby canary is refused");
  eq(r.result.end, "unchanged", "and nothing changed");
  assert(!r.calls.some((c) => c.startsWith("deploy") || c.startsWith("upload")), "no deploy or upload was attempted");
  const unknown = await drive({ ...HAPPY, start: [{ versionId: OLD, percentage: 90 }, { versionId: CANARY, percentage: 10 }], standby: { [OLD]: null } });
  eq(unknown.result.exit, EXIT.healRefused, "and so is one whose larger share cannot be read: it might be a canary");
}

// --- a THROW after the split opens is restored inside the run --------------------
//
// The settle step is a second line, not the first: a throw that escapes the run with
// the split open would leave production split until it runs, and not at all on a
// hand run. So anything thrown after the split call restores the old version itself.
for (const at of ["probe:canary", "promote", "probe:promoted", "triggers"] as const) {
  const r = await drive({ ...HAPPY, throwAt: at });
  if (at === "triggers") {
    // Promoted and probed: the new version is whole and correct; a throw from the
    // triggers call is the triggers ending, and the code is not rolled back for it.
    eq(r.result.exit, EXIT.triggersFailed, "a throw from the triggers call is the triggers ending");
    eq(r.result.end, "new", "and the passed release stays");
    continue;
  }
  eq(r.result.exit, EXIT.threw, `a throw at ${at} is its own ending`);
  eq(r.result.end, "old", "and the old version was restored");
  eq(JSON.stringify(r.deployment), JSON.stringify([{ versionId: OLD, percentage: 100 }]), `after a throw at ${at} production is whole on the old version`);
  assert(r.result.message.includes("planted throw"), "the message carries what was thrown");
}
{
  const r = await drive({ ...HAPPY, throwAt: "upload" });
  eq(r.result.exit, EXIT.threwBeforeSplit, "a throw before the split is caught into its own ending, never an unhandled rejection");
  eq(r.result.end, "unchanged", "and nothing changed");
  assert(r.result.message.includes("planted throw"), "the message carries what was thrown");
  assert(!r.records.includes("split-attempted"), "and nothing recorded a split");
}

{
  // A restore that itself throws counts as a failed attempt and is retried, rather
  // than escaping the run with the split standing.
  const r = await drive({ ...HAPPY, canaryProbe: "release", restoreThrows: 2 });
  eq(r.result.exit, EXIT.canaryFailed, "a restore that throws twice and then works still ends on the old version");
  eq(r.restoreCalls, 3, "each throw was a counted attempt");
  const never = await drive({ ...HAPPY, canaryProbe: "release", restoreThrows: 99 });
  eq(never.result.exit, EXIT.restoreFailed, "a restore that always throws is the restore-failed ending, not an escape");
}

// --- what the run records, which the settle step decides from ---------------------
{
  const ok = await drive(HAPPY);
  eq(ok.records.join(","), "split-attempted,ended", "a clean run records the split attempt, then that it ended whole");
  const refused = await drive({ ...HAPPY, canaryUpload: false });
  eq(refused.records.length, 0, "a run that never reached the split records nothing");
  const lost = await drive({ ...HAPPY, canaryProbe: "release", restoreFailures: 99 });
  eq(lost.records.join(","), "split-attempted", "a run whose restore failed does NOT record that it ended");
}
{
  eq(settleDecision(null).action, "none", "no record: the run never reached the split, so settle says nothing and reads nothing");
  eq(settleDecision(["split-attempted", "ended"]).action, "none", "a recorded clean end needs no settling");
  eq(settleDecision(["split-attempted"]).action, "read", "a split attempt with no recorded end is the only case that reads what is serving");
  eq(settleDecision([]).action, "none", "an empty record is the same as none");
  eq(settleDecision(["split-attempted", "ended", "split-attempted"]).action, "read", "the LAST event decides: a heal that ended, then a split that did not, reads");
}
{
  // A heal whose every restore fails records the attempt, so the settle step looks.
  const r = await drive({
    ...HAPPY,
    start: [{ versionId: OLD, percentage: 90 }, { versionId: CANARY, percentage: 10 }],
    restoreFailures: 99,
  });
  eq(r.result.exit, EXIT.restoreFailed, "a heal that never lands is the restore-failed ending");
  eq(r.records.join(","), "split-attempted", "and it recorded the attempt, so settle reads the deployment");
  const ok = await drive({ ...HAPPY, start: [{ versionId: OLD, percentage: 90 }, { versionId: CANARY, percentage: 10 }] });
  eq(ok.records.join(","), "split-attempted,ended,split-attempted,ended", "a successful heal and deploy record both, in order");
  eq(readSplitRecords(null), null, "no state file is no record");
  eq(readSplitRecords("split-attempted\n")?.join(","), "split-attempted", "a file with only the attempt reads as an open split");
  eq(settleDecision(readSplitRecords("split-attempted\nended\n")).action, "none", "and one carrying its end reads as nothing to settle");
  eq(readSplitRecords("garbage\nsplit-attempted")?.join(","), "split-attempted", "an unknown line is dropped, never guessed at");
}

// --- THE INVARIANT: every combination ends at 100% of one version, or says it could not
//
// Driven over the full product of outcomes rather than the handful above, because the
// path nobody wrote a case for is where a split is left standing (L517).
function endsWhole(d: VersionShare[]): boolean {
  return d.length === 1 && d[0].percentage === 100;
}
async function checkInvariant(runner: (s: Scenario) => Promise<Run>): Promise<string[]> {
  const faults: ProbeFault[] = ["none", "version", "release", "fleet"];
  const problems: string[] = [];
  for (const start of [HAPPY.start, null, [{ versionId: OLD, percentage: 90 }, { versionId: CANARY, percentage: 10 }]])
    for (const canaryUpload of [true, false])
      for (const releaseUpload of [true, false])
        for (const split of [true, false])
          for (const canaryProbe of faults)
            for (const promote of [true, false])
              for (const finalProbe of faults)
                for (const triggers of [true, false])
                  for (const restoreFailures of [0, 1, 99]) {
                    const s: Scenario = { start, canaryUpload, releaseUpload, split, canaryProbe, promote, finalProbe, triggers, restoreFailures };
                    const r = await runner(s);
                    const tag = JSON.stringify(s);
                    if (r.result.exit !== EXIT.restoreFailed && !endsWhole(r.deployment)) problems.push(`left split: ${tag}`);
                    if (r.deployment.some((d) => d.versionId === CANARY && d.percentage === 100)) problems.push(`canary at 100%: ${tag}`);
                    const servingNew = endsWhole(r.deployment) && r.deployment[0].versionId === RELEASE;
                    if (r.result.end === "new" && !servingNew) problems.push(`says new, is not: ${tag}`);
                    if ((r.result.end === "old" || r.result.end === "unchanged") && servingNew) problems.push(`says old, serves new: ${tag}`);
                    if (r.result.exit === EXIT.promoted && (canaryProbe === "version" || canaryProbe === "release")) problems.push(`promoted past a failed canary: ${tag}`);
                  }
  return problems;
}
{
  const problems = await checkInvariant(drive);
  assert(problems.length === 0, `every combination ends whole and says truthfully where it ended (${problems.length} problems: ${problems.slice(0, 3).join("; ")})`);
}
// Positive control: a runner that returns the moment the canary probe fails, without
// restoring, must be caught. An invariant checker that cannot fail proves nothing (L1).
{
  const broken = async (s: Scenario): Promise<Run> => {
    const r = await drive(s);
    if (s.canaryProbe === "release" && s.split && s.canaryUpload && s.releaseUpload && s.start !== null) {
      return { ...r, deployment: [{ versionId: CANARY, percentage: 10 }, { versionId: OLD, percentage: 90 }], result: { ...r.result, exit: EXIT.canaryFailed } };
    }
    return r;
  };
  const problems = await checkInvariant(broken);
  assert(problems.some((p) => p.startsWith("left split")), "the invariant check catches a run that leaves the split standing");
}

// --- the uploads ---------------------------------------------------------------
{
  const canary = uploadArgs("canary", "abc1234def56");
  const release = uploadArgs("release", "abc1234def56");
  assert(canary.join(" ").includes(`--var ${CRON_STANDBY_VAR}:1`), "the canary is uploaded in cron standby");
  assert(!release.join(" ").includes(CRON_STANDBY_VAR), "the release is NOT: it is the version that runs cron lanes once promoted");
  assert([...canary, ...release].every((a) => !/[\s'"]/.test(a)), "no argument needs quoting (the adapter joins them through a shell)");
  assert(canary.includes("abc1234def56") && release.includes("abc1234def56"), "both carry the commit as their tag, which the rollback reads");
  let threw = false;
  try {
    uploadArgs("release", "main; rm -rf /");
  } catch {
    threw = true;
  }
  assert(threw, "a value that is not a commit is refused rather than handed to a shell");
}
eq(
  versionIdFromUploadOutput(
    [
      '{"type":"wrangler-session","version":1}',
      "not json",
      `{"type":"version-upload","version":1,"worker_name":"slate","version_id":"${CANARY}"}`,
    ].join("\n"),
  ),
  CANARY,
  "the version id is read from wrangler's own output record",
);
eq(versionIdFromUploadOutput('{"type":"deploy","version_id":"x"}'), null, "no version-upload record means no id, never a guess");

// --- percentages and the override --------------------------------------------------
eq(CANARY_PERCENT, 10, "the canary takes 10% (Dan, 2026-10-03)");
eq(splitSpecs(OLD, CANARY).join(" "), `${CANARY}@10% ${OLD}@90%`, "the split puts the canary at 10% and the serving version at 90%");
{
  let threw = false;
  try {
    splitSpecs(OLD, OLD);
  } catch {
    threw = true;
  }
  assert(threw, "a split of a version with itself is refused");
}
eq(overrideValue(CANARY), `slate="${CANARY}"`, "the override header names the Worker and quotes the version id (an RFC 8941 dictionary)");
eq(workerNameFor(undefined), "slate", "production is the Worker named in wrangler.jsonc");
eq(workerNameFor("loadtest"), "slate-loadtest", "the load test environment is wrangler's <name>-<env>, which its override must name");
eq(overrideValue(CANARY, workerNameFor("loadtest")), `slate-loadtest="${CANARY}"`, "so the rehearsal's override is addressed to the load test Worker");

// --- reading the deployment ------------------------------------------------------
eq(
  JSON.stringify(readDeploymentStatus(JSON.stringify({ id: "d", versions: [{ version_id: OLD, percentage: 100 }] }))),
  JSON.stringify([{ versionId: OLD, percentage: 100 }]),
  "the status shape wrangler prints is read",
);
for (const bad of ["", "{}", '{"versions":[]}', '{"versions":[{"version_id":"nope","percentage":100}]}']) {
  eq(readDeploymentStatus(bad), null, `unreadable status (${JSON.stringify(bad)}) is null, never an empty deployment`);
}
eq(planStart([{ versionId: OLD, percentage: 50 }, { versionId: CANARY, percentage: 50 }]).kind, "refuse", "an even split has no serving version to restore, so it is refused");
eq(planSettle([{ versionId: OLD, percentage: 100 }]).action, "none", "settle does nothing on a whole deployment");
eq(
  JSON.stringify(planSettle([{ versionId: OLD, percentage: 90 }, { versionId: CANARY, percentage: 10 }])),
  JSON.stringify({ action: "deploy", specs: [`${OLD}@100%`] }),
  "settle puts a leftover split's larger share back at 100%",
);

// --- the cron window -------------------------------------------------------------
const crons = cronsFromWranglerConfig(readFileSync(join(ROOT, "wrangler.jsonc"), "utf8"));
assert(crons !== null && crons.length >= 10, `the crons are read from the real wrangler.jsonc (got ${crons?.length})`);
const real = crons ?? [];
eq(
  real.filter(isFrequentCron).sort().join(", "),
  ["* * * * *", "*/10 * * * *", "*/15 * * * *", "*/5 * * * *"].join(", "),
  "only the lanes that run at least every fifteen minutes may fall inside the split",
);
assert(!isFrequentCron("0 * * * *"), "the hourly roster sync is protected");
assert(!isFrequentCron("0 13 * * MON-FRI"), "a digest slot (exactly one of two fires) is protected");
assert(cronFiresAt("0 */6 * * *", Date.UTC(2026, 9, 3, 12, 0)), "a stepped hour field matches");
assert(!cronFiresAt("0 */6 * * *", Date.UTC(2026, 9, 3, 13, 0)), "and not off its step");
{
  const at = (h: number, m: number, s = 0) => Date.UTC(2026, 9, 5, h, m, s);
  eq(msUntilSplitWindowClear(at(10, 30), real), 0, "a quiet half hour opens at once");
  const w = msUntilSplitWindowClear(at(10, 57), real);
  eq(at(10, 57) + w, at(11, 0) + CRON_MARGIN_MS + 1, "just before the hour it waits until the hour's tick is out");
  const early = msUntilSplitWindowClear(at(2, 58), real);
  eq(at(2, 58) + early, at(3, 5) + CRON_MARGIN_MS + 1, "and it chains past the retention lane at 03:05 too");
}
// Property: from every start in a day, the window it picks contains no protected tick.
// Checked independently of the function, by enumerating the window's minutes directly.
function windowIsClear(startMs: number, cs: string[]): boolean {
  const protectedCrons = cs.filter((c) => !isFrequentCron(c));
  for (let m = Math.floor((startMs - CRON_MARGIN_MS) / 60_000) * 60_000; m <= startMs + SPLIT_BUDGET_MS; m += 60_000) {
    if (m + CRON_MARGIN_MS < startMs) continue;
    if (protectedCrons.some((c) => cronFiresAt(c, m))) return false;
  }
  return true;
}
{
  let bad = 0;
  const day = Date.UTC(2026, 9, 5);
  for (let s = 0; s < 86_400; s += 37) {
    const now = day + s * 1000;
    if (!windowIsClear(now + msUntilSplitWindowClear(now, real), real)) bad++;
  }
  eq(bad, 0, "from every start across a day, the chosen window holds no protected cron tick");
  assert(!windowIsClear(Date.UTC(2026, 9, 5, 10, 58), real), "positive control: a window across the hour IS detected as unclear");
}
const worst = maxCronWaitMs(real);
assert(worst > 0 && worst <= 20 * 60_000, `the longest wait any deploy can meet is bounded (${Math.round(worst / 1000)}s), and the deploy job's timeout is sized against it`);

// --- cron fields it cannot read mean "may fire" ---------------------------------------
{
  const at = (h: number, m: number) => Date.UTC(2026, 9, 5, h, m);
  assert(cronFiresAt("0-30/5 * * * *", at(9, 10)), "a stepped range fires on its step");
  assert(!cronFiresAt("0-30/5 * * * *", at(9, 11)), "and not off it");
  assert(!cronFiresAt("0-30/5 * * * *", at(9, 35)), "nor past the range");
  assert(cronFiresAt("0 1-5/2 * * *", at(3, 0)), "a stepped hour range fires on its step");
  assert(!cronFiresAt("0 1-5/2 * * *", at(4, 0)), "and not off it");
  assert(cronFiresAt("5/15 * * * *", at(9, 20)), "n/step runs from n to the end of the range");
  for (const odd of ["0 foo * * *", "L * * * *", "0 * * *", "@hourly"]) {
    assert(cronFiresAt(odd, at(9, 7)), `an expression it cannot read (${odd}) may fire at any minute`);
  }
  let threw = false;
  try {
    msUntilSplitWindowClear(at(9, 0), ["0 foo * * *"]);
  } catch {
    threw = true;
  }
  assert(threw, "a schedule it cannot read at all leaves no clear window, so the deploy refuses rather than guesses");
  assert(!isFrequentCron("0-30/5 * * * *"), "a stepped range is not one of the always-on lanes, so it is protected");
}

// --- the exit tables in DEPLOY.md list every ending ------------------------------------
{
  const doc = readFileSync(join(ROOT, "DEPLOY.md"), "utf8");
  const section = doc.slice(doc.indexOf("### What CI does: a gradual deploy"), doc.indexOf("### What the split looks like"));
  const rows = new Set([...section.matchAll(/^\| (\d+) \|/gm)].map((m) => Number(m[1])));
  const missing = Object.entries(EXIT).filter(([, code]) => !rows.has(code)).map(([name, code]) => `${name}=${code}`);
  eq(missing.join(", "), "", "every EXIT code has a row in DEPLOY.md's gradual deploy table");
  const extra = [...rows].filter((c) => !Object.values(EXIT).includes(c as never));
  eq(extra.join(", "), "", "and the table has no row for a code the deploy cannot exit with");
}

// --- exit codes: one ending, one number --------------------------------------------
{
  const codes = Object.values(EXIT);
  eq(new Set(codes).size, codes.length, "no two endings share an exit code");
  eq(EXIT.promoted, 0, "only a promoted, healthy release exits 0");
}

finish();
