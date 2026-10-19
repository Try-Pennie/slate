// #3919: an advisor moving a Slate booking's invite in Google Calendar.
//
// The decisions are Dan's (2026-10-19, the first comment on #3919): a start that
// differs by more than a minute is a move and is put back, with the lead emailed and
// the advisor told; an end only change is posted and left; a second move, or one
// inside 30 minutes of the call, is left and escalated to the advisor, their manager
// and the alerts channel; while a move is left the advisor is busy at BOTH times; the
// busy drift page stays quiet for it; and the launch sweep reports without reverting.
//
// Everything here runs with no network, no database and no clock: the sync's write
// plan and the busy drift sampler are the real functions, and the handler is driven
// through the same seams the sync wires to Supabase, Google and Slack.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-invite-moves.ts
import {
  INVITE_MOVE_TOLERANCE_MS,
  NEAR_START_MS,
  judgeInvite,
  mayTakeOverLock,
  primaryCalendarId,
  splitSlateInvites,
  decideInviteChange,
  type BookedInvite,
  type InviteChangeRecord,
} from "../src/lib/google/invite-moves.ts";
import {
  noticeOutOfStepInvites,
  type InviteMoveDeps,
  type FreshBooking,
  type NewInviteChange,
} from "../src/lib/google/invite-move-notice.ts";
import { sweepOutOfStepInvites, type InviteSweepDeps } from "../src/lib/google/invite-move-sweep.ts";
import { partitionBusyWrites } from "../src/lib/google/sync-core.ts";
import { runBusyDriftSample, reportBusyDrift, type DriftInterval } from "../src/lib/monitor/busy-drift-sampler.ts";
import { EventGone } from "../src/lib/booking/core.ts";
import { GoogleHttpError } from "../src/lib/google/http-error.ts";
import type { GoogleEvent } from "../src/lib/google/calendar.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const MIN = 60_000;
const BOOKING = "774521f6-0c1d-4b8e-9f3a-2d5e6a7b8c9d";
const EVENT = "slate0f3a9c";
const USER = "user-bkenny";
const EMAIL = "bkenny@trypennie.com";
// 4:05 to 4:25 PM ET on Monday, October 19, the measured booking in #3919.
const BOOKED: BookedInvite = {
  bookingId: BOOKING,
  startsAt: "2026-10-19T20:05:00.000Z",
  endsAt: "2026-10-19T20:25:00.000Z",
};
// 9:00 AM ET that morning: the call is seven hours away.
const MORNING = Date.parse("2026-10-19T13:00:00.000Z");
// 3:45 PM ET: twenty minutes before the call.
const NEAR = Date.parse("2026-10-19T19:45:00.000Z");

function ev(startIso: string, endIso: string, extra: Partial<GoogleEvent> & { updated?: string } = {}): GoogleEvent {
  return {
    id: EVENT,
    status: "confirmed",
    start: { dateTime: startIso },
    end: { dateTime: endIso },
    ...extra,
  } as GoogleEvent;
}
const MOVED = ev("2026-10-19T20:00:00.000Z", "2026-10-19T20:20:00.000Z", { updated: "2026-10-19T12:19:04.000Z" } as never);
const IN_STEP = ev(BOOKED.startsAt, BOOKED.endsAt, { updated: "2026-10-19T12:30:00.000Z" } as never);
const RESIZED = ev(BOOKED.startsAt, "2026-10-19T20:45:00.000Z", { updated: "2026-10-19T12:21:00.000Z" } as never);

