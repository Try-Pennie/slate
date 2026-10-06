// Relative value import so this module runs under `node --experimental-strip-types`
// in tests (type-only "@/" imports are erased anyway).
import {
  oooManagerCalendarAlert,
  oooCalendarCreateBothFailedAlert,
  oooCalendarCreateAlert,
  oooAgentCalendarAlert,
  oooBusyBlockFallbackAlert,
  oooCalcomAlert,
  oooCalcomStaleUnrecordedAlert,
  oooAgentDmAlert,
  oooUndoManagerAlert,
  oooUndoAgentAlert,
  oooCoverageStopAlert,
  oooNarrowCalendarAlert,
  oooNarrowHoldAlert,
} from "./alert-copy.ts";
import {
  declinedReleasedLine,
  modifyAgentDm,
  modifyManagerHeading,
  modifyManagerNote,
  type HeldOnEarlier,
  type ModifyOutcome,
} from "./modify-copy.ts";
import {
  cancelActPerformed,
  cancelAgentDm,
  cancelManagerDm,
  type CancelAct,
} from "./cancel-copy.ts";
import {
  approvedCoverageLine,
  cancelledCoverageLine,
  pendingCoverageLine,
  type CoverageMove,
  type CoverageStopState,
  type CoverageSweepState,
} from "./coverage-notice-copy.ts";
import {
  agentDisplayName,
  managerDisplayName,
  canCancel,
  canHoldManagerOfRecord,
  canModerate,
  canModify,
  canRetrySideEffects,
  capitalizeReviewer,
  fallbackReviewerFor,
  isAdminDecidingOwn,
  OWN_REQUEST_REFUSAL,
  DEFAULT_REJECTION_NOTE,
  DUPLICATE_REQUEST_MESSAGE,
  formatRequestWhenAndReason,
  formatWhenLine,
  holdsApprovalArtifacts,
  overlaps,
  shortDate,
  stripModifiedMarkers,
  validateWindow,
  windowWithin,
} from "./core.ts";
// Relative value import, per this file's header: a "@/" VALUE import is not
// erased and breaks the node --experimental-strip-types suites.
import { roleLabel } from "../auth/roles.ts";
import { isRetiredSkip } from "../calcom/outcomes.ts";
import { reachabilityFromError } from "../google/reachability-classify.ts";
import { deterministicEventId } from "../booking/core.ts";
import { log } from "../log.ts";
import type { OooRequest, OooStatus, User } from "@/lib/db/types";

/**
 * OOO orchestration (submit / approve / reject / cancel / modify / retry),
 * ported from the Apps Script workflow and split out from IO so it's
 * unit-testable. Every side effect — DB, Google Calendar, busy_blocks, Cal.com,
 * Slack, audit — goes through the injected `OooDeps`;
 * `scripts/test-ooo-orchestration.ts` drives the flow with in-memory fakes and
 * `service.ts` binds the real implementations. This module imports NO IO.
 *
 * Post-approval side effects are best-effort and never roll back the approval
 * (parity with doPostApproval_): each outcome lands in `side_effects`, ids of
 * created artifacts land on the row, and `retrySideEffects` re-runs only what's
 * missing.
 */

export interface OooEventArgs {
  summary: string;
  description: string;
  start: string;
  end: string;
  timezone: string;
}

export type OooInsert = {
  org_id: string;
  user_id: string;
  /**
   * Nullable since #1499: nine active people carry no manager of record, and a
   * request from one of them is accepted and routed to the moderator pool rather
   * than refused. The column has always been nullable; this type was the only
   * thing insisting otherwise.
   */
  manager_id: string | null;
  starts_at: string;
  ends_at: string;
  display_tz_id: string;
  display_tz_label: string;
  all_day: boolean;
  reason: string;
  notes: string | null;
  status: "pending";
};

export type InsertOooResult =
  | { ok: true; request: OooRequest }
  | { ok: false; duplicate: boolean; error?: string };

export type TransitionResult =
  | { ok: true; request: OooRequest }
  | { ok: false; duplicate: boolean };

export type OooBusyBlockInsert = {
  user_id: string;
  starts_at: string;
  ends_at: string;
  /**
   * Always a held window (#3360, #3365). Typed to the one shape so nothing can go
   * back to writing a source='gcal' row keyed on the agent event, which is the
   * row the calendar sync treats as that event's mirror and rewrites. Its own
   * source since 0171, because the reconcile sweep frees every 'slate' row with no
   * booking unless its owner is APPROVED, and a narrowed request keeps its window
   * held while it waits for re-approval as pending.
   */
  source: "ooo";
  gcal_event_id: null;
  calendar_id: null;
  /**
   * The request this row was written for (#1464). Required, not optional: it is
   * what tells the reconcile sweep and the pool-exit prune that an approved time
   * off owns this window, and a block written without it is the exact row
   * production lost 31 seconds after writing it.
   */
  ooo_request_id: string;
};

/** Coordinates of a posted Slack message, so it can be edited later. */
export type SlackRef = { channel: string; ts: string };

/**
 * What one coverage sweep enqueued (#1237 for the count, #1239 for the detail).
 *
 * `queued` is what the enqueue itself reported, and it is the number the manager is
 * told. `moves` is the same work described appointment by appointment, so the notice
 * can NAME the ones starting within the next couple of hours; nothing else reads it,
 * and it never decides what moves.
 *
 * Named REPORT rather than Outcome because `src/lib/offboarding/service.ts` already
 * exports a `CoverageSweepOutcome`, and it is a different thing entirely (the string
 * "queued" | "none" | "failed" that the lifecycle API answers with). One name across
 * two modules gets read as one concept (L263), and these two would then be assumed
 * interchangeable by whoever meets the second one.
 */
export interface CoverageSweepReport {
  queued: number;
  moves: CoverageMove[];
}

/**
 * What stopping a coverage sweep did (#1665), as the database answered it.
 *
 * `stopped` is the count of appointments that were still waiting to move and now
 * never will; `alreadyMoved` is the count that had already moved and stays put
 * (#1219 decision 4). Both are counts of rows a conditional write actually
 * matched, so neither can claim something that did not happen.
 */
export interface CoverageStopReport {
  stopped: number;
  alreadyMoved: number;
}

/** Which absence a cal.com override write is about (#2417). */
export interface CalcomOverrideTarget {
  requestId: string;
  agentUserId: string;
  agentEmail: string;
  startIso: string;
  endIso: string;
}

export interface OooDeps {
  loadRequest(id: string): Promise<OooRequest | null>;
  /**
   * A user's still-active (pending/approved) requests, for overlap checks.
   *
   * **null means the read FAILED**, and it is not interchangeable with `[]`
   * (#1674). An empty array is a measured answer: this agent has no active
   * request, so nothing can clash. A failed read has measured nothing, and
   * before this it arrived here as `[]` and read as a clear calendar, so an
   * overlapping absence was accepted with nothing anywhere saying a read failed.
   * The overlap guard refuses on null rather than guessing (L530).
   */
  listActiveRequests(
    userId: string,
  ): Promise<
    | Pick<
        OooRequest,
        "id" | "starts_at" | "ends_at" | "display_tz_id" | "display_tz_label"
      >[]
    | null
  >;
  insertRequest(row: OooInsert): Promise<InsertOooResult>;
  /**
   * Conditional update: applies `patch` only while status is one of `from`
   * (the race guard). ok=false with duplicate=true means the patch hit the
   * active-window unique index; duplicate=false means the guard missed.
   */
  transitionRequest(
    id: string,
    from: OooStatus[],
    patch: Partial<OooRequest>,
  ): Promise<TransitionResult>;
  patchRequest(id: string, patch: Partial<OooRequest>): Promise<void>;
  getUser(userId: string): Promise<User | null>;

  /**
   * Enqueue the coverage sweep for an approved absence (#1237): move the bookings this agent
   * cannot now take. Returns how many were queued.
   *
   * Injected rather than called directly so the orchestration stays drivable with in-memory
   * fakes, including the branch where it throws, which is the one that must not be allowed to
   * cost the approval.
   */
  startCoverageSweep(args: {
    requestId: string;
    outUserId: string;
    startIso: string;
    endIso: string;
    /** The approving or retrying actor. Never null: both call sites have one, and a sweep
     *  that moves customers' bookings should name a person in its audit trail. */
    createdBy: string;
  }): Promise<CoverageSweepReport>;

