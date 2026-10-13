// #3372: who hears about an approved time off whose Google Calendar event no longer
// matches it, and when. The agent first, then their manager, then the alerts channel,
// with each step's wait set by how soon the uncovered hours begin.
//
// Pure: no clock, no network, no database. The runner on the monitor lane executes
// what `planEscalation` decides; every decision is pinned here.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-ooo-mismatch-escalation.ts
import {
  agentNoticeKey,
  agentOutcomeKey,
  managerDeliveredKey,
  managerNoticeKey,
  parseNoticeRow,
  escalationPace,
  gapSpans,
  bookedInsideGap,
  planEscalation,
  managerToTell,
  OOO_MISMATCH_NOTICE_PREFIX,
  URGENT_LEAD_MS,
  SOON_LEAD_MS,
  PACES,
  STALE_SEND_MS,
  type MeasuredMismatch,
  type NoticeRecord,
} from "../src/lib/ooo/mismatch-escalation.ts";
import type { OooEventMismatch } from "../src/lib/ooo/alert-copy.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-06T15:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

// --- the keys --------------------------------------------------------------------
{
  const a = agentNoticeKey("u1", "r1");
  assert(a.startsWith(OOO_MISMATCH_NOTICE_PREFIX), "an agent notice key carries the family prefix");
  const m = managerNoticeKey("u1", "r1", { kind: "told", managerId: "m1" });
  const none = managerNoticeKey("u1", "r1", { kind: "none" });
  const lost = managerNoticeKey("u1", "r1", { kind: "unreachable" });
  assert(new Set([a, m, none, lost]).size === 4, "agent, manager, no-manager and undelivered records never share a key");
  eq(
    parseNoticeRow({ key: a, last_sent_at: iso(NOW) }),
    { role: "agent", agentId: "u1", requestId: "r1", toldAtMs: NOW, key: a },
    "an agent record reads back what was written",
  );
  eq(
    parseNoticeRow({ key: m, last_sent_at: iso(NOW) }),
    { role: "manager", agentId: "u1", requestId: "r1", outcome: { kind: "told", managerId: "m1" }, toldAtMs: NOW, key: m },
    "a manager record reads back who was told",
  );
  eq(
    parseNoticeRow({ key: none, last_sent_at: iso(NOW) }),
    { role: "manager", agentId: "u1", requestId: "r1", outcome: { kind: "none" }, toldAtMs: NOW, key: none },
    "a record of there being no manager to tell reads back as nobody",
  );
  eq(
    parseNoticeRow({ key: lost, last_sent_at: iso(NOW) })?.role === "manager"
      ? (parseNoticeRow({ key: lost, last_sent_at: iso(NOW) }) as { outcome: unknown }).outcome
      : null,
    { kind: "unreachable" },
    "a manager message that could not be delivered reads back as such, not as told",
  );
  eq(parseNoticeRow({ key: `${OOO_MISMATCH_NOTICE_PREFIX}agent:u1`, last_sent_at: iso(NOW) }), null,
    "a key missing its request is not read as anybody's record");
  eq(parseNoticeRow({ key: "ooo_event_mismatch:u1", last_sent_at: iso(NOW) }), null,
    "a key of another family is not a notice record");
  const unreadable = parseNoticeRow({ key: a, last_sent_at: "not a time" });
  assert(
    unreadable !== null && unreadable.toldAtMs === null,
    "an unreadable stamp reads as null, never as NaN or as now",
  );
}

// --- the pace --------------------------------------------------------------------
{
  eq(escalationPace(NOW + 7 * DAY, NOW, false), "relaxed", "a gap a week out can wait for the agent");
  eq(escalationPace(NOW + SOON_LEAD_MS + HOUR, NOW, false), "relaxed", "just past three days is still relaxed");
  eq(escalationPace(NOW + SOON_LEAD_MS - HOUR, NOW, false), "soon", "inside three days is soon");
  eq(escalationPace(NOW + URGENT_LEAD_MS + HOUR, NOW, false), "soon", "just past a day is soon");
  eq(escalationPace(NOW + URGENT_LEAD_MS - HOUR, NOW, false), "urgent", "a gap starting tomorrow is urgent");
  eq(escalationPace(NOW - HOUR, NOW, false), "urgent", "a gap already open is urgent");
  eq(escalationPace(NOW + 20 * DAY, NOW, true), "urgent", "a call booked inside the gap is urgent however far out");
  assert(
    PACES.urgent.agentGraceMs < PACES.soon.agentGraceMs && PACES.soon.agentGraceMs < PACES.relaxed.agentGraceMs,
    "the agent's wait shrinks as the gap gets closer",
  );
  assert(
    PACES.urgent.managerGraceMs < PACES.soon.managerGraceMs && PACES.soon.managerGraceMs < PACES.relaxed.managerGraceMs,
    "the manager's wait shrinks as the gap gets closer",
  );
  // A week out, the whole ladder still finishes days before the hours begin.
  assert(
    PACES.relaxed.agentGraceMs + PACES.relaxed.managerGraceMs < 7 * DAY - SOON_LEAD_MS,
    "a mismatch a week out reaches the alerts channel before it even becomes soon",
  );
}