// --- what counts as a move (decision 1) ------------------------------------------
{
  eq(judgeInvite(MOVED, BOOKED), "moved", "a start five minutes earlier is a move");
  eq(judgeInvite(IN_STEP, BOOKED), "in-step", "the booked times are in step");
  eq(judgeInvite(RESIZED, BOOKED), "resized", "the same start with a later end is an end only change");
  const jitter = ev(
    new Date(Date.parse(BOOKED.startsAt) + INVITE_MOVE_TOLERANCE_MS).toISOString(),
    new Date(Date.parse(BOOKED.endsAt) + INVITE_MOVE_TOLERANCE_MS).toISOString(),
  );
  eq(judgeInvite(jitter, BOOKED), "in-step", "a start exactly one minute off is not a move (more than a minute is)");
  const justOver = ev(
    new Date(Date.parse(BOOKED.startsAt) + INVITE_MOVE_TOLERANCE_MS + 1000).toISOString(),
    BOOKED.endsAt,
  );
  eq(judgeInvite(justOver, BOOKED), "moved", "a start just over a minute off is a move");
  eq(judgeInvite({ ...MOVED, status: "cancelled" }, BOOKED), "not-held", "a cancelled event is not a move");
  eq(
    judgeInvite({ ...MOVED, attendees: [{ self: true, responseStatus: "declined" }] }, BOOKED),
    "not-held",
    "an invite the advisor declined holds no time, so it is not a move",
  );
}

// --- the sync's write plan: both times blocked while a move stands (decision 6) --
const invites = new Map([[EVENT, BOOKED]]);
{
  const split = splitSlateInvites([MOVED], invites);
  assert(!split.skip.has(EVENT), "a moved Slate invite is NOT skipped, so the sync mirrors it at the moved time");
  eq(split.outOfStep.map((o) => [o.eventId, o.bookingId, o.step]), [[EVENT, BOOKING, "moved"]], "and it is handed to the handler");
  const plan = partitionBusyWrites(USER, EMAIL, [MOVED], split.skip, "America/New_York", null);
  eq(
    plan.upserts.map((u) => [u.gcal_event_id, u.starts_at, u.ends_at]),
    [[EVENT, "2026-10-19T20:00:00.000Z", "2026-10-19T20:20:00.000Z"]],
    "the moved time is written as busy; the booked time keeps the booking's own block",
  );

  const back = splitSlateInvites([IN_STEP], invites);
  assert(back.skip.has(EVENT) && back.outOfStep.length === 0, "an invite back in step is skipped again");
  const cleared = partitionBusyWrites(USER, EMAIL, [IN_STEP], back.skip, "America/New_York", null);
  eq(cleared.deletes, [EVENT], "and its mirror is deleted, so only the booked time stays blocked");

  const resized = splitSlateInvites([RESIZED], invites);
  assert(!resized.skip.has(EVENT), "an invite lengthened in Google is mirrored too, so its extra time is blocked");

  const other = splitSlateInvites([MOVED], new Map());
  assert(other.outOfStep.length === 0, "an event that is not a Slate booking's is never handed to the handler");

  const keepsUnseen = splitSlateInvites([], new Map([["other-slate-event", BOOKED]]));
  assert(keepsUnseen.skip.has("other-slate-event"), "a Slate event this pass did not deliver stays in the skip set");
}

// --- the busy drift page stays silent for a moved invite (decision 7) ------------
async function driftCase(): Promise<void> {
  // The booking's own block at the booked time, plus whatever the sync wrote.
  const plan = partitionBusyWrites(USER, EMAIL, [MOVED], splitSlateInvites([MOVED], invites).skip, "America/New_York", null);
  const cached: DriftInterval[] = [
    { startIso: BOOKED.startsAt, endIso: BOOKED.endsAt },
    ...plan.upserts.map((u) => ({ startIso: u.starts_at, endIso: u.ends_at })),
  ];
  const window = { fromIso: "2026-10-19T19:00:00.000Z", toIso: "2026-10-19T23:00:00.000Z" };
  const run = (live: { start: string; end: string }[]) =>
    runBusyDriftSample({
      sample: [{ email: EMAIL, userId: USER }],
      ...window,
      readLive: async () => ({
        agents: [{ email: EMAIL, calendarIds: [EMAIL] }],
        busyByCalendar: new Map([[EMAIL, { busy: live, error: false }]]),
      }) as never,
      loadCachedBlocks: async () => new Map([[USER, cached]]),
    });
  const moved = await run([{ start: "2026-10-19T20:00:00.000Z", end: "2026-10-19T20:20:00.000Z" }]);
  eq(moved.gapAgents.length, 0, "Google's busy time at the moved invite is cached, so the sampler finds no gap");

  const real = await run([
    { start: "2026-10-19T20:00:00.000Z", end: "2026-10-19T20:20:00.000Z" },
    { start: "2026-10-19T21:30:00.000Z", end: "2026-10-19T22:00:00.000Z" },
  ]);
  eq(real.gapAgents.length, 1, "a meeting the cache does not hold is still a gap");
  const sent: string[] = [];
  const verdict = await reportBusyDrift({
    result: real,
    rotationTicks: 1,
    tickMs: 5 * MIN,
    cooldownMs: 60 * MIN,
    hit: async () => true,
    clearStreak: async () => {},
    notify: async (_key, _ms, text) => {
      sent.push(text);
    },
    resolve: async () => true,
  });
  eq(verdict.verdict, "sustained", "and a real cache gap still pages");
  assert(sent.length === 1 && sent[0]!.includes("21:30 UTC"), "the page names the real gap, not the moved invite");
}