  /**
   * Stop the coverage sweep this request's approval started (#1665).
   *
   * Approving enqueues a sweep that moves the agent's upcoming customer appointments
   * to colleagues. Cancelling the time off, or narrowing it by a modification, removes
   * the reason those appointments are moving, and nothing else in this file reaches the
   * sweep: the undo below tears down the calendar events and the busy block and knows
   * nothing about it.
   *
   * Whatever it has already moved stays moved (#1219 decision 4); this stops the rest.
   * Injected, like `startCoverageSweep`, so the flow including its failure branch is
   * drivable with in-memory fakes.
   */
  stopCoverageSweep(args: { requestId: string }): Promise<CoverageStopReport>;

  /**
   * How many of this agent's upcoming appointments fall in the window and would move
   * on approval (#1239), for the manager's PENDING notice.
   *
   * `null`, never 0, when the count could not be read. Zero is silence on the notice,
   * and a manager reads silence as "nothing will move", so an unreadable read has to
   * stay distinguishable all the way to the sentence (AGENTS.md, "Ask what the EMPTY
   * result means downstream").
   *
   * Answers the SAME question as the sweep's own selection (`movesUnderCoverage`), so
   * it reads through the same predicate rather than a second definition of "needs
   * covering" (L16).
   */
  countCoverageBookings(args: {
    outUserId: string;
    startIso: string;
    endIso: string;
  }): Promise<number | null>;

  /**
   * Create an event on `calendarId` impersonating `actorEmail`; returns event id.
   *
   * `clientId` is a deterministic Google event id (#1469). It makes the create
   * idempotent: an attempt that timed out may still have landed on Google's side,
   * and sending the same id again returns THAT event instead of inserting a
   * second one.
   */
  createCalendarEvent(
    actorEmail: string,
    calendarId: string,
    args: OooEventArgs,
    clientId?: string,
  ): Promise<string>;
  /** Delete tolerantly (404/410 are fine). */
  deleteCalendarEvent(
    actorEmail: string,
    calendarId: string,
    eventId: string,
  ): Promise<void>;
  /**
   * Move an existing event to new times (#3365, a narrowed request). "gone" when
   * Google no longer has the event (404/410), so the caller can tell "moved" from
   * "nothing was there"; any other failure THROWS.
   */
  moveCalendarEvent(
    actorEmail: string,
    calendarId: string,
    eventId: string,
    args: { start: string; end: string; timezone: string },
  ): Promise<"moved" | "gone">;
  /**
   * Narrow a request's held block in place to a new window (#3365). Matches on the
   * block id AND its owner, so it can never resize a row another request holds.
   * True only when exactly that row was written.
   */
  holdNarrowedWindow(args: {
    id: string;
    requestId: string;
    userId: string;
    startIso: string;
    endIso: string;
  }): Promise<boolean>;
  /**
   * The window a request's held block REALLY covers (#3365). After a failed
   * narrowing it is the earlier, wider window, not the one the request row carries,
   * and a later change is judged against it. Null when no row with that id belongs to
   * the request; THROWS on a failed read, which the caller turns into a refusal,
   * because a read that never ran cannot say what is held.
   */
  loadHeldWindow(args: {
    id: string;
    requestId: string;
  }): Promise<{ startIso: string; endIso: string } | null>;

  /** Returns the inserted busy block id (null on failure — alerted inside). */
  insertBusyBlock(block: OooBusyBlockInsert): Promise<string | null>;
  deleteBusyBlock(args: {
    id: string | null;
    userId: string;
    gcalEventId: string | null;
  }): Promise<void>;

  /**
   * Cal.com dual-write; returns "ok" | "skipped" | "failed: <why>".
   *
   * Takes the REQUEST and the agent's id, not just a window, because a date's
   * overrides are derived from every approved absence touching it (#2417): the
   * binding reads that set and refuses the write when it cannot.
   */
  calcomAddOverrides(args: CalcomOverrideTarget): Promise<string>;
  calcomRemoveOverrides(args: CalcomOverrideTarget): Promise<string>;

  /**
   * #2890: record a window cal.com still blocks because its removal was skipped
   * while cal.com was retired, so the override sweep can take it out once cal.com
   * is put back. Idempotent on (request, window). THROWS when it could not record:
   * the caller says so, because nothing else would remember the window.
   */
  recordCalcomRemovalPending(args: {
    requestId: string;
    agentUserId: string;
    startIso: string;
    endIso: string;
    reason: string;
  }): Promise<void>;

  /**
   * Slack DM by email; the message ref when delivered, null when undeliverable.
   * `oooRequestId` attaches interactive Approve/Decline buttons for that request
   * (the manager notification); omit it for plain agent DMs.
   */
  dmUserByEmail(
    email: string,
    text: string,
    oooRequestId?: string,
  ): Promise<SlackRef | null>;
  /** Fallback channel post when a DM can't be delivered; returns the message ref. */
  postFallbackChannel(
    text: string,
    oooRequestId?: string,
  ): Promise<SlackRef | null>;
  /** Edit a prior manager notification so it mirrors the request's new status. */
  editMessage(ref: SlackRef, text: string): Promise<void>;
  /** Throttled ops alert (mirrors postToStatusPage_). */
  alertOps(key: string, message: string): Promise<void>;

  /**
   * Append one OOO action to the audit trail.
   *
   * Takes an object, not five positional strings, because the two uuids here mean
   * different things and were silently swapped for two months (#1220): the
   * request id was passed where the agent belonged, and `audit_log.target_id`
   * has a foreign key to `users(id)`, so every ooo.* write was rejected. The
   * names now say which is which at every call site.
   */
  recordAudit(entry: {
    action:
      | "ooo.submit"
      | "ooo.approve"
      | "ooo.reject"
      | "ooo.cancel"
      | "ooo.modify"
      | "ooo.retry";
    /** Who took the action: the agent for submit, the decider for the rest. */
    actorId: string;
    orgId: string;
    /** The agent the request is ABOUT. Lands in target_id, which FKs users(id). */
    targetUserId: string;
    /** The ooo_requests row. Lands in `details`, where no foreign key applies. */
    requestId: string;
    details?: Record<string, unknown>;
  }): Promise<void>;

  appBaseUrl(): string;
  mainOooCalendarId(): string;
  /** DWD actor for manager/main OOO calendar writes (ooo@trypennie.com). */
  oooCalendarActorEmail(): string;
  nowIso(): string;
}

/**
 * A refusal, named on its own so every result shape can share it. `fail` returns
 * THIS rather than a whole result union: a helper typed as the union carries an
 * `ok: true` branch the caller must then re-narrow, which is what stopped a
 * refusal being usable inside a result that asks more of its success branch.
 */
export type OooFailure = {
  ok: false;
  error: string;
  // `conflictRequestId` is set only on the overlap error, so the form can link
  // straight to the request the agent should edit instead.
  conflictRequestId?: string;
};

export type OooActionResult = { ok: true; request: OooRequest } | OooFailure;

/**
 * A cancel's result carries WHICH act it performed (#2406), and carries it
 * REQUIRED rather than optional: the caller writes the agent's outcome message
 * from it, the row's status by then reads `cancelled` for both acts, and an
 * optional field defaulted at the call site would silently tell somebody who
 * cancelled an approved week that they withdrew a request (L168).
 */
export type OooCancelResult =
  | { ok: true; request: OooRequest; act: CancelAct }
  | OooFailure;

const fail = (error: string, conflictRequestId?: string): OooFailure =>
  conflictRequestId ? { ok: false, error, conflictRequestId } : { ok: false, error };

function whenLineFor(r: OooRequest): string {
  return formatWhenLine(
    r.starts_at,
    r.ends_at,
    r.display_tz_id,
    r.display_tz_label,
  );
}

function reviewUrl(deps: OooDeps, requestId: string): string {
  return `${deps.appBaseUrl()}/admin/ooo?request=${requestId}`;
}

type OverlapCandidate = Pick<
  OooRequest,
  "id" | "starts_at" | "ends_at" | "display_tz_id" | "display_tz_label"
