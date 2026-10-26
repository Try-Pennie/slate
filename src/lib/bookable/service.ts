import { supabaseAdmin } from "@/lib/supabase/admin";
import { planBookableChange } from "@/lib/bookable/plan";
import { classifyCalendarReachability } from "@/lib/google/reachability";
import type { Reachability } from "@/lib/google/reachability-classify";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import { logAlertSendFailure } from "@/lib/notify/send-failure";
import { cleanupOnPoolExit } from "@/lib/google/sync";
import { onboardIntoPool, type PoolEntryOptions, type PoolEntryResult } from "@/lib/google/pool-entry";
import { ACTIVATION_BUDGET_MS } from "@/lib/bookable/activation-allowance";
import { poolEntryRefusal } from "@/lib/bookable/pool-entry-verdict";
import {
  defaultActivationHoursDeps,
  importHoursOnActivation,
  type ActivationHoursOutcome,
} from "@/lib/bookable/activation-hours";
import { withinBudget } from "@/lib/google/sync-pace";
import { log } from "@/lib/log";
import {
  bookableBlockedAlert,
  bookableNotProvisionedAlert,
  bookableUnverifiedAlert,
  bookableUnhydratedAlert,
  bookableTimedOutAlert,
  bookableContendedAlert,
} from "@/lib/notify/misc-alert-copy";
import { isDefinitiveFailure } from "@/lib/google/sync-health";
import type { ThrottledNotify } from "@/lib/monitor/alert-deps";
import { twilioUndoesBookable } from "@/lib/twilio/roster-plan";
import type { Attributes } from "@/lib/db/types";
import { heldOutSince } from "@/lib/bookable/refused-pool-exit";

/**
 * Keyed per agent (`bookable_blocked:<userId>`) so a single agent stuck with a
 * broken calendar can't throttle away the first alert for a different agent.
 * 30 min mirrors the watch-lapse cadence: a persistently-failing activation
 * pages once, not on every retry.
 */
export const BOOKABLE_BLOCKED_COOLDOWN_MS = 30 * 60 * 1000;

/** google_unreachable = a definitive "account gone" failure; google_unverified
 *  = a transient failure that persisted through one retry (couldn't confirm). */
export type BlockedReason =
  | "google_unreachable"
  /** #1396: the account exists but has never been given Calendar. Definitive like
   *  google_unreachable, and refused for the same reason, but its own value so the
   *  admin screen and the alert can name the fix (a Workspace admin, not a re-auth). */
  | "google_not_provisioned"
  | "google_unverified"
  /**
   * #2302: the account was reachable and Slate still could not load its events
   * into the availability cache. Refused for the same reason as the three above,
   * and named separately because it sends the reader to the calendar sync lane
   * rather than to the credentials or to a Workspace admin.
   *
   * Dan's rule, 2026-09-14: "we don't want someone without a read calendar to be
   * bookable." An agent in the pool with no cached busy time is offered as free
   * for every hour their working hours allow, and verify on book only catches
   * that at the last moment, after the lead has been shown the slot.
   */
  | "calendar_unhydrated"
  /**
   * #2317: the gate ran out of its budget before it could finish.
   *
   * Its OWN reason rather than folded into `calendar_unhydrated`, because the
   * reader's next move is different: wait and retry, not go and look at the
   * calendar sync lane. Nothing here says a calendar is broken; what it says is
   * that nobody measured one, and a message sending somebody to read sync errors
   * that do not exist is advice that can never work (the same distinction #1396
   * drew between a gone account and one that never had Calendar).
   */
  | "activation_timed_out"
  /**
   * #2705: another lane held one of the agent's calendars while the gate tried to
   * load it (the hydration claim was taken, or the sync token moved under the
   * fetch). The retry kind, like `activation_timed_out`, and its own reason
   * because what it says is different: nothing was slow and nothing is broken, the
   * gate simply lost a race with a pass that is loading the same calendar.
   */
  | "calendar_contended"
  /**
   * #3028: Twilio carries the Redistribute tag for them, so the hourly Twilio sync
   * would take them straight back out of the pool. Refused HERE rather than in one
   * caller, because the admin toggle, the machine API and the Salesforce activation
   * all arrive through this service, and a refusal only one of them made would be
   * one other route away from not existing. No Google call is made for it and no
   * alert is sent: nothing is broken, the tag is a decision somebody made in Twilio.
   */
  | "twilio_redistribute";