// --- the decision (decisions 1, 4, 5) --------------------------------------------
function rec(over: Partial<InviteChangeRecord>): InviteChangeRecord {
  return {
    id: "row-1",
    kind: "moved",
    moveNumber: 1,
    action: "revert",
    outcome: "reverted",
    eventStartsAt: "2026-10-19T20:00:00.000Z",
    eventEndsAt: "2026-10-19T20:20:00.000Z",
    eventUpdated: "2026-10-19T12:19:04.000Z",
    ...over,
  };
}
const live = (e: GoogleEvent) => e;
{
  eq(decideInviteChange({ event: live(MOVED), booked: BOOKED, prior: [], nowMs: MORNING }), { kind: "record", change: { kind: "moved", moveNumber: 1, action: "revert" } }, "a first move hours ahead is put back");
  eq(decideInviteChange({ event: live(MOVED), booked: BOOKED, prior: [], nowMs: NEAR }), { kind: "record", change: { kind: "moved", moveNumber: 1, action: "leave_near_start" } }, "a first move inside 30 minutes is left");
  eq(
    decideInviteChange({ event: live(MOVED), booked: BOOKED, prior: [], nowMs: Date.parse(BOOKED.startsAt) - NEAR_START_MS - MIN }),
    { kind: "record", change: { kind: "moved", moveNumber: 1, action: "revert" } },
    "31 minutes before the call is still put back",
  );
  const again = { ...MOVED, updated: "2026-10-19T14:02:00.000Z" } as GoogleEvent;
  eq(decideInviteChange({ event: again, booked: BOOKED, prior: [rec({})], nowMs: MORNING }), { kind: "record", change: { kind: "moved", moveNumber: 2, action: "leave_second_move" } }, "a second move of the same booking is left, even to the same time");
  eq(decideInviteChange({ event: live(MOVED), booked: BOOKED, prior: [rec({})], nowMs: MORNING }), { kind: "nothing", why: "already-recorded" }, "the change already recorded is not acted on twice");
  const accepted = { ...MOVED, updated: "2026-10-19T14:30:00.000Z" } as GoogleEvent;
  eq(
    decideInviteChange({ event: accepted, booked: BOOKED, prior: [rec({ moveNumber: 2, action: "leave_second_move", outcome: null })], nowMs: MORNING }),
    { kind: "nothing", why: "standing" },
    "a left move whose invite changed in some other way (the lead accepted) is the same move, not a third",
  );
  eq(
    decideInviteChange({ event: accepted, booked: BOOKED, prior: [rec({ outcome: "revert_refused" })], nowMs: MORNING }),
    { kind: "nothing", why: "standing" },
    "a move Google refused to put back is not retried on the next change",
  );
  eq(decideInviteChange({ event: live(IN_STEP), booked: BOOKED, prior: [], nowMs: MORNING }), { kind: "nothing", why: "in-step" }, "an invite in step is nothing");
  eq(decideInviteChange({ event: live(RESIZED), booked: BOOKED, prior: [], nowMs: MORNING }), { kind: "record", change: { kind: "resized", moveNumber: null, action: "report_resize" } }, "an end only change is reported");
  eq(
    decideInviteChange({ event: { ...RESIZED, updated: "2026-10-19T15:00:00.000Z" } as GoogleEvent, booked: BOOKED, prior: [rec({ kind: "resized", moveNumber: null, action: "report_resize", outcome: null, eventStartsAt: BOOKED.startsAt, eventEndsAt: "2026-10-19T20:45:00.000Z", eventUpdated: "x" })], nowMs: MORNING }),
    { kind: "nothing", why: "standing" },
    "the same end change is reported once",
  );
  eq(decideInviteChange({ event: live(MOVED), booked: BOOKED, prior: [], nowMs: Date.parse(BOOKED.endsAt) + MIN }), { kind: "nothing", why: "past" }, "a call that has ended is left alone");
}