>;

/**
 * Three outcomes, deliberately, because two of them look identical from the
 * caller and mean opposite things (#1674):
 *   { measured: true, clash: <request> }  something overlaps, refuse and link
 *   { measured: true, clash: null }       nothing overlaps, go ahead
 *   { measured: false }                   we could not tell, refuse retriably
 */
type OverlapOutcome =
  | { measured: true; clash: OverlapCandidate | null }
  | { measured: false };

async function findOverlap(
  userId: string,
  startIso: string,
  endIso: string,
  deps: OooDeps,
  excludeId?: string,
): Promise<OverlapOutcome> {
  const active = await deps.listActiveRequests(userId);
  if (active === null) return { measured: false };
  return {
    measured: true,
    clash:
      active.find(
        (r) =>
          r.id !== excludeId &&
          overlaps(startIso, endIso, r.starts_at, r.ends_at),
      ) ?? null,
  };
}

/**
 * The refusal when the overlap check could not run. It is retriable and says so,
 * because the agent has done nothing wrong and the same submission will go
 * through once the read recovers. It deliberately does NOT claim there is a
 * clash, and carries no `conflictRequestId`, because none was found.
 */
export const OVERLAP_UNREADABLE_MESSAGE =
  "We could not check your existing time off just now. Please try again in a moment.";

/** #3365: a change to a held request whose block could not be read. Nothing was changed. */
export const HELD_WINDOW_UNREADABLE_MESSAGE =
  "We could not check what this time off is blocking just now, so nothing was changed. Please try again in a moment.";

function overlapError(r: OverlapCandidate): string {
  return (
    `This overlaps a request you already have for ` +
    `${formatWhenLine(r.starts_at, r.ends_at, r.display_tz_id, r.display_tz_label)}. ` +
    `Edit that request instead of adding a new one.`
  );
}

export interface SubmitOooInput {
  startIso: string;
  endIso: string;
  displayTzId: string;
  displayTzLabel: string;
  allDay: boolean;
  reason: string;
  notes?: string;
}

/** Agent submits a request for themselves. */
export async function submitOoo(
  agent: User,
  input: SubmitOooInput,
  deps: OooDeps,
): Promise<OooActionResult> {
  const windowError = validateWindow(input.startIso, input.endIso);
  if (windowError) return fail(windowError);
  if (!input.reason.trim()) {
    return fail("Please add a short reason for your time off.");
  }
  // #1499: no manager of record is deliberately NOT a refusal. It routes to the
  // moderator pool below (`notifyManagerOfPending`) instead, which is who would
  // have approved it anyway. The old refusal named a step nobody can perform.

  const overlap = await findOverlap(
    agent.id,
    input.startIso,
    input.endIso,
    deps,
  );
  if (!overlap.measured) return fail(OVERLAP_UNREADABLE_MESSAGE);
  if (overlap.clash) return fail(overlapError(overlap.clash), overlap.clash.id);

  const inserted = await deps.insertRequest({
    org_id: agent.org_id,
    user_id: agent.id,
    manager_id: agent.manager_id,
    starts_at: input.startIso,
    ends_at: input.endIso,
    display_tz_id: input.displayTzId,
    display_tz_label: input.displayTzLabel,
    all_day: input.allDay,
    reason: input.reason.trim(),
    notes: input.notes?.trim() || null,
    status: "pending",
  });
  if (!inserted.ok) {
    return fail(
      inserted.duplicate
        ? DUPLICATE_REQUEST_MESSAGE
        : "Your request could not be saved. Please try again.",
    );
  }
  const request = inserted.request;

  await deps.recordAudit({
    action: "ooo.submit",
    actorId: agent.id,
    orgId: agent.org_id,
    targetUserId: agent.id,
    requestId: request.id,
    details: { starts_at: request.starts_at, ends_at: request.ends_at },
  });
  await notifyManagerOfPending(request, agent, "New time off request", deps);
  return { ok: true, request };
}

const STATUS_LINE = {
  pending: ":hourglass_flowing_sand: *Pending your approval*",
  approved: ":white_check_mark: *Approved*",
  rejected: ":x: *Declined*",
  cancelled: ":no_entry_sign: *Cancelled*",
  // The agent edited this request, so it returned to pending under a fresh
  // message; this one is left only to mark the old window as no longer current.
  superseded: ":arrows_counterclockwise: *Edited and resubmitted — see the latest request*",
} as const;

function managerNotice(
  request: OooRequest,
  agent: User,
  deps: OooDeps,
  heading: string,
  status: keyof typeof STATUS_LINE,
  /** The coverage line for this status (#1239), or null when there is nothing to
   *  say about the customer appointments. Built by the pure builders in
   *  coverage-notice-copy.ts, never assembled here, so every state is readable in
   *  one place (L41). */
  coverage?: string | null,
  /** What is blocked while the manager decides a changed request (#3365), built by
   *  `modifyManagerNote`; null when there is nothing to say. */
  note?: string | null,
): string {
  return (
    `*${heading}* from ${agentDisplayName(agent)}\n` +
    `${STATUS_LINE[status]}\n` +
    (note ? `${note}\n` : "") +
    `${formatRequestWhenAndReason(request)}` +
    (request.notes ? `\nNotes: ${request.notes}` : "") +
    (coverage ? `\n${coverage}` : "") +
    `\n<${reviewUrl(deps, request.id)}|Review it here>`
  );
}

async function notifyManagerOfPending(
  request: OooRequest,
  agent: User,
  heading: string,
  deps: OooDeps,
  note: string | null = null,
): Promise<void> {
  // Read here rather than at the call sites, so the fresh notice `modifyOoo` posts
  // recomputes by construction: an edited request carrying the submit-time number
  // would be stale twice over, on a window that no longer exists.
  const willMove = await deps.countCoverageBookings({
    outUserId: request.user_id,
    startIso: request.starts_at,
    endIso: request.ends_at,
  });
  const text = managerNotice(
    request,
    agent,
    deps,
    heading,
    "pending",
    pendingCoverageLine(willMove),
    note,
  );
  const namedManager = request.manager_id
    ? await deps.getUser(request.manager_id)
    : null;
  // #1475: only DM the manager of record when they can actually ACT on it. The
  // notification carries Approve/Decline buttons, and those buttons run through
  // canModerate, so DMing somebody the rule now refuses would hand them a control
  // that answers "Not authorized" with nothing on screen explaining why (L109).
  //
  // Read from the SAME predicate the action enforces, never a hand-rolled role
  // test, so the button offered and the action performed cannot drift apart. This
  // is the #1468 pattern applied to the notification rather than to a page.
  //
  // #3114: an admin named as their OWN manager of record is refused by the same
  // rule, so they are not DMed either; the request goes to the moderators.
  const selfApprover = namedManager !== null && isAdminDecidingOwn(namedManager, request);
  const manager =
    namedManager && canHoldManagerOfRecord(namedManager.role) && !selfApprover
      ? namedManager
      : null;
  // Pass the request id so the notification carries Approve/Decline buttons.
  let ref = manager
    ? await deps.dmUserByEmail(manager.email, text, request.id)
    : null;
  if (!ref) {
    // The DM failed, or there is nobody to DM. Post to the fallback channel, where
    // team leads and up see it, and say WHICH of the three cases this is: a failed
    // DM is a Slack permissions problem, a manager who cannot approve is a roster
    // problem, and no manager at all is neither. One message for one cause (L11).
    let fallbackText: string;
    // Who can act, true for the author too (#3114, L659): an admin's own request
    // names everyone but them.
    const reviewer = fallbackReviewerFor(agent, request);
    if (selfApprover) {
      fallbackText =
        `:information_source: *${agentDisplayName(agent)} is their own manager of record and cannot decide their own time off.* ` +
        `${capitalizeReviewer(reviewer)} can approve it here.\n\n${text}`;
    } else if (manager) {
      fallbackText = `:warning: *Couldn't DM ${managerDisplayName(manager)}.* Posting here as a fallback; check the Slack bot's DM permissions.\n\n${text}`;
    } else if (namedManager) {
      fallbackText =
        `:warning: *${managerDisplayName(namedManager)} is set as the manager of record but cannot approve time off* ` +
        `(they hold the ${roleLabel(namedManager.role)} role). ${capitalizeReviewer(reviewer)} can action this, and their ` +
        `manager of record should be corrected in Salesforce.\n\n${text}`;
    } else if (request.manager_id === null) {
      // #1499: nobody was named, so nobody could be nudged. Say that, and name who
      // CAN act, rather than posting a bare request that reads like an ordinary
      // one whose approver is simply slow. It must not repeat the old refusal's
      // advice to have an admin set a manager: that field is read only (L111).
      fallbackText =
        `:information_source: *${agentDisplayName(agent)} has no manager of record, so nobody was nudged directly.* ` +
        `${capitalizeReviewer(reviewer)} can approve it here.\n\n${text}`;
    } else {
      // A manager of record is named but could not be read back at all (offboarded,
      // or a stale id). A third cause, and a roster repair rather than a Slack one.
      fallbackText =
        `:warning: *Their manager of record could not be found, so nobody was nudged.* ` +
        `${capitalizeReviewer(reviewer)} can approve it here, ` +
        `and their Agent Manager should be corrected in Salesforce.\n\n${text}`;
    }
    ref = await deps.postFallbackChannel(fallbackText, request.id);
  }
  if (ref) {
    await deps.patchRequest(request.id, {
      slack_channel: ref.channel,
      slack_ts: ref.ts,
    });
  }
}

