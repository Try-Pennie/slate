// Orchestration tests for the OOO flow, driven through in-memory fakes of
// OooDeps (no DB/Google/Slack). Covers submit (happy/duplicate/no-manager),
// approval side effects + fallbacks, reject, cancel undo, modify re-approval,
// and the silent retry path.
// Run: node --experimental-strip-types scripts/test-ooo-orchestration.ts
import {
  approveOoo,
  cancelOoo,
  modifyOoo,
  rejectOoo,
  retryOooSideEffects,
  submitOoo,
  type OooDeps,
} from "../src/lib/ooo/orchestration.ts";
import {
  agentDisplayName,
  DEFAULT_REJECTION_NOTE,
  NO_MANAGER_MESSAGE,
} from "../src/lib/ooo/core.ts";
import type { OooRequest, User } from "../src/lib/db/types.ts";
import { GoogleHttpError } from "../src/lib/google/http-error.ts";
import { assert, finish } from "./lib/harness.ts";

/**
 * The audit entry for one action, or null. Every ooo.* audit row records the
 * agent the request is ABOUT as its target (audit_log.target_id FKs users), and
 * carries the request id in details instead, where no foreign key applies.
 */
function auditFor(w: World, action: string): AuditRecord | null {
  return w.audits.find((a) => a.action === action) ?? null;
}

function assertAudited(w: World, action: string, targetUserId: string, requestId: string) {
  const rec = auditFor(w, action);
  assert(rec !== null, `${action} audited`);
  assert(rec!.targetUserId === targetUserId, `${action} targets the agent, not the request`);
  assert(rec!.requestId === requestId, `${action} records which request it was`);
}

const baseUser = {
  org_id: "org-1",
  auth_user_id: null,
  google_sub: null,
  attributes: {},
  bookable: true,
  ooo_calendar_id: null,
  created_at: "2026-01-01T00:00:00Z",
};
const agent: User = {
  ...baseUser,
  id: "u-agent",
  email: "agent@trypennie.com",
  name: "Aria Agent",
  role: "agent",
  manager_id: "u-mgr",
};
// A name-less agent so the two consolidated display sites (calendar summary,
// withdrawal notice) exercise the shared agentDisplayName email fallback (#1008).
const namelessAgent: User = {
  ...baseUser,
  id: "u-nameless",
  email: "noname@trypennie.com",
  name: null,
  role: "agent",
  manager_id: "u-mgr",
};
const manager: User = {
  ...baseUser,
  id: "u-mgr",
  email: "mgr@trypennie.com",
  name: "Mona Manager",
  role: "manager",
  manager_id: null,
  ooo_calendar_id: "mgr-ooo-cal@group.calendar.google.com",
};
const admin: User = {
  ...baseUser,
  id: "u-admin",
  email: "admin@trypennie.com",
  name: "Ada Admin",
  role: "admin",
  manager_id: null,
};
const stranger: User = {
  ...baseUser,
  id: "u-other",
  email: "other@trypennie.com",
  name: "Oz Other",
  role: "manager",
  manager_id: null,
};
// #1468: the rank ABOVE admin. The retry gated on `role !== "admin"`, so the
// only role that outranks admin was the one refused, and the person holding it
// is the one who reaches for the repair.
const superAdmin: User = {
  ...baseUser,
  id: "u-super",
  email: "super@trypennie.com",
  name: "Sam Super",
  role: "super_admin",
  manager_id: null,
};
// The rank directly BELOW admin: moderates any request, but does not repair one.
const teamLead: User = {
  ...baseUser,
  id: "u-lead",
  email: "lead@trypennie.com",
  name: "Lee Lead",
  role: "team_lead",
  manager_id: null,
};

interface AuditRecord {
  action: string;
  actorId: string;
  orgId: string;
  targetUserId: string;
  requestId: string;
  details?: Record<string, unknown>;
}

interface World {
  deps: OooDeps;
  requests: Map<string, OooRequest>;
  dms: { email: string; text: string }[];
  channelPosts: string[];
  edits: { ref: { channel: string; ts: string }; text: string }[];
  alerts: { key: string; message: string }[];
  createdEvents: { actor: string; calendarId: string; summary: string; id: string }[];
  deletedEvents: { actor: string; calendarId: string; eventId: string }[];
  busyBlocks: Map<string, Record<string, unknown>>;
  // The WHOLE audit entry, not just the action. Recording only the action is how
  // #1220 hid for two months: every ooo.* write was failing its target_id
  // foreign key in prod while this fake happily accepted the request id.
  audits: AuditRecord[];
  failCalendars: Set<string>;
  failAgentEvent: boolean;
  /** What the cal.com dual-write returns, so a test can drive the skip and the
   *  failure paths apart (#1249/#1250). */
  calcomOutcome: string;
}

