// Relative value import so this module runs under `node --experimental-strip-types`
// in tests (type-only "@/" imports are erased anyway).
import {
  oooManagerCalendarAlert,
  oooCalendarCreateBothFailedAlert,
  oooCalendarCreateAlert,
  oooAgentCalendarAlert,
  oooBusyBlockFallbackAlert,
  oooCalcomAlert,
  oooAgentDmAlert,
  oooUndoManagerAlert,
  oooUndoAgentAlert,
} from "./alert-copy.ts";
import {
  agentDisplayName,
  managerDisplayName,
  canCancel,
  canHoldManagerOfRecord,
  canModerate,
  canModify,
  canRetrySideEffects,
  DEFAULT_REJECTION_NOTE,
  DUPLICATE_REQUEST_MESSAGE,
  formatRequestWhenAndReason,
  formatWhenLine,
  NO_MANAGER_MESSAGE,
  overlaps,
  shortDate,
  stripModifiedMarkers,
  validateWindow,
} from "./core.ts";
// Relative value import, per this file's header: a "@/" VALUE import is not
// erased and breaks the node --experimental-strip-types suites.
import { roleLabel } from "../auth/roles.ts";
import { reachabilityFromError } from "../google/reachability-classify.ts";
import { deterministicEventId } from "../booking/core.ts";
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
  manager_id: string;
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
  source: "slate" | "gcal";
  gcal_event_id: string | null;
  calendar_id: string | null;
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

export interface OooDeps {
  loadRequest(id: string): Promise<OooRequest | null>;
  /** A user's still-active (pending/approved) requests, for overlap checks. */
  listActiveRequests(
    userId: string,
  ): Promise<
    Pick<
      OooRequest,
      "id" | "starts_at" | "ends_at" | "display_tz_id" | "display_tz_label"
    >[]
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

  /** The agent's primary calendar id from agent_calendars (fallback "primary"). */
  agentPrimaryCalendarId(userId: string): Promise<string>;
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

  /** Returns the inserted busy block id (null on failure — alerted inside). */
  insertBusyBlock(block: OooBusyBlockInsert): Promise<string | null>;
  deleteBusyBlock(args: {
    id: string | null;
    userId: string;
    gcalEventId: string | null;
  }): Promise<void>;

  /** Cal.com dual-write; returns "ok" | "skipped" | "failed: <why>". */
  calcomAddOverrides(
    agentEmail: string,
    startIso: string,
    endIso: string,
  ): Promise<string>;
  calcomRemoveOverrides(
    agentEmail: string,
    startIso: string,
    endIso: string,
  ): Promise<string>;

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

export type OooActionResult =
  | { ok: true; request: OooRequest }
  // `conflictRequestId` is set only on the overlap error, so the form can link
  // straight to the request the agent should edit instead.
  | { ok: false; error: string; conflictRequestId?: string };

const fail = (error: string, conflictRequestId?: string): OooActionResult =>
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

/** The user's first still-active request that overlaps [start, end), or null. */
async function findOverlap(
  userId: string,
  startIso: string,
  endIso: string,
  deps: OooDeps,
  excludeId?: string,
): Promise<OverlapCandidate | null> {
  const active = await deps.listActiveRequests(userId);
  return (
    active.find(
      (r) =>
        r.id !== excludeId && overlaps(startIso, endIso, r.starts_at, r.ends_at),
    ) ?? null
  );
}

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
  if (!agent.manager_id) return fail(NO_MANAGER_MESSAGE);

  const clash = await findOverlap(agent.id, input.startIso, input.endIso, deps);
  if (clash) return fail(overlapError(clash), clash.id);

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
): string {
  return (
    `*${heading}* from ${agentDisplayName(agent)}\n` +
    `${STATUS_LINE[status]}\n` +
    `${formatRequestWhenAndReason(request)}` +
    (request.notes ? `\nNotes: ${request.notes}` : "") +
    `\n<${reviewUrl(deps, request.id)}|Review it here>`
  );
}