/** Edit the stored manager notification to mirror the request's new status. */
async function updateManagerStatus(
  request: OooRequest,
  agent: User,
  deps: OooDeps,
  status: keyof typeof STATUS_LINE,
  coverage?: string | null,
): Promise<void> {
  if (!request.slack_channel || !request.slack_ts) return;
  await deps.editMessage(
    { channel: request.slack_channel, ts: request.slack_ts },
    managerNotice(request, agent, deps, "Time off request", status, coverage),
  );
}

/** Effect keys recorded in side_effects (stable: the retry path keys off them). */
export const EFFECTS = {
  managerEvent: "manager_event",
  agentEvent: "agent_event",
  busyBlock: "busy_block",
  calcom: "calcom",
  agentDm: "agent_dm",
  coverage: "coverage",
} as const;

/**
 * How many attempts one calendar create gets inside the manager's wait (#1469).
 *
 * The writes are bounded at 8 seconds because the manager is watching, which is
 * the right posture, but that made a timeout PERMANENT: the failure was recorded
 * and the only route back was somebody noticing a Slack line and pressing Retry.
 * A timeout is the most retryable failure there is, and one more attempt costs
 * the manager a few seconds at worst.
 *
 * Two, not more: the point is to survive one slow moment at Google, not to keep
 * a person waiting through an outage. Everything past that is what the retry
 * control and the monitor page (#1467) are for.
 */
const CALENDAR_CREATE_ATTEMPTS = 2;

/**
 * Create a calendar event, retrying ONCE on a transient failure.
 *
 * What counts as transient is decided by `reachabilityFromError`, the same
 * classifier the sync health path uses (L35: classify once, explicitly). A
 * definitive refusal (a 404, a revoked delegation, an account with no Calendar)
 * is not retried: it would spend another 8 seconds of the manager's wait to be
 * told the same thing.
 *
 * `clientId` is what makes the retry safe. An aborted insert may still have been
 * applied on Google's side, so the second attempt sends the same deterministic
 * event id and Google answers with the event it already created rather than
 * inserting a duplicate. Without it a retry could put two OOO events on an
 * agent's calendar for the same window.
 */
async function createEventWithRetry(
  deps: OooDeps,
  actorEmail: string,
  calendarId: string,
  args: OooEventArgs,
  clientId: string,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= CALENDAR_CREATE_ATTEMPTS; attempt++) {
    try {
      return await deps.createCalendarEvent(actorEmail, calendarId, args, clientId);
    } catch (e) {
      lastError = e;
      if (reachabilityFromError(e) !== "transient") throw e;
    }
  }
  throw lastError;
}

/**
 * Post-approval side effects (port of doPostApproval_). Idempotent: each effect
 * is skipped when its artifact/outcome already exists, so retry only fills
 * gaps. Never throws; outcomes land in side_effects.
 */