function makeWorld(): World {
  let eventSeq = 0;
  let blockSeq = 0;
  let reqSeq = 0;
  const world: World = {
    requests: new Map(),
    dms: [],
    channelPosts: [],
    edits: [],
    alerts: [],
    createdEvents: [],
    deletedEvents: [],
    busyBlocks: new Map(),
    audits: [],
    failCalendars: new Set(),
    failAgentEvent: false,
    /** Transient failures to serve on the agent calendar before succeeding (#1469). */
    transientAgentFailures: 0,
    /** A permanent Google refusal on the agent calendar, which must NOT be retried. */
    permanentAgentFailure: false,
    /** Every client id the orchestration sent, in order (#1469 idempotency). */
    clientIds: [] as (string | undefined)[],
    calcomOutcome: "skipped",
    /** The roster getUser reads, exposed so a test can add its own fixture user. */
    users: new Map<string, User>(
      [agent, namelessAgent, manager, admin, superAdmin, teamLead, stranger].map(
        (u) => [u.id, u] as const,
      ),
    ),
    deps: null as unknown as OooDeps,
  };
  const users = world.users;
  const isDuplicate = (
    userId: string,
    startsAt: string,
    endsAt: string,
    excludeId?: string,
  ) =>
    [...world.requests.values()].some(
      (r) =>
        r.id !== excludeId &&
        r.user_id === userId &&
        r.starts_at === startsAt &&
        r.ends_at === endsAt &&
        (r.status === "pending" || r.status === "approved"),
    );

  world.deps = {
    loadRequest: async (id) => world.requests.get(id) ?? null,
    listActiveRequests: async (userId) =>
      [...world.requests.values()]
        .filter(
          (r) =>
            r.user_id === userId &&
            (r.status === "pending" || r.status === "approved"),
        )
        .map((r) => ({
          id: r.id,
          starts_at: r.starts_at,
          ends_at: r.ends_at,
          display_tz_id: r.display_tz_id,
          display_tz_label: r.display_tz_label,
        })),
    insertRequest: async (row) => {
      if (isDuplicate(row.user_id, row.starts_at, row.ends_at)) {
        return { ok: false, duplicate: true };
      }
      const request: OooRequest = {
        id: `req-${++reqSeq}`,
        rejection_note: null,
        decided_by: null,
        decided_at: null,
        cancelled_at: null,
        manager_event_id: null,
        manager_event_calendar_id: null,
        agent_event_id: null,
        busy_block_id: null,
        calcom_synced: false,
        side_effects: {},
        legacy_request_id: null,
        created_at: "2026-06-12T00:00:00Z",
        updated_at: "2026-06-12T00:00:00Z",
        ...row,
      };
      world.requests.set(request.id, request);
      return { ok: true, request };
    },
    transitionRequest: async (id, from, patch) => {
      const current = world.requests.get(id);
      if (!current || !from.includes(current.status)) {
        return { ok: false, duplicate: false };
      }
      const startsAt = (patch.starts_at as string) ?? current.starts_at;
      const endsAt = (patch.ends_at as string) ?? current.ends_at;
      const nextStatus = (patch.status as OooRequest["status"]) ?? current.status;
      if (
        (nextStatus === "pending" || nextStatus === "approved") &&
        isDuplicate(current.user_id, startsAt, endsAt, id)
      ) {
        return { ok: false, duplicate: true };
      }
      const next = { ...current, ...patch } as OooRequest;
      world.requests.set(id, next);
      return { ok: true, request: next };
    },
    patchRequest: async (id, patch) => {
      const current = world.requests.get(id);
      if (current) world.requests.set(id, { ...current, ...patch } as OooRequest);
    },
    getUser: async (userId) => users.get(userId) ?? null,
    agentPrimaryCalendarId: async () => "agent-cal-id",
    createCalendarEvent: async (actorEmail, calendarId, args, clientId) => {
      if (calendarId === "primary") world.clientIds.push(clientId);
      if (world.failCalendars.has(calendarId)) {
        throw new Error(`no access to ${calendarId}`);
      }
      if (world.failAgentEvent && calendarId === "primary") {
        throw new Error("agent calendar unavailable");
      }
      if (world.permanentAgentFailure && calendarId === "primary") {
        throw new GoogleHttpError("events.insert failed: 404 not found", 404);
      }
      if (world.transientAgentFailures > 0 && calendarId === "primary") {
        world.transientAgentFailures--;
        throw new Error("AbortError: The operation was aborted");
      }
      const id = `evt-${++eventSeq}`;
      world.createdEvents.push({ actor: actorEmail, calendarId, summary: args.summary, id });
      return id;
    },
    deleteCalendarEvent: async (actorEmail, calendarId, eventId) => {
      world.deletedEvents.push({ actor: actorEmail, calendarId, eventId });
    },
    insertBusyBlock: async (block) => {
      const id = `blk-${++blockSeq}`;
      world.busyBlocks.set(id, { ...block });
      return id;
    },
    deleteBusyBlock: async ({ id, userId, gcalEventId }) => {
      if (id) world.busyBlocks.delete(id);
      for (const [key, b] of world.busyBlocks) {
        if (b.user_id === userId && gcalEventId && b.gcal_event_id === gcalEventId) {
          world.busyBlocks.delete(key);
        }
      }
    },
    calcomAddOverrides: async () => world.calcomOutcome,
    calcomRemoveOverrides: async () => "skipped",
    dmUserByEmail: async (email, text) => {
      world.dms.push({ email, text });
      return { channel: `D-${email}`, ts: `ts-dm-${world.dms.length}` };
    },
    postFallbackChannel: async (text) => {
      world.channelPosts.push(text);
      return { channel: "C-alerts", ts: `ts-ch-${world.channelPosts.length}` };
    },
    editMessage: async (ref, text) => {
      world.edits.push({ ref, text });
    },
    alertOps: async (key, message) => {
      world.alerts.push({ key, message });
    },
    // Stands in for the real audit_log insert, INCLUDING its foreign keys:
    // target_id references users(id), so a target that is not a user in this
    // world is the exact rejection prod gave us. Fail loud here rather than
    // recording it, so a repeat of #1220 goes red in this suite.
    recordAudit: async (entry) => {
      if (!users.has(entry.targetUserId)) {
        throw new Error(
          `audit_log.target_id FKs users(id): "${entry.targetUserId}" is not a user ` +
            `(action ${entry.action}). A request id is not a user id.`,
        );
      }
      if (!users.has(entry.actorId)) {
        throw new Error(
          `audit_log.actor_id FKs users(id): "${entry.actorId}" is not a user ` +
            `(action ${entry.action}).`,
        );
      }
      world.audits.push(entry);
    },
    appBaseUrl: () => "https://slate.test",
    mainOooCalendarId: () => "main-ooo-cal",
    oooCalendarActorEmail: () => "ooo@trypennie.com",
    nowIso: () => "2026-06-12T12:00:00Z",
  };
  return world;
}

