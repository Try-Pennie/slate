/**
 * Who is accountable for the bookings a coverage sweep moves (#1241)?
 *
 * Every sweep before this one was started by a person in the admin coverage panel
 * or by whoever approved a time-off request, so `created_by` was always set and
 * the drain refused a job without it. That refusal is not bureaucracy: moving a
 * customer's appointment onto a different advisor is a customer-visible change,
 * and one nobody is recorded for cannot be explained afterwards.
 *
 * An offboarding sweep genuinely has no human actor, and so does the hourly Twilio
 * redistribute flip (#2115). The offboarding automation
 * POSTs to the lifecycle endpoint and there is no person in the request at all, so
 * `created_by` is null on purpose, and the moves are recorded as `initiator:
 * "system"` exactly like the machine contact-owner reassign path already is.
 *
 * The distinction that matters, and the reason this is a function rather than a
 * `?? "system"` at the call site: "no actor because the automation did it" and "no
 * actor because one was lost" are the same null. Only `offboarding_deactivated_at`
 * tells them apart, so the refusal still stands for every job that cannot say why
 * it has nobody (L93, L11).
 */
import type { ValidatedReason } from "@/lib/booking/core";

export type CoverageSweepActor =
  | { kind: "staff"; userId: string; actingAsUserId: string | null }
  | { kind: "system" };

export function coverageSweepActor(job: {
  created_by: string | null;
  acting_as_user_id: string | null;
  offboarding_deactivated_at: string | null;
  redistribute_marked_at?: string | null;
  demotion_marked_at?: string | null;
}): CoverageSweepActor {
  if (job.created_by) {
    return { kind: "staff", userId: job.created_by, actingAsUserId: job.acting_as_user_id };
  }
  if (job.offboarding_deactivated_at) return { kind: "system" };
  // #2115: the Twilio redistribute flip is the second automation with nobody in the
  // request. It records WHY it has no actor the same way, through its own cause
  // column, so the refusal below still stands for a job that cannot say.
  if (job.redistribute_marked_at) return { kind: "system" };
  // #3582: the Twilio tier/backend demotion is the third. Same system initiator, its own cause
  // column, so the refusal still stands for a job that records no reason for its missing actor.
  if (job.demotion_marked_at) return { kind: "system" };
  throw new Error("bulk-reassign job has no accountable actor (created_by)");
}

/**
 * Why the moves a coverage sweep makes are recorded (#1643).
 *
 * The other half of what a move is recorded with, beside who made it, and refused
 * on the same grounds: a customer's appointment moved for no recorded reason cannot
 * be explained afterwards. It lived as a single line inside the drain's dependency
 * object, which nothing exports, so no test could reach it and deleting it changed
 * nothing any suite could see. It is here so one can (the pattern above, #1241).
 *
 * Structural only, deliberately. The code was validated against the reason options
 * when the job was ENQUEUED, and re-validating it here against the live option set
 * (which degrades to coded defaults on a transient read error) would fail a
 * legitimate, already approved move and burn its retries (#346). What is refused is
 * a job that carries no code at all, a blank one included.
 */
export function coverageSweepReason(job: {
  reason_code: string | null;
  reason_detail: string | null;
}): ValidatedReason {
  const code = (job.reason_code ?? "").trim();
  if (!code) throw new Error("bulk-reassign job has no reason code");
  return { code, detail: job.reason_detail ?? null };
}