async function runPostApproval(
  request: OooRequest,
  agent: User,
  deps: OooDeps,
  /** `actorId` is who approved or retried, recorded as the sweep's creator so the reassign
   *  audit names a person rather than the system (#1237). */
  opts: { notifyAgent: boolean; actorId: string },
): Promise<{ request: OooRequest; coverage: CoverageSweepState }> {
  const effects: Record<string, string> = { ...request.side_effects };
  const patch: Partial<OooRequest> = {};
  const eventArgs: OooEventArgs = {
    summary: `${agentDisplayName(agent)} - OOO`,
    description: `Request ID: ${request.id}`,
    start: request.starts_at,
    end: request.ends_at,
    timezone: request.display_tz_id,
  };

  // 0. A narrowed request (#3365) whose calendar events or held block could not be
  //    moved to its narrower window when it was changed: try again now. Only what is
  //    recorded as still on the earlier window is touched, so a fresh approval and an
  //    ordinary retry do nothing here. A vanished event's id is cleared, so the steps
  //    below create it afresh.
  await narrowHeldArtifacts(request, agent, deps, effects, patch, { onlyWhereEarlier: true });
  const managerEventNow =
    "manager_event_id" in patch ? patch.manager_event_id : request.manager_event_id;
  const agentEventNow = "agent_event_id" in patch ? patch.agent_event_id : request.agent_event_id;

  // 1. Manager OOO calendar event (per-manager calendar, main fallback).
  if (!managerEventNow) {
    const manager = request.manager_id
      ? await deps.getUser(request.manager_id)
      : null;
    const preferred = manager?.ooo_calendar_id || deps.mainOooCalendarId();
    const actor = deps.oooCalendarActorEmail();
    try {
      patch.manager_event_id = await createEventWithRetry(
        deps,
        actor,
        preferred,
        eventArgs,
        await deterministicEventId(`ooo-manager:${request.id}`, preferred),
      );
      patch.manager_event_calendar_id = preferred;
      effects[EFFECTS.managerEvent] = "ok";
    } catch (e) {
      const main = deps.mainOooCalendarId();
      if (preferred !== main) {
        try {
          patch.manager_event_id = await createEventWithRetry(
            deps,
            actor,
            main,
            eventArgs,
            await deterministicEventId(`ooo-manager:${request.id}`, main),
          );
          patch.manager_event_calendar_id = main;
          effects[EFFECTS.managerEvent] = "ok (main fallback)";
          await deps.alertOps(
            "ooo_manager_calendar",
            oooManagerCalendarAlert(request.id, String(e).slice(0, 200)),
          );
        } catch (e2) {
          effects[EFFECTS.managerEvent] = `failed: ${String(e2).slice(0, 200)}`;
          await deps.alertOps(
            "ooo_calendar_create",
            oooCalendarCreateBothFailedAlert(request.id, String(e2).slice(0, 200)),
          );
        }
      } else {
        effects[EFFECTS.managerEvent] = `failed: ${String(e).slice(0, 200)}`;
        await deps.alertOps(
          "ooo_calendar_create",
          oooCalendarCreateAlert(request.id, String(e).slice(0, 200)),
        );
      }
    }
  }

  // 2. Agent-calendar event (best-effort) — this is what blocks availability
  //    once synced, and the busy block below makes it immediate.
  if (!agentEventNow && !effects[EFFECTS.agentEvent]?.startsWith("ok")) {
    try {
      patch.agent_event_id = await createEventWithRetry(
        deps,
        agent.email,
        "primary",
        {
          ...eventArgs,
          description:
            `Reason: ${request.reason}` +
            (request.notes ? `: ${request.notes}` : "") +
            `\nRequest ID: ${request.id}`,
        },
        await deterministicEventId(`ooo-agent:${request.id}`, agent.id),
      );
      effects[EFFECTS.agentEvent] = "ok";
    } catch (e) {
      effects[EFFECTS.agentEvent] = `failed: ${String(e).slice(0, 200)}`;
      await deps.alertOps(
        "ooo_agent_calendar",
        oooAgentCalendarAlert(request.id, String(e).slice(0, 200)),
      );
    }
  }

  // 3. busy_blocks write-through so the embed stops offering the window now.
  //
  //    The APPROVED window is held by a block the calendar sync can never write
  //    (#3360): source='ooo' (#3365), no gcal_event_id, no calendar_id, owned
  //    through `ooo_request_id`. It used to be a source='gcal' row carrying the agent
  //    event's id, so the sync's upsert on (user_id, calendar_id, gcal_event_id)
  //    treated it as that event's mirror and rewrote it to whatever span the event
  //    had. On 2026-10-06 one hand edit in Google cut 690 minutes off an approved
  //    day this way, the block followed, and a lead was booked into the morning
  //    the edit opened. An approval is the record of what was agreed, so its
  //    protection must not depend on the event staying as it was written.
  //
  //    The event gets its own ordinary mirror row from the sync, like any other
  //    event, so a WIDER event still blocks its extra hours. When the two
  //    disagree, the sync pages (src/lib/ooo/event-coverage.ts) and asks a person
  //    to make them agree, in whichever direction is true.
  //
  //    No sweep can see this shape: the reconcile sweep and the missing block
  //    check read only 'slate' rows, both pool exit prunes keep any row with an
  //    `ooo_request_id`, and nothing on the sync path touches it (its upsert and
  //    deletes match on gcal_event_id and calendar_id, its reconcile and the
  //    nightly prune on source='gcal'). It ends with its request instead: the
  //    undo below deletes it, and a trigger (0171) deletes it whenever the
  //    request is cancelled or declined or stops pointing at it.
  //
  //    The condition is `busy_block_id` alone, deliberately (#1464, L121). It used
  //    to also skip whenever `side_effects.busy_block` began with "ok", which made
  //    the step decide from its own success MARKER instead of from the artifact.
  //    When the reconcile sweep deleted the row, the FK (ON DELETE SET NULL) left
  //    `busy_block_id` null while the effect still read "ok (slate fallback)", so
  //    the retry that exists to repair exactly this request skipped the only step
  //    that was broken, permanently. The id is the artifact's own existence, so a
  //    null id with an "ok" effect is damage and gets re-created.
  // Read through the patch with `in`, never `??`: a vanished event's id is cleared to
  // null in the patch (#3365), and `??` would fall back to the stale id.
  const agentEventId = "agent_event_id" in patch ? patch.agent_event_id : request.agent_event_id;
  if (!request.busy_block_id) {
    const blockId = await deps.insertBusyBlock(heldWindowBlock(request, agent.id));
    if (blockId) {
      patch.busy_block_id = blockId;
      effects[EFFECTS.busyBlock] = agentEventId ? "ok" : "ok (slate fallback)";
      if (!agentEventId) {
        await deps.alertOps(
          "ooo_busy_block_fallback",
          oooBusyBlockFallbackAlert(request.id),
        );
      }
    } else {
      effects[EFFECTS.busyBlock] = "failed";
    }
  } else if (agentEventId && effects[EFFECTS.busyBlock] === "ok (slate fallback)") {
    // 3b. A retry created the agent event a fallback approval was missing. The
    //     held block is already the final shape, so it stays exactly as it is and
    //     only the record changes: protection no longer rests on this row alone.
    //     #78 used to re-key the block onto the new event here, which is the very
    //     link #3360 removed.
    effects[EFFECTS.busyBlock] = "ok";
  }

  // 4. Cal.com dual-write (transition only; "skipped" when the flag is off).
  //
  // Three outcomes, kept apart deliberately (#1250/#1249). "ok" means an override
  // now exists. "skipped" means there was nothing to do, because cal.com is
  // unconfigured or the agent has no cal.com account at all, so nobody can book
  // them there: recorded, never paged, because there is no action in it.
  // "failed" means the integration is broken and the absence is NOT reflected in
  // the system still taking real bookings, so it pages.
  //
  // `calcom_synced` means "an override exists that a cancellation must undo" (it
  // is what gates calcomRemoveOverrides below), so a skip must NOT set it. A retry
  // lane (#1253) therefore has to exclude skips by reading side_effects, not by
  // treating this flag as "settled", or it will re-attempt writes that can never
  // succeed.
  if (!request.calcom_synced) {
    const outcome = await deps.calcomAddOverrides({
      requestId: request.id,
      agentUserId: agent.id,
      agentEmail: agent.email,
      startIso: request.starts_at,
      endIso: request.ends_at,
    });
    effects[EFFECTS.calcom] = outcome;
    if (outcome === "ok") patch.calcom_synced = true;
    else if (outcome.startsWith("failed")) {
      await deps.alertOps(
        "ooo_calcom",
        oooCalcomAlert(request.id, outcome),
      );
    }
  }

  // 5. DM the agent (suppressed on silent retries).
  if (opts.notifyAgent && !effects[EFFECTS.agentDm]?.startsWith("ok")) {
    const delivered = await deps.dmUserByEmail(
      agent.email,
      `:white_check_mark: Your time off request was *approved* for ${whenLineFor(request)}.\n\n*Your reason:* ${request.reason}`,
    );
    effects[EFFECTS.agentDm] = delivered ? "ok" : "failed: dm undeliverable";
    if (!delivered) {
      await deps.alertOps(
        "ooo_agent_dm",
        oooAgentDmAlert(agent.email, request.id),
      );
    }
  }

  // 6. Coverage sweep (#1237): the agent is definitely absent, so every appointment still
  //    ahead of them inside the window has to move to somebody who is not.
  //
  //    LAST, and never able to throw. The steps above are what stop the agent being booked
  //    again; losing them to a sweep failure would make the absence worse than not sweeping at
  //    all. A `failed` outcome is recorded and is retryable through the existing admin path.
  //
  //    Skipped once the effect starts with "ok", which is the right test HERE and not the
  //    #1464 mistake it may resemble: the artifact is a job row this function does not hold an
  //    id for, and the enqueue is idempotent by a database key on (request, window) anyway, so
  //    the marker is a cheap first gate rather than the only guard. Re-running would also move
  //    customers' bookings a second time, which is not a harmless duplicate.
  //
  //    The outcome is also RETURNED, not just recorded (#1239): the manager's message is
  //    edited to say what actually moved, and reading that back out of the recorded
  //    "ok (3 queued)" string would be re-deriving a fact from its own rendering.
  let coverage: CoverageSweepState = { kind: "already" };
  if (!effects[EFFECTS.coverage]?.startsWith("ok")) {
    try {
      const outcome = await deps.startCoverageSweep({
        requestId: request.id,
        outUserId: agent.id,
        // The request's OWN bounds, exact timestamps rather than whole days, so a half day
        // absence does not pull in the whole day's appointments.
        startIso: request.starts_at,
        endIso: request.ends_at,
        createdBy: opts.actorId,
      });
      coverage = { kind: "queued", queued: outcome.queued, moves: outcome.moves };
      // Nothing to move is a measured answer and reads differently from a failure: one needs
      // no action, the other is retryable (L11).
      effects[EFFECTS.coverage] =
        outcome.queued > 0 ? `ok (${outcome.queued} queued)` : "ok (none in window)";
    } catch (e) {
      const reason = shortReason(e);
      coverage = { kind: "failed", reason };
      effects[EFFECTS.coverage] = `failed: ${reason}`;
    }
  }

  patch.side_effects = effects;
  await deps.patchRequest(request.id, patch);
  return { request: { ...request, ...patch }, coverage };
}

/**
 * The row that holds an approved window (#3360): Slate written, keyed on nothing
 * the calendar sync writes, owned by the request, with a source of its own that no
 * sweep of 'slate' or 'gcal' rows can see (#3365, migration 0171). One constructor,
 * so approval and retry can never write two different shapes.
 */
export function heldWindowBlock(
  request: Pick<OooRequest, "id" | "starts_at" | "ends_at">,
  agentId: string,
): OooBusyBlockInsert {
  return {
    user_id: agentId,
    starts_at: request.starts_at,
    ends_at: request.ends_at,
    source: "ooo",
    gcal_event_id: null,
    calendar_id: null,
    ooo_request_id: request.id,
  };
}