const input = {
  startIso: "2026-07-01T13:00:00Z",
  endIso: "2026-07-01T21:00:00Z",
  displayTzId: "America/New_York",
  displayTzLabel: "ET",
  allDay: false,
  reason: "Family trip",
  notes: "Back Thursday",
};

// --- submit ---
{
  const w = makeWorld();
  const res = await submitOoo(agent, input, w.deps);
  assert(res.ok, "submit succeeds");
  if (res.ok) {
    assert(res.request.status === "pending", "submitted request is pending");
    assert(res.request.manager_id === "u-mgr", "manager snapshot stored");
    assert(res.request.all_day === false, "all_day stored from the input");
  }
  // An all-day request stores all_day=true (read directly, not inferred).
  {
    const w2 = makeWorld();
    const allDayRes = await submitOoo(
      agent,
      {
        ...input,
        startIso: "2026-09-01T04:00:00Z",
        endIso: "2026-09-02T03:59:00Z",
        allDay: true,
      },
      w2.deps,
    );
    assert(
      allDayRes.ok && allDayRes.request.all_day === true,
      "all-day submit stores all_day=true",
    );
  }
  assert(w.dms.length === 1 && w.dms[0].email === manager.email, "manager DM'd");
  assert(w.dms[0].text.includes("https://slate.test/admin/ooo?request=req-1"), "DM has deep link");
  assert(w.dms[0].text.includes("Family trip"), "DM includes reason");
  assert(w.dms[0].text.includes("Pending your approval"), "DM shows pending status");
  assert(
    res.ok && w.requests.get(res.request.id)?.slack_ts === "ts-dm-1",
    "manager message ref stored on the request",
  );
  assert(res.ok, "submit succeeded before auditing it");
  assertAudited(w, "ooo.submit", agent.id, res.ok ? res.request.id : "");

  const dup = await submitOoo(agent, input, w.deps);
  assert(
    !dup.ok && /overlaps a request you already have/.test(dup.error ?? ""),
    "exact duplicate caught as an overlap",
  );

  // A different window that still overlaps the pending one is blocked too, and
  // the message points the agent at the existing request to edit.
  const overlapping = await submitOoo(
    agent,
    {
      ...input,
      startIso: "2026-07-01T18:00:00Z",
      endIso: "2026-07-01T23:00:00Z",
    },
    w.deps,
  );
  assert(
    !overlapping.ok && /Edit that request instead/.test(overlapping.error ?? ""),
    "overlapping (non-identical) window blocked with edit hint",
  );
  assert(
    !overlapping.ok &&
      res.ok &&
      overlapping.conflictRequestId === res.request.id,
    "overlap error carries the clashing request id to link to",
  );

  // A window that clears the existing one entirely goes through.
  const clear = await submitOoo(
    agent,
    {
      ...input,
      startIso: "2026-07-08T13:00:00Z",
      endIso: "2026-07-08T21:00:00Z",
    },
    w.deps,
  );
  assert(clear.ok, "non-overlapping window accepted");

  // Over the max length is rejected by validateWindow before any overlap check.
  const tooLong = await submitOoo(
    agent,
    {
      ...input,
      startIso: "2026-01-01T00:00:00Z",
      endIso: "2026-06-01T00:00:00Z",
    },
    w.deps,
  );
  assert(
    !tooLong.ok && /can't be longer than/.test(tooLong.error ?? ""),
    "over-max-length window blocked",
  );

  const noMgr = await submitOoo({ ...agent, manager_id: null }, input, w.deps);
  assert(!noMgr.ok && noMgr.error === NO_MANAGER_MESSAGE, "no manager blocks submit");

  const badWindow = await submitOoo(
    agent,
    { ...input, endIso: input.startIso },
    w.deps,
  );
  assert(!badWindow.ok, "zero-length window blocked");
}

// --- submit falls back to channel when manager DM undeliverable, flagged ---
{
  const w = makeWorld();
  w.deps.dmUserByEmail = async () => null;
  const sub = await submitOoo(agent, input, w.deps);
  assert(w.channelPosts.length === 1, "fallback channel post when DM fails");
  assert(w.channelPosts[0].includes("Couldn't DM"), "fallback post flags the DM failure");
  assert(
    sub.ok && w.requests.get(sub.request.id)?.slack_channel === "C-alerts",
    "message ref stored from the fallback post",
  );
}