/**
 * The row could not be READ, so nothing was decided and nothing was written
 * (#3028). Its own type so a caller with a person waiting can say exactly that,
 * rather than every throw from the service reading as the same failure. Fail
 * closed: an unreadable row is never treated as untagged, absent or admissible.
 */
export class BookableLookupError extends Error {
  constructor(message: string) {
    super(`bookable lookup failed: ${message}`);
    this.name = "BookableLookupError";
  }
}

/** How a caller that knows more than the stored row qualifies the flip. */
export interface BookableOptions {
  /**
   * The caller read Twilio moments ago and this person's worker carries NO
   * Redistribute tag, so the stored copy of the tag (written after the flip) may
   * lag that read. Only the Twilio sync's own reactivation can say this.
   */
  liveTwilioUntagged?: boolean;
}

export type BookableResult =
  | { status: "not_found" }
  | { status: "noop"; userId: string; bookable: boolean }
  | { status: "applied"; userId: string; bookable: boolean }
  | { status: "blocked"; userId: string; reason: BlockedReason };

export interface BookableDeps {
  /** Live Google reachability probe (injected in tests). */
  checkReachable: (email: string) => Promise<Reachability>;
  /** Throttled named alert (injected in tests). */
  notify: ThrottledNotify;
  /** Pool-exit cleanup on deactivation: stop watches + prune busy_blocks (#239/#248). */
  cleanupOnPoolExit: (userId: string) => Promise<void>;
  /**
   * Pool-ENTRY onboarding on activation (#2302): discover the agent's calendars,
   * bootstrap each one out to the booking horizon, and stamp the agent as synced,
   * so being bookable and having a calendar Slate can read are one event rather
   * than half an hour apart.
   *
   * The options are `Required<...>` (#2317), so the gate must hand it a budget: an
   * optional one here would let a caller omit it and silently get back the
   * unbounded behaviour this exists to end.
   */
  onboardIntoPool: (userId: string, opts: Required<PoolEntryOptions>) => Promise<PoolEntryResult>;
  /**
   * Import the agent's cal.com week once the calendar is admitted (#2627), so a hire
   * enters the pool on their real hours rather than the seeded Eastern week. Only a
   * seeded week is replaced, and nothing it meets may stop the activation: it
   * returns an outcome, and the call site contains a throw regardless.
   *
   * `remainingMs` is what is LEFT of this gate's deadline, so the import and the
   * calendar reads before it spend one budget between them. REQUIRED, like the
   * others, so `tsc` names every construction site.
   */
  importHours: (user: { id: string; email: string }, remainingMs: () => number) => Promise<ActivationHoursOutcome>;
  /**
   * The clock the gate's deadline is measured against (#2317).
   *
   * REQUIRED, so `tsc` enumerates every construction site rather than letting one
   * quietly inherit the real clock and become a test that waits for thirty seconds
   * or, worse, one that cannot drive the boundary at all (L524).
   */
  now: () => number;
  /**
   * #3700: when this row's pending mark was written by the calendar refused pool
   * exit (`refused-pool-exit.ts`), the moment it was, which starts the episode the
   * blocked note is said once for; null for anybody else. Optional because the
   * answer only QUIETS a note: absent, or throwing, every refusal notes on the
   * ordinary cooldown, which is the loud direction to be wrong in.
   */
  heldOutSince?: (userId: string, pendingSince: string | null) => Promise<number | null>;
}