/** One line, no stack: side_effects is read by a person in an admin panel, and a pasted
 *  Google or Postgres stack there is unreadable and pushes the actual reason off screen. */
function shortReason(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return text.split("\n")[0]!.slice(0, 200);
}

/**
 * Stop the coverage sweep, and answer what to TELL the reader about it (#1665).
 *
 * Called after the status transition has committed, never before, and that is the
 * whole of the concurrency reasoning on this side: the transition is the atomic
 * claim on the cancellation, so reaching this line means this call is the one that
 * closed the request, and an approval that lost the race never enqueued anything to
 * stop. Everything about the sweep's own races (a drain part way through its batch,
 * an item mid move) is settled by conditional writes in
 * `coverage-sweep-cancel.ts`, not here.
 *
 * Never throws. The request is already cancelled by the time this runs and there is
 * no rolling that back, so a failure here becomes a state the reader is TOLD about
 * plus a page, rather than an exception that loses the cancellation.
 */
async function stopCoverage(
  request: OooRequest,
  deps: OooDeps,
): Promise<CoverageStopState> {
  try {
    const report = await deps.stopCoverageSweep({ requestId: request.id });
    return { kind: "checked", stopped: report.stopped, alreadyMoved: report.alreadyMoved };
  } catch (e) {
    await deps.alertOps(
      "ooo_coverage_stop",
      oooCoverageStopAlert(request.id, shortReason(e)),
    );
    return { kind: "failed" };
  }
}

/**
 * Recorded on an artifact that still shows the window a request had before it was
 * narrowed (#3365), so re-approval knows exactly what to move and nothing else.
 */
export const EARLIER_WINDOW = "failed: still on the earlier window";

/**
 * Move what an approval holds to the request's current, narrower window (#3365).
 *
 * The agent's own event first, because the held block FOLLOWS it: if the event could
 * not be moved, the block is deliberately left on the earlier window too, so Slate and
 * the agent's calendar go on agreeing about what is blocked (over-blocking is the safe
 * direction), and the failure is said out loud. A vanished event (404) has its id
 * cleared, so the next approval or retry creates it afresh, and the block then narrows,
 * since it is the only thing blocking the window.
 *
 * `onlyWhereEarlier` is the re-approval form: touch only what was recorded as still on
 * the earlier window. Writes into `effects` and `patch`; the caller persists them.
 * Never throws.
 */
async function narrowHeldArtifacts(
  request: OooRequest,
  agent: User,
  deps: OooDeps,
  effects: Record<string, string>,
  patch: Partial<OooRequest>,
  opts: { onlyWhereEarlier: boolean },
): Promise<void> {
  const due = (key: string) =>
    !opts.onlyWhereEarlier || (effects[key] ?? "").startsWith(EARLIER_WINDOW);
  const times = {
    start: request.starts_at,
    end: request.ends_at,
    timezone: request.display_tz_id,
  };

  if (request.agent_event_id && due(EFFECTS.agentEvent)) {
    try {
      const out = await deps.moveCalendarEvent(agent.email, "primary", request.agent_event_id, times);
      if (out === "moved") {
        effects[EFFECTS.agentEvent] = "ok";
      } else {
        patch.agent_event_id = null;
        effects[EFFECTS.agentEvent] = "failed: the calendar event was gone";
      }
    } catch (e) {
      const reason = shortReason(e);
      effects[EFFECTS.agentEvent] = `${EARLIER_WINDOW} (${reason})`;
      await deps.alertOps("ooo_agent_calendar", oooNarrowCalendarAlert(request.id, "agent", reason));
    }
  }

  if (request.manager_event_id && due(EFFECTS.managerEvent)) {
    const calendarId = request.manager_event_calendar_id ?? deps.mainOooCalendarId();
    try {
      const out = await deps.moveCalendarEvent(
        deps.oooCalendarActorEmail(),
        calendarId,
        request.manager_event_id,
        times,
      );
      if (out === "moved") {
        effects[EFFECTS.managerEvent] = "ok";
      } else {
        patch.manager_event_id = null;
        patch.manager_event_calendar_id = null;
        effects[EFFECTS.managerEvent] = "failed: the calendar event was gone";
      }
    } catch (e) {
      const reason = shortReason(e);
      effects[EFFECTS.managerEvent] = `${EARLIER_WINDOW} (${reason})`;
      await deps.alertOps("ooo_manager_calendar", oooNarrowCalendarAlert(request.id, "manager", reason));
    }
  }

  if (request.busy_block_id && due(EFFECTS.busyBlock)) {
    if ((effects[EFFECTS.agentEvent] ?? "").startsWith(EARLIER_WINDOW)) {
      effects[EFFECTS.busyBlock] = `${EARLIER_WINDOW} (kept with the calendar event)`;
    } else {
      const narrowed = await deps.holdNarrowedWindow({
        id: request.busy_block_id,
        requestId: request.id,
        userId: request.user_id,
        startIso: request.starts_at,
        endIso: request.ends_at,
      });
      if (narrowed) {
        const before = effects[EFFECTS.busyBlock] ?? "";
        effects[EFFECTS.busyBlock] = before.startsWith("ok") ? before : "ok";
      } else {
        effects[EFFECTS.busyBlock] = `${EARLIER_WINDOW} (the block could not be narrowed)`;
        await deps.alertOps("busy_block_write_through", oooNarrowHoldAlert(request.id));
      }
    }
  }
}

/** Undo of every approval artifact (cancel + modify-of-approved share this). */
async function undoPostApproval(
  request: OooRequest,
  agent: User,
  deps: OooDeps,
): Promise<Partial<OooRequest>> {
  const actor = deps.oooCalendarActorEmail();
  if (request.manager_event_id) {
    try {
      await deps.deleteCalendarEvent(
        actor,
        request.manager_event_calendar_id ?? deps.mainOooCalendarId(),
        request.manager_event_id,
      );
    } catch (e) {
      await deps.alertOps(
        "ooo_undo",
        oooUndoManagerAlert(request.id, String(e).slice(0, 200)),
      );
    }
  }
  if (request.agent_event_id) {
    try {
      await deps.deleteCalendarEvent(
        agent.email,
        "primary",
        request.agent_event_id,
      );
    } catch (e) {
      await deps.alertOps(
        "ooo_undo",
        oooUndoAgentAlert(request.id, String(e).slice(0, 200)),
      );
    }
  }
  await deps.deleteBusyBlock({
    id: request.busy_block_id,
    userId: agent.id,
    gcalEventId: request.agent_event_id,
  });
  if (request.calcom_synced) await undoCalcom(request, agent, deps);
  return {
    manager_event_id: null,
    manager_event_calendar_id: null,
    agent_event_id: null,
    busy_block_id: null,
    calcom_synced: false,
  };
}

/**
 * Take a request's cal.com override out for the window it holds (#2417, #2890).
 * Shared by the undo and by a narrowing change (#3365), which keeps Slate's held
 * block but treats cal.com exactly as every change did before: removed now, put
 * back for the new window on re-approval.
 */
async function undoCalcom(request: OooRequest, agent: User, deps: OooDeps): Promise<void> {
  // #2417 / L100: the removal recomputes the dates from the agent's REMAINING
  // approved absences, so it can find that the override it was meant to undo
  // was never there. That is not success and it is not silent: cal.com is left
  // correct and somebody is told the two systems had disagreed.
  const outcome = await deps.calcomRemoveOverrides({
    requestId: request.id,
    agentUserId: agent.id,
    agentEmail: agent.email,
    startIso: request.starts_at,
    endIso: request.ends_at,
  });
  if (outcome.startsWith("failed")) {
    await deps.alertOps("ooo_calcom", oooCalcomAlert(request.id, outcome));
  } else if (isRetiredSkip(outcome)) {
    // #2890: cal.com is retired, so the block stays in cal.com, and this request
    // is about to forget the window (the caller sets calcom_synced false, and a
    // change replaces the dates). Recorded, so putting cal.com back can take it out.
    try {
      await deps.recordCalcomRemovalPending({
        requestId: request.id,
        agentUserId: agent.id,
        startIso: request.starts_at,
        endIso: request.ends_at,
        reason: outcome,
      });
    } catch (e) {
      // Its own key, an INCIDENT (#2890 review). Never `ooo_calcom`: the override
      // sweep ends that page with "all in place" as soon as no override is
      // failing, which would clear this while the block is still in cal.com. And
      // there is no healthy state to observe: the window was never recorded, so
      // nothing in Slate can tell when somebody has taken the block out.
      // Keyed per AGENT (#2890 review): the cooldown is per key, so one shared key
      // silenced every second unrecorded block inside the window. Per agent rather
      // than per request because the suffix must be bounded (alert-catalog.ts):
      // agents are bounded by the roster, requests grow forever with nothing to
      // prune their rows. Nothing is lost when one agent's second block collapses
      // into the first page, because that page sends the reader to the agent's
      // whole cal.com schedule, not to one window.
      await deps.alertOps(
        `ooo_calcom_stale_unrecorded:${agent.id}`,
        oooCalcomStaleUnrecordedAlert(request.id, agent.email, shortReason(e)),
      );
    }
  }
}

