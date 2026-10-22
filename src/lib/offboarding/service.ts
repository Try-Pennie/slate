import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { log } from "@/lib/log";
import { startBulkReassign } from "@/lib/booking/service";
import { planLifecycleChange, type LifecycleAction } from "@/lib/offboarding/plan";
import { writeRoutableState } from "@/lib/bookable/routable-write";
import { planOffboardingCoverageSweep, type OffboardingSweepPlan } from "@/lib/offboarding/coverage-trigger";
import { clearInvitesForLeaver } from "@/lib/offboarding/clear-invites-io";
import type { ClearInvitesResult } from "@/lib/offboarding/clear-invites";
import {
  revokeSupabaseSessions,
  restoreSupabaseSessions,
  type SessionRevokeOutcome,
} from "@/lib/auth/session-revoke";

/**
 * What the automatic coverage sweep did on this call (#1241).
 *
 * `failed` is reported rather than thrown: see the enqueue below for why, and for
 * what makes the failure visible to a person.
 */
export type CoverageSweepOutcome = "queued" | "none" | "failed";

/**
 * What happened to the person's ability to hold a Supabase session (#2378).
 *
 * `failed` is reported rather than thrown, for the same reason `coverageSweep`
 * is, and the argument is below at `withSessionAccess`. What must never happen is
 * a call reporting nothing at all, because then a caller recording "deactivated"
 * is recording that access was removed on the strength of a write that only
 * stamped a row (L397).
 */
export type SessionRevokeResult = SessionRevokeOutcome | "failed";

/**
 * What clearing the departed advisor's invites did before the sweep (#3667): the
 * counts, or `failed` when the bookings could not even be read. Reported rather
 * than thrown, for the reason `coverageSweep` is: the deactivation must stand.
 */
export type InvitesClearedResult = ClearInvitesResult | "failed";

export type LifecycleResult =
  | { status: "not_found" }
  | {
      status: "noop";
      userId: string;
      invitesCleared?: InvitesClearedResult;
      coverageSweep?: CoverageSweepOutcome;
      sessionRevoke?: SessionRevokeResult;
    }
  | {
      status: "applied";
      userId: string;
      deactivate: boolean;
      invitesCleared?: InvitesClearedResult;
      coverageSweep?: CoverageSweepOutcome;
      sessionRevoke?: SessionRevokeResult;
      /**
       * #2386: this reactivation met a departed row still marked bookable and
       * cleared it. Present only when it happened, so the ordinary return reads as
       * ordinary and this one carries a fact somebody can act on.
       */
      clearedStaleBookable?: true;
    };

/** The lifecycle change plus the facts only the writer knows: the row's
 *  `deactivated_at` after the call, which is what the coverage sweep is keyed on. */
interface LifecycleOutcome {
  result: LifecycleResult;
  userId: string | null;
  deactivatedAtIso: string | null;
}

/**
 * Deactivate or reactivate a user by email (#264/#265), and, on a deactivation,
 * move the appointments they still hold (#1241).
 *
 * This is the OFFBOARDING AUTOMATION's path: the only callers are the bearer-key
 * gated lifecycle endpoints (`/api/users/deactivate`, `/api/users/reactivate`,
 * `/api/users/lifecycle`). Nobody is present in those requests, so there is no
 * decision to put in front of anyone and the sweep runs on its own.
 *
 * The admin UI deactivates through `applyLifecycleByUserId` below, which sweeps
 * only when the admin ASKED it to (#2124): there is a person right there, so the
 * confirm puts the question to them rather than deciding on their behalf in
 * either direction. Both paths run this same function, so the window, the
 * idempotency key, the failure handling and the reported outcome are the same
 * whichever way an agent leaves.
 *
 * Idempotent: the write to apply is decided by the pure `planLifecycleChange` from
 * the current row, and the write itself is a compare-and-swap, so a retrying (or
 * concurrent) offboarding automation is harmless. Deactivate SETS
 * `deactivated_at`; reactivate CLEARS it. The row is never deleted, so history
 * (bookings, OOO) and a future rehire stay intact.
 */
