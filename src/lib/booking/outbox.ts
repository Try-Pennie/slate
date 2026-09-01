// Outbox executor + drain (#429 P2). The pure core that delivers a booking
// mutation's side effects idempotently with retry-until-complete. Producers
// (P3/P4) write a booking_outbox row at the mutation's atomic commit point; the
// dedicated /api/cron/outbox lane drains it. Both the inline happy path and the
// drain call the SAME runOutboxSteps, so a step runs at most once to completion
// regardless of which path gets there first.
//
// Relative ".ts" value import (not "@/") so this stays node-runnable for tests;
// the "@/" import below is type-only and erased by --experimental-strip-types.
import type { BookingDeps } from "./orchestration.ts";
import type { BookingOutbox } from "@/lib/db/types";
import { DRAIN_ALERT_AFTER } from "./drain-backoff.ts";
import type { OutboxWriteOutcome } from "./outbox-lease.ts";
import { mapWithConcurrency } from "../concurrency.ts";

// Bounded fan-out for the drain (AUD-062). Rows are leased independently, so
// draining them concurrently never double-runs a row; the cap keeps outbound
// side-effect calls (webhook send, calendar delete) under Cloudflare's
// simultaneous-connection ceiling. Matches the verify-on-book fan-out cap.
export const OUTBOX_DRAIN_CONCURRENCY = 8;

/** Performs one named side effect idempotently. Throws to mark the step failed
 *  (the drain retries it next pass); returns to mark it done. */
export type OutboxStepHandler = (deps: BookingDeps, row: BookingOutbox) => Promise<void>;
export type OutboxHandlers = Record<string, OutboxStepHandler>;

/** Why a row's run ended early, or null when it ran to the end (#1048). Named
 *  separately from the step outcomes because neither is the row's own fault and
 *  neither should count as a delivery attempt. */
export type OutboxRunStop = "lease-lost" | "write-failed";

export interface OutboxRunResult {
  delivered: boolean;
  ran: string[];
  failed: string[];
  /** Set when a lease-gated write told us to stop; null on a normal run. */
  stopped: OutboxRunStop | null;
}

/**
 * Run every not-`done` step of one outbox row. Each step is independently
 * idempotent, so re-running after a crash is safe; a `done` step is skipped, a
 * throwing step is marked failed (and recorded) without blocking the rest. The
 * row is marked delivered only when ALL steps are done. Pure over `deps` — the
 * caller owns leasing and passes the token it holds.
 *
 * Every write goes through that token (#1048), so the run STOPS the moment a write
 * reports the lease is gone. That is not a failure of this row: another holder owns
 * it and is running the same steps, so pressing on would mean two holders writing
 * whole steps arrays over each other, which is how a step that already ran gets
 * re-opened and a recorded failure text is erased.
 */
export async function runOutboxSteps(
  deps: BookingDeps,
  row: BookingOutbox,
  handlers: OutboxHandlers,
  lease: string,
): Promise<OutboxRunResult> {
  const ran: string[] = [];
  const failed: string[] = [];
  /** Maps a write's outcome to whether the run may continue. */
  const stopFor = (outcome: OutboxWriteOutcome): OutboxRunStop | null =>
    outcome === "written" ? null : outcome === "lease-lost" ? "lease-lost" : "write-failed";

  for (const step of row.steps) {
    if (step.state === "done") continue;
    const handler = handlers[step.name];
    if (!handler) {
      // A step with no handler must never count as success — it would silently
      // drop a side effect. Fail it so the row stays pending and is visible.
      step.state = "failed";
      step.error = `no handler for step "${step.name}"`;
      failed.push(step.name);
      const stop = stopFor(await deps.saveOutboxSteps(row.id, row.steps, lease));
      if (stop) return { delivered: false, ran, failed, stopped: stop };
      continue;
    }
    try {
      await handler(deps, row);
      step.state = "done";
      step.error = null;
      ran.push(step.name);
    } catch (err) {
      step.state = "failed";
      step.error = err instanceof Error ? err.message : String(err);
      failed.push(step.name);
    }
    // Persist progress after each step so a crash mid-row resumes from here. The
    // write is gated on this holder's lease, so the whole-array write can only ever
    // land while this really is the only holder.
    const stop = stopFor(await deps.saveOutboxSteps(row.id, row.steps, lease));
    if (stop) return { delivered: false, ran, failed, stopped: stop };
  }

  const allDone = row.steps.every((s) => s.state === "done");
  if (!allDone) return { delivered: false, ran, failed, stopped: null };

  // Declaring delivery is gated too: a stale holder whose steps all read done must
  // not close a row that a live holder still has work left on.
  const stop = stopFor(await deps.markOutboxDelivered(row.id, lease));
  if (stop) return { delivered: false, ran, failed, stopped: stop };
  return { delivered: true, ran, failed, stopped: null };
}

