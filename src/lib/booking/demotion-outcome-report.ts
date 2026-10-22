// The Slack line for a FINISHED demotion sweep (#3615).
//
// It used to go out from the hourly roster sync when the sweep was QUEUED, so it could only say
// "is moving 1 call", and on 2026-10-21 it said that for evaldez1's call that nobody was free to
// take. The every minute drain now calls this once per sweep, from the tick whose done flip
// landed (`drainBulkReassign`), so the line is written from how the calls actually settled.
import { summarizeBulkReassignItems } from "@/lib/booking/bulk-reassign";
import { readDemotionChange } from "@/lib/booking/demotion-plan";
import type { BulkReassignItemStatus, BulkReassignJob } from "@/lib/db/types";
import { demotionRerouteOutcomeInfo } from "@/lib/monitor/cron-alert-copy";

/** The reads and the send, injected so `scripts/test-demotion-outcome-report.ts` drives them. */
export interface DemotionOutcomeReportDeps {
  /** Every item of the sweep. Throws on a failed read: an empty list would say "None moved". */
  loadItemStatuses(jobId: string): Promise<{ status: BulkReassignItemStatus }[]>;
  /** The advisor, or null when no such user exists. Throws on a failed read. */
  loadAdvisor(userId: string): Promise<{ email: string; isTest: boolean } | null>;
  appUrl(): string;
  sendInfo(key: string, text: string): Promise<void>;
}

/** One key per advisor. Sweeps finish a tick apart, and under one shared key the info
 *  throttle would drop the second; one advisor's sweeps are at least an hour apart. */
export function demotionOutcomeKey(outUserId: string): string {
  return `demotion_reroute_moved:${outUserId}`;
}

/**
 * Say how a finished demotion sweep's calls settled. Every other kind of sweep says nothing and
 * reads nothing, and so does a test advisor's: the daily reroute drill sweeps one through this
 * same drain and reports its own verdict. Throws rather than sending a line built from a failed
 * read; the drain logs it.
 */
export async function reportDemotionSweepOutcome(
  job: BulkReassignJob,
  deps: DemotionOutcomeReportDeps,
): Promise<void> {
  if (job.demotion_marked_at == null) return;
  const [items, advisor] = await Promise.all([deps.loadItemStatuses(job.id), deps.loadAdvisor(job.out_user_id)]);
  if (advisor === null) throw new Error(`no user ${job.out_user_id} for demotion sweep ${job.id}`);
  if (advisor.isTest) return;
  const { counts } = summarizeBulkReassignItems(items);
  const url = `${deps.appUrl()}/admin/agents/${encodeURIComponent(job.out_user_id)}?job=${encodeURIComponent(job.id)}`;
  await deps.sendInfo(
    demotionOutcomeKey(job.out_user_id),
    demotionRerouteOutcomeInfo({ email: advisor.email, change: readDemotionChange(job.demotion_change), counts, url }),
  );
}