export async function applyLifecycleByEmail(
  email: string,
  action: LifecycleAction,
): Promise<LifecycleResult> {
  const db = supabaseAdmin();
  // Exact match, consistent with every other user-by-email lookup in the app
  // (booking/service.ts, provision.ts). NOT ilike: ilike would treat `_`/`%` in
  // the address as wildcards and could resolve the WRONG user, dangerous for a
  // deactivate call.
  const data = unwrap(
    await db
      // cap-safe: an exact-email lookup returns at most one row.
      .from("users")
      .select("id, deactivated_at, auth_user_id, bookable")
      .eq("email", email.trim())
      .maybeSingle(),
    "offboarding-lookup-by-email",
  );
  const outcome = await flipLifecycle(data as LifecycleRow | null, action);
  return withAutomaticCoverage(outcome, action);
}

/**
 * Same idempotent flip, keyed by user id, for the admin UI action (#278) where
 * the caller already has the row's id (RBAC-checked). Shares `flipLifecycle`
 * with the by-email path so both write identically.
 *
 * THE COVERAGE SWEEP IS THE CALLER'S CHOICE (#2124), and the recorded reason it
 * used to be refused here is answered rather than deleted.
 *
 * #1241 wrote: "Deliberately no automatic coverage sweep. An admin deactivating on
 * the agent page has the coverage panel one click away and is asked to confirm,
 * and that confirm step is the whole reason the automation path may skip it. Do
 * not consolidate the sweep into `flipLifecycle`: it would silently start moving
 * customers' appointments out from under an admin who was only pausing somebody."
 *
 * The objection was about SILENCE, not about the sweep, and the cost of leaving it
 * was real: deactivating an agent who held upcoming calls left those customers
 * with an advisor who had left, until somebody noticed and opened the coverage
 * panel by hand, and nothing on any screen said so.
 *
 * Dan settled it on 2026-09-09: "can we add a warning asking if they'd like to
 * sweep? that way it's a deliberate choice". So the confirm ASKS, and a press that
 * asks is not silent. The "only pausing somebody" case is also a different control
 * (Not bookable under Access), which the panel already points at.
 *
 * The flag DEFAULTS TO NOT SWEEPING, and that is the load-bearing part. A default
 * of true would make every existing caller start moving customers' appointments
 * the moment this shipped, which is precisely the silent change the comment above
 * refused. A caller has to say so.
 */
export interface LifecycleOptions {
  /**
   * Move the departed agent's remaining appointments, because somebody chose to.
   * Ignored on reactivate, where `planOffboardingCoverageSweep` refuses anyway.
   */
  sweepCoverage?: boolean;
}

export async function applyLifecycleByUserId(
  userId: string,
  action: LifecycleAction,
  options: LifecycleOptions = {},
): Promise<LifecycleResult> {
  const data = unwrap(
    await supabaseAdmin()
      // cap-safe: single-row primary-key lookup.
      .from("users")
      .select("id, deactivated_at, auth_user_id, bookable")
      .eq("id", userId)
      .maybeSingle(),
    "offboarding-lookup-by-id",
  );
  const outcome = await flipLifecycle(data as LifecycleRow | null, action);
  // The SAME function the automation path uses, so the window, the idempotency
  // key, the failure handling and the reported outcome cannot differ between the
  // two ways an agent leaves (L41). Two copies of "what happens to their
  // appointments" would drift, and the drift would be invisible on both sides.
  return options.sweepCoverage ? withAutomaticCoverage(outcome, action) : outcome.result;
}

type LifecycleRow = {
  id: string;
  deactivated_at: string | null;
  /** #2378: the Supabase auth user whose sessions are revoked or restored. Null
   *  for somebody who has never signed in, which is not a failure. */
  auth_user_id: string | null;
  /**
   * #2386: read so a reactivation can SAY it had to clear a flag a departed row
   * should never have been carrying. The write clears it either way; this is only
   * how the caller learns it was there, and a row written before the reap shared
   * the lifecycle write is the only way it can be.
   */
  bookable?: boolean | null;
};