// --- whose held lock the handler may take over -------------------------------------
{
  const at = (ms: number) => new Date(ms).toISOString();
  assert(!mayTakeOverLock({ lease_until: at(MORNING + MIN), gcal_client_id: null }, MORNING), "a live lease is somebody at work: never taken");
  assert(mayTakeOverLock({ lease_until: at(MORNING - MIN), gcal_client_id: null }, MORNING), "an expired unpinned lock, which nothing else removes, is taken over");
  assert(!mayTakeOverLock({ lease_until: at(MORNING - MIN), gcal_client_id: "evt" }, MORNING), "an expired PINNED lock is a crashed reschedule's, left to its resume and the sweep");
  assert(mayTakeOverLock({ lease_until: null, gcal_client_id: null }, MORNING), "an unreadable lease counts as expired, as the reschedule's own takeover reads it");
}

// --- which calendar the launch sweep blocks the moved time on ----------------------
{
  eq(primaryCalendarId(["team-ooo@group.calendar.google.com", "BKenny@trypennie.com"], EMAIL), "BKenny@trypennie.com", "the calendar named by the advisor's address, whatever its case");
  eq(primaryCalendarId(["primary-id"], EMAIL), "primary-id", "the only synced calendar, when there is one");
  eq(primaryCalendarId(["a", "b"], EMAIL), null, "never a guess among several");
  eq(primaryCalendarId([], EMAIL), null, "nothing when none is synced");
}

// --- the handler, through its seams ------------------------------------------------
interface World {
  nowMs: number;
  lockHeld?: boolean;
  reassign?: boolean;
  booking?: FreshBooking | null;
  live?: GoogleEvent | null;
  liveThrows?: boolean;
  prior?: InviteChangeRecord[];
  recordConflict?: boolean;
  revertError?: unknown;
  advisorDm?: boolean;
  manager?: { name: string | null; email: string } | null | "unread";
  available?: boolean;
}
function fresh(over: Partial<FreshBooking> = {}): FreshBooking {
  return {
    id: BOOKING,
    status: "confirmed",
    startsAt: BOOKED.startsAt,
    endsAt: BOOKED.endsAt,
    gcalEventId: EVENT,
    assignedUserId: USER,
    timezone: "America/Chicago",
    ...over,
  };
}
function harness(w: World) {
  const calls = {
    claims: 0,
    releases: 0,
    reads: 0,
    recorded: [] as NewInviteChange[],
    outcomes: [] as [string, string, string | null][],
    reverts: [] as [string, string, string, string, string][],
    dms: [] as [string, string][],
    posts: [] as [string, string][],
  };
  const deps: InviteMoveDeps = {
    nowMs: w.nowMs,
    advisorUserId: USER,
    advisorEmail: EMAIL,
    appBaseUrl: "https://slate.trypennie.app",
    messagesAvailable: () => w.available !== false,
    claimLock: async () => {
      calls.claims++;
      return w.lockHeld ? null : "token-1";
    },
    releaseLock: async () => {
      calls.releases++;
    },
    reassignInFlight: async () => w.reassign === true,
    loadBooking: async () => (w.booking === undefined ? fresh() : w.booking),
    readEvent: async () => {
      calls.reads++;
      if (w.liveThrows) throw new Error("events.get failed: 503 backendError");
      return w.live === undefined ? MOVED : w.live;
    },
    loadChanges: async () => w.prior ?? [],
    recordChange: async (row) => {
      if (w.recordConflict) return null;
      calls.recorded.push(row);
      return `row-${calls.recorded.length}`;
    },
    setOutcome: async (id, outcome, detail) => {
      calls.outcomes.push([id, outcome, detail]);
    },
    revert: async (email, eventId, s, e, tz) => {
      calls.reverts.push([email, eventId, s, e, tz]);
      if (w.revertError) throw w.revertError;
    },
    loadPeople: async () => ({
      advisorName: "Brian Kenny",
      manager: w.manager === undefined ? { name: "Morgan Diaz", email: "mdiaz@trypennie.com" } : w.manager,
    }),
    dm: async (email, text) => {
      if (email === EMAIL && w.advisorDm === false) return false;
      calls.dms.push([email, text]);
      return true;
    },
    post: async (key, text) => {
      calls.posts.push([key, text]);
    },
  };
  return { deps, calls };
}
const ITEM = { eventId: EVENT, bookingId: BOOKING, bookedStartsAt: BOOKED.startsAt };