export async function approveOoo(
  requestId: string,
  actor: User,
  deps: OooDeps,
): Promise<OooActionResult> {
  const request = await deps.loadRequest(requestId);
  if (!request) return fail("Request not found.");
  if (isAdminDecidingOwn(actor, request)) return fail(OWN_REQUEST_REFUSAL);
  if (!canModerate(actor, request)) return fail("Not authorized");
  if (request.status !== "pending") {
    return fail(`This request was already ${request.status}.`);
  }

  const flipped = await deps.transitionRequest(requestId, ["pending"], {
      status: "approved",
      decided_by: actor.id,
      decided_at: deps.nowIso(),
    });
  if (!flipped.ok) return fail("This request was already decided.");

  await deps.recordAudit({
    action: "ooo.approve",
    actorId: actor.id,
    orgId: actor.org_id,
    targetUserId: request.user_id,
    requestId,
  });

  const agent = await deps.getUser(request.user_id);
  if (!agent) return fail("The requesting agent no longer exists.");
  const { request: updated, coverage } = await runPostApproval(flipped.request, agent, deps, {
    notifyAgent: true,
    actorId: actor.id,
  });
  // The edit reports what the sweep ACTUALLY did, and names anything starting soon
  // enough that somebody should also phone the customer (#1239). Built from the
  // finished outcome, so the message and the record cannot disagree (L78).
  await updateManagerStatus(
    request,
    agent,
    deps,
    "approved",
    approvedCoverageLine(coverage, {
      nowIso: deps.nowIso(),
      tzId: request.display_tz_id,
      tzLabel: request.display_tz_label,
    }),
  );
  return { ok: true, request: updated };
}

export async function rejectOoo(
  requestId: string,
  actor: User,
  note: string,
  deps: OooDeps,
): Promise<OooActionResult> {
  const request = await deps.loadRequest(requestId);
  if (!request) return fail("Request not found.");
  if (isAdminDecidingOwn(actor, request)) return fail(OWN_REQUEST_REFUSAL);
  if (!canModerate(actor, request)) return fail("Not authorized");
  if (request.status !== "pending") {
    return fail(`This request was already ${request.status}.`);
  }

  const rejectionNote = note.trim() || DEFAULT_REJECTION_NOTE;
  const flipped = await deps.transitionRequest(requestId, ["pending"], {
      status: "rejected",
      rejection_note: rejectionNote,
      decided_by: actor.id,
      decided_at: deps.nowIso(),
    });
  if (!flipped.ok) return fail("This request was already decided.");

  await deps.recordAudit({
    action: "ooo.reject",
    actorId: actor.id,
    orgId: actor.org_id,
    targetUserId: request.user_id,
    requestId,
  });

  const agent = await deps.getUser(request.user_id);
  // #3365: declining a narrowed request ends the time off, so what its approval held
  // comes down now. After the transition, so a decline that lost the race undoes
  // nothing; the 0171 trigger releases the held block on `rejected` even if this
  // cannot run (no agent row to address the calendar by).
  const released = agent !== null && holdsApprovalArtifacts(request);
  let decided = flipped.request;
  if (released) {
    const undoPatch = await undoPostApproval(request, agent, deps);
    await deps.patchRequest(requestId, undoPatch);
    decided = { ...decided, ...undoPatch };
  }
  if (agent) {
    await deps.dmUserByEmail(
      agent.email,
      `:x: Your time off request for ${whenLineFor(request)} was *declined*.\n\n*Note from your manager:* ${rejectionNote}` +
        (released ? `\n\n${declinedReleasedLine()}` : ""),
    );
    await updateManagerStatus(request, agent, deps, "rejected");
  }
  return { ok: true, request: decided };
}

export async function cancelOoo(
  requestId: string,
  actor: User,
  deps: OooDeps,
): Promise<OooCancelResult> {
  const request = await deps.loadRequest(requestId);
  if (!request) return fail("Request not found.");
  if (!canCancel(actor, request)) return fail("Not authorized");
  if (request.status !== "pending" && request.status !== "approved") {
    return fail(`This request was already ${request.status}.`);
  }
  const wasApproved = request.status === "approved";

  const agent = await deps.getUser(request.user_id);
  if (!agent) return fail("The requesting agent no longer exists.");

  // #3365: a narrowed request waits for re-approval as PENDING while still holding its
  // window, so what to undo is decided by what is held, never by the status.
  const undoPatch =
    wasApproved || holdsApprovalArtifacts(request)
      ? await undoPostApproval(request, agent, deps)
      : {};
  const flipped = await deps.transitionRequest(requestId, ["pending", "approved"], {
      status: "cancelled",
      cancelled_at: deps.nowIso(),
      ...undoPatch,
    });
  if (!flipped.ok) return fail("This request was already closed.");

  await deps.recordAudit({
    action: "ooo.cancel",
    actorId: actor.id,
    orgId: actor.org_id,
    targetUserId: request.user_id,
    requestId,
    details: { was_approved: wasApproved },
  });

  // The sweep the approval started (#1665). Stopped here, AFTER the transition, so
  // this only ever stops a sweep for a request this call really did cancel.
  //
  // Attempted whatever the prior status was, not only for an approved one: a request
  // that was approved, then modified back to pending, and only then cancelled still
  // has a sweep behind it, and the numbers are what decide whether there is anything
  // to say rather than a flag guessing on their behalf.
  //
  // Appointments it already moved stay with the covering advisor (#1219 decision 4):
  // the customer has been told twice by then and the covering advisor holds the slot
  // under their own cap. Both halves are said out loud on both messages, so they are
  // a decision the reader was told rather than one they find out about.
  const coverageNote = cancelledCoverageLine(await stopCoverage(request, deps));
  // #2406: the same event, named the same way it was named on screen. The act is
  // taken from what this call DID, never from the row's status, which now reads
  // `cancelled` whichever of the two produced it (L680).
  const act = cancelActPerformed(wasApproved);
  await deps.dmUserByEmail(
    agent.email,
    cancelAgentDm(act, whenLineFor(request)) +
      (coverageNote ? `\n\n${coverageNote}` : ""),
  );
  await updateManagerStatus(request, agent, deps, "cancelled", coverageNote);
  if (!wasApproved && request.manager_id) {
    const manager = await deps.getUser(request.manager_id);
    if (manager) {
      await deps.dmUserByEmail(
        manager.email,
        cancelManagerDm(act, agentDisplayName(agent), whenLineFor(request)),
      );
    }
  }
  return { ok: true, request: flipped.request, act };
}

export interface ModifyOooInput extends SubmitOooInput {
  /** When omitted, reason/notes keep their current values. */
  reason: string;
  notes?: string;
}

/**
 * Port of handleModifyOOO_: the requester replaces the window (and optionally
 * reason/notes). A pending request just updates. One that holds an approval goes
 * back to pending for re-approval, and what happens to what it holds depends on the
 * new window (#3365):
 *
 *  - INSIDE what is held (narrower, or the same): nothing new is being asked for, so
 *    the held block and both calendar events are KEPT and moved to the new window,
 *    and stay in force while the manager decides. Before #3365 every change undid
 *    them, so shortening a day opened all of it to bookings until re-approval.
 *  - anything else (wider, or moved): everything comes down, as before, because a
 *    manager has not agreed to the new hours.
 */