// --- the gap ---------------------------------------------------------------------
const uncovered = (startMs: number, endMs: number): OooEventMismatch => ({
  requestId: "r1",
  startsAt: iso(NOW + DAY),
  endsAt: iso(NOW + 2 * DAY),
  displayTzId: "America/Denver",
  displayTzLabel: "MT",
  coverage: { kind: "uncovered", spans: [{ startMs, endMs }] },
});
const notBlocking = (over: Partial<OooEventMismatch> = {}): OooEventMismatch => ({
  requestId: "r1",
  startsAt: iso(NOW + DAY),
  endsAt: iso(NOW + 2 * DAY),
  displayTzId: "America/Denver",
  displayTzLabel: "MT",
  coverage: { kind: "not-blocking", unmeasured: null },
  ...over,
});
{
  eq(gapSpans(uncovered(NOW + DAY, NOW + DAY + 5 * HOUR), NOW), [{ startMs: NOW + DAY, endMs: NOW + DAY + 5 * HOUR }],
    "an uncovered finding's gap is the open spans the judge measured");
  eq(gapSpans(notBlocking(), NOW), [{ startMs: NOW + DAY, endMs: NOW + 2 * DAY }],
    "a not blocking finding's gap is the whole window still ahead");
  eq(gapSpans(notBlocking({ startsAt: iso(NOW - HOUR) }), NOW), [{ startMs: NOW, endMs: NOW + 2 * DAY }],
    "hours already gone are not part of the gap");
  eq(
    gapSpans(notBlocking({ coverage: { kind: "not-blocking", unmeasured: { startMs: NOW + 30 * HOUR, endMs: NOW + 2 * DAY } } }), NOW),
    [{ startMs: NOW + DAY, endMs: NOW + 30 * HOUR }],
    "the tail too far ahead to check is never part of the gap",
  );
  const gap = [{ startMs: NOW + DAY, endMs: NOW + DAY + 5 * HOUR }];
  assert(bookedInsideGap(gap, [{ startsAt: iso(NOW + DAY + HOUR), endsAt: iso(NOW + DAY + 2 * HOUR) }]),
    "a call inside the gap is found");
  assert(bookedInsideGap(gap, [{ startsAt: iso(NOW + DAY - HOUR), endsAt: iso(NOW + DAY + 30 * 60_000) }]),
    "a call straddling the gap's start is found");
  assert(!bookedInsideGap(gap, [{ startsAt: iso(NOW + DAY + 5 * HOUR), endsAt: iso(NOW + DAY + 6 * HOUR) }]),
    "a call starting as the gap ends is not inside it");
  assert(!bookedInsideGap(gap, [{ startsAt: "garbage", endsAt: iso(NOW + DAY + 2 * HOUR) }]),
    "an unreadable call is not counted as booked");
}

// --- the manager -----------------------------------------------------------------
{
  const agent = { id: "u1", managerId: "m1" };
  const mgr = { id: "m1", name: "Pat Lead", email: "pat@trypennie.com", role: "manager" as const, deactivatedAt: null };
  eq(managerToTell(agent, mgr)?.id ?? null, "m1", "a manager of record who can act is told");
  eq(managerToTell({ id: "u1", managerId: null }, null), null, "no manager of record is nobody to tell");
  eq(managerToTell(agent, { ...mgr, role: "agent" }), null, "a manager of record who cannot act on time off is not told");
  eq(managerToTell(agent, { ...mgr, deactivatedAt: iso(NOW) }), null, "a departed manager is not told");
  eq(managerToTell(agent, { ...mgr, email: null }), null, "a manager with no address cannot be told");
  eq(managerToTell({ id: "m1", managerId: "m1" }, { ...mgr }), null, "an agent named as their own manager is not told twice");
  eq(managerToTell(agent, { ...mgr, id: "other" }), null, "a row for somebody else is never taken for the manager");
}