/**
 * Post the note for a refused activation (#3700 for the held out branch).
 *
 * Ordinarily it is `bookable_blocked:<id>` on `BOOKABLE_BLOCKED_COOLDOWN_MS`, so a
 * hire stuck on an unprovisioned account is reminded on each hourly retry.
 *
 * An advisor the calendar refused pool exit took out is different: the pool exit's
 * own note already said who, why and what fixes it, and the hourly retry is
 * expected to be refused for as long as the account stays broken. So for them the
 * note is said ONCE per episode per reason. The key carries the reason, so a new
 * reason is a new key and posts at once; the cooldown is the time since the episode
 * began, so the dispatcher's own rule (due when the last post is at least a cooldown
 * old) reads as "due when this key has not posted since the pool exit took them
 * out". A later episode, after a return and a second removal, starts later than any
 * post of the first, so it posts again. Never shorter than the ordinary cooldown.
 */
async function noteBlocked(
  user: BookableRow,
  key: string,
  reason: BlockedReason,
  message: string,
  deps: BookableDeps,
): Promise<void> {
  let since: number | null = null;
  if (deps.heldOutSince) {
    try {
      since = await deps.heldOutSince(user.id, user.bookable_pending_since);
    } catch (err) {
      log.warn("bookable-api", { msg: "held out check failed; noting on the ordinary cooldown", user_id: user.id }, err);
    }
  }
  if (since === null) {
    await deps.notify(key, BOOKABLE_BLOCKED_COOLDOWN_MS, message);
    return;
  }
  await deps.notify(`${key}:${reason}`, Math.max(BOOKABLE_BLOCKED_COOLDOWN_MS, deps.now() - since), message);
}

/**
 * Exported so a batch caller can flip somebody WITHOUT the inline onboarding
 * (#2302), by spreading these and replacing `onboardIntoPool`. The Salesforce
 * sync is the one such caller: it can flip a whole licence upgrade at once, and
 * each onboarding is a handful of Google calls out of one shared invocation
 * budget.
 */
export const defaultBookableDeps: BookableDeps = {
  checkReachable: classifyCalendarReachability,
  // Best-effort: a flaky Slack must never fail the flip (the write already
  // didn't happen on a block; the alert is the only side effect left).
  // alert-key: bookable_blocked:*
  // alert-key: bookable_unverified:*
  notify: (key, cooldownMs, text, repeat) => sendThrottledAlert(key, cooldownMs, text, repeat).catch(logAlertSendFailure(key)),
  // Best-effort: the flip already succeeded, so a cleanup failure must not fail
  // it. The self-heal reconcile backstop retries any leftover watch/blocks.
  cleanupOnPoolExit: (userId) => cleanupOnPoolExit(userId).then(() => {}),
  onboardIntoPool: (userId, opts) => onboardIntoPool(userId, undefined, opts),
  importHours: (user, remainingMs) => importHoursOnActivation(user, defaultActivationHoursDeps(remainingMs)),
  now: () => Date.now(),
  // #3700: reads the pool exit's audit row for the row's current pending mark.
  heldOutSince,
};

/**
 * Run the EXIT transition's side effect without letting it fail the flip that has
 * already been written.
 *
 * Only the exit. Entering the pool is a GATE since #2302 (see below), so its
 * failure is the whole point rather than something to swallow.
 *
 * At the CALL SITE rather than in the default wiring, because that is the difference
 * between a guarantee and a habit: containment in the default wiring is lost by any
 * caller that injects its own collaborator, and the property here is not optional.
 * The write has committed either way, so throwing would report a flip that happened
 * as one that did not, and the caller would have no correct response to it.
 *
 * The self-heal reconcile backstop retries a leftover watch or block on the way out,
 * and the sync and hydration rotations converge on the way in. On the entry side the
 * failure also records itself on the calendar row, which is what cancels the
 * monitors' first-run patience (#2299, #2300), so a bootstrap that really is broken
 * pages at once rather than after fifteen quiet minutes.
 */
async function settleTransition(
  what: "pool-exit cleanup",
  userId: string,
  run: () => Promise<void>,
): Promise<void> {
  try {
    await run();
  } catch (err) {
    log.error("bookable-api", { msg: `${what} failed`, user_id: userId }, err);
  }
}