/**
 * The lifecycle change, then the person's Supabase session access (#2378).
 *
 * WHY IT RUNS ON A NO-OP TOO, which is the part worth understanding. The row
 * write and the auth call are two steps with no transaction between them, so a
 * crash or a transient failure in the gap leaves the row stamped and the session
 * alive. A retry then sees a no-op flip: if the revoke only ran on the
 * TRANSITION, that session would stay alive for ever while every retry reported
 * success. Running it whenever the END STATE holds is the same convergence
 * `withAutomaticCoverage` chose below, and the call is idempotent, so the repeat
 * costs one write.
 *
 * The end state is decided by the ACTION, not by which branch got here: past
 * `not_found`, both `applied` and `noop` mean the state the action asked for now
 * holds, whoever wrote it.
 *
 * WHY A FAILURE DOES NOT ROLL THE DEACTIVATION BACK. Rolling it back would put
 * the agent back in the routing pool taking NEW bookings to report a session
 * problem, which is strictly worse, and it is the ordering #1237 and #1241 chose
 * for the same shape. It also would not help: the app layer gate refuses a
 * deactivated person's session on their very next request whether or not this
 * call succeeded, so the row write is the control that closes the hole and this
 * is the one that stops them minting new tokens.
 *
 * WHAT IT IS NOT ALLOWED TO DO is report success. A failure is:
 *
 *   - returned to the caller as `sessionRevoke: "failed"`, so the offboarding
 *     automation's own run holds the fact and the API response carries it;
 *   - logged at error level with the user and the Error, so it is in the Worker
 *     logs under `tag=offboarding`;
 *   - converged by a retry of the same call, per the no-op rule above.
 */
async function withSessionAccess(
  outcome: LifecycleOutcome,
  authUserId: string | null,
  action: LifecycleAction,
): Promise<LifecycleOutcome> {
  if (outcome.result.status === "not_found") return outcome;
  try {
    const sessionRevoke =
      action === "deactivate"
        ? await revokeSupabaseSessions(authUserId)
        : await restoreSupabaseSessions(authUserId);
    return { ...outcome, result: { ...outcome.result, sessionRevoke } };
  } catch (e) {
    log.error(
      "offboarding",
      { msg: "session access change failed", user_id: outcome.userId, action },
      e,
    );
    return { ...outcome, result: { ...outcome.result, sessionRevoke: "failed" } };
  }
}

/**
 * The shared decision + write: plan from the current row (idempotent), then
 * stamp/clear `deactivated_at` only when a change is due.
 *
 * Fails loud on the write. `status: "applied"` is a claim every caller believes:
 * the admin page repaints the agent as deactivated, and the offboarding automation
 * records the offboarding as finished and never looks again, while the agent keeps
 * taking bookings. A swallowed update error made that claim off a write that never
 * happened, and both callers already surface a throw (the server action shows the
 * message, the API route returns a 500).
 */
async function flipLifecycle(
  user: LifecycleRow | null,
  action: LifecycleAction,
): Promise<LifecycleOutcome> {
  const outcome = await writeLifecycle(user, action);
  return withSessionAccess(outcome, user?.auth_user_id ?? null, action);
}