// --- the plan --------------------------------------------------------------------
const mm = (over: Partial<MeasuredMismatch> = {}): MeasuredMismatch => ({
  agentId: "u1",
  requestId: "r1",
  finding: notBlocking(),
  gapStartMs: NOW + 7 * DAY,
  bookedInGap: false,
  ...over,
});
const agentRec = (requestId: string, toldAtMs: number | null, agentId = "u1"): NoticeRecord => ({
  role: "agent", agentId, requestId, toldAtMs, key: agentNoticeKey(agentId, requestId),
});
// The agent was told: an attempt and its delivered outcome, as the lane writes them.
const outcomeRec = (requestId: string, toldAtMs: number | null, outcome: "told" | "unreachable"): NoticeRecord => ({
  role: "agent-outcome", agentId: "u1", requestId, outcome, toldAtMs, key: agentOutcomeKey("u1", requestId, outcome),
});
const told = (requestId: string, toldAtMs: number | null): NoticeRecord[] => [
  agentRec(requestId, toldAtMs),
  outcomeRec(requestId, toldAtMs, "told"),
];
type Outcome = Extract<NoticeRecord, { role: "manager" }>["outcome"];
const TOLD: Outcome = { kind: "told", managerId: "m1" };
const mgrRec = (requestId: string, toldAtMs: number | null, outcome: Outcome = TOLD): NoticeRecord => ({
  role: "manager", agentId: "u1", requestId, outcome, toldAtMs, key: managerNoticeKey("u1", requestId, outcome),
});
// The manager was told: the told record and its delivery, as the lane writes them.
const deliveredRec = (requestId: string, toldAtMs: number | null): NoticeRecord => ({
  role: "manager-delivered", agentId: "u1", requestId, toldAtMs, key: managerDeliveredKey("u1", requestId),
});
const toldMgr = (requestId: string, toldAtMs: number | null): NoticeRecord[] => [mgrRec(requestId, toldAtMs), deliveredRec(requestId, toldAtMs)];
const plan = (over: Partial<Parameters<typeof planEscalation>[0]> = {}) =>
  planEscalation({
    nowMs: NOW,
    mismatches: [],
    agreed: new Set(),
    approved: new Set(["r1"]),
    departedAgents: new Set(),
    records: [],
    ...over,
  });
const ids = (list: { requestId: string }[]) => list.map((x) => x.requestId);

{
  const p = plan({ mismatches: [mm()] });
  eq(ids(p.tellAgent), ["r1"], "a measured mismatch nobody has heard about goes to the agent first");
  eq(ids(p.tellManager), [], "the manager is not told on the first step");
  eq(ids(p.pageDan), [], "the alerts channel is not told on the first step");
}
{
  const p = plan({ mismatches: [mm()], records: [...told("r1", NOW - PACES.relaxed.agentGraceMs + HOUR)] });
  eq([...ids(p.tellAgent), ...ids(p.tellManager), ...ids(p.pageDan)], [],
    "a week out, the agent's wait is not over, so nobody else hears yet");
}
{
  const p = plan({ mismatches: [mm()], records: [...told("r1", NOW - PACES.relaxed.agentGraceMs)] });
  eq(ids(p.tellManager), ["r1"], "once the agent's wait is over, the manager is told");
  eq(ids(p.tellAgent), [], "the agent is not told twice");
}
{
  // The same record, an hour and a half old: too young for a week out, old enough
  // for a gap tomorrow and for a call already booked inside it.
  const rec = [...told("r1", NOW - 90 * 60_000)];
  eq(ids(plan({ mismatches: [mm({ gapStartMs: NOW + 12 * HOUR })], records: rec }).tellManager), ["r1"],
    "a gap starting tomorrow reaches the manager sooner");
  eq(ids(plan({ mismatches: [mm({ bookedInGap: true })], records: rec }).tellManager), ["r1"],
    "a call booked inside the gap reaches the manager sooner");
  eq(ids(plan({ mismatches: [mm()], records: rec }).tellManager), [], "a week out it still waits");
}
{
  const p = plan({
    mismatches: [mm()],
    records: [...told("r1", NOW - 5 * DAY), ...toldMgr("r1", NOW - PACES.relaxed.managerGraceMs + HOUR)],
  });
  eq([...ids(p.tellManager), ...ids(p.pageDan)], [], "the manager's wait is not over, so the alerts channel waits");
}
{
  const p = plan({
    mismatches: [mm()],
    records: [...told("r1", NOW - 5 * DAY), ...toldMgr("r1", NOW - PACES.relaxed.managerGraceMs)],
  });
  eq(ids(p.pageDan), ["r1"], "the alerts channel hears only once neither the agent nor the manager acted");
  eq(ids(p.tellManager), [], "the manager is not told twice");
}
{
  const p = plan({ mismatches: [mm()], records: [...told("r1", NOW - 5 * DAY), mgrRec("r1", NOW, { kind: "none" })] });
  eq(ids(p.pageDan), ["r1"], "with no manager to tell, the alerts channel hears without a second wait");
  const q = plan({ mismatches: [mm()], records: [...told("r1", NOW - 5 * DAY), mgrRec("r1", NOW, { kind: "unreachable" })] });
  eq(ids(q.pageDan), ["r1"], "with the manager's message undelivered, the alerts channel hears without a second wait");
}
{
  const p = plan({ mismatches: [mm()], records: [...told("r1", null)] });
  eq(ids(p.tellManager), ["r1"], "an unreadable stamp counts as the wait being over, the loud direction");
}

