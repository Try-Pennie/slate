// The record of a FINISHED demotion sweep (#3615): how its calls settled.
//
// It was a Slack whisper ("FYI, no action needed now") until 2026-10-23, when Dan turned it off:
// "you can log it but I don't need a slack message". Nothing about a settled sweep asks anybody to
// act (a call nobody could take is retried hourly and pages through coverage-needs-human if it never
// lands), so it is one log line, read from how the calls actually settled. The every minute drain
// calls this once per sweep, from the tick whose done flip landed (`drainBulkReassign`).
import { summarizeBulkReassignItems } from "@/lib/booking/bulk-reassign";
import { readDemotionChange } from "@/lib/booking/demotion-plan";
import type { BulkReassignItemStatus, BulkReassignJob } from "@/lib/db/types";
import type { LogFields } from "@/lib/log";

/** The read and the log, injected so `scripts/test-demotion-outcome-report.ts` drives them. */
export interface DemotionOutcomeReportDeps {
  /** Every item of the sweep. Throws on a failed read: an empty list would log nothing moved. */
  loadItemStatuses(jobId: string): Promise<{ status: BulkReassignItemStatus }[]>;
  log(fields: LogFields): void;
}

/**
 * Log how a finished demotion sweep's calls settled. Every other kind of sweep logs nothing and
 * reads nothing. Throws rather than logging counts built from a failed read; the drain logs it.
 */
export async function reportDemotionSweepOutcome(
  job: BulkReassignJob,
  deps: DemotionOutcomeReportDeps,
): Promise<void> {
  if (job.demotion_marked_at == null) return;
  const { total, counts } = summarizeBulkReassignItems(await deps.loadItemStatuses(job.id));
  const change = readDemotionChange(job.demotion_change);
  deps.log({
    msg: "demotion sweep settled",
    out_user_id: job.out_user_id,
    job_id: job.id,
    total,
    moved: counts.moved,
    unplaceable: counts.unplaceable,
    failed: counts.failed,
    skipped: counts.skipped,
    cancelled: counts.cancelled,
    from_tiers: change ? change.from.debtTeam.join(",") : null,
    to_tiers: change ? change.to.debtTeam.join(",") : null,
  });
}