async function writeLifecycle(
  user: LifecycleRow | null,
  action: LifecycleAction,
): Promise<LifecycleOutcome> {
  const plan = planLifecycleChange(user, action);
  if (plan.status === "not_found") {
    return { result: { status: "not_found" }, userId: null, deactivatedAtIso: null };
  }
  if (plan.status === "noop") {
    return {
      result: { status: "noop", userId: user!.id },
      userId: user!.id,
      deactivatedAtIso: user!.deactivated_at,
    };
  }

  // WHICH COLUMNS EACH DIRECTION MOVES lives in `lifecycle-write.ts` (#1324,
  // #2386), with the whole argument for the rule. In short: departing clears
  // `bookable` in the SAME statement that stamps `deactivated_at`, and returning
  // writes it false rather than leaving it, so re-entry to the routing pool always
  // goes through the activation gate.
  //
  // #1241: the write is a COMPARE-AND-SWAP, matched on the state the plan was made
  // from, not a blind update. Two offboarding calls in flight at once both read an
  // active row and both plan a deactivation; Postgres serializes the two updates on
  // the row, so the second re-evaluates the filter after the first commits and
  // matches nothing. Exactly one caller performs the transition, so `deactivated_at`
  // records when they actually left rather than whenever the last retry happened,
  // and the coverage sweep keyed on that stamp cannot be enqueued twice under two
  // different keys.
  //
  // #2085: the write itself is `writeRoutableState`, the one helper that owns
  // every write to `bookable` and `deactivated_at`, because a departure is one of
  // the changes Regal has to hear about (the trait telling it whether Slate can
  // route to this person) and the helper sends that from inside the write. It
  // throws on a refused write, which is what this function has always done.
  const stampIso = new Date().toISOString();
  let written;
  try {
    written = await writeRoutableState(
      plan.deactivate
        ? { kind: "depart", userIds: [user!.id], stampIso }
        : { kind: "return", userId: user!.id },
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`offboarding ${action} failed for user ${user!.id}: ${detail}`);
  }
  const changed = written.length > 0;
  if (!changed) {
    // Somebody else got there first, between the read and the write. The desired
    // end state holds either way, so this is the same no-op a sequential retry
    // reports. Read the row back rather than assuming our own stamp won: the
    // sweep's idempotency key is the stamp that is actually STORED, and using ours
    // would key a second sweep on a timestamp no row carries.
    const fresh = unwrap(
      await supabaseAdmin()
        // cap-safe: single-row primary-key lookup.
        .from("users")
        .select("deactivated_at")
        .eq("id", user!.id)
        .maybeSingle(),
      "offboarding-reread-after-lost-race",
    ) as { deactivated_at: string | null } | null;
    return {
      result: { status: "noop", userId: user!.id },
      userId: user!.id,
      deactivatedAtIso: fresh?.deactivated_at ?? null,
    };
  }
  // #2386: a returning row that was STILL marked bookable was left that way by a
  // write predating the shared rule, and the clear above has just repaired it.
  // Repairing in silence is the one objection to clearing rather than refusing, so
  // it is said twice: to the CALLER, which for the lifecycle API is the JSON it
  // answers with, and to the Worker log under `tag=offboarding`, where a sweep for
  // how many rows the reap left behind can find them. The admin action returns
  // nothing and does not carry it; what an admin sees is the agent page repainting
  // the person as not bookable, beside the control that admits them properly.
  const clearedStaleBookable = !plan.deactivate && user!.bookable === true;
  if (clearedStaleBookable) {
    log.warn("offboarding", {
      msg: "reactivated a departed row that was still marked bookable; cleared it so re-entry passes the activation gate",
      user_id: user!.id,
    });
  }
  return {
    result: {
      status: "applied",
      userId: user!.id,
      deactivate: plan.deactivate,
      ...(clearedStaleBookable ? { clearedStaleBookable: true as const } : {}),
    },
    userId: user!.id,
    deactivatedAtIso: plan.deactivate ? stampIso : null,
  };
}