async function handlerCases(): Promise<void> {
  // A moved start is put back, the lead is emailed (sendUpdates=all, inside
  // `revert`), and the advisor is told. Nobody else is.
  {
    const { deps, calls } = harness({ nowMs: MORNING });
    const out = await noticeOutOfStepInvites(deps, [ITEM]);
    eq(calls.reverts, [[EMAIL, EVENT, BOOKED.startsAt, BOOKED.endsAt, "America/Chicago"]], "the invite is moved back to the booked time");
    eq(calls.recorded.map((r) => [r.kind, r.moveNumber, r.action]), [["moved", 1, "revert"]], "the move is recorded as the first");
    eq(calls.outcomes.map((o) => o[1]), ["reverted"], "and its outcome as reverted");
    eq(calls.dms.map((d) => d[0]), [EMAIL], "only the advisor is messaged");
    assert(/times change in Slate, not in Google Calendar/i.test(calls.dms[0]![1]), "the DM says times change in Slate, not Google");
    assert(/ask your manager/i.test(calls.dms[0]![1]), "and to ask their manager to move or reassign it");
    eq(calls.posts.length, 0, "nothing is posted to the alerts channel");
    eq(calls.releases, 1, "the booking's lock is given back");
    eq(out.reverted, 1, "the summary counts the revert");
  }
  // An end only change: posted, never reverted, nobody DMed.
  {
    const { deps, calls } = harness({ nowMs: MORNING, live: RESIZED });
    await noticeOutOfStepInvites(deps, [{ ...ITEM }]);
    eq(calls.reverts.length, 0, "an end only change is not put back");
    eq(calls.dms.length, 0, "and nobody is DMed");
    eq(calls.posts.length, 1, "it is posted to the alerts channel");
    assert(calls.posts[0]![0] === `booking_invite_resized:${BOOKING}:${Date.parse("2026-10-19T20:45:00.000Z")}`, "under its own per booking key");
  }
  // A second move is escalated to all three and left.
  {
    const again = { ...MOVED, updated: "2026-10-19T14:02:00.000Z" } as GoogleEvent;
    const { deps, calls } = harness({ nowMs: MORNING, live: again, prior: [rec({})] });
    const out = await noticeOutOfStepInvites(deps, [ITEM]);
    eq(calls.reverts.length, 0, "a second move is not put back");
    eq(calls.dms.map((d) => d[0]).sort(), [EMAIL, "mdiaz@trypennie.com"].sort(), "the advisor and their manager are DMed");
    assert(/told your manager/.test(calls.dms.find((d) => d[0] === EMAIL)![1]), "the advisor is told their manager knows, because that DM was delivered first");
    eq(calls.posts.map((p) => p[0]), [`booking_invite_moved:${BOOKING}:2`], "and it is posted to the alerts channel");
    assert(/second time/i.test(calls.posts[0]![1]), "the post says it is the second move");
    eq(out.left, 1, "the summary counts it as left in place");
  }
  // Inside 30 minutes: escalated, not put back.
  {
    const { deps, calls } = harness({ nowMs: NEAR });
    await noticeOutOfStepInvites(deps, [ITEM]);
    eq(calls.reverts.length, 0, "a move inside 30 minutes of the call is not put back");
    eq(calls.dms.length, 2, "the advisor and manager are DMed");
    eq(calls.posts.length, 1, "and the alerts channel is told");
    assert(/30 minutes/.test(calls.posts[0]![1]), "the post says why it was left");
  }
  // No manager of record: the post says so rather than claiming they were told.
  {
    const { deps, calls } = harness({ nowMs: NEAR, manager: null });
    await noticeOutOfStepInvites(deps, [ITEM]);
    eq(calls.dms.map((d) => d[0]), [EMAIL], "only the advisor can be DMed");
    assert(/no manager of record/i.test(calls.posts[0]![1]), "the post says there is no manager to tell");
    assert(!/told your manager/.test(calls.dms[0]![1]), "and the advisor is not told a manager knows");
    assert(!/asked for|somebody/.test(calls.dms[0]![1]), "nor that anybody else was asked, which nothing measured");
    assert(/Please tell them about this move/.test(calls.dms[0]![1]), "they are asked to tell their manager themselves");
  }
  // The manager lookup FAILED: never reported as having no manager (L11).
  {
    const { deps, calls } = harness({ nowMs: NEAR, manager: "unread" });
    await noticeOutOfStepInvites(deps, [ITEM]);
    eq(calls.dms.map((d) => d[0]), [EMAIL], "nobody but the advisor can be DMed");
    assert(/could not be looked up/.test(calls.posts[0]![1]), "the post says the manager could not be looked up");
    assert(!/no manager of record/.test(calls.posts[0]![1]), "and never that there is no manager");
  }
  // Slate's own reschedule holds the booking's lock: not a move at all.
  {
    const { deps, calls } = harness({ nowMs: MORNING, lockHeld: true });
    const out = await noticeOutOfStepInvites(deps, [ITEM]);
    eq([calls.reads, calls.reverts.length, calls.recorded.length, calls.dms.length, calls.posts.length], [0, 0, 0, 0, 0], "a reschedule in flight is left entirely alone");
    eq(calls.releases, 0, "and a lock this run never took is not released");
    eq(out.slateOwn, 1, "it is counted as Slate's own change");
  }
  // The race the lock read alone cannot close: the sync read the booking before a
  // reschedule committed, and by the time this runs the lock is released and the
  // booking is at the new time. The FRESH booking read under our own lock sees it.
  {
    const newTime = ev("2026-10-20T15:00:00.000Z", "2026-10-20T15:20:00.000Z", { updated: "2026-10-19T12:40:00.000Z" } as never);
    const { deps, calls } = harness({
      nowMs: MORNING,
      live: newTime,
      booking: fresh({ startsAt: "2026-10-20T15:00:00.000Z", endsAt: "2026-10-20T15:20:00.000Z", status: "rescheduled" }),
    });
    await noticeOutOfStepInvites(deps, [ITEM]);
    eq([calls.reverts.length, calls.recorded.length, calls.dms.length, calls.posts.length], [0, 0, 0, 0], "a reschedule that committed after the sync read is never reverted");
  }
  // A reassign in flight.
  {
    const { deps, calls } = harness({ nowMs: MORNING, reassign: true });
    await noticeOutOfStepInvites(deps, [ITEM]);
    eq([calls.reverts.length, calls.recorded.length], [0, 0], "a reassign in flight is Slate's own change");
    eq(calls.releases, 1, "and the lock this run took is given back");
  }
  // The booking moved to another advisor, or was cancelled, since the sync read.
  {
    const { deps, calls } = harness({ nowMs: MORNING, booking: fresh({ gcalEventId: "another-event" }) });
    await noticeOutOfStepInvites(deps, [ITEM]);
    eq(calls.reverts.length, 0, "an event that is no longer the booking's invite is not touched");
    const cancelled = harness({ nowMs: MORNING, booking: fresh({ status: "cancelled" }) });
    await noticeOutOfStepInvites(cancelled.deps, [ITEM]);
    eq(cancelled.calls.reverts.length, 0, "nor is a cancelled booking's");
  }
  // Two runs see the same change (the push and the minute lane): the database decides.
  {
    const { deps, calls } = harness({ nowMs: MORNING, recordConflict: true });
    await noticeOutOfStepInvites(deps, [ITEM]);
    eq([calls.reverts.length, calls.dms.length, calls.posts.length], [0, 0, 0], "the run that did not write the record does nothing");
  }
  // Google refuses the revert: reported, never swallowed.
  {
    const { deps, calls } = harness({ nowMs: MORNING, revertError: new GoogleHttpError('events.patch failed: 403 {"error":{"errors":[{"domain":"calendar","reason":"forbiddenForNonOrganizer"}],"code":403}}', 403, "forbiddenForNonOrganizer") });
    const out = await noticeOutOfStepInvites(deps, [ITEM]);
    eq(calls.outcomes.map((o) => o[1]), ["revert_refused"], "the refusal is recorded");
    eq(calls.posts.length, 1, "and posted to the alerts channel");
    assert(calls.posts[0]![1].includes("(403 forbiddenForNonOrganizer)"), "naming what Google said, short, never the raw body");
    assert(!/times change in Slate/i.test(calls.dms.map((d) => d[1]).join(" ")), "the advisor is not told it was put back");
    eq(out.refused, 1, "the summary counts the refusal");
  }
  {
    const { deps, calls } = harness({ nowMs: MORNING, revertError: new EventGone("events.patch") });
    await noticeOutOfStepInvites(deps, [ITEM]);
    eq(calls.outcomes.map((o) => o[1]), ["event_gone"], "an invite Google says is gone is recorded as gone");
    assert(calls.posts.length === 1 && /no longer on/i.test(calls.posts[0]![1]), "and posted, saying the invite is gone");
  }
  // The advisor cannot be reached on Slack after a revert: somebody else is told.
  {
    const { deps, calls } = harness({ nowMs: MORNING, advisorDm: false });
    await noticeOutOfStepInvites(deps, [ITEM]);
    eq(calls.reverts.length, 1, "the invite is still put back");
    eq(calls.posts.length, 1, "and the alerts channel is told the advisor could not be messaged");
  }
  // A live read that fails is not a verdict: the invite is returned as unchecked for
  // the caller to page about, never thrown into the sync (which would stop it caching
  // every other meeting), the lock is given back, and the next invite is still checked.
  {
    const { deps, calls } = harness({ nowMs: MORNING, liveThrows: true });
    const out = await noticeOutOfStepInvites(deps, [ITEM, { ...ITEM, bookingId: "b-other" }]);
    eq(out.failed, [
      { bookingId: BOOKING, reason: "503" },
      { bookingId: "b-other", reason: "503" },
    ], "each unreadable invite is reported as unchecked, with a short reason, and the second is still tried");
    eq(calls.releases, 2, "each lock is released on the way out");
    eq(calls.reverts.length, 0, "and nothing was moved");
  }
  // An invite already put back by the time this runs (another run won): nothing.
  {
    const { deps, calls } = harness({ nowMs: MORNING, live: IN_STEP });
    await noticeOutOfStepInvites(deps, [ITEM]);
    eq([calls.reverts.length, calls.recorded.length], [0, 0], "an invite already back in step is nothing");
  }
  // Where no message may be sent (a laptop pointed at production, a load run), the
  // handler does nothing at all: it does not even take the lock.
  {
    const { deps, calls } = harness({ nowMs: MORNING, available: false });
    await noticeOutOfStepInvites(deps, [ITEM]);
    eq([calls.claims, calls.reverts.length], [0, 0], "nothing is read or moved where nothing may be sent");
  }
}