// Unmeasured never messages anybody: the plan only ever acts on `mismatches`, the
// findings the judge MEASURED. A request in the approved set that is neither a
// mismatch nor agreed (unmeasured, unreadable, out of the pool) is held exactly.
{
  const held = plan({ records: [...told("r1", NOW - 30 * DAY), ...toldMgr("r1", NOW - 30 * DAY)] });
  eq([...ids(held.tellAgent), ...ids(held.tellManager), ...ids(held.pageDan)], [],
    "a request this tick could not measure is never escalated, however old its records");
  eq(held.clear, [], "and it is never cleared either: nothing was compared");
  eq(held.forget, [], "and its records are kept for a tick that can measure it");
  const fresh = plan({});
  eq([...ids(fresh.tellAgent), ...ids(fresh.tellManager), ...ids(fresh.pageDan)], [],
    "an unmeasured request with no records messages nobody");
}

// The stop, whichever side changed.
{
  const p = plan({ agreed: new Set(["r1"]), records: [...told("r1", NOW - DAY), ...toldMgr("r1", NOW - HOUR)] });
  eq(p.clear.length, 1, "a request measured agreeing again is cleared");
  eq(p.clear[0]!.why, "agreed", "and says it agrees again");
  eq(p.clear[0]!.records.map((r) => r.role).sort(), ["agent", "agent-outcome", "manager", "manager-delivered"], "everybody who was told hears it");
}
{
  const p = plan({ approved: new Set(), records: [...told("r1", NOW - DAY)] });
  eq(p.clear.length, 1, "a request no longer approved (changed, cancelled or passed) is cleared");
  eq(p.clear[0]!.why, "left-approved", "and says the request moved, not that the calendar was fixed");
}
{
  const p = plan({ agreed: new Set(["r1"]) });
  eq(p.clear, [], "an agreeing request nobody was told about sends nothing");
}
{
  const p = plan({ mismatches: [mm({ requestId: "r2" })], approved: new Set(["r1", "r2"]),
    agreed: new Set(["r1"]), records: [...told("r1", NOW - DAY), ...told("r2", NOW - HOUR)] });
  eq(p.clear.map((c) => c.requestId), ["r1"], "one request agreeing clears that request alone");
  eq([...ids(p.tellManager), ...ids(p.tellAgent)], [], "while the other keeps its own clock");
}

// A departed agent is skipped.
{
  const p = plan({
    mismatches: [mm()],
    departedAgents: new Set(["u1"]),
    records: [...told("r1", NOW - 30 * DAY), ...toldMgr("r1", NOW - 30 * DAY)],
  });
  eq([...ids(p.tellAgent), ...ids(p.tellManager), ...ids(p.pageDan)], [], "a departed agent's mismatch messages nobody");
  eq(p.clear, [], "and sends no all-clear to somebody who has left");
  eq(p.forget.length, 4, "their records are dropped quietly");
}

