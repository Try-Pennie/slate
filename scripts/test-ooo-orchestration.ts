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
  EFFECTS,
  type OooDeps,
} from "../src/lib/ooo/orchestration.ts";
import {
  agentDisplayName,
  DEFAULT_REJECTION_NOTE,
} from "../src/lib/ooo/core.ts";
import {
  COVERAGE_SHORT_NOTICE_MS,
  type CoverageMove,
} from "../src/lib/ooo/coverage-notice-copy.ts";
import type { OooRequest, User } from "../src/lib/db/types.ts";
import { GoogleHttpError } from "../src/lib/google/http-error.ts";
import { assert, eq, finish } from "./lib/harness.ts";

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
  /** What the cal.com REMOVAL returns (#2417). A removal recomputes the date from
   *  the agent's remaining approved absences, so it can find that the override it
   *  was undoing was never there, which must not report as success (L100). */
  calcomRemoveOutcome: string;
  /** Every removal asked for, so the request it names can be asserted (#2417). */
  calcomRemovals: { requestId: string; agentUserId: string; agentEmail: string }[];
  /** #2890: blocks left in cal.com by a removal skipped while it was retired. */
  staleRemovals: { requestId: string; agentUserId: string; startIso: string; endIso: string; reason: string }[];
  /** #2890: make recording a stale block throw, so the failure path is reachable. */
  staleRecordFails: boolean;
  /** Coverage sweeps enqueued, with the exact bounds each was given (#1237). */
  sweeps: { requestId: string; startIso: string; endIso: string; queued: number }[];
  /** How the sweep answers: a count, or a throw, so the failure path is reachable. */
  sweepResult: number | "throw";
  /** The appointments the sweep reports having queued, which is what the approved
   *  edit names when one of them starts within the short notice window (#1239). */
  sweepMoves: CoverageMove[];
  /** Every request whose coverage sweep was asked to STOP (#1665), in order. */
  sweepStops: string[];
  /** What stopping the sweep answers: the two counts, or a throw so the branch that
   *  pages and tells the reader it could not be confirmed is reachable. */
  stopResult: { stopped: number; alreadyMoved: number } | "throw";
  /** Every "how many would move" read the pending notice made, with its bounds, so
   *  a test can prove modify RECOMPUTED rather than reusing the submit number. */
  countReads: { outUserId: string; startIso: string; endIso: string }[];
  /** The answers to serve those reads, in order. `null` is the unreadable case, and
   *  an exhausted queue answers 0 (the ordinary "nothing to move" state). */
  countAnswers: (number | null)[];
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
    calcomRemoveOutcome: "skipped",
    calcomRemovals: [],
    staleRemovals: [],
    staleRecordFails: false,
    sweeps: [],
    sweepResult: 0,
    sweepMoves: [],
    sweepStops: [],
    stopResult: { stopped: 0, alreadyMoved: 0 },
    countReads: [],
    countAnswers: [],
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
    startCoverageSweep: async ({ requestId, startIso, endIso }) => {
      if (world.sweepResult === "throw") throw new Error("sweep store unreachable");
      world.sweeps.push({ requestId, startIso, endIso, queued: world.sweepResult });
      return { queued: world.sweepResult, moves: world.sweepMoves };
    },
    stopCoverageSweep: async ({ requestId }) => {
      world.sweepStops.push(requestId);
      if (world.stopResult === "throw") throw new Error("sweep store unreachable");
      return world.stopResult;
    },
    countCoverageBookings: async ({ outUserId, startIso, endIso }) => {
      world.countReads.push({ outUserId, startIso, endIso });
      return world.countAnswers.length > 0 ? world.countAnswers.shift()! : 0;
    },
    calcomRemoveOverrides: async ({ requestId, agentUserId, agentEmail }) => {
      world.calcomRemovals.push({ requestId, agentUserId, agentEmail });
      return world.calcomRemoveOutcome;
    },
    recordCalcomRemovalPending: async (args) => {
      if (world.staleRecordFails) throw new Error("calcom_override_removals insert refused");
      world.staleRemovals.push(args);
    },
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

  // #1674: the overlap guard must REFUSE when it could not read the existing
  // requests, not accept. `listActiveRequests` resolving to null is "could not
  // measure"; an empty array is "measured, and there are none". Before this the
  // dep returned `(data ?? [])`, so a failed read arrived as a clear calendar and
  // an overlapping absence was accepted with nothing anywhere saying a read
  // failed. The healthy control below sits in the SAME world so the refusal
  // cannot pass vacuously (L159).
  {
    const wUnreadable = makeWorld();
    const seed = await submitOoo(agent, input, wUnreadable.deps);
    assert(seed.ok, "control: the same window is accepted while the read works");

    const before = wUnreadable.requests.size;
    wUnreadable.deps.listActiveRequests = async () => null;
    const unreadable = await submitOoo(
      agent,
      {
        ...input,
        startIso: "2026-07-15T13:00:00Z",
        endIso: "2026-07-15T21:00:00Z",
      },
      wUnreadable.deps,
    );
    assert(
      !unreadable.ok &&
        /could not check your existing time off/i.test(unreadable.error ?? ""),
      "an unreadable active-request list refuses the submission by name",
    );
    assert(
      !unreadable.ok && unreadable.conflictRequestId === undefined,
      "the unreadable refusal names no clashing request (it found none)",
    );
    assert(
      wUnreadable.requests.size === before,
      "nothing was written when the overlap check could not run",
    );

    // And the same on the modify path, which runs the same guard.
    const modifyUnreadable = await modifyOoo(
      seed.ok ? seed.request.id : "",
      agent,
      {
        startIso: "2026-07-16T13:00:00Z",
        endIso: "2026-07-16T21:00:00Z",
        displayTzId: input.displayTzId,
        displayTzLabel: input.displayTzLabel,
        allDay: false,
        reason: input.reason,
      },
      wUnreadable.deps,
    );
    assert(
      !modifyUnreadable.ok &&
        /could not check your existing time off/i.test(
          modifyUnreadable.error ?? "",
        ),
      "modify refuses too when the overlap check could not run",
    );
    assert(
      seed.ok &&
        wUnreadable.requests.get(seed.request.id)?.starts_at ===
          input.startIso,
      "the modified request kept its original window",
    );
  }

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

  // #1499: no manager of record is NOT a refusal. Nine active people (every one
  // of Pennie's debt managers among them) carry no manager of record, and the old
  // refusal told them to ask an admin to set one, which after #1474 nobody can do
  // (the field is read only and Salesforce holds null for them). The request is
  // accepted and routed to whoever moderates all time off.
  const orphanEarly: User = {
    ...agent,
    id: "u-orphan-early",
    email: "orphan-early@trypennie.com",
    manager_id: null,
  };
  w.users.set(orphanEarly.id, orphanEarly);
  const noMgr = await submitOoo(orphanEarly, input, w.deps);
  assert(noMgr.ok, `no manager of record still submits (got: ${noMgr.ok ? "" : noMgr.error})`);
  assert(
    noMgr.ok && w.requests.get(noMgr.request.id)?.manager_id === null,
    "the stored request carries a null manager of record rather than a fabricated one",
  );

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

