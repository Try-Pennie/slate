// The rollback's decisions (#3094): which version to go back to, what it should report
// once it serves, and what each ending says.
//
// The target choice is the part that is easy to get wrong in a way that looks right.
// Since #3095 every release leaves THREE deployments behind (old at 100%, the 10/90
// split, new at 100%), so "the previous deployment" is the split, and the version
// beside the old one in it is a canary that runs no cron lane. Going back to it would
// restore the code and switch every cron lane off.
//
// Run: node --experimental-strip-types scripts/test-rollback-plan.ts
import {
  ROLLBACK_EXIT,
  chooseRollbackTarget,
  expectedCommitFor,
  isCanaryView,
  readDeploymentsList,
  readVersionView,
  runRollback,
  type RollbackOps,
} from "./lib/rollback-plan.ts";
import type { ProbeFault, ProbeOutcome } from "./lib/post-deploy-probe.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // two releases ago
const OLD = "11111111-1111-4111-8111-111111111111";
const CANARY = "22222222-2222-4222-8222-222222222222";
const NEW = "33333333-3333-4333-8333-333333333333";

const listJson = JSON.stringify([
  { created_on: "2026-10-01T10:00:00Z", versions: [{ version_id: A, percentage: 100 }] },
  { created_on: "2026-10-02T10:00:00Z", versions: [{ version_id: OLD, percentage: 100 }] },
  { created_on: "2026-10-03T10:00:00Z", versions: [{ version_id: CANARY, percentage: 10 }, { version_id: OLD, percentage: 90 }] },
  { created_on: "2026-10-03T10:02:00Z", versions: [{ version_id: NEW, percentage: 100 }] },
]);

// --- reading -------------------------------------------------------------------
{
  const list = readDeploymentsList(listJson);
  eq(list?.length, 4, "every deployment is read");
  eq(readDeploymentsList("[]"), null, "an empty list is unreadable, never 'nothing to roll back to'");
  eq(readDeploymentsList("nope"), null, "garbage is unreadable");
  // Wrangler sorts oldest first, but the plan must not depend on it.
  const shuffled = JSON.stringify(JSON.parse(listJson).reverse());
  eq(chooseRollbackTarget(readDeploymentsList(shuffled), "").kind, "target", "the order the list arrives in does not matter");
  const t = chooseRollbackTarget(readDeploymentsList(shuffled), "");
  eq(t.kind === "target" ? t.versionId : "", OLD, "and the newest deployment is still the one being left");
}

// --- the default target skips the split and its canary ---------------------------
{
  const t = chooseRollbackTarget(readDeploymentsList(listJson), "");
  assert(t.kind === "target", "a target is found");
  eq(t.kind === "target" ? t.versionId : "", OLD, "the default target is the last version that served 100% on its own, not the split before it");
  eq(t.kind === "target" ? t.current : "", `${NEW}@100%`, "and it records what it is leaving");
}
{
  // Positive control: had the split's versions been eligible, the canary would be a
  // candidate. A list whose ONLY earlier entry is a split has nothing to go back to.
  const onlySplit = JSON.stringify([
    { created_on: "2026-10-03T10:00:00Z", versions: [{ version_id: CANARY, percentage: 10 }, { version_id: OLD, percentage: 90 }] },
    { created_on: "2026-10-03T10:02:00Z", versions: [{ version_id: NEW, percentage: 100 }] },
  ]);
  eq(chooseRollbackTarget(readDeploymentsList(onlySplit), "").kind, "refuse", "a split is never a target, so with nothing else there is nothing to go back to");
}
{
  const t = chooseRollbackTarget(readDeploymentsList(listJson), A);
  eq(t.kind === "target" ? t.versionId : "", A, "a named version is honoured");
  eq(chooseRollbackTarget(readDeploymentsList(listJson), NEW).kind, "refuse", "naming the version already serving is refused");
  eq(chooseRollbackTarget(readDeploymentsList(listJson), "not-a-uuid").kind, "refuse", "a value that is not a version id is refused");
  eq(chooseRollbackTarget(null, "").kind, "refuse", "an unreadable list is refused");
  // The ending is carried as a typed field, never re-derived from the reason's wording
  // (L199): a reworded reason must not move a refusal between exit codes.
  const unreadable = chooseRollbackTarget(null, "");
  eq(unreadable.kind === "refuse" ? unreadable.why : "", "unreadable", "an unreadable list is the unreadable ending");
  const refused = chooseRollbackTarget(readDeploymentsList(listJson), NEW);
  eq(refused.kind === "refuse" ? refused.why : "", "refused", "naming the serving version is the refused ending");
  const noTarget = chooseRollbackTarget(readDeploymentsList(JSON.stringify([{ created_on: "x", versions: [{ version_id: NEW, percentage: 100 }] }])), "");
  eq(noTarget.kind === "refuse" ? noTarget.why : "", "refused", "nothing to go back to is refused, though it was read fine");
}
{
  // Rolling back FROM a split (a deploy died mid-way and the settle failed): the
  // current deployment is not one version, and the old side of it is a fine target.
  const fromSplit = JSON.stringify([
    { created_on: "2026-10-02T10:00:00Z", versions: [{ version_id: OLD, percentage: 100 }] },
    { created_on: "2026-10-03T10:00:00Z", versions: [{ version_id: CANARY, percentage: 10 }, { version_id: OLD, percentage: 90 }] },
  ]);
  const t = chooseRollbackTarget(readDeploymentsList(fromSplit), "");
  eq(t.kind === "target" ? t.versionId : "", OLD, "from a split, the version that served alone before it is the target, even though it is half of the split");
}

