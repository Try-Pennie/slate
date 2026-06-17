// Relative value import so this module runs under `node --experimental-strip-types`
// in tests (type-only "@/" imports are erased anyway).
import {
  canCancel,
  canModerate,
  canModify,
  DEFAULT_REJECTION_NOTE,
  DUPLICATE_REQUEST_MESSAGE,
  formatWhenLine,
  NO_MANAGER_MESSAGE,
  overlaps,
  shortDate,
  stripModifiedMarkers,
  validateWindow,
} from "./core.ts";
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
  /** Create an event on `calendarId` impersonating `actorEmail`; returns event id. */
  createCalendarEvent(
    actorEmail: string,
    calendarId: string,
    args: OooEventArgs,
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

  recordAudit(
    action:
      | "ooo.submit"
      | "ooo.approve"
      | "ooo.reject"
      | "ooo.cancel"
      | "ooo.modify"
      | "ooo.retry",
    actorId: string,
    orgId: string,
    requestId: string,
    details?: Record<string, unknown>,
  ): Promise<void>;

  appBaseUrl(): string;
  mainOooCalendarId(): string;
  /** DWD actor for manager/main OOO calendar writes (ooo@trypennie.com). */
  oooCalendarActorEmail(): string;
  nowIso(): string;
}

export type OooActionResult =
  | { ok: true; request: OooRequest }
  | { ok: false; error: string };