/**
 * The activation reachability gate (#281, #913). Probes the calendar; a
 * definitive "gone" blocks at once, a "transient" is retried once (to ride out a
 * Google blip) and only then blocks. Returns null when the agent may go into the
 * pool (reachable), or a {reason, key, message} block otherwise.
 *
 * Exported for the live proof (`pnpm verify:pool-entry`, #2316), which asks this
 * half of the gate about a real unlicensed account. It only READS: the alert is
 * sent by the caller, never from here.
 */
export async function checkActivationGate(
  email: string,
  userId: string,
  deps: Pick<BookableDeps, "checkReachable">,
): Promise<{ reason: BlockedReason; key: string; message: string } | null> {
  let kind = await deps.checkReachable(email);
  if (kind === "transient") kind = await deps.checkReachable(email); // one retry
  if (kind === "reachable") return null;
  // #1396: refused for the same reason as gone (nothing about their availability
  // can be read, ever, until a human acts) but named separately, because the human
  // and the action are different. Enumerated BEFORE the gone branch so the two
  // cannot be conflated, and note the fall-through at the bottom is the TRANSIENT
  // branch: a definitive kind reaching it would be refused with "retry shortly",
  // which is advice that can never work. isDefinitiveFailure is what keeps that
  // from happening silently if a fourth kind ever arrives.
  if (kind === "not-provisioned") {
    return {
      reason: "google_not_provisioned",
      key: `bookable_blocked:${userId}`,
      message: bookableNotProvisionedAlert(email),
    };
  }
  if (isDefinitiveFailure(kind)) {
    return {
      reason: "google_unreachable",
      key: `bookable_blocked:${userId}`,
      message: bookableBlockedAlert(email),
    };
  }
  return {
    reason: "google_unverified",
    key: `bookable_unverified:${userId}`,
    message: bookableUnverifiedAlert(email),
  };
}

/** The one write that flips a user's bookable flag (shared with the admin
 *  action, #281). Orthogonal to `deactivated_at` (this never touches it).
 *
 *  It lives in `routable-write.ts` since #2085, which owns every write to
 *  `bookable` and `deactivated_at` so the trait telling Regal whether Slate can
 *  route to this person is sent from inside the write rather than beside it. It
 *  still settles `bookable_pending_since` (#2071) and still THROWS on a refused
 *  write (#2482); re-exported here because every caller knows it by this path. */
export { writeBookable } from "@/lib/bookable/routable-write";
import { writeBookable } from "@/lib/bookable/routable-write";

/**
 * Move an agent into or out of the bookable pool by email (#281). Idempotent on
 * email; the plan is a pure function of the current row so a retrying automation
 * is harmless. On ACTIVATION only, verifies the agent's Google calendar is
 * reachable first: if it is not, the flip is BLOCKED (the agent stays out of the
 * pool) and a named alert fires, never a silent admit. Deactivation is never
 * blocked.
 */
type BookableRow = {
  id: string;
  bookable: boolean;
  email: string;
  bookable_pending_since: string | null;
  /** Read for the Twilio Redistribute tag (#3028). */
  attributes: Attributes | null;
};

/** The one read of the row both entry points make, failing closed (#3028). */
async function lookupRow(column: "id" | "email", value: string): Promise<BookableRow | null> {
  const { data, error } = await supabaseAdmin()
    .from("users")
    .select("id, bookable, email, bookable_pending_since, attributes")
    .eq(column, value)
    .maybeSingle();
  if (error) throw new BookableLookupError(error.message);
  return (data ?? null) as BookableRow | null;
}

export async function applyBookableByEmail(
  email: string,
  bookable: boolean,
  deps: BookableDeps = defaultBookableDeps,
): Promise<BookableResult> {
  // Exact match, consistent with the offboarding lookup (NOT ilike: `_`/`%` in
  // the address would act as wildcards and could resolve the WRONG user).
  const user = await lookupRow("email", email.trim());
  return applyBookableToRow(user, bookable, deps);
}

/**
 * Same flip keyed by user id, for the admin toggle (#912) where the caller
 * already has the RBAC-checked id. Shares the activation gate and write with the
 * by-email path so the admin UI can't put a calendar-less agent into the pool
 * either.
 */