/**
 * Move the departed agent's remaining appointments (#1241).
 *
 * Runs on a NO-OP as well as on the transition, deliberately. The transition and
 * the enqueue are two writes with no transaction between them, so a crash or a
 * transient database error in the gap would otherwise strand the sweep forever
 * while the deactivation stands; letting a retry converge is the same choice
 * #1235 made for the time-off sweeps, and the unique key on (agent, deactivation)
 * is what makes it converge onto ONE sweep instead of accumulating them. The
 * repeat costs one indexed read of the agent's upcoming bookings, which is empty
 * for a departed agent whose sweep already ran.
 *
 * A FAILED enqueue does not fail the deactivate. The deactivation is what stops
 * the agent being offered for anything NEW, and rolling it back to report a
 * coverage problem would leave them taking fresh bookings, which is strictly
 * worse (the same ordering #1237 chose for approvals). It is not swallowed
 * either:
 *
 *   - it is logged at error level with the agent and the reason, so the failure
 *     is in the Worker logs under `tag=offboarding`;
 *   - it is reported to the caller as `coverageSweep: "failed"`, so the
 *     offboarding automation's own run has the fact;
 *   - a retry of the same call converges, as above;
 *   - and if nothing does, the `inactive_agent_bookings` monitor pages about an
 *     hour later naming the agent and telling a person to run the coverage panel.
 *     That monitor fires exactly when a missed sweep actually matters, because it
 *     counts a deactivated agent's remaining future appointments: the case where
 *     the enqueue failed and there was nothing to move raises nothing, correctly.
 */
async function withAutomaticCoverage(
  outcome: LifecycleOutcome,
  action: LifecycleAction,
): Promise<LifecycleResult> {
  const plan = planOffboardingCoverageSweep({
    action,
    userId: outcome.userId,
    deactivatedAtIso: outcome.deactivatedAtIso,
  });
  if (!plan) return outcome.result;
  if (outcome.result.status === "not_found") return outcome.result;
  return { ...outcome.result, ...(await coverDeparture(plan)) };
}

/**
 * The coverage a departure owes (#1241): clear the departed advisor's invites, then
 * enqueue the offboarding sweep keyed on (advisor, departure). ONE function for every
 * path that departs an advisor with nobody to ask, the lifecycle API above and the hourly
 * Salesforce reap (#1678, `coverReapDepartures`), so the two can never cover a leaver
 * differently. Never throws: each half's failure is logged and reported, for the reasons
 * `withAutomaticCoverage` gives.
 */
export async function coverDeparture(
  plan: OffboardingSweepPlan,
): Promise<{ invitesCleared: InvitesClearedResult; coverageSweep: CoverageSweepOutcome }> {
  // #3667: clear the invites FIRST. The automation archives the Google account 10
  // seconds after this call, and from then on Google refuses every delete, so the
  // lead would keep the departed advisor's invite beside the new one. The sweep's own
  // reassign still deletes whatever this could not, exactly as before.
  const invitesCleared = await clearInvitesReported(plan.outUserId, plan.deactivatedAtIso);

  try {
    const { itemCount } = await startBulkReassign({
      outUserId: plan.outUserId,
      // Open ended, from the moment they left: everything still ahead of them is
      // theirs no longer. `coverageSelectionBounds` still refuses to move an
      // appointment already under way.
      rangeStartIso: plan.deactivatedAtIso,
      rangeEndIso: null,
      reason: { code: "coverage", detail: null },
      // No human actor: nobody is present in an offboarding API call. The sweep
      // records WHY through `offboardingDeactivatedAtIso` and its moves are
      // recorded as system-initiated (see coverage-sweep-actor.ts).
      actor: null,
      offboardingDeactivatedAtIso: plan.deactivatedAtIso,
    });
    log.info("offboarding", {
      msg: "coverage sweep enqueued",
      user_id: plan.outUserId,
      queued: itemCount,
    });
    return { invitesCleared, coverageSweep: itemCount > 0 ? "queued" : "none" };
  } catch (e) {
    log.error(
      "offboarding",
      { msg: "coverage sweep enqueue failed", user_id: plan.outUserId },
      e,
    );
    return { invitesCleared, coverageSweep: "failed" };
  }
}

/** `clearInvitesForLeaver`, logged, with a failure reported rather than thrown (#3667). */
async function clearInvitesReported(userId: string, deactivatedAtIso: string): Promise<InvitesClearedResult> {
  try {
    const r = await clearInvitesForLeaver(userId, deactivatedAtIso);
    log.info("offboarding", { msg: "invites cleared before archive", user_id: userId, ...r });
    return r;
  } catch (e) {
    log.error("offboarding", { msg: "invites could not be cleared before archive", user_id: userId }, e);
    return "failed";
  }
}