// --- #1475: an unqualified manager of record is not DMed buttons it cannot use ---
//
// The pending notification carries Approve/Decline buttons, and those buttons run
// through canModerate. Since a manager of record must now hold at least `manager`,
// DMing an AGENT named as somebody's manager would hand them a control that answers
// "Not authorized" with nothing on screen explaining why (L109). It goes to the
// fallback channel instead, where team leads and up see it, and the post says WHY
// rather than reading like a Slack permissions problem.
{
  const w = makeWorld();
  // An agent set as this requester's manager of record: the exact live shape, where
  // a manager had one of his own agents as his approver.
  const agentApprover: User = {
    ...agent,
    id: "u-agent-approver",
    email: "approver-agent@trypennie.com",
    name: "Andy Approver",
    role: "agent",
  };
  w.users.set(agentApprover.id, agentApprover);
  const requester: User = { ...agent, id: "u-req", email: "req@trypennie.com", manager_id: agentApprover.id };
  w.users.set(requester.id, requester);

  const sub = await submitOoo(requester, input, w.deps);
  assert(sub.ok, "the request is still accepted (routing changes, submission does not)");
  assert(
    w.dms.every((d) => d.email !== agentApprover.email),
    "an agent named as manager of record is NOT DMed the approve buttons",
  );
  assert(w.channelPosts.length === 1, "it goes to the fallback channel instead");
  assert(
    w.channelPosts[0].includes("cannot approve time off"),
    `the post says the named manager cannot approve (got: ${w.channelPosts[0].slice(0, 120)})`,
  );
  assert(
    !w.channelPosts[0].includes("Couldn't DM"),
    "and does NOT read as a Slack permissions problem, which is a different cause",
  );
  assert(
    w.channelPosts[0].includes("Salesforce"),
    "and names where the manager of record is corrected",
  );
  // The request is not stranded: a team lead can still action it.
  const id = sub.ok ? sub.request.id : "";
  const byLead = await approveOoo(id, teamLead, w.deps);
  assert(byLead.ok, "a team lead can still approve it");
}
{
  // The qualifying side of the same routing: a real manager still gets the DM, so
  // this is a floor and not a blanket redirect to the channel.
  const w = makeWorld();
  const sub = await submitOoo(agent, input, w.deps);
  assert(sub.ok, "a request with a qualifying manager is accepted");
  assert(
    w.dms.some((d) => d.email === manager.email),
    "a manager named as manager of record IS DMed the approve buttons",
  );
  assert(w.channelPosts.length === 0, "and nothing is posted to the fallback channel");
}

// --- approve: full happy path ---
{
  const w = makeWorld();
  const sub = await submitOoo(agent, input, w.deps);
  const id = sub.ok ? sub.request.id : "";
  w.dms.length = 0;

  const denied = await approveOoo(id, stranger, w.deps);
  assert(!denied.ok, "unrelated manager cannot approve");

  const res = await approveOoo(id, manager, w.deps);
  assert(res.ok, "manager approves");
  const r = w.requests.get(id)!;
  assert(r.status === "approved", "status approved");
  assert(r.decided_by === manager.id, "decided_by stored");
  assert(
    r.manager_event_calendar_id === manager.ooo_calendar_id,
    "manager event on the manager's OOO calendar",
  );
  assert(
    w.createdEvents.some(
      (e) => e.calendarId === manager.ooo_calendar_id && e.actor === "ooo@trypennie.com",
    ),
    "manager event created via the OOO actor",
  );
  assert(
    w.createdEvents.some((e) => e.calendarId === "primary" && e.actor === agent.email),
    "agent event created on their primary calendar",
  );
  assert(
    w.createdEvents.every((e) => e.summary === "Aria Agent - OOO"),
    "event title matches the legacy format",
  );
  assert(r.agent_event_id !== null && r.busy_block_id !== null, "artifact ids stored");
  const block = w.busyBlocks.get(r.busy_block_id!)!;
  assert(
    block.source === "gcal" && block.gcal_event_id === r.agent_event_id,
    "busy block converges with the agent event (source=gcal)",
  );
  assert(block.calendar_id === "agent-cal-id", "busy block carries the synced calendar id");
  assert(r.side_effects.manager_event === "ok", "manager_event effect ok");
  assert(r.side_effects.calcom === "skipped", "calcom skipped when flag off");
  assert(
    w.dms.length === 1 && w.dms[0].email === agent.email && w.dms[0].text.includes("approved"),
    "agent DM'd the approval",
  );
  assertAudited(w, "ooo.approve", agent.id, r.id);
  assert(
    w.edits.length === 1 && w.edits[0].text.includes("Approved"),
    "manager notification edited to Approved",
  );

  const again = await approveOoo(id, manager, w.deps);
  assert(!again.ok, "double approve blocked");
}

// --- approve: agent-calendar failure falls back to a slate block ---
{
  const w = makeWorld();
  w.failAgentEvent = true;
  const sub = await submitOoo(agent, input, w.deps);
  const id = sub.ok ? sub.request.id : "";
  const res = await approveOoo(id, manager, w.deps);
  assert(res.ok, "approval survives agent-calendar failure");
  const r = w.requests.get(id)!;
  assert(r.agent_event_id === null, "no agent event id");
  assert(r.side_effects.agent_event.startsWith("failed"), "agent_event recorded failed");
  const block = w.busyBlocks.get(r.busy_block_id!)!;
  assert(block.source === "slate" && block.gcal_event_id === null, "slate fallback block");
  assert(w.alerts.some((a) => a.key === "ooo_agent_calendar"), "ops alerted");
  assert(
    w.alerts.some((a) => a.key === "ooo_busy_block_fallback"),
    "busy-block slate fallback flagged to ops",
  );
}

// --- approve: manager calendar inaccessible falls back to main ---
{
  const w = makeWorld();
  w.failCalendars.add(manager.ooo_calendar_id!);
  const sub = await submitOoo(agent, input, w.deps);
  const id = sub.ok ? sub.request.id : "";
  await approveOoo(id, manager, w.deps);
  const r = w.requests.get(id)!;
  assert(r.manager_event_calendar_id === "main-ooo-cal", "fell back to main OOO calendar");
  assert(r.side_effects.manager_event === "ok (main fallback)", "fallback recorded");
  assert(w.alerts.some((a) => a.key === "ooo_manager_calendar"), "fallback alerted");
}

