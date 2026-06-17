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
  DEFAULT_REJECTION_NOTE,
  NO_MANAGER_MESSAGE,
} from "../src/lib/ooo/core.ts";
import type { OooRequest, User } from "../src/lib/db/types.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`ok: ${msg}`);
  else {
    console.error(`FAIL: ${msg}`);
    failures++;
  }
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
  audits: string[];
  failCalendars: Set<string>;
  failAgentEvent: boolean;
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
    deps: null as unknown as OooDeps,
  };
  const users = new Map(
    [agent, manager, admin, stranger].map((u) => [u.id, u]),
  );
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
    createCalendarEvent: async (actorEmail, calendarId, args) => {
      if (world.failCalendars.has(calendarId)) {
        throw new Error(`no access to ${calendarId}`);
      }
      if (world.failAgentEvent && calendarId === "primary") {
        throw new Error("agent calendar unavailable");
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
    calcomAddOverrides: async () => "skipped",
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
    recordAudit: async (action) => {
      world.audits.push(action);
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
  assert(w.audits.includes("ooo.submit"), "submit audited");

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
  assert(w.audits.includes("ooo.approve"), "approve audited");
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
  assert(
    w.dms.some((d) => d.email === manager.email && d.text.includes("withdrew")),
    "manager told about the withdrawal",
  );
  assert(
    w.edits.some((e) => e.text.includes("Cancelled")),
    "manager notification edited to Cancelled",
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
  assert(w.audits.includes("ooo.modify"), "modify audited");

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
  w.dms.length = 0;
  const res = await modifyOoo(
    id,
    agent,
    { ...input, startIso: "2026-07-03T13:00:00Z", endIso: "2026-07-03T21:00:00Z" },
    w.deps,
  );
  assert(res.ok, "modify approved succeeds");
  const r = w.requests.get(id)!;
  assert(r.status === "pending", "approved returns to pending");
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
  void first;
  const res = await modifyOoo(secondId, agent, input, w.deps);
  assert(
    !res.ok && /overlaps a request you already have/.test(res.error ?? ""),
    "modify into an existing window blocked as an overlap",
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
  assert(w.busyBlocks.size === blocksAfterApprove, "existing busy block kept");
  assert(w.dms.length === 0, "silent retry sends no DMs");
  assert(w.audits.includes("ooo.retry"), "retry audited");
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nALL PASSED");