// --- the launch sweep (decision 9) ------------------------------------------------
async function sweepCases(): Promise<void> {
  const mirrors: { userId: string; eventId: string; startsAt: string; endsAt: string }[] = [];
  const recorded: NewInviteChange[] = [];
  const posts: string[] = [];
  const deps: InviteSweepDeps = {
    nowMs: MORNING,
    appBaseUrl: "https://slate.trypennie.app",
    apply: true,
    loadUpcoming: async () => [
      { ...fresh(), advisorEmail: EMAIL, advisorName: "Brian Kenny" },
      { ...fresh({ id: "b-2", gcalEventId: "evt-2" }), advisorEmail: "ana@trypennie.com", advisorName: "Ana Ruiz" },
      { ...fresh({ id: "b-3", gcalEventId: "evt-3" }), advisorEmail: "lee@trypennie.com", advisorName: "Lee Park" },
    ],
    bookingsWithChanges: async () => new Set(["b-3"]),
    readEvent: async (_email, id) => (id === EVENT ? MOVED : IN_STEP),
    recordChange: async (row) => {
      recorded.push(row);
      return "row";
    },
    writeMirror: async (m) => {
      mirrors.push(m);
    },
    post: async (_key, text) => {
      posts.push(text);
      return true;
    },
  };
  const out = await sweepOutOfStepInvites(deps);
  eq(out.found.map((f) => f.bookingId), [BOOKING], "only the out of step invite is found, and a booking the handler already recorded is skipped");
  // The sweep is handed no way to move an invite at all: nothing is reverted by construction.
  assert(!("revert" in deps) && !Object.keys(deps).some((k) => /revert|updateEvent/i.test(k)), "the sweep has no seam that could move an invite");
  eq(recorded.map((r) => [r.bookingId, r.kind, r.moveNumber, r.action]), [[BOOKING, "moved", 1, "report_launch"]], "it is recorded, so a later change to it is not taken for a first move");
  eq(mirrors.map((m) => [m.eventId, m.startsAt]), [[EVENT, "2026-10-19T20:00:00.000Z"]], "and its moved time is blocked");
  eq(posts.length, 1, "one message goes to the alerts channel");
  assert(posts[0]!.includes("Brian Kenny") && !/moved back/i.test(posts[0]!.replace(/not moved back/gi, "")), "naming the advisor and moving nothing back");

  // Another run (the live handler, or an earlier sweep) records one first: that one is
  // not reported by this run.
  {
    const mirrors2: string[] = [];
    const posts2: string[] = [];
    const out2 = await sweepOutOfStepInvites({
      ...deps,
      loadUpcoming: async () => [
        { ...fresh(), advisorEmail: EMAIL, advisorName: "Brian Kenny" },
        { ...fresh({ id: "b-4", gcalEventId: "evt-4" }), advisorEmail: "ana@trypennie.com", advisorName: "Ana Ruiz" },
      ],
      bookingsWithChanges: async () => new Set(),
      readEvent: async () => MOVED,
      recordChange: async (row) => (row.bookingId === BOOKING ? null : "row"),
      writeMirror: async (m) => {
        mirrors2.push(m.eventId);
      },
      post: async (_k, text) => {
        posts2.push(text);
        return true;
      },
    });
    eq(mirrors2, [EVENT, "evt-4"], "both are blocked, which is the sync's own rule for an out of step invite");
    eq(out2.recordedElsewhere, 1, "the one recorded elsewhere is counted");
    assert(posts2.length === 1 && posts2[0]!.includes("Ana Ruiz") && !posts2[0]!.includes("Brian Kenny"), "and only what this run recorded is reported");
  }

  // A block that cannot be written stops only that invite, which is named and never
  // recorded; and a message that did not post is returned, because a rerun would skip
  // what is already recorded.
  {
    const out3 = await sweepOutOfStepInvites({
      ...deps,
      loadUpcoming: async () => [
        { ...fresh(), advisorEmail: EMAIL, advisorName: "Brian Kenny" },
        { ...fresh({ id: "b-5", gcalEventId: "evt-5" }), advisorEmail: "ana@trypennie.com", advisorName: "Ana Ruiz" },
      ],
      bookingsWithChanges: async () => new Set(),
      readEvent: async () => MOVED,
      recordChange: async () => "row",
      writeMirror: async (m) => {
        if (m.eventId === EVENT) throw new Error("busy block refused");
      },
      post: async () => false,
    });
    eq(out3.notRecorded, [{ bookingId: BOOKING, reason: "busy block refused" }], "the invite whose block failed is named, not recorded");
    eq(out3.reported.map((f) => f.bookingId), ["b-5"], "and the rest are still recorded");
    eq(out3.posted, false, "a message that did not go out is said, so it can be sent by hand");
  }

  const dry = await sweepOutOfStepInvites({ ...deps, apply: false, recordChange: async () => { throw new Error("dry run wrote"); }, writeMirror: async () => { throw new Error("dry run wrote"); }, post: async () => { throw new Error("dry run posted"); } });
  eq(dry.found.length, 1, "a dry run finds the same and writes nothing");
}

await driftCase();
await handlerCases();
await sweepCases();
finish();