// --- the version view, and what it should report ------------------------------------
{
  const v = readVersionView(JSON.stringify({ id: OLD, annotations: { "workers/tag": "abc1234def56", "workers/message": "slate-release-abc1234def56" } }));
  eq(v?.tag, "abc1234def56", "the tag is read");
  eq(expectedCommitFor(v, ""), "abc1234def56", "a tagged version is expected to report its tag");
  const untagged = readVersionView(JSON.stringify({ id: OLD, annotations: {} }));
  eq(expectedCommitFor(untagged, ""), null, "an untagged version (one deployed before #3095) has no known commit");
  eq(expectedCommitFor(untagged, "0123456789abcdef"), "0123456789ab", "unless the operator supplies one");
  eq(expectedCommitFor(untagged, "main"), null, "and a supplied value that is not a commit is ignored, not stamped as one");
  eq(readVersionView("{}"), null, "a view with no id is unreadable");
}

// --- the run ----------------------------------------------------------------------
function outcome(fault: ProbeFault): ProbeOutcome {
  return { ok: fault === "none", fault, steps: [], summary: `fault ${fault}` };
}
interface Fake {
  list?: string | null;
  view?: string | null;
  rollback?: boolean;
  probe?: ProbeFault;
  requested?: string;
  commit?: string;
}
async function drive(f: Fake) {
  const calls: string[] = [];
  const ops: RollbackOps = {
    list: async () => {
      calls.push("list");
      return f.list === undefined ? listJson : f.list;
    },
    view: async (id) => {
      calls.push(`view:${id}`);
      return f.view === undefined
        ? JSON.stringify({ id, annotations: { "workers/tag": "abc1234def56", "workers/message": "slate-release-abc1234def56" } })
        : f.view;
    },
    rollback: async (id) => {
      calls.push(`rollback:${id}`);
      return f.rollback ?? true;
    },
    probe: async (commit) => {
      calls.push(`probe:${commit}`);
      return outcome(f.probe ?? "none");
    },
    log: () => {},
  };
  const result = await runRollback(ops, { requestedVersionId: f.requested ?? "", expectedCommit: f.commit ?? "" });
  return { result, calls };
}
{
  const r = await drive({});
  eq(r.result.exit, ROLLBACK_EXIT.rolledBack, "a rollback that serves the target's commit and passes the probe exits 0");
  eq(r.calls.join(" | "), ["list", `view:${OLD}`, `rollback:${OLD}`, "probe:abc1234def56"].join(" | "), "read, check the target, roll back, then probe for the TARGET's commit");
}
{
  const r = await drive({ view: JSON.stringify({ id: OLD, annotations: { "workers/tag": "abc1234def56", "workers/message": "slate-canary-abc1234def56" } }) });
  eq(r.result.exit, ROLLBACK_EXIT.refused, "a canary is refused as a target");
  assert(!r.calls.some((c) => c.startsWith("rollback")), "and nothing is rolled back");
  assert(r.result.message.includes("cron"), "the refusal says why: a canary runs no cron lane");
}
{
  const r = await drive({ list: null });
  eq(r.result.exit, ROLLBACK_EXIT.unreadable, "an unreadable deployment list is refused before anything changes");
  const named = await drive({ requested: NEW });
  eq(named.result.exit, ROLLBACK_EXIT.refused, "naming the serving version exits refused, not unreadable");
}
{
  eq(isCanaryView(readVersionView(JSON.stringify({ id: OLD, annotations: { "workers/message": "slate-canary-abc1234" } }))), true, "a canary is recognised by its annotation");
  eq(isCanaryView(readVersionView(JSON.stringify({ id: OLD, annotations: {} }))), false, "an unannotated version is not a canary");
  eq(isCanaryView(null), null, "an unreadable view is unknown, never 'not a canary'");
}
{
  const r = await drive({ view: null });
  eq(r.result.exit, ROLLBACK_EXIT.unreadable, "an unreadable target is refused before anything changes (it might be a canary)");
  assert(!r.calls.some((c) => c.startsWith("rollback")), "and nothing is rolled back");
}
{
  const r = await drive({ rollback: false });
  eq(r.result.exit, ROLLBACK_EXIT.rollbackFailed, "a failed rollback command is its own ending");
  assert(!r.calls.some((c) => c.startsWith("probe")), "and nothing is probed as if it had worked");
}
{
  const r = await drive({ probe: "release" });
  eq(r.result.exit, ROLLBACK_EXIT.probeFailed, "a target that fails its probe is its own ending: the old version is unhealthy too");
}
{
  const r = await drive({ probe: "version" });
  eq(r.result.exit, ROLLBACK_EXIT.probeFailed, "a target that never confirms is a failure too");
}
{
  const r = await drive({ probe: "fleet" });
  eq(r.result.exit, ROLLBACK_EXIT.fleetCondition, "a stale lane after a rollback is reported as the fleet's, under its own code");
}
{
  const r = await drive({ view: JSON.stringify({ id: OLD, annotations: {} }) });
  eq(r.result.exit, ROLLBACK_EXIT.unconfirmed, "an untagged target is rolled back (an emergency must not wait) but reported as unconfirmed");
  assert(r.calls.some((c) => c.startsWith("rollback")), "it did roll back");
  assert(!r.calls.some((c) => c.startsWith("probe")), "it did not pretend to confirm a commit it does not know");
}
{
  const r = await drive({ view: JSON.stringify({ id: OLD, annotations: {} }), commit: "fedcba9876543" });
  eq(r.result.exit, ROLLBACK_EXIT.rolledBack, "an operator supplied commit lets an untagged target be confirmed");
  assert(r.calls.includes("probe:fedcba987654"), "and the probe asks for that commit");
}
{
  const codes = Object.values(ROLLBACK_EXIT);
  eq(new Set(codes).size, codes.length, "no two rollback endings share an exit code");
}

finish();