// --- approve: both calendars failing still approves ---
{
  const w = makeWorld();
  w.failCalendars.add(manager.ooo_calendar_id!);
  w.failCalendars.add("main-ooo-cal");
  const sub = await submitOoo(agent, input, w.deps);
  const id = sub.ok ? sub.request.id : "";
  const res = await approveOoo(id, manager, w.deps);
  assert(res.ok, "approval never rolls back on calendar failures");
  const r = w.requests.get(id)!;
  assert(r.side_effects.manager_event.startsWith("failed"), "manager_event failed recorded");
  assert(r.busy_block_id !== null, "busy block still written");
}

// --- approve: an agent who is not in cal.com is a skip, not a page (#1249) ---
{
  const w = makeWorld();
  w.calcomOutcome = "skipped: not in cal.com (agent@trypennie.com)";
  const sub = await submitOoo(agent, input, w.deps);
  const id = sub.ok ? sub.request.id : "";
  await approveOoo(id, manager, w.deps);
  const r = w.requests.get(id)!;
  assert(
    r.side_effects.calcom.startsWith("skipped"),
    "the skip is recorded on the request, not hidden",
  );
  assert(
    !w.alerts.some((a) => a.key === "ooo_calcom"),
    "no ops page for an agent who has no cal.com account to block",
  );
  // The flag means "an override exists in cal.com that a cancellation must undo"
  // (it gates calcomRemoveOverrides). Nothing was written here, so it must stay
  // false, and #1253's retry lane must exclude skips by reading side_effects
  // rather than by setting this.
  assert(r.calcom_synced === false, "a skip does not claim an override exists");
}

// --- approve: a genuine cal.com failure still pages (control for the case above) ---
{
  const w = makeWorld();
  w.calcomOutcome = "failed: cal.com user lookup returned 401";
  const sub = await submitOoo(agent, input, w.deps);
  const id = sub.ok ? sub.request.id : "";
  await approveOoo(id, manager, w.deps);
  const r = w.requests.get(id)!;
  assert(r.side_effects.calcom.startsWith("failed"), "the failure is recorded");
  assert(
    w.alerts.some((a) => a.key === "ooo_calcom"),
    "a broken integration DOES page, so the skip assertion above means something",
  );
  assert(r.calcom_synced === false, "a failure does not claim an override exists");
}

// --- reject ---
{
  const w = makeWorld();
  const sub = await submitOoo(agent, input, w.deps);
  const id = sub.ok ? sub.request.id : "";
  w.dms.length = 0;
  const res = await rejectOoo(id, manager, "Coverage is too thin that week.", w.deps);
  assert(res.ok, "manager rejects");
  const r = w.requests.get(id)!;
  assert(r.status === "rejected", "status rejected");
  assert(r.rejection_note === "Coverage is too thin that week.", "note stored");
  assert(w.dms[0].text.includes("Coverage is too thin"), "agent DM includes the note");
  assert(w.createdEvents.length === 0, "no calendar events on reject");
  assertAudited(w, "ooo.reject", agent.id, id);
  assert(
    w.edits.some((e) => e.text.includes("Declined")),
    "manager notification edited to Declined",
  );
}
{
  const w = makeWorld();
  const sub = await submitOoo(agent, input, w.deps);
  const id = sub.ok ? sub.request.id : "";
  await rejectOoo(id, manager, "   ", w.deps);
  assert(
    w.requests.get(id)!.rejection_note === DEFAULT_REJECTION_NOTE,
    "blank note gets the default copy",
  );
}

// --- cancel: pending notifies the manager ---
{
  const w = makeWorld();
  const sub = await submitOoo(agent, input, w.deps);
  const id = sub.ok ? sub.request.id : "";
  w.dms.length = 0;
  const denied = await cancelOoo(id, stranger, w.deps);
  assert(!denied.ok, "non-requester cannot cancel");
  const res = await cancelOoo(id, agent, w.deps);
  assert(res.ok, "requester cancels pending");
  assert(w.requests.get(id)!.status === "cancelled", "status cancelled");
  // The canceller here is the agent, so actor and target coincide; what matters
  // is that the target is a user id at all.
  assertAudited(w, "ooo.cancel", agent.id, id);
  assert(
    w.dms.some((d) => d.email === manager.email && d.text.includes("withdrew")),
    "manager told about the withdrawal",
  );
  assert(
    w.edits.some((e) => e.text.includes("Cancelled")),
    "manager notification edited to Cancelled",
  );
}

// --- name-less agent: both consolidated display sites use the shared helper (#1008) ---
{
  const shown = agentDisplayName(namelessAgent);
  assert(shown === namelessAgent.email, "helper falls back to email for a name-less agent");

  // Calendar summary (approve path) resolves the name via agentDisplayName.
  const wApprove = makeWorld();
  const subA = await submitOoo(namelessAgent, input, wApprove.deps);
  const idA = subA.ok ? subA.request.id : "";
  await approveOoo(idA, manager, wApprove.deps);
  assert(
    wApprove.createdEvents.every((e) => e.summary === `${shown} - OOO`),
    "calendar summary uses the shared display name for a name-less agent",
  );

  // Withdrawal notice (cancel-of-pending path) resolves the name the same way.
  const wCancel = makeWorld();
  const subC = await submitOoo(namelessAgent, input, wCancel.deps);
  const idC = subC.ok ? subC.request.id : "";
  wCancel.dms.length = 0;
  await cancelOoo(idC, namelessAgent, wCancel.deps);
  assert(
    wCancel.dms.some(
      (d) => d.email === manager.email && d.text.startsWith(`${shown} withdrew`),
    ),
    "withdrawal notice uses the shared display name for a name-less agent",
  );
}

