// How a FINISHED demotion sweep (#3615) is recorded: which sweeps record it, and from which counts.
// It was a Slack whisper until 2026-10-23, when Dan turned it off ("you can log it but I don't need
// a slack message"): it never asked anybody to act, so it is now one log line and no post.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-demotion-outcome-report.ts
import { reportDemotionSweepOutcome, type DemotionOutcomeReportDeps } from "../src/lib/booking/demotion-outcome-report.ts";
import type { BulkReassignItemStatus, BulkReassignJob } from "../src/lib/db/types.ts";
import type { LogFields } from "../src/lib/log.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const change = { from: { debtTeam: ["medium", "low"], backendService: ["achieve"] }, to: { debtTeam: ["medium"], backendService: ["achieve"] } };

const demotionJob = {
  id: "job1",
  out_user_id: "u1",
  demotion_marked_at: "2026-10-21T22:00:41.490Z",
  demotion_change: change,
} as unknown as BulkReassignJob;

function deps(statuses: BulkReassignItemStatus[], over: Partial<DemotionOutcomeReportDeps> = {}) {
  const logged: LogFields[] = [];
  const reads: string[] = [];
  const d: DemotionOutcomeReportDeps = {
    loadItemStatuses: async (jobId) => {
      reads.push(`items:${jobId}`);
      return statuses.map((status) => ({ status }));
    },
    log: (fields) => {
      logged.push(fields);
    },
    ...over,
  };
  return { d, logged, reads };
}

// The module no longer offers a Slack sender at all, so nothing here can post.
{
  const { d } = deps(["moved"]);
  assert(!("sendInfo" in d), "the reporter takes no Slack sender");
}

// A demotion sweep logs how its calls settled, once, naming the advisor and the sweep by id.
{
  const { d, logged } = deps(["unplaceable"]);
  await reportDemotionSweepOutcome(demotionJob, d);
  eq(logged.length, 1, "a finished demotion sweep logs one line");
  eq(logged[0]?.out_user_id, "u1", "naming the advisor by id");
  eq(logged[0]?.job_id, "job1", "and the sweep by id");
  eq(logged[0]?.moved, 0, "with the moved count");
  eq(logged[0]?.unplaceable, 1, "and the calls nobody was free to take");
  eq(logged[0]?.from_tiers, "medium,low", "and what changed, read from the job's record");
  eq(logged[0]?.to_tiers, "medium", "both sides of it");
}

// The counts come from every item of the sweep, not only the ones the last tick touched.
{
  const { d, logged } = deps(["moved", "moved", "unplaceable"]);
  await reportDemotionSweepOutcome(demotionJob, d);
  eq(logged[0]?.total, 3, "every item is counted");
  eq(logged[0]?.moved, 2, "mixed outcomes are counted from the items");
}

// Every other sweep (time off, offboarding, Redistribute, an admin's) records nothing here, and reads nothing.
{
  const { d, logged, reads } = deps(["moved"]);
  await reportDemotionSweepOutcome({ ...demotionJob, demotion_marked_at: null } as BulkReassignJob, d);
  eq(logged.length + reads.length, 0, "a sweep that is not a demotion logs nothing and reads nothing");
}

// A change the job never recorded is logged as unknown, never as an empty tier list.
{
  const { d, logged } = deps(["moved"]);
  await reportDemotionSweepOutcome({ ...demotionJob, demotion_change: null } as BulkReassignJob, d);
  eq(logged[0]?.from_tiers, null, "an unrecorded change logs its tiers as unknown");
}

// A read that fails throws rather than logging counts built from nothing: an empty item list
// would read as nothing moved. The drain logs the throw.
{
  const { d, logged } = deps([], { loadItemStatuses: async () => { throw new Error("db down"); } });
  let threw = false;
  try {
    await reportDemotionSweepOutcome(demotionJob, d);
  } catch {
    threw = true;
  }
  assert(threw && logged.length === 0, "a failed item read throws and logs no counts");
}

finish();