export async function modifyOoo(
  requestId: string,
  actor: User,
  input: ModifyOooInput,
  deps: OooDeps,
): Promise<OooActionResult> {
  const request = await deps.loadRequest(requestId);
  if (!request) return fail("Request not found.");
  if (!canModify(actor, request)) return fail("Not authorized");
  if (request.status !== "pending" && request.status !== "approved") {
    return fail(`This request can no longer be changed (${request.status}).`);
  }
  const windowError = validateWindow(input.startIso, input.endIso);
  if (windowError) return fail(windowError);

  const overlap = await findOverlap(
    request.user_id,
    input.startIso,
    input.endIso,
    deps,
    requestId,
  );
  if (!overlap.measured) return fail(OVERLAP_UNREADABLE_MESSAGE);
  if (overlap.clash) return fail(overlapError(overlap.clash), overlap.clash.id);

  const wasApproved = request.status === "approved";
  const agent = await deps.getUser(request.user_id);
  if (!agent) return fail("The requesting agent no longer exists.");

  // What it holds, not its status, decides (#3365): a narrowed request is pending and
  // still holds its window. `reapproval` keeps today's meaning for an approved request
  // that holds nothing at all (one imported from the old tool, #1485).
  const held = holdsApprovalArtifacts(request);
  const reapproval = wasApproved || held;
  const newWindow = { startIso: input.startIso, endIso: input.endIso };
  // Judged against the window the held block REALLY covers, never the row's own: after
  // a failed narrowing the block (and the agent's event with it) is still on the
  // earlier, wider window while the row carries the narrower one, so judging the row
  // would release hours the block still holds. The request's window when it holds no
  // block (only calendar events, which follow the row).
  let heldWindow = { startIso: request.starts_at, endIso: request.ends_at };
  if (held && request.busy_block_id) {
    let blockWindow: { startIso: string; endIso: string } | null;
    try {
      blockWindow = await deps.loadHeldWindow({ id: request.busy_block_id, requestId });
    } catch (e) {
      log.error("ooo", { msg: "held window unreadable; change refused", request_id: requestId }, e);
      return fail(HELD_WINDOW_UNREADABLE_MESSAGE);
    }
    if (blockWindow) heldWindow = blockWindow;
  }
  const keeps = held && windowWithin(newWindow, heldWindow);
  const sameWindow = keeps && windowWithin(heldWindow, newWindow);

  const undoPatch = reapproval && !keeps ? await undoPostApproval(request, agent, deps) : {};
  // A kept request keeps its record of what was written for it, minus what re-approval
  // must do again: tell the agent, put cal.com back, and run the coverage sweep over
  // the new window.
  const keptEffects: Record<string, string> = keeps ? { ...request.side_effects } : {};
  delete keptEffects[EFFECTS.agentDm];
  delete keptEffects[EFFECTS.calcom];
  delete keptEffects[EFFECTS.coverage];

  const stamp = shortDate(deps.nowIso());
  const marker = reapproval
    ? `[Modified ${stamp}, requires re-approval]`
    : `[Modified ${stamp}]`;
  // Strip any prior marker so repeated edits don't stack them in the notes.
  const baseNotes = stripModifiedMarkers(input.notes?.trim() ?? request.notes ?? "");
  // The transition comes FIRST for a kept request too: the calendar sync pages a
  // shortened event of an APPROVED request (#3360), so the events must not move
  // until this request reads pending.
  const flipped = await deps.transitionRequest(requestId, ["pending", "approved"], {
      status: "pending",
      starts_at: input.startIso,
      ends_at: input.endIso,
      display_tz_id: input.displayTzId,
      display_tz_label: input.displayTzLabel,
      all_day: input.allDay,
      reason: input.reason.trim() || request.reason,
      notes: [baseNotes, marker].filter(Boolean).join(" "),
      decided_by: null,
      decided_at: null,
      rejection_note: null,
      side_effects: keptEffects,
      ...undoPatch,
    });
  if (!flipped.ok) {
    return fail(
      flipped.duplicate
        ? DUPLICATE_REQUEST_MESSAGE
        : "This request was already decided. Refresh and try again.",
    );
  }

  await deps.recordAudit({
    action: "ooo.modify",
    actorId: actor.id,
    orgId: actor.org_id,
    targetUserId: request.user_id,
    requestId,
    details: {
      was_approved: wasApproved,
      starts_at: input.startIso,
      ends_at: input.endIso,
      kept_window: keeps,
    },
  });

  let current = flipped.request;
  let stillEarlier: HeldOnEarlier | null = null;
  if (keeps) {
    const effects: Record<string, string> = { ...keptEffects };
    const patch: Partial<OooRequest> = {};
    await narrowHeldArtifacts(flipped.request, agent, deps, effects, patch, {
      onlyWhereEarlier: false,
    });
    if (request.calcom_synced) {
      await undoCalcom(request, agent, deps);
      patch.calcom_synced = false;
    }
    patch.side_effects = effects;
    await deps.patchRequest(requestId, patch);
    current = { ...flipped.request, ...patch };
    // What is REALLY held, so neither message says the removed hours reopened while a
    // block still covers them (L11). The event first: when it did not move, the block
    // was deliberately left with it, and the calendar is what needs repairing.
    stillEarlier = (effects[EFFECTS.agentEvent] ?? "").startsWith(EARLIER_WINDOW)
      ? "calendar"
      : (effects[EFFECTS.busyBlock] ?? "").startsWith(EARLIER_WINDOW)
        ? "block"
        : null;
  }

  // The same gap as the cancel (#1665), and it is worse here rather than milder.
  // A modification returns the request to PENDING, so the agent is bookable again
  // and the absence may not happen at all, while the sweep the old approval started
  // goes on moving that agent's customers away over the OLD window. Narrowing a
  // window is the sharpest version: the appointments the narrowing put back inside
  // the working day are exactly the ones still queued to move.
  //
  // Stopping it is not a loss on re-approval: the enqueue is convergent, so
  // approving again re-arms the stopped items and picks up anything booked in the
  // pending gap (#1235). Placed after the transition, for the same reason as in
  // cancelOoo.
  const coverageNote = cancelledCoverageLine(await stopCoverage(request, deps));

  // notifyManagerOfPending posts a fresh message and overwrites the stored
  // slack ref, so first mark the prior manager message (an 'Approved' or
  // earlier 'Pending') as superseded, once the ref is overwritten its location
  // is lost and it can never be edited again, leaving a stale status forever.
  // Uses the pre-modify `request` (old window + old ref); a no-op when none.
  await updateManagerStatus(request, agent, deps, "superseded", coverageNote);

  const outcome: ModifyOutcome = keeps
    ? { kind: "kept", shortened: !sameWindow, stillEarlier }
    : reapproval
      ? { kind: "released" }
      : { kind: "edited" };
  await notifyManagerOfPending(
    current,
    agent,
    modifyManagerHeading(outcome),
    deps,
    modifyManagerNote(outcome, whenLineFor(request)),
  );
  const agentDm = modifyAgentDm(outcome, whenLineFor(current));
  if (agentDm) await deps.dmUserByEmail(agent.email, agentDm);
  return { ok: true, request: current };
}

/**
 * Admin-only idempotent re-run of post-approval effects, without re-notifying
 * the agent (port of handleAdminApproveSilent_).
 */
export async function retryOooSideEffects(
  requestId: string,
  actor: User,
  deps: OooDeps,
): Promise<OooActionResult> {
  if (!canRetrySideEffects(actor)) {
    return fail("Only a team lead or admin can retry the calendar updates.");
  }
  const request = await deps.loadRequest(requestId);
  if (!request) return fail("Request not found.");
  if (request.status !== "approved") {
    return fail("Only approved requests can have their updates retried.");
  }
  const agent = await deps.getUser(request.user_id);
  if (!agent) return fail("The requesting agent no longer exists.");

  await deps.recordAudit({
    action: "ooo.retry",
    actorId: actor.id,
    orgId: actor.org_id,
    targetUserId: request.user_id,
    requestId,
  });
  const { request: updated } = await runPostApproval(request, agent, deps, {
    notifyAgent: false,
    actorId: actor.id,
  });
  return { ok: true, request: updated };
}
