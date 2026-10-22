// The Slack line for a FINISHED demotion sweep (#3615): which sweeps say it, under which key, and
// from which counts. It used to go out when the sweep was queued and said "is moving 1 call" for
// a call nobody was free to take (evaldez1, 2026-10-21); the drain now calls this once per sweep,
// from the tick whose done flip landed.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-demotion-outcome-report.ts
import { reportDemotionSweepOutcome, type DemotionOutcomeReportDeps } from "../src/lib/booking/demotion-outcome-report.ts";
import type { BulkReassignItemStatus, BulkReassignJob } from "../src/lib/db/types.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const change = { from: { debtTeam: ["medium", "low"], backendService: ["achieve"] }, to: { debtTeam: ["medium"], backendService: ["achieve"] } };

const demotionJob = {
  id: "job1",
  out_user_id: "u1",
  demotion_marked_at: "2026-10-21T22:00:41.490Z",
  demotion_change: change,
} as unknown as BulkReassignJob;

function deps(statuses: BulkReassignItemStatus[], over: Partial<DemotionOutcomeReportDeps> = {}) {
  const sent: { key: string; text: string }[] = [];
  const reads: string[] = [];
  const d: DemotionOutcomeReportDeps = {
    loadItemStatuses: async (jobId) => {
      reads.push(`items:${jobId}`);
      return statuses.map((status) => ({ status }));
    },
    loadAdvisor: async (userId) => {
      reads.push(`advisor:${userId}`);
      return { email: "evaldez1@trypennie.com", isTest: false };
    },
    appUrl: () => "https://slate.trypennie.app",
    sendInfo: async (key, text) => {
      sent.push({ key, text });
    },
    ...over,
  };
  return { d, sent, reads };
}

// A demotion sweep says how its calls settled, under its advisor's own key.
{
  const { d, sent } = deps(["unplaceable"]);
  await reportDemotionSweepOutcome(demotionJob, d);
  eq(sent.length, 1, "a finished demotion sweep sends one line");
  eq(sent[0]?.key, "demotion_reroute_moved:u1", "keyed by the advisor, so another advisor's sweep a tick later is not throttled away");
  assert(/None moved/.test(sent[0]?.text ?? "") && !/moving/.test(sent[0]?.text ?? ""), `it reports the settled counts (got: ${sent[0]?.text})`);
  assert((sent[0]?.text ?? "").includes("https://slate.trypennie.app/admin/agents/u1?job=job1"), "and links the sweep on the advisor's page");
  assert((sent[0]?.text ?? "").includes("Medium and Low to Medium"), "and what changed, read from the job's record");
}

// Every other sweep (time off, offboarding, Redistribute, an admin's) says nothing here, and reads nothing.
{
  const { d, sent, reads } = deps(["moved"]);
  await reportDemotionSweepOutcome({ ...demotionJob, demotion_marked_at: null } as BulkReassignJob, d);
  eq(sent.length + reads.length, 0, "a sweep that is not a demotion sends nothing and reads nothing");
}

// The daily reroute drill sweeps a test advisor every day through this same drain, so a test
// advisor's sweep says nothing: the drill reports its own verdict.
{
  const { d, sent } = deps(["moved"], { loadAdvisor: async () => ({ email: "smoketest@trypennie.com", isTest: true }) });
  await reportDemotionSweepOutcome(demotionJob, d);
  eq(sent.length, 0, "a test advisor's sweep (the daily drill) posts nothing");
}

// The counts come from every item of the sweep, not only the ones the last tick touched.
{
  const { d, sent } = deps(["moved", "moved", "unplaceable"]);
  await reportDemotionSweepOutcome(demotionJob, d);
  assert(/2 of 3 moved/.test(sent[0]?.text ?? ""), `mixed outcomes are counted from the items (got: ${sent[0]?.text})`);
}

// A read that fails throws rather than sending a line built from nothing: an empty item list
// would read as "None moved" and an unknown advisor as nobody. The drain logs the throw.
{
  const { d, sent } = deps([], { loadItemStatuses: async () => { throw new Error("db down"); } });
  let threw = false;
  try {
    await reportDemotionSweepOutcome(demotionJob, d);
  } catch {
    threw = true;
  }
  assert(threw && sent.length === 0, "a failed item read throws and sends nothing");
}
{
  const { d, sent } = deps(["moved"], { loadAdvisor: async () => null });
  let threw = false;
  try {
    await reportDemotionSweepOutcome(demotionJob, d);
  } catch {
    threw = true;
  }
  assert(threw && sent.length === 0, "an advisor who cannot be found throws and sends nothing");
}

finish();