/**
 * Drain a batch of undelivered outbox rows (#429 P2). Each row is leased first
 * (a gated UPDATE, so a concurrent drain or the inline producer can't double-run
 * its steps); a row already leased elsewhere is skipped. The lease is released
 * in a finally so a crash mid-step doesn't strand the row past its lease TTL.
 */
export async function processBookingOutbox(
  deps: BookingDeps,
  limit: number,
  handlers: OutboxHandlers,
): Promise<{
  processed: number;
  delivered: number;
  skipped: number;
  /** Rows whose run stopped because a gated write said the lease was gone or the
   *  write failed (#1048). Counted apart from `skipped`, which is a row we never got
   *  the lease for at all: one means we never started, the other means we started and
   *  had to stand down, and a single number could not tell anybody which. */
  handedOff: number;
  stuck: BookingOutbox[];
}> {
  const rows = await deps.loadDrainableOutbox(limit);
  let delivered = 0;
  let skipped = 0;
  let handedOff = 0;
  const stuck: BookingOutbox[] = [];

  // Drain rows concurrently but bounded (AUD-062). Each row is leased before its
  // steps run, so a large backlog clears in far fewer ticks without two drains
  // ever double-running the same row. A row already leased elsewhere is skipped.
  await mapWithConcurrency(rows, OUTBOX_DRAIN_CONCURRENCY, async (row) => {
    const lease = await deps.leaseOutbox(row.id);
    if (!lease) {
      skipped++;
      return;
    }
    try {
      const res = await runOutboxSteps(deps, row, handlers, lease);
      if (res.delivered) {
        delivered++;
      } else if (res.stopped) {
        // Not this row's failure, so it must NOT count as a delivery attempt: bumping
        // attempts here would walk a healthy row toward the give-up cap on the
        // strength of somebody else holding it. It stays pending with its own lease
        // holder (or, on a write failure, its untouched backoff) and is picked up
        // again on a later tick.
        handedOff++;
      } else {
        // A step failed this pass (#445): bump attempts + record why, and let the
        // dep schedule the next retry with backoff so we don't re-hit the failing
        // step every tick. A row past the alert threshold is reported for a
        // throttled Slack alert; past the give-up cap the loader stops returning it.
        const attempts = row.attempts + 1;
        const lastError =
          row.steps
            .filter((s) => s.state === "failed")
            .map((s) => `${s.name}: ${s.error ?? "failed"}`)
            .join("; ") || "delivery incomplete";
        await deps.bumpOutboxAttempt(row.id, attempts, lastError);
        if (attempts >= DRAIN_ALERT_AFTER) {
          stuck.push({ ...row, attempts, last_error: lastError });
        }
      }
    } finally {
      // Gated on the token this holder wrote, so a run that overran its lease cannot
      // release the lease a second holder now owns (#1048).
      await deps.releaseOutboxLease(row.id, lease);
    }
  });

  return { processed: rows.length, delivered, skipped, handedOff, stuck };
}

/**
 * Did this drain tick actually MEASURE whether side effects are completing? (#1048)
 *
 * A row that stood down is charged no failed attempt, deliberately, so a tick where
 * every row the drain leased stood down learns nothing: it cannot reach the
 * attempt-cap alert, and it must not send that alert's all-clear either, which would
 * be a recovery notice off a signal that measured nothing (#1152).
 *
 * Pure, and the ONE place the comparison is made, so the alarm and the all-clear both
 * consult the same predicate rather than each rebuilding it (L144).
 *
 * A tick with nothing to drain, or one where every row was already leased elsewhere,
 * is NOT a stand-down: nothing was attempted, which is the normal quiet state.
 */
export function everyLeasedRowStoodDown(result: {
  processed: number;
  skipped: number;
  handedOff: number;
}): boolean {
  const leased = result.processed - result.skipped;
  return leased > 0 && result.handedOff === leased;
}
