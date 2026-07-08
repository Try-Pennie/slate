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

/**
 * Run every not-`done` step of one outbox row. Each step is independently
 * idempotent, so re-running after a crash is safe; a `done` step is skipped, a
 * throwing step is marked failed (and recorded) without blocking the rest. The
 * row is marked delivered only when ALL steps are done. Pure over `deps` — the
 * caller owns leasing.
 */
export async function runOutboxSteps(
  deps: BookingDeps,
  row: BookingOutbox,
  handlers: OutboxHandlers,
): Promise<{ delivered: boolean; ran: string[]; failed: string[] }> {
  const ran: string[] = [];
  const failed: string[] = [];

  for (const step of row.steps) {
    if (step.state === "done") continue;
    const handler = handlers[step.name];
    if (!handler) {
      // A step with no handler must never count as success — it would silently
      // drop a side effect. Fail it so the row stays pending and is visible.
      step.state = "failed";
      step.error = `no handler for step "${step.name}"`;
      failed.push(step.name);
      await deps.saveOutboxSteps(row.id, row.steps);
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
    // Persist progress after each step so a crash mid-row resumes from here
    // (the row is leased, so no concurrent writer races this whole-array write).
    await deps.saveOutboxSteps(row.id, row.steps);
  }

  const delivered = row.steps.every((s) => s.state === "done");
  if (delivered) await deps.markOutboxDelivered(row.id);
  return { delivered, ran, failed };
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
  stuck: BookingOutbox[];
}> {
  const rows = await deps.loadDrainableOutbox(limit);
  let delivered = 0;
  let skipped = 0;
  const stuck: BookingOutbox[] = [];

  // Drain rows concurrently but bounded (AUD-062). Each row is leased before its
  // steps run, so a large backlog clears in far fewer ticks without two drains
  // ever double-running the same row. A row already leased elsewhere is skipped.
  await mapWithConcurrency(rows, OUTBOX_DRAIN_CONCURRENCY, async (row) => {
    const leased = await deps.leaseOutbox(row.id);
    if (!leased) {
      skipped++;
      return;
    }
    try {
      const res = await runOutboxSteps(deps, row, handlers);
      if (res.delivered) {
        delivered++;
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
      await deps.releaseOutboxLease(row.id);
    }
  });

  return { processed: rows.length, delivered, skipped, stuck };
}