export async function applyBookableByUserId(
  userId: string,
  bookable: boolean,
  deps: BookableDeps = defaultBookableDeps,
  opts: BookableOptions = {},
): Promise<BookableResult> {
  const user = await lookupRow("id", userId);
  return applyBookableToRow(user, bookable, deps, opts);
}

/**
 * Establish the agent's calendars and load them into the availability cache, and
 * answer what that achieved. `null` means it threw.
 *
 * A throw is the LEAST informative failure there is, so it must not be the one
 * that admits somebody: it is mapped to the same refusal a measured failure gets
 * (L93, choose which defect ships and say so). What it costs is precision in the
 * message, which is why the log line carries the counts separately.
 */
async function readCalendarForPool(
  userId: string,
  deps: BookableDeps,
  opts: Required<PoolEntryOptions>,
): Promise<PoolEntryResult | null> {
  try {
    return await deps.onboardIntoPool(userId, opts);
  } catch (err) {
    log.error("bookable-api", { msg: "pool-entry read threw", user_id: userId }, err);
    return null;
  }
}

/** Shared: plan (idempotent) from the row, run the activation gate on the way
 *  into the pool, then write. The gate probes the row's canonical email. */
async function applyBookableToRow(
  user: BookableRow | null,
  bookable: boolean,
  deps: BookableDeps,
  opts: BookableOptions = {},
): Promise<BookableResult> {
  const plan = planBookableChange(user, bookable);
  if (plan.status === "not_found") return { status: "not_found" };
  if (plan.status === "noop") return { status: "noop", userId: user!.id, bookable };

  // #3028: somebody Twilio holds on Redistribute is turned straight back off by the
  // next hourly sync, so the flip in is refused before anything is spent on it: no
  // Google call, no pending mark (nothing here is owed a retry), no alert. Only the
  // flip IN: taking somebody out of the pool is never held back. Asked through the
  // same predicate the console disables its control with.
  if (plan.bookable === true && !opts.liveTwilioUntagged && twilioUndoesBookable(user!.attributes)) {
    log.info("bookable-api", { msg: "activation refused, Twilio holds them on Redistribute", user_id: user!.id });
    return { status: "blocked", userId: user!.id, reason: "twilio_redistribute" };
  }

  if (plan.bookable === true) {
    // The gate's deadline (#2317), taken BEFORE the first Google call, because the
    // probe and its retry are part of the wait a person or a lane is sitting
    // through. It bounds what has not STARTED yet and cannot interrupt a call in
    // flight, which is the same per-calendar granularity the hydration lane has,
    // and is said out loud here so nobody reads it as the stronger guarantee.
    const deadlineMs = deps.now() + ACTIVATION_BUDGET_MS;
    const inBudget = () => withinBudget(deps.now(), deadlineMs);

    const block = await checkActivationGate(user!.email, user!.id, deps);
    if (block) {
      await noteBlocked(user!, block.key, block.reason, block.message, deps);
      log.warn("bookable-api", { msg: "activation blocked", user_id: user!.id, reason: block.reason });
      return { status: "blocked", userId: user!.id, reason: block.reason };
    }

    // A probe that answered slowly enough to spend the whole budget refuses HERE,
    // before the pending mark and before a single calendar call. Marking somebody
    // as owed an activation is cheap and correct either way, but spending Google
    // calls on a run that already cannot finish is not, and the reachability probe
    // is the one step whose own retry can double its cost.
    if (!inBudget()) {
      await noteBlocked(
        user!,
        `bookable_blocked:${user!.id}`,
        "activation_timed_out",
        bookableTimedOutAlert(user!.email, ACTIVATION_BUDGET_MS),
        deps,
      );
      log.warn("bookable-api", {
        msg: "activation blocked",
        user_id: user!.id,
        reason: "activation_timed_out",
        stage: "reachability",
        budget_ms: ACTIVATION_BUDGET_MS,
      });
      return { status: "blocked", userId: user!.id, reason: "activation_timed_out" };
    }

    // Record that an activation is OWED before building one (#2302).
    //
    // Between here and the write below, the agent is a non-bookable row holding a
    // live Google watch and fresh busy blocks, which is precisely what the pool
    // exit reconcile reaps, every minute. This mark is what tells that lane the
    // difference between an activation being built and one that was abandoned.
    //
    // Only when it is not already set. The stamp is how long somebody has been
    // waiting, which the readiness check reads, so restamping it on every hourly
    // retry would make an agent stuck for a week look freshly pending every run.
    //
    // It SURVIVES a refusal, deliberately, and that is the same contract #2071
    // already gives the Salesforce sync: the mark is the intent, an admin asking
    // for somebody to be bookable is an intent, and only an explicit bookable write
    // settles it. So a refused admin toggle is retried hourly until the calendar
    // reads, rather than being forgotten the moment the page redirects.
    if (user!.bookable_pending_since == null) {
      const { error } = await supabaseAdmin()
        .from("users")
        .update({ bookable_pending_since: new Date().toISOString() })
        .eq("id", user!.id);
      // Loud. Without the mark the reconcile can tear down what the next few
      // seconds build, and the result is invisible afterwards (#1879), so this must
      // not degrade into an unprotected activation in silence.
      if (error) throw new Error(`bookable pending mark failed: ${error.message}`);
    }

    // The SECOND half of the gate (#2302). Reachable is not the same as readable:
    // the probe above asks whether Google answers for this account, and this asks
    // whether their events actually reached the availability cache. Before the
    // write, because the answer decides whether there is a write at all.
    const entry = await readCalendarForPool(user!.id, deps, { withinBudget: inBudget });
    // The decision, and which refusal wins when several hold, lives in ONE pure
    // predicate so the live proof (#2316) judges Google's answer by the same rule.
    const refusal = poolEntryRefusal(entry);
    if (refusal !== null) {
      const reason: BlockedReason = refusal;
      const message =
        refusal === "activation_timed_out"
          ? bookableTimedOutAlert(user!.email, ACTIVATION_BUDGET_MS)
          : refusal === "calendar_contended"
            ? bookableContendedAlert(user!.email, entry?.contended ?? 0)
            : bookableUnhydratedAlert(user!.email, entry?.hydrated ?? 0, entry?.calendars ?? 0);
      await noteBlocked(user!, `bookable_blocked:${user!.id}`, reason, message, deps);
      log.warn("bookable-api", {
        msg: "activation blocked",
        user_id: user!.id,
        reason,
        calendars: entry?.calendars ?? 0,
        hydrated: entry?.hydrated ?? 0,
        failed: entry?.failed ?? 0,
        contended: entry?.contended ?? 0,
        out_of_budget: entry?.outOfBudget ?? false,
      });
      // Nothing written, so `bookable_pending_since` survives and the hourly roster
      // sync retries this next hour, which is the same recovery path every other
      // arm of the gate already uses.
      return { status: "blocked", userId: user!.id, reason };
    }

    // Admitted. Bring their real week across from cal.com BEFORE the write (#2627),
    // so they enter the pool on it rather than on the seeded Eastern default for up
    // to a day. Only a seeded week is replaced, and the outcome is logged inside
    // with its own reason. Contained HERE as well as inside, because nothing this
    // meets may refuse an activation the calendar gate has just admitted: the daily
    // importer is the repair for a week this could not bring across.
    try {
      await deps.importHours({ id: user!.id, email: user!.email }, () => deadlineMs - deps.now());
    } catch (err) {
      log.error("bookable-api", { msg: "calcom hours import threw on activation", user_id: user!.id }, err);
    }
  }

  await writeBookable(user!.id, plan.bookable);
  // Left the pool: stop the agent's Google watches and prune their cached busy
  // time so we're no longer POSTed for someone we don't book (#239/#248).
  if (plan.bookable === false) {
    await settleTransition("pool-exit cleanup", user!.id, () => deps.cleanupOnPoolExit(user!.id));
  }

  log.info("bookable-api", { msg: "bookable set", user_id: user!.id, bookable: plan.bookable });
  return { status: "applied", userId: user!.id, bookable: plan.bookable };
}