async function notifyManagerOfPending(
  request: OooRequest,
  agent: User,
  heading: string,
  deps: OooDeps,
): Promise<void> {
  const text = managerNotice(request, agent, deps, heading, "pending");
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
  const manager =
    namedManager && canHoldManagerOfRecord(namedManager.role) ? namedManager : null;
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
    if (manager) {
      fallbackText = `:warning: *Couldn't DM ${managerDisplayName(manager)}.* Posting here as a fallback; check the Slack bot's DM permissions.\n\n${text}`;
    } else if (namedManager) {
      fallbackText =
        `:warning: *${managerDisplayName(namedManager)} is set as the manager of record but cannot approve time off* ` +
        `(they hold the ${roleLabel(namedManager.role)} role). A team lead or admin can action this, and their ` +
        `manager of record should be corrected in Salesforce.\n\n${text}`;
    } else {
      fallbackText = text;
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
): Promise<void> {
  if (!request.slack_channel || !request.slack_ts) return;
  await deps.editMessage(
    { channel: request.slack_channel, ts: request.slack_ts },
    managerNotice(request, agent, deps, "Time off request", status),
  );
}

/** Effect keys recorded in side_effects (stable: the retry path keys off them). */
export const EFFECTS = {
  managerEvent: "manager_event",
  agentEvent: "agent_event",
  busyBlock: "busy_block",
  calcom: "calcom",
  agentDm: "agent_dm",
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
  opts: { notifyAgent: boolean },
): Promise<OooRequest> {
  const effects: Record<string, string> = { ...request.side_effects };
  const patch: Partial<OooRequest> = {};
  const eventArgs: OooEventArgs = {
    summary: `${agentDisplayName(agent)} - OOO`,
    description: `Request ID: ${request.id}`,
    start: request.starts_at,
    end: request.ends_at,
    timezone: request.display_tz_id,
  };

  // 1. Manager OOO calendar event (per-manager calendar, main fallback).
  if (!request.manager_event_id) {
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
  if (!request.agent_event_id && !effects[EFFECTS.agentEvent]?.startsWith("ok")) {
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
  //    With the agent event in hand we insert source='gcal' + its event id so
  //    the next sync pass upserts onto this same row (no double-counting);
  //    without it we fall back to a slate-source block.
  //
  //    The condition is `busy_block_id` alone, deliberately (#1464, L121). It used
  //    to also skip whenever `side_effects.busy_block` began with "ok", which made
  //    the step decide from its own success MARKER instead of from the artifact.
  //    When the reconcile sweep deleted the row, the FK (ON DELETE SET NULL) left
  //    `busy_block_id` null while the effect still read "ok (slate fallback)", so
  //    the retry that exists to repair exactly this request skipped the only step
  //    that was broken, permanently. The id is the artifact's own existence, so a
  //    null id with an "ok" effect is damage and gets re-created.
  if (!request.busy_block_id) {
    const agentEventId = patch.agent_event_id ?? request.agent_event_id;
    const block: OooBusyBlockInsert = agentEventId
      ? {
          user_id: agent.id,
          starts_at: request.starts_at,
          ends_at: request.ends_at,
          source: "gcal",
          gcal_event_id: agentEventId,
          calendar_id: await deps.agentPrimaryCalendarId(agent.id),
          ooo_request_id: request.id,
        }
      : {
          user_id: agent.id,
          starts_at: request.starts_at,
          ends_at: request.ends_at,
          source: "slate",
          gcal_event_id: null,
          calendar_id: null,
          ooo_request_id: request.id,
        };
    const blockId = await deps.insertBusyBlock(block);
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
  } else if (
    // 3b. Converge a slate fallback once a retry creates the missing agent
    //     event (#78): the slate-source block stays, but sync would now also
    //     mirror the new Google event into a second, overlapping gcal block.
    //     Replace the slate block with a gcal-linked one so the next sync
    //     upserts onto it. Insert the replacement before deleting the old block
    //     so availability is never momentarily unblocked.
    request.busy_block_id &&
    patch.agent_event_id &&
    effects[EFFECTS.busyBlock] === "ok (slate fallback)"
  ) {
    const convergedId = await deps.insertBusyBlock({
      user_id: agent.id,
      starts_at: request.starts_at,
      ends_at: request.ends_at,
      source: "gcal",
      gcal_event_id: patch.agent_event_id,
      calendar_id: await deps.agentPrimaryCalendarId(agent.id),
      ooo_request_id: request.id,
    });
    if (convergedId) {
      await deps.deleteBusyBlock({
        id: request.busy_block_id,
        userId: agent.id,
        gcalEventId: null,
      });
      patch.busy_block_id = convergedId;
      effects[EFFECTS.busyBlock] = "ok";
    }
    // If the converging insert failed, keep the slate block (still blocking)
    // and leave the effect as the fallback so a later retry tries again.
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
    const outcome = await deps.calcomAddOverrides(
      agent.email,
      request.starts_at,
      request.ends_at,
    );
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

  patch.side_effects = effects;
  await deps.patchRequest(request.id, patch);
  return { ...request, ...patch };
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
  if (request.calcom_synced) {
    await deps.calcomRemoveOverrides(
      agent.email,
      request.starts_at,
      request.ends_at,
    );
  }
  return {
    manager_event_id: null,
    manager_event_calendar_id: null,
    agent_event_id: null,
    busy_block_id: null,
    calcom_synced: false,
  };
}

export async function approveOoo(
  requestId: string,
  actor: User,
  deps: OooDeps,
): Promise<OooActionResult> {
  const request = await deps.loadRequest(requestId);
  if (!request) return fail("Request not found.");
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
  const updated = await runPostApproval(flipped.request, agent, deps, {
    notifyAgent: true,
  });
  await updateManagerStatus(request, agent, deps, "approved");
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
  if (agent) {
    await deps.dmUserByEmail(
      agent.email,
      `:x: Your time off request for ${whenLineFor(request)} was *declined*.\n\n*Note from your manager:* ${rejectionNote}`,
    );
    await updateManagerStatus(request, agent, deps, "rejected");
  }
  return { ok: true, request: flipped.request };
}

export async function cancelOoo(
  requestId: string,
  actor: User,
  deps: OooDeps,
): Promise<OooActionResult> {
  const request = await deps.loadRequest(requestId);
  if (!request) return fail("Request not found.");
  if (!canCancel(actor, request)) return fail("Not authorized");
  if (request.status !== "pending" && request.status !== "approved") {
    return fail(`This request was already ${request.status}.`);
  }
  const wasApproved = request.status === "approved";

  const agent = await deps.getUser(request.user_id);
  if (!agent) return fail("The requesting agent no longer exists.");

  const undoPatch = wasApproved
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

  await deps.dmUserByEmail(
    agent.email,
    `Your time off request for ${whenLineFor(request)} was cancelled.`,
  );
  await updateManagerStatus(request, agent, deps, "cancelled");
  if (!wasApproved && request.manager_id) {
    const manager = await deps.getUser(request.manager_id);
    if (manager) {
      await deps.dmUserByEmail(
        manager.email,
        `${agentDisplayName(agent)} withdrew their time off request for ${whenLineFor(request)}.`,
      );
    }
  }
  return { ok: true, request: flipped.request };
}

export interface ModifyOooInput extends SubmitOooInput {
  /** When omitted, reason/notes keep their current values. */
  reason: string;
  notes?: string;
}

/**
 * Port of handleModifyOOO_: the requester replaces the window (and optionally
 * reason/notes). A pending request just updates; an approved one has its
 * artifacts undone and returns to pending for re-approval.
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

  const clash = await findOverlap(
    request.user_id,
    input.startIso,
    input.endIso,
    deps,
    requestId,
  );
  if (clash) return fail(overlapError(clash), clash.id);

  const wasApproved = request.status === "approved";
  const agent = await deps.getUser(request.user_id);
  if (!agent) return fail("The requesting agent no longer exists.");

  const undoPatch = wasApproved
    ? await undoPostApproval(request, agent, deps)
    : {};

  const stamp = shortDate(deps.nowIso());
  const marker = wasApproved
    ? `[Modified ${stamp}, requires re-approval]`
    : `[Modified ${stamp}]`;
  // Strip any prior marker so repeated edits don't stack them in the notes.
  const baseNotes = stripModifiedMarkers(input.notes?.trim() ?? request.notes ?? "");
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
      side_effects: {},
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
    },
  });

  // notifyManagerOfPending posts a fresh message and overwrites the stored
  // slack ref, so first mark the prior manager message (an 'Approved' or
  // earlier 'Pending') as superseded — once the ref is overwritten its location
  // is lost and it can never be edited again, leaving a stale status forever.
  // Uses the pre-modify `request` (old window + old ref); a no-op when none.
  await updateManagerStatus(request, agent, deps, "superseded");

  await notifyManagerOfPending(
    flipped.request,
    agent,
    wasApproved
      ? "Changed time off request (needs re-approval)"
      : "Changed time off request",
    deps,
  );
  if (wasApproved) {
    await deps.dmUserByEmail(
      agent.email,
      `Your changed time off request for ${whenLineFor(flipped.request)} was sent to your manager for re-approval.`,
    );
  }
  return { ok: true, request: flipped.request };
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
    return fail("Only an admin can retry the calendar updates.");
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
  const updated = await runPostApproval(request, agent, deps, {
    notifyAgent: false,
  });
  return { ok: true, request: updated };
}