const fail = (error: string): OooActionResult => ({ ok: false, error });

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
  if (clash) return fail(overlapError(clash));

  const inserted = await deps.insertRequest({
    org_id: agent.org_id,
    user_id: agent.id,
    manager_id: agent.manager_id,
    starts_at: input.startIso,
    ends_at: input.endIso,
    display_tz_id: input.displayTzId,
    display_tz_label: input.displayTzLabel,
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

  await deps.recordAudit("ooo.submit", agent.id, agent.org_id, request.id, {
    starts_at: request.starts_at,
    ends_at: request.ends_at,
  });
  await notifyManagerOfPending(request, agent, "New time off request", deps);
  return { ok: true, request };
}

const STATUS_LINE = {
  pending: ":hourglass_flowing_sand: *Pending your approval*",
  approved: ":white_check_mark: *Approved*",
  rejected: ":x: *Declined*",
  cancelled: ":no_entry_sign: *Cancelled*",
} as const;

function managerNotice(
  request: OooRequest,
  agent: User,
  deps: OooDeps,
  heading: string,
  status: keyof typeof STATUS_LINE,
): string {
  return (
    `*${heading}* from ${agent.name ?? agent.email}\n` +
    `${STATUS_LINE[status]}\n` +
    `${whenLineFor(request)}\n` +
    `Reason: ${request.reason}` +
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
  const manager = request.manager_id
    ? await deps.getUser(request.manager_id)
    : null;
  // Pass the request id so the notification carries Approve/Decline buttons.
  let ref = manager
    ? await deps.dmUserByEmail(manager.email, text, request.id)
    : null;
  if (!ref) {
    // The DM failed (or no manager resolved). Post to the fallback channel, and
    // when a manager was expected, flag it so someone checks why the DM failed
    // (usually the bot is missing users:read.email / im:write).
    const fallbackText = manager
      ? `:warning: *Couldn't DM ${manager.name ?? manager.email}.* Posting here as a fallback; check the Slack bot's DM permissions.\n\n${text}`
      : text;
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
    summary: `${agent.name ?? agent.email} - OOO`,
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
      patch.manager_event_id = await deps.createCalendarEvent(
        actor,
        preferred,
        eventArgs,
      );
      patch.manager_event_calendar_id = preferred;
      effects[EFFECTS.managerEvent] = "ok";
    } catch (e) {
      const main = deps.mainOooCalendarId();
      if (preferred !== main) {
        try {
          patch.manager_event_id = await deps.createCalendarEvent(
            actor,
            main,
            eventArgs,
          );
          patch.manager_event_calendar_id = main;
          effects[EFFECTS.managerEvent] = "ok (main fallback)";
          await deps.alertOps(
            "ooo_manager_calendar",
            `Slate: the OOO calendar for request ${request.id} was not accessible (${String(e).slice(0, 200)}); the event landed on the main OOO calendar instead.`,
          );
        } catch (e2) {
          effects[EFFECTS.managerEvent] = `failed: ${String(e2).slice(0, 200)}`;
          await deps.alertOps(
            "ooo_calendar_create",
            `Slate: creating the OOO calendar event for request ${request.id} failed on both the manager and main calendars: ${String(e2).slice(0, 200)}`,
          );
        }
      } else {
        effects[EFFECTS.managerEvent] = `failed: ${String(e).slice(0, 200)}`;
        await deps.alertOps(
          "ooo_calendar_create",
          `Slate: creating the OOO calendar event for request ${request.id} failed: ${String(e).slice(0, 200)}`,
        );
      }
    }
  }

  // 2. Agent-calendar event (best-effort) — this is what blocks availability
  //    once synced, and the busy block below makes it immediate.
  if (!request.agent_event_id && !effects[EFFECTS.agentEvent]?.startsWith("ok")) {
    try {
      patch.agent_event_id = await deps.createCalendarEvent(
        agent.email,
        "primary",
        {
          ...eventArgs,
          description:
            `Reason: ${request.reason}` +
            (request.notes ? `: ${request.notes}` : "") +
            `\nRequest ID: ${request.id}`,
        },
      );
      effects[EFFECTS.agentEvent] = "ok";
    } catch (e) {
      effects[EFFECTS.agentEvent] = `failed: ${String(e).slice(0, 200)}`;
      await deps.alertOps(
        "ooo_agent_calendar",
        `Slate: creating the agent calendar OOO event for request ${request.id} failed: ${String(e).slice(0, 200)}`,
      );
    }
  }

  // 3. busy_blocks write-through so the embed stops offering the window now.
  //    With the agent event in hand we insert source='gcal' + its event id so
  //    the next sync pass upserts onto this same row (no double-counting);
  //    without it we fall back to a slate-source block.
  if (!request.busy_block_id && !effects[EFFECTS.busyBlock]?.startsWith("ok")) {
    const agentEventId = patch.agent_event_id ?? request.agent_event_id;
    const block: OooBusyBlockInsert = agentEventId
      ? {
          user_id: agent.id,
          starts_at: request.starts_at,
          ends_at: request.ends_at,
          source: "gcal",
          gcal_event_id: agentEventId,
          calendar_id: await deps.agentPrimaryCalendarId(agent.id),
        }
      : {
          user_id: agent.id,
          starts_at: request.starts_at,
          ends_at: request.ends_at,
          source: "slate",
          gcal_event_id: null,
          calendar_id: null,
        };
    const blockId = await deps.insertBusyBlock(block);
    if (blockId) {
      patch.busy_block_id = blockId;
      effects[EFFECTS.busyBlock] = agentEventId ? "ok" : "ok (slate fallback)";
      if (!agentEventId) {
        await deps.alertOps(
          "ooo_busy_block_fallback",
          `Slate: availability for request ${request.id} was blocked with a Slate-native busy block (the calendar-linked one couldn't be used because the agent calendar event wasn't created). Availability is blocked correctly; flagging the fallback.`,
        );
      }
    } else {
      effects[EFFECTS.busyBlock] = "failed";
    }
  }

  // 4. Cal.com dual-write (transition only; "skipped" when the flag is off).
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
        `Slate: the Cal.com availability override for request ${request.id} failed (${outcome}).`,
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
        `Slate: the approval DM to ${agent.email} for request ${request.id} could not be delivered.`,
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
        `Slate: removing the manager OOO event for request ${request.id} failed: ${String(e).slice(0, 200)}`,
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
        `Slate: removing the agent calendar OOO event for request ${request.id} failed: ${String(e).slice(0, 200)}`,
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

  await deps.recordAudit("ooo.approve", actor.id, actor.org_id, requestId);

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

  await deps.recordAudit("ooo.reject", actor.id, actor.org_id, requestId);

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

  await deps.recordAudit("ooo.cancel", actor.id, actor.org_id, requestId, {
    was_approved: wasApproved,
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
        `${agent.name ?? agent.email} withdrew their time off request for ${whenLineFor(request)}.`,
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
  if (clash) return fail(overlapError(clash));

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

  await deps.recordAudit("ooo.modify", actor.id, actor.org_id, requestId, {
    was_approved: wasApproved,
    starts_at: input.startIso,
    ends_at: input.endIso,
  });

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
  if (actor.role !== "admin") return fail("Not authorized");
  const request = await deps.loadRequest(requestId);
  if (!request) return fail("Request not found.");
  if (request.status !== "approved") {
    return fail("Only approved requests can have their updates retried.");
  }
  const agent = await deps.getUser(request.user_id);
  if (!agent) return fail("The requesting agent no longer exists.");

  await deps.recordAudit("ooo.retry", actor.id, actor.org_id, requestId);
  const updated = await runPostApproval(request, agent, deps, {
    notifyAgent: false,
  });
  return { ok: true, request: updated };
}