// --- cancel: approved undoes every artifact ---
{
  const w = makeWorld();
  const sub = await submitOoo(agent, input, w.deps);
  const id = sub.ok ? sub.request.id : "";
  await approveOoo(id, manager, w.deps);
  const before = w.requests.get(id)!;
  const managerEventId = before.manager_event_id!;
  const agentEventId = before.agent_event_id!;
  w.dms.length = 0;

  const res = await cancelOoo(id, agent, w.deps);
  assert(res.ok, "requester cancels approved");
  const r = w.requests.get(id)!;
  assert(r.status === "cancelled", "status cancelled after approval");
  assert(
    w.deletedEvents.some(
      (e) => e.eventId === managerEventId && e.calendarId === manager.ooo_calendar_id,
    ),
    "manager event deleted",
  );
  assert(
    w.deletedEvents.some((e) => e.eventId === agentEventId && e.calendarId === "primary"),
    "agent event deleted",
  );
  assert(w.busyBlocks.size === 0, "busy block deleted");
  assert(r.manager_event_id === null && r.agent_event_id === null, "artifact ids cleared");
  assert(
    w.dms.some((d) => d.email === agent.email && d.text.includes("cancelled")),
    "agent DM'd the cancellation",
  );
}

// --- modify: pending updates in place and re-notifies ---
{
  const w = makeWorld();
  const sub = await submitOoo(agent, input, w.deps);
  const id = sub.ok ? sub.request.id : "";
  w.dms.length = 0;
  const res = await modifyOoo(
    id,
    agent,
    { ...input, startIso: "2026-07-02T13:00:00Z", endIso: "2026-07-02T21:00:00Z" },
    w.deps,
  );
  assert(res.ok, "modify pending succeeds");
  const r = w.requests.get(id)!;
  assert(r.starts_at === "2026-07-02T13:00:00Z", "window replaced");
  assert(r.status === "pending", "stays pending");
  assert(r.notes!.includes("[Modified Jun 12, 2026]"), "modified marker appended (humanized)");
  assert(
    w.dms.some((d) => d.email === manager.email && d.text.includes("Changed time off request")),
    "manager re-notified",
  );
  assertAudited(w, "ooo.modify", agent.id, id);

  // Editing again must not stack a second "[Modified …]" marker — here notes is
  // omitted so baseNotes falls back to the stored notes (which already carry the
  // first marker), exercising the strip-on-save guard.
  await modifyOoo(
    id,
    agent,
    {
      ...input,
      notes: undefined,
      startIso: "2026-07-02T14:00:00Z",
      endIso: "2026-07-02T21:00:00Z",
    },
    w.deps,
  );
  const r2 = w.requests.get(id)!;
  assert(
    (r2.notes!.match(/\[Modified/g) ?? []).length === 1,
    "modified marker does not stack across edits",
  );
}

// --- modify: approved undoes artifacts and returns to pending ---
{
  const w = makeWorld();
  const sub = await submitOoo(agent, input, w.deps);
  const id = sub.ok ? sub.request.id : "";
  await approveOoo(id, manager, w.deps);
  const approvedRef = { channel: w.requests.get(id)!.slack_channel, ts: w.requests.get(id)!.slack_ts };
  w.dms.length = 0;
  w.edits.length = 0;
  const res = await modifyOoo(
    id,
    agent,
    { ...input, startIso: "2026-07-03T13:00:00Z", endIso: "2026-07-03T21:00:00Z" },
    w.deps,
  );
  assert(res.ok, "modify approved succeeds");
  const r = w.requests.get(id)!;
  assert(r.status === "pending", "approved returns to pending");
  // The old 'Approved' message is edited to 'superseded' before the fresh
  // pending notification overwrites the stored ref (#134).
  assert(
    w.edits.some(
      (e) =>
        e.ref.ts === approvedRef.ts &&
        e.ref.channel === approvedRef.channel &&
        /Edited and resubmitted/.test(e.text),
    ),
    "prior approved Slack message superseded before reposting",
  );
  assert(r.notes!.includes("requires re-approval"), "re-approval marker appended");
  assert(r.manager_event_id === null && r.busy_block_id === null, "artifacts cleared");
  assert(r.decided_by === null && r.decided_at === null, "decision cleared");
  assert(w.busyBlocks.size === 0, "busy block removed on modify");
  assert(w.deletedEvents.length === 2, "both events removed on modify");
  assert(
    w.dms.some((d) => d.email === manager.email && d.text.includes("re-approval")),
    "manager told it needs re-approval",
  );
  assert(
    w.dms.some((d) => d.email === agent.email && d.text.includes("re-approval")),
    "agent told it went back for re-approval",
  );

  const denied = await modifyOoo(id, manager, input, w.deps);
  assert(!denied.ok, "manager cannot modify the agent's request");
}

// --- modify: collision with another active request surfaces duplicate copy ---
{
  const w = makeWorld();
  const first = await submitOoo(agent, input, w.deps);
  const second = await submitOoo(
    agent,
    { ...input, startIso: "2026-08-01T13:00:00Z", endIso: "2026-08-01T21:00:00Z" },
    w.deps,
  );
  const secondId = second.ok ? second.request.id : "";
  const res = await modifyOoo(secondId, agent, input, w.deps);
  assert(
    !res.ok && /overlaps a request you already have/.test(res.error ?? ""),
    "modify into an existing window blocked as an overlap",
  );
  assert(
    !res.ok && first.ok && res.conflictRequestId === first.request.id,
    "modify overlap error carries the clashing request id",
  );
  // Modifying a request to a window that overlaps only ITSELF is allowed
  // (the overlap check excludes the request being edited).
  const selfOk = await modifyOoo(
    secondId,
    agent,
    { ...input, startIso: "2026-08-01T12:00:00Z", endIso: "2026-08-01T22:00:00Z" },
    w.deps,
  );
  assert(selfOk.ok, "modify overlapping only its own prior window allowed");
}

// --- retry: fills only the gaps, silently ---
{
  const w = makeWorld();
  w.failAgentEvent = true;
  const sub = await submitOoo(agent, input, w.deps);
  const id = sub.ok ? sub.request.id : "";
  await approveOoo(id, manager, w.deps);
  const blocksAfterApprove = w.busyBlocks.size;
  w.failAgentEvent = false;
  w.dms.length = 0;
  const createdBefore = w.createdEvents.length;

  const denied = await retryOooSideEffects(id, manager, w.deps);
  assert(!denied.ok, "retry is admin-only");

  const res = await retryOooSideEffects(id, admin, w.deps);
  assert(res.ok, "admin retry succeeds");
  const r = w.requests.get(id)!;
  assert(r.agent_event_id !== null, "missing agent event filled in");
  assert(
    w.createdEvents.length === createdBefore + 1,
    "manager event NOT recreated on retry",
  );
  // #78: the slate fallback block converges to a gcal-linked one pointing at
  // the now-created agent event (so the next sync upserts onto it instead of
  // adding a second, overlapping block) — still exactly one block.
  assert(
    w.busyBlocks.size === blocksAfterApprove,
    "still exactly one busy block (converged, not duplicated)",
  );
  const convergedBlock = w.busyBlocks.get(r.busy_block_id!)!;
  assert(
    convergedBlock.source === "gcal" &&
      convergedBlock.gcal_event_id === r.agent_event_id,
    "slate fallback converged to a gcal-linked block on retry",
  );
  assert(w.dms.length === 0, "silent retry sends no DMs");
  assertAudited(w, "ooo.retry", agent.id, id);
}

// --- retry: every rank at or above admin, and nothing below (#1468) ---
// The gate was written as `role !== "admin"`, an equality against ONE rank of a
// five tier hierarchy, so super_admin (the only rank above it) was refused by
// the one control that repairs a time off whose calendar write failed. Drive
// the TOP tier explicitly: it is the rank no other fixture reaches for, which
// is exactly why the defect shipped and survived a passing suite.
{
  for (const actor of [admin, superAdmin]) {
    const w = makeWorld();
    w.failAgentEvent = true;
    const sub = await submitOoo(agent, input, w.deps);
    const id = sub.ok ? sub.request.id : "";
    await approveOoo(id, manager, w.deps);
    assert(
      w.requests.get(id)!.agent_event_id === null,
      `${actor.role}: the agent event really is missing before the retry`,
    );
    w.failAgentEvent = false;

    const res = await retryOooSideEffects(id, actor, w.deps);
    assert(res.ok, `${actor.role} may retry the calendar updates`);
    assert(
      w.requests.get(id)!.agent_event_id !== null,
      `${actor.role}: the retry actually filled the missing agent event`,
    );
  }

  // The ranks BELOW admin stay refused, or the check above proves nothing.
  for (const actor of [agent, manager, teamLead]) {
    const w = makeWorld();
    w.failAgentEvent = true;
    const sub = await submitOoo(agent, input, w.deps);
    const id = sub.ok ? sub.request.id : "";
    await approveOoo(id, manager, w.deps);
    w.failAgentEvent = false;

    const res = await retryOooSideEffects(id, actor, w.deps);
    assert(!res.ok, `${actor.role} may NOT retry the calendar updates`);
    assert(
      w.requests.get(id)!.agent_event_id === null,
      `${actor.role}: a refused retry changes nothing`,
    );
  }
}

// --- the fallback block names the time off that owns it (#1464) ---
// A slate block with no booking used to be indistinguishable from an orphan, and
// the reconcile sweep deleted this one 31 seconds after it was written. The owner
// is what lets every sweep tell "nothing owns this" from "this is the only thing
// blocking approved time off".
{
  const w = makeWorld();
  w.failAgentEvent = true;
  const sub = await submitOoo(agent, input, w.deps);
  const id = sub.ok ? sub.request.id : "";
  await approveOoo(id, manager, w.deps);
  const r = w.requests.get(id)!;
  const block = w.busyBlocks.get(r.busy_block_id!)!;
  assert(
    block.ooo_request_id === id,
    "#1464: the slate fallback block names the request that owns it",
  );
}

{
  // The happy path writes a gcal-linked block instead, and it needs the same
  // owner: the pool-exit prune deletes by user_id regardless of source (#1471),
  // so an unowned gcal block is just as losable.
  const w = makeWorld();
  const sub = await submitOoo(agent, input, w.deps);
  const id = sub.ok ? sub.request.id : "";
  await approveOoo(id, manager, w.deps);
  const r = w.requests.get(id)!;
  const block = w.busyBlocks.get(r.busy_block_id!)!;
  assert(block.source === "gcal", "the happy path still writes a gcal-linked block");
  assert(
    block.ooo_request_id === id,
    "#1464: the gcal-linked block names its owner too",
  );
}

// --- a recorded "ok" is not proof the block still exists (#1464, L121) ---
// The re-entry guard read `side_effects.busy_block` starting with "ok" as proof,
// so once the row had been deleted underneath it, no later pass could ever put it
// back: the retry that exists to repair this request skipped the one step that
// was broken. The FK is ON DELETE SET NULL, so a deleted block leaves
// `busy_block_id` null while the effect still says "ok (slate fallback)". Decide
// from the artifact, never from the marker.
{
  const w = makeWorld();
  w.failAgentEvent = true;
  const sub = await submitOoo(agent, input, w.deps);
  const id = sub.ok ? sub.request.id : "";
  await approveOoo(id, manager, w.deps);
  const approved = w.requests.get(id)!;
  assert(
    approved.side_effects.busy_block === "ok (slate fallback)",
    "precondition: the effect records the fallback as ok",
  );

  // What production did to it: the sweep deleted the row, the FK nulled the id.
  w.busyBlocks.delete(approved.busy_block_id!);
  w.requests.set(id, { ...approved, busy_block_id: null });
  w.failAgentEvent = true; // still no agent calendar, so the fallback is still the only cover

  const res = await retryOooSideEffects(id, admin, w.deps);
  assert(res.ok, "#1464: the retry runs");
  const r = w.requests.get(id)!;
  assert(
    r.busy_block_id !== null,
    "#1464: a deleted block is re-created rather than skipped as already ok",
  );
  const rebuilt = w.busyBlocks.get(r.busy_block_id!)!;
  assert(
    rebuilt.source === "slate" && rebuilt.ooo_request_id === id,
    "#1464: the re-created block is owned, so the sweep will not take it again",
  );
  assert(w.busyBlocks.size === 1, "#1464: exactly one block, not a duplicate");
}

{
  // The mirror direction: a block that is still there must NOT be re-created, or
  // every retry doubles the cached busy rows for the same window.
  const w = makeWorld();
  w.failAgentEvent = true;
  const sub = await submitOoo(agent, input, w.deps);
  const id = sub.ok ? sub.request.id : "";
  await approveOoo(id, manager, w.deps);
  const before = w.requests.get(id)!.busy_block_id;
  await retryOooSideEffects(id, admin, w.deps);
  assert(
    w.busyBlocks.size === 1 && w.requests.get(id)!.busy_block_id === before,
    "#1464: an intact block is left exactly as it was",
  );
}


// --- a timed out calendar write is retried in window (#1469) -----------------
// The OOO calendar writes are bounded at 8 seconds because the manager is
// waiting on them, which is the right posture. A timeout was then PERMANENT: the
// failure was recorded and the only route back was an admin noticing a Slack
// line and pressing Retry. On 2026-08-13 one slow moment from Google left an
// approved time off with no event on the agent's calendar, and the button that
// repairs it was itself broken (#1464, #1468).
{
  const w = makeWorld();
  w.transientAgentFailures = 1;
  const sub = await submitOoo(agent, input, w.deps);
  const id = sub.ok ? sub.request.id : "";
  await approveOoo(id, manager, w.deps);
  const r = w.requests.get(id)!;

  assert(r.agent_event_id !== null, "#1469: a transient failure is retried and lands");
  assert(r.side_effects.agent_event === "ok", "#1469: the outcome recorded is the retry's");
  assert(
    !w.alerts.some((a) => a.key === "ooo_busy_block_fallback"),
    "#1469: no fallback alert, because there was no fallback",
  );
  assert(w.clientIds.length === 2, "#1469: exactly two attempts, never a loop");
}

{
  // Both attempts fail: recorded, alerted, and NOT retried a third time. The
  // manager is waiting, so the bound on attempts is part of the posture.
  const w = makeWorld();
  w.transientAgentFailures = 5;
  const sub = await submitOoo(agent, input, w.deps);
  const id = sub.ok ? sub.request.id : "";
  await approveOoo(id, manager, w.deps);
  const r = w.requests.get(id)!;

  assert(r.agent_event_id === null, "#1469: a repeated transient failure still fails");
  assert(r.side_effects.agent_event.startsWith("failed"), "#1469: recorded as failed");
  assert(w.clientIds.length === 2, "#1469: stops at two attempts");
  assert(w.alerts.some((a) => a.key === "ooo_agent_calendar"), "#1469: ops still alerted");
  assert(r.busy_block_id !== null, "#1469: the fallback block still covers the window");
}

{
  // A definitive refusal is NOT retried. Retrying a 404 spends another 8 seconds
  // of the manager's wait to be told the same thing (L35: classify once, and the
  // classification decides what happens).
  const w = makeWorld();
  w.permanentAgentFailure = true;
  const sub = await submitOoo(agent, input, w.deps);
  const id = sub.ok ? sub.request.id : "";
  await approveOoo(id, manager, w.deps);

  assert(w.clientIds.length === 1, "#1469: a definitive Google refusal is attempted once");
  assert(
    w.requests.get(id)!.side_effects.agent_event.startsWith("failed"),
    "#1469: and is recorded as failed",
  );
}

{
  // The retry must reconcile, not blindly insert: an aborted request may already
  // have been applied on Google's side. Both attempts carry the SAME client id,
  // which is what makes the second one a 409 that Google answers with the event
  // it already created rather than a duplicate.
  const w = makeWorld();
  w.transientAgentFailures = 1;
  const sub = await submitOoo(agent, input, w.deps);
  const id = sub.ok ? sub.request.id : "";
  await approveOoo(id, manager, w.deps);

  assert(w.clientIds[0] !== undefined, "#1469: the create carries a client id");
  assert(
    w.clientIds[0] === w.clientIds[1],
    "#1469: the retry sends the SAME client id, so Google dedupes it",
  );
}

{
  // Two different requests must not collide on one client id, or approving the
  // second would silently reuse the first one's event.
  const w = makeWorld();
  const a = await submitOoo(agent, input, w.deps);
  const idA = a.ok ? a.request.id : "";
  await approveOoo(idA, manager, w.deps);
  const b = await submitOoo(
    agent,
    { ...input, startIso: "2026-07-08T13:00:00Z", endIso: "2026-07-08T21:00:00Z" },
    w.deps,
  );
  const idB = b.ok ? b.request.id : "";
  await approveOoo(idB, manager, w.deps);

  assert(
    w.clientIds[0] !== w.clientIds[1],
    "#1469: each request gets its own client id",
  );
}

finish();