// The attempt and its outcome are two records, so a run that dies between claiming
// and sending can be told apart from one that sent (#3372 review, L766).
{
  const k = agentOutcomeKey("u1", "r1", "told");
  const lost = agentOutcomeKey("u1", "r1", "unreachable");
  assert(new Set([agentNoticeKey("u1", "r1"), k, lost]).size === 3, "the attempt and each outcome have their own keys");
  eq(parseNoticeRow({ key: lost, last_sent_at: iso(NOW) }),
    { role: "agent-outcome", agentId: "u1", requestId: "r1", outcome: "unreachable", toldAtMs: NOW, key: lost },
    "an undelivered agent message reads back as such");
  eq(parseNoticeRow({ key: `${OOO_MISMATCH_NOTICE_PREFIX}outcome:u1:r1:maybe`, last_sent_at: iso(NOW) }), null,
    "an outcome that is neither told nor unreachable is not read as either");
}
{
  const fresh = plan({ mismatches: [mm()], records: [agentRec("r1", NOW - STALE_SEND_MS + 60_000)] });
  eq([...ids(fresh.tellAgent), ...ids(fresh.tellManager), ...ids(fresh.pageDan)], [],
    "an attempt still inside its send window is left alone: it may yet answer");
  const stale = plan({ mismatches: [mm()], records: [agentRec("r1", NOW - STALE_SEND_MS)] });
  eq(ids(stale.tellAgent), ["r1"], "an attempt that never recorded an outcome is tried again once no send can still be answering");
  eq(stale.tellAgent[0]!.staleKey, agentNoticeKey("u1", "r1"), "naming the dead attempt to remove");
  eq(ids(stale.tellManager), [], "and the manager is not told about a message nobody may have read");
  eq(ids(plan({ mismatches: [mm()], records: [agentRec("r1", null)] }).tellAgent), ["r1"],
    "an attempt whose stamp cannot be read is tried again, the loud direction");
}
{
  const p = plan({ mismatches: [mm()], records: [agentRec("r1", NOW), outcomeRec("r1", NOW, "unreachable")] });
  eq(ids(p.tellManager), ["r1"], "an agent who could not be reached sends the manager the message with no wait");
  eq(p.tellManager[0]!.agentTold, "unreachable", "saying the agent could not be reached");
  const q = plan({ mismatches: [mm()], records: told("r1", NOW - PACES.relaxed.agentGraceMs) });
  eq(q.tellManager[0]!.agentTold, { atMs: NOW - PACES.relaxed.agentGraceMs }, "a delivered message gives the manager when it was sent");
}
{
  // Three requests, three different histories: each page line carries its own reason.
  const p = plan({
    approved: new Set(["r1", "r2", "r3"]),
    mismatches: [mm(), mm({ requestId: "r2" }), mm({ requestId: "r3" })],
    records: [
      ...told("r1", NOW - 5 * DAY), ...toldMgr("r1", NOW - 2 * DAY),
      ...told("r2", NOW - 5 * DAY), mgrRec("r2", NOW, { kind: "none" }),
      agentRec("r3", NOW - 5 * DAY), outcomeRec("r3", NOW - 5 * DAY, "unreachable"), ...toldMgr("r3", NOW - 2 * DAY),
    ],
  });
  eq(p.pageDan.map((x) => [x.requestId, x.reason]), [
    ["r1", { agent: "told", manager: "told" }],
    ["r2", { agent: "told", manager: "none" }],
    ["r3", { agent: "unreachable", manager: "told" }],
  ], "each request reaches the alerts channel with its own reason, never another request's");
}

// The manager step has the same two halves: told is claimed before the send, and
// delivered is written after it, so a run that died between them is retried.
{
  const fresh = plan({ mismatches: [mm()], records: [...told("r1", NOW - 5 * DAY), mgrRec("r1", NOW - STALE_SEND_MS + 60_000)] });
  eq([...ids(fresh.tellManager), ...ids(fresh.pageDan)], [], "a manager message still inside its send window is left alone");
  const stale = plan({ mismatches: [mm()], records: [...told("r1", NOW - 5 * DAY), mgrRec("r1", NOW - 3 * DAY)] });
  eq(ids(stale.tellManager), ["r1"], "a manager message that never recorded its delivery is sent again");
  eq(stale.tellManager[0]!.staleKey, managerNoticeKey("u1", "r1", TOLD), "naming the dead record to remove");
  eq(ids(stale.pageDan), [], "and the alerts channel is not told the manager was told");
}

finish();
