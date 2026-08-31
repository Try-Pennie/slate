/**
 * Who is accountable for the bookings a coverage sweep moves (#1241)?
 *
 * Every sweep before this one was started by a person in the admin coverage panel
 * or by whoever approved a time-off request, so `created_by` was always set and
 * the drain refused a job without it. That refusal is not bureaucracy: moving a
 * customer's appointment onto a different advisor is a customer-visible change,
 * and one nobody is recorded for cannot be explained afterwards.
 *
 * An offboarding sweep genuinely has no human actor. The offboarding automation
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

export type CoverageSweepActor =
  | { kind: "staff"; userId: string; actingAsUserId: string | null }
  | { kind: "system" };

export function coverageSweepActor(job: {
  created_by: string | null;
  acting_as_user_id: string | null;
  offboarding_deactivated_at: string | null;
}): CoverageSweepActor {
  if (job.created_by) {
    return { kind: "staff", userId: job.created_by, actingAsUserId: job.acting_as_user_id };
  }
  if (job.offboarding_deactivated_at) return { kind: "system" };
  throw new Error("bulk-reassign job has no accountable actor (created_by)");
}