// --- #1499: no manager of record routes to the moderators, and says so ---
//
// Three causes reach the fallback channel and each gets its own sentence (L11):
// a failed DM is a Slack permissions problem, a manager who cannot approve is a
// roster problem, and no manager at all is neither. The last one used to be
// unreachable, because submission refused first.
{
  const w = makeWorld();
  const orphan: User = {
    ...agent,
    id: "u-orphan",
    email: "orphan@trypennie.com",
    name: "Olive Orphan",
    manager_id: null,
  };
  w.users.set(orphan.id, orphan);

  const sub = await submitOoo(orphan, input, w.deps);
  assert(sub.ok, "a requester with no manager of record is accepted");
  assert(w.dms.length === 0, "nobody is DMed, because there is nobody to DM");
  assert(w.channelPosts.length === 1, "it goes to the fallback channel the moderators watch");
  assert(
    w.channelPosts[0].includes("no manager of record"),
    `the post names THIS cause (got: ${w.channelPosts[0].slice(0, 140)})`,
  );
  assert(
    !w.channelPosts[0].includes("Couldn't DM") &&
      !w.channelPosts[0].includes("cannot approve time off"),
    "and is not confused with the DM failure or the unqualified manager cause",
  );
  assert(
    !/ask an admin to set/i.test(w.channelPosts[0]),
    "and never names the step nobody can perform: the field is read only (L111)",
  );

  // Not stranded: a team lead moderates all time off, so the request is actionable.
  const id = sub.ok ? sub.request.id : "";
  const byLead = await approveOoo(id, teamLead, w.deps);
  assert(byLead.ok, "a team lead can approve a request with no manager of record");
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

// --- cancel: a removal that found nothing to remove is said out loud (#2417) ---
//
// The removal recomputes the date from the agent's REMAINING approved absences,
// so it can discover that the override this cancellation was meant to undo was
// never in cal.com. Before #2417 the removal's answer went nowhere at all, so
// "the write was undone" and "there was nothing there" were the same silence
// (L100). Both directions are driven, because a page nothing can turn off is
// indistinguishable from a page that always fires (L1).
{
  const w = makeWorld();
  w.calcomOutcome = "ok";
  w.calcomRemoveOutcome = "failed: no cal.com override was on 2026-07-01 to remove";
  const sub = await submitOoo(agent, input, w.deps);
  const id = sub.ok ? sub.request.id : "";
  await approveOoo(id, manager, w.deps);
  const before = w.alerts.filter((a) => a.key === "ooo_calcom").length;
  await cancelOoo(id, agent, w.deps);
  assert(
    w.alerts.filter((a) => a.key === "ooo_calcom").length > before,
    "a removal that matched nothing pages rather than passing silently",
  );
  assert(
    w.calcomRemovals.some((r) => r.requestId === id && r.agentUserId === agent.id),
    "the removal names the request and the agent, so the date can be recomputed",
  );
}

{
  const w = makeWorld();
  w.calcomOutcome = "ok";
  w.calcomRemoveOutcome = "ok";
  const sub = await submitOoo(agent, input, w.deps);
  const id = sub.ok ? sub.request.id : "";
  await approveOoo(id, manager, w.deps);
  const before = w.alerts.filter((a) => a.key === "ooo_calcom").length;
  await cancelOoo(id, agent, w.deps);
  assert(
    w.alerts.filter((a) => a.key === "ooo_calcom").length === before,
    "a removal that did undo the override stays quiet, so the page above means something",
  );
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
  assert(!denied.ok, "a manager, scoped to their own reports, may not retry");

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

// --- retry: every rank that moderates all time off, and nothing below (#1468, #1473) ---
// The gate was written as `role !== "admin"`, an equality against ONE rank of a
// five tier hierarchy, so super_admin (the only rank above it) was refused by
// the one control that repairs a time off whose calendar write failed. Drive
// the TOP tier explicitly: it is the rank no other fixture reaches for, which
// is exactly why the defect shipped and survived a passing suite.
//
// The floor is the same one that gates moderating every request (#1473), so the
// person who approved a request can also repair it rather than having to find an
// admin. team_lead is asserted through the real action, not only the predicate:
// a rank moved to the allowed side has to be seen doing the work.
{
  for (const actor of [teamLead, admin, superAdmin]) {
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

  // The ranks below stay refused, or the check above proves nothing. A manager is
  // scoped to their own reports, so they are the boundary that matters here.
  for (const actor of [agent, manager]) {
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

// --- #1237: approving time off enqueues a coverage sweep -----------------------
//
// The advisor is definitely absent, so every appointment still ahead of them inside the
// window has to move. This is the step that starts that, and the shape matters more than the
// counting: it must never be able to roll back an approval or lose the calendar work already
// done, because those are what actually stop the agent being booked again.
{
  const w = makeWorld();
  w.sweepResult = 3;
  const sub = await submitOoo(agent, input, w.deps);
  const id = sub.ok ? sub.request.id : "";
  const res = await approveOoo(id, manager, w.deps);
  assert(res.ok, "the approval succeeds");

  assert(w.sweeps.length === 1, `exactly one sweep is enqueued (got ${w.sweeps.length})`);
  const sweep = w.sweeps[0]!;
  // EXACT timestamps, not whole days. A half day absence must not pull in the morning's
  // appointments, and the window here is 13:00 to 21:00 rather than a date.
  assert(
    sweep.startIso === input.startIso && sweep.endIso === input.endIso,
    `the sweep gets the request's own bounds (got ${sweep.startIso} to ${sweep.endIso})`,
  );
  assert(sweep.requestId === id, "and is tied to the request, so the enqueue is idempotent by key");

  const stored = w.requests.get(id)!;
  const effects = (stored.side_effects ?? {}) as Record<string, string>;
  assert(
    effects[EFFECTS.coverage] === "ok (3 queued)",
    `the outcome records how many moved (got ${effects[EFFECTS.coverage]})`,
  );
}

{
  // Nothing to move is a real, measured answer and must read differently from a failure: one
  // needs no action and the other is retryable (L11).
  const w = makeWorld();
  w.sweepResult = 0;
  const sub = await submitOoo(agent, input, w.deps);
  const id = sub.ok ? sub.request.id : "";
  await approveOoo(id, manager, w.deps);
  const effects = (w.requests.get(id)!.side_effects ?? {}) as Record<string, string>;
  assert(
    effects[EFFECTS.coverage] === "ok (none in window)",
    `an empty window says so in its own words (got ${effects[EFFECTS.coverage]})`,
  );
}

{
  // A throwing sweep must NOT roll back the approval or undo the calendar work. The agent
  // being blocked is what stops new bookings landing; losing that to save a reassignment
  // would make the absence worse than not sweeping at all.
  const w = makeWorld();
  w.sweepResult = "throw";
  const sub = await submitOoo(agent, input, w.deps);
  const id = sub.ok ? sub.request.id : "";

  // Caught explicitly. Letting it propagate DOES fail the suite, but as a crash that names
  // no property, and this is the single most important thing about this step: a sweep
  // failure must never cost the approval or the calendar work that stops the agent being
  // booked again. A named assertion says which invariant broke (L140, inverted).
  let threw: unknown = null;
  const res = await approveOoo(id, manager, w.deps).catch((e) => {
    threw = e;
    return { ok: false as const, error: String(e) };
  });
  assert(threw === null, `the sweep failure never escapes runPostApproval (threw: ${String(threw)})`);
  assert(res.ok, "the approval still succeeds when the sweep throws");
  const stored = w.requests.get(id)!;
  assert(stored.status === "approved", "and the request is approved");
  assert(stored.busy_block_id !== null, "and the busy block that blocks availability survives");
  const effects = (stored.side_effects ?? {}) as Record<string, string>;
  assert(
    (effects[EFFECTS.coverage] ?? "").startsWith("failed"),
    `the failure is recorded so the retry path can pick it up (got ${effects[EFFECTS.coverage]})`,
  );
  assert(
    !(effects[EFFECTS.coverage] ?? "").includes("sweep store unreachable\n"),
    "and the recorded reason is short, not a pasted stack",
  );
}

{
  // Idempotence at THIS layer, on top of the database key. A retry after a successful sweep
  // must not enqueue a second one: the sweep moves customers' bookings, so doing it twice is
  // not a harmless duplicate.
  const w = makeWorld();
  w.sweepResult = 2;
  const sub = await submitOoo(agent, input, w.deps);
  const id = sub.ok ? sub.request.id : "";
  await approveOoo(id, manager, w.deps);
  assert(w.sweeps.length === 1, "the approval enqueues once");

  const retried = await retryOooSideEffects(id, admin, w.deps);
  assert(retried.ok, "the retry is accepted (a manager is refused, so this must use an admin)");
  assert(
    w.sweeps.length === 1,
    `a retry after success does NOT enqueue again (got ${w.sweeps.length})`,
  );
}

{
  // And the other half: a retry after a FAILURE must try again, or the retry control is
  // decoration on the one outcome it exists for.
  const w = makeWorld();
  w.sweepResult = "throw";
  const sub = await submitOoo(agent, input, w.deps);
  const id = sub.ok ? sub.request.id : "";
  await approveOoo(id, manager, w.deps);
  assert(w.sweeps.length === 0, "the throwing sweep enqueued nothing");

  w.sweepResult = 1;
  const again = await retryOooSideEffects(id, admin, w.deps);
  assert(again.ok, "the retry is accepted");
  assert(w.sweeps.length === 1, "the retry enqueues it");
  const effects = (w.requests.get(id)!.side_effects ?? {}) as Record<string, string>;
  assert(
    effects[EFFECTS.coverage] === "ok (1 queued)",
    `and the outcome converges to ok (got ${effects[EFFECTS.coverage]})`,
  );
}

// --- #1239: what the manager is told will move, and what actually moved --------
//
// The sentences themselves live in coverage-notice-copy.ts and are asserted state by
// state there. What these check is the WIRING: that the pending notice carries a
// count read for THIS request's window, that an edit recomputes it, and that the
// approved and cancelled edits carry the outcome rather than a silence a reader
// would take for "nothing happened".

/** The manager's most recent pending notice, wherever it was delivered. */
function latestManagerNotice(w: World): string {
  const dm = [...w.dms].reverse().find((d) => d.email === manager.email);
  return dm?.text ?? w.channelPosts[w.channelPosts.length - 1] ?? "";
}

{
  const w = makeWorld();
  w.countAnswers = [2];
  const sub = await submitOoo(agent, input, w.deps);
  assert(sub.ok, "the submit succeeds");
  const notice = latestManagerNotice(w);
  assert(
    /2 upcoming appointments/.test(notice),
    `the pending notice says how many appointments approving would move (got: ${notice})`,
  );
  assert(w.countReads.length === 1, `the count is read once (got ${w.countReads.length})`);
  const read = w.countReads[0]!;
  assert(
    read.outUserId === agent.id &&
      read.startIso === input.startIso &&
      read.endIso === input.endIso,
    "and it is read for THIS agent over THIS request's exact window",
  );
}

{
  // Nothing to move stays silent: a line on every request would be noise on the
  // majority that move nothing, which is why the issue asks for it above zero only.
  const w = makeWorld();
  w.countAnswers = [0];
  await submitOoo(agent, input, w.deps);
  assert(
    !/upcoming appointment/.test(latestManagerNotice(w)),
    "a window with nothing in it adds no line",
  );
}

{
  // The failure path, and the reason this is not just a nicety: a count that could
  // not be READ must not render as the zero state, because the zero state is silence
  // and a manager reads silence as "nothing will move".
  const w = makeWorld();
  w.countAnswers = [null];
  await submitOoo(agent, input, w.deps);
  const notice = latestManagerNotice(w);
  assert(
    /could not read how many/.test(notice),
    `an unreadable count says so on the notice (got: ${notice})`,
  );
  assert(
    !/^0 upcoming/m.test(notice),
    "and never claims the window is empty",
  );
}

{
  // modifyOoo posts a FRESH pending notice, so it must recompute. Carrying the
  // submit-time number would make an edited request doubly stale: wrong window and
  // wrong clock.
  const w = makeWorld();
  w.countAnswers = [1, 5];
  const sub = await submitOoo(agent, input, w.deps);
  const id = sub.ok ? sub.request.id : "";
  const changed = {
    ...input,
    startIso: "2026-07-02T13:00:00Z",
    endIso: "2026-07-02T21:00:00Z",
  };
  const res = await modifyOoo(id, agent, changed, w.deps);
  assert(res.ok, "the edit succeeds");
  const notice = latestManagerNotice(w);
  assert(
    /5 upcoming appointments/.test(notice),
    `the reposted notice carries the RECOMPUTED count (got: ${notice})`,
  );
  assert(!/1 upcoming appointment\b/.test(notice), "not the one from submit time");
  assert(w.countReads.length === 2, `the count is read again on edit (got ${w.countReads.length})`);
  assert(
    w.countReads[1]!.startIso === changed.startIso &&
      w.countReads[1]!.endIso === changed.endIso,
    "and over the NEW window, not the one that was replaced",
  );
}

{
  // After approval the status edit reports what was actually queued.
  const w = makeWorld();
  w.sweepResult = 3;
  const sub = await submitOoo(agent, input, w.deps);
  const id = sub.ok ? sub.request.id : "";
  await approveOoo(id, manager, w.deps);
  const edit = w.edits[w.edits.length - 1]?.text ?? "";
  assert(
    /3 upcoming appointments were queued to move/.test(edit),
    `the approved edit reports what was queued (got: ${edit})`,
  );
  assert(
    !/Starting within/.test(edit),
    "and names nobody when nothing starts within the short notice window",
  );
}

{
  // A same day approval: one of the appointments starts within COVERAGE_SHORT_NOTICE_MS,
  // so the edit NAMES it. The threshold decides only what is said; both appointments
  // still move.
  const w = makeWorld();
  const now = Date.parse(await w.deps.nowIso());
  const soonStart = new Date(now + COVERAGE_SHORT_NOTICE_MS / 2).toISOString();
  const laterStart = new Date(now + 6 * 60 * 60 * 1000).toISOString();
  const halfHourAfter = (iso: string) =>
    new Date(Date.parse(iso) + 30 * 60_000).toISOString();
  w.sweepResult = 2;
  w.sweepMoves = [
    { startsAtIso: soonStart, endsAtIso: halfHourAfter(soonStart), attendeeName: "Jane Smith" },
    { startsAtIso: laterStart, endsAtIso: halfHourAfter(laterStart), attendeeName: "Later Larry" },
  ];
  const sameDay = {
    ...input,
    startIso: new Date(now).toISOString(),
    endIso: new Date(now + 8 * 60 * 60 * 1000).toISOString(),
    reason: "Sick day",
  };
  const sub = await submitOoo(agent, sameDay, w.deps);
  const id = sub.ok ? sub.request.id : "";
  await approveOoo(id, manager, w.deps);
  const edit = w.edits[w.edits.length - 1]?.text ?? "";
  assert(
    /2 upcoming appointments were queued to move/.test(edit),
    `both appointments still move (got: ${edit})`,
  );
  assert(/Jane Smith/.test(edit), "the one starting within two hours is named so it can be phoned");
  assert(!/Later Larry/.test(edit), "the one further out is not");
}

{
  // A sweep that failed must not leave the manager reading an unchanged message that
  // says nothing: the appointments are still on the agent who is away.
  const w = makeWorld();
  w.sweepResult = "throw";
  const sub = await submitOoo(agent, input, w.deps);
  const id = sub.ok ? sub.request.id : "";
  await approveOoo(id, manager, w.deps);
  const edit = w.edits[w.edits.length - 1]?.text ?? "";
  assert(
    /could not be queued to move/.test(edit),
    `the approved edit says the sweep failed (got: ${edit})`,
  );
  assert(
    !/were queued to move/.test(edit),
    "and never claims a number of appointments moved",
  );
}

{
  // Cancelling approved time off STOPS the sweep for what has not moved yet (#1665),
  // and does NOT move back what has (#1219 decision 4). Both the agent and the
  // manager are told, so both are decisions rather than things discovered later.
  const w = makeWorld();
  w.sweepResult = 3;
  w.stopResult = { stopped: 2, alreadyMoved: 1 };
  const sub = await submitOoo(agent, input, w.deps);
  const id = sub.ok ? sub.request.id : "";
  await approveOoo(id, manager, w.deps);
  const dmsBefore = w.dms.length;
  const res = await cancelOoo(id, agent, w.deps);
  assert(res.ok, "the cancel succeeds");
  assert(
    w.sweepStops.length === 1 && w.sweepStops[0] === id,
    "cancelling asks the sweep for THIS request to stop, which nothing used to do",
  );
  const agentDm = w.dms.slice(dmsBefore).find((d) => d.email === agent.email)?.text ?? "";
  assert(
    /still waiting to move/.test(agentDm) && /will not move now/i.test(agentDm),
    `the agent is told what was stopped (got: ${agentDm})`,
  );
  assert(
    /stays with that advisor/.test(agentDm),
    `and that the moved appointment stays moved (got: ${agentDm})`,
  );
  const edit = w.edits[w.edits.length - 1]?.text ?? "";
  assert(
    /does not move it back/.test(edit) && /will not move now/i.test(edit),
    `and so is the manager, on the cancelled message (got: ${edit})`,
  );
}

{
  // The stop runs AFTER the status transition, so a cancel that lost the race and
  // changed nothing can never stop a sweep for a request that is still approved.
  const w = makeWorld();
  w.sweepResult = 2;
  const sub = await submitOoo(agent, input, w.deps);
  const id = sub.ok ? sub.request.id : "";
  await approveOoo(id, manager, w.deps);
  await cancelOoo(id, agent, w.deps);
  const stopsAfterFirst = w.sweepStops.length;
  const second = await cancelOoo(id, agent, w.deps);
  assert(!second.ok, "a second cancel of the same request is refused");
  assert(
    w.sweepStops.length === stopsAfterFirst,
    "and it does not reach the sweep, because the transition it never won is what gates the stop",
  );
}

{
  // A stop that could not be confirmed is its own state: it pages, and it tells the
  // reader that appointments may still be moving. It must never read as the silence
  // of a request that had nothing to stop.
  const w = makeWorld();
  w.sweepResult = 2;
  w.stopResult = "throw";
  const sub = await submitOoo(agent, input, w.deps);
  const id = sub.ok ? sub.request.id : "";
  await approveOoo(id, manager, w.deps);
  const dmsBefore = w.dms.length;
  const res = await cancelOoo(id, agent, w.deps);
  assert(res.ok, "the cancellation itself still succeeds: the sweep must not cost it");
  const agentDm = w.dms.slice(dmsBefore).find((d) => d.email === agent.email)?.text ?? "";
  assert(
    /could not confirm/.test(agentDm) && /may still move/.test(agentDm),
    `a failed stop is said out loud (got: ${agentDm})`,
  );
  assert(
    w.alerts.some((a) => a.key === "ooo_coverage_stop"),
    "and it pages, because nothing retries it and customers may still be handed over",
  );

  // CONTROL: the same flow with a stop that answers zero says nothing and pages
  // nothing, so the assertions above are about the failure and not about cancelling.
  const c = makeWorld();
  c.sweepResult = 2;
  const csub = await submitOoo(agent, input, c.deps);
  const cid = csub.ok ? csub.request.id : "";
  await approveOoo(cid, manager, c.deps);
  const cBefore = c.dms.length;
  await cancelOoo(cid, agent, c.deps);
  const cDm = c.dms.slice(cBefore).find((d) => d.email === agent.email)?.text ?? "";
  assert(
    !/could not confirm/.test(cDm) && !c.alerts.some((a) => a.key === "ooo_coverage_stop"),
    `CONTROL: a measured stop of nothing is silent (got: ${cDm})`,
  );
}

{
  // A request cancelled while still PENDING moved nothing, so it must not say
  // anything about appointments staying with another advisor.
  const w = makeWorld();
  const sub = await submitOoo(agent, input, w.deps);
  const id = sub.ok ? sub.request.id : "";
  const dmsBefore = w.dms.length;
  await cancelOoo(id, agent, w.deps);
  const agentDm = w.dms.slice(dmsBefore).find((d) => d.email === agent.email)?.text ?? "";
  assert(
    !/stay with that advisor/.test(agentDm),
    `a withdrawn pending request says nothing about moved appointments (got: ${agentDm})`,
  );
}

{
  // The same gap on MODIFY (#1665). Narrowing an approved window returns the request
  // to pending, and the sweep the old approval started would otherwise carry on
  // moving that agent's customers over the OLD window.
  const w = makeWorld();
  w.sweepResult = 3;
  w.stopResult = { stopped: 2, alreadyMoved: 1 };
  const sub = await submitOoo(agent, input, w.deps);
  const id = sub.ok ? sub.request.id : "";
  await approveOoo(id, manager, w.deps);
  const editsBefore = w.edits.length;
  const res = await modifyOoo(
    id,
    agent,
    {
      startIso: "2026-07-01T13:00:00.000Z",
      endIso: "2026-07-01T17:00:00.000Z",
      displayTzId: "America/New_York",
      displayTzLabel: "ET",
      allDay: false,
      reason: "Appointment",
    },
    w.deps,
  );
  assert(res.ok, "narrowing the window succeeds");
  assert(
    w.sweepStops.length === 1 && w.sweepStops[0] === id,
    "narrowing an approved window stops the sweep the old approval started",
  );
  const superseded = w.edits.slice(editsBefore)[0]?.text ?? "";
  assert(
    /still waiting to move/.test(superseded) && /had already moved/.test(superseded),
    `and the superseded message says what happened to both halves (got: ${superseded})`,
  );

  // CONTROL: modifying a request that was never approved has no sweep behind it, so
  // the same code path says nothing rather than inventing a stop.
  const c = makeWorld();
  const csub = await submitOoo(agent, input, c.deps);
  const cid = csub.ok ? csub.request.id : "";
  const cEditsBefore = c.edits.length;
  await modifyOoo(
    cid,
    agent,
    {
      startIso: "2026-07-01T13:00:00.000Z",
      endIso: "2026-07-01T17:00:00.000Z",
      displayTzId: "America/New_York",
      displayTzLabel: "ET",
      allDay: false,
      reason: "Appointment",
    },
    c.deps,
  );
  const cSuperseded = c.edits.slice(cEditsBefore)[0]?.text ?? "";
  assert(
    !/still waiting to move/.test(cSuperseded) && !/had already moved/.test(cSuperseded),
    `CONTROL: a never-approved request's edit says nothing about appointments (got: ${cSuperseded})`,
  );
}

// --- #2890: a removal skipped while cal.com was retired is recorded --------------
//
// While cal.com is retired the removal writes nothing, and the request row then
// forgets the window (a cancel clears calcom_synced, a change replaces the dates).
// So the window cal.com still blocks is recorded, for the override sweep to take
// out once cal.com is put back. Both directions are driven: the cancel and the
// change (whose recorded window must be the OLD one), and a live removal that
// records nothing.
{
  const RETIRED = "skipped: cal.com retired";
  // Cancel while retired.
  {
    const w = makeWorld();
    w.calcomOutcome = "ok";
    const sub = await submitOoo(agent, input, w.deps);
    const id = sub.ok ? sub.request.id : "";
    await approveOoo(id, manager, w.deps);
    w.calcomRemoveOutcome = RETIRED;
    const before = w.alerts.filter((a) => a.key === "ooo_calcom").length;
    const res = await cancelOoo(id, agent, w.deps);
    assert(res.ok, "retired cancel: the cancellation still goes through");
    eq(
      w.staleRemovals,
      [{ requestId: id, agentUserId: agent.id, startIso: input.startIso, endIso: input.endIso, reason: RETIRED }],
      "retired cancel: the window cal.com still blocks is recorded for put back",
    );
    eq(w.alerts.filter((a) => a.key === "ooo_calcom").length, before, "retired cancel: nothing pages");
  }
  // Change while retired: the OLD window is what cal.com holds.
  {
    const w = makeWorld();
    w.calcomOutcome = "ok";
    const sub = await submitOoo(agent, input, w.deps);
    const id = sub.ok ? sub.request.id : "";
    await approveOoo(id, manager, w.deps);
    w.calcomRemoveOutcome = RETIRED;
    await modifyOoo(
      id,
      agent,
      { ...input, startIso: "2026-07-01T17:00:00Z", endIso: "2026-07-01T21:00:00Z" },
      w.deps,
    );
    eq(w.staleRemovals.length, 1, "retired change: one stale window is recorded");
    eq(
      [w.staleRemovals[0]?.startIso, w.staleRemovals[0]?.endIso],
      [input.startIso, input.endIso],
      "retired change: the recorded window is the OLD one, not the new",
    );
  }
  // Live removal: nothing to record.
  {
    const w = makeWorld();
    w.calcomOutcome = "ok";
    w.calcomRemoveOutcome = "ok";
    const sub = await submitOoo(agent, input, w.deps);
    const id = sub.ok ? sub.request.id : "";
    await approveOoo(id, manager, w.deps);
    await cancelOoo(id, agent, w.deps);
    eq(w.staleRemovals.length, 0, "live cancel: a removal that landed records nothing");
  }
  // Recording it fails: said out loud, and the cancellation still completes.
  {
    const w = makeWorld();
    w.calcomOutcome = "ok";
    const sub = await submitOoo(agent, input, w.deps);
    const id = sub.ok ? sub.request.id : "";
    await approveOoo(id, manager, w.deps);
    w.calcomRemoveOutcome = RETIRED;
    w.staleRecordFails = true;
    const res = await cancelOoo(id, agent, w.deps);
    assert(res.ok, "record refused: the cancellation still goes through");
    assert(
      w.alerts.some((a) => a.key === "ooo_calcom_stale_unrecorded" && /put back/i.test(a.message)),
      "record refused: pages, naming what put back will not be able to undo",
    );
    // Its own key, never `ooo_calcom`: the override sweep ends that page with "all
    // in place, no action is needed" as soon as no override is failing, which would
    // clear this one while the stale block is still in cal.com.
    assert(
      !w.alerts.some((a) => a.key === "ooo_calcom"),
      "record refused: not sent on ooo_calcom, which the sweep's all-clear would end",
    );
  }
}

finish();
