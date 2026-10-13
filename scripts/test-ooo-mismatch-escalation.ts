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
type Outcome = Extract<NoticeRecord, { role: "manager" }>["outcome"];
const TOLD: Outcome = { kind: "told", managerId: "m1" };
const mgrRec = (requestId: string, toldAtMs: number | null, outcome: Outcome = TOLD): NoticeRecord => ({
  role: "manager", agentId: "u1", requestId, outcome, toldAtMs, key: managerNoticeKey("u1", requestId, outcome),
});
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
  const p = plan({ mismatches: [mm()], records: [agentRec("r1", NOW - PACES.relaxed.agentGraceMs + HOUR)] });
  eq([...ids(p.tellAgent), ...ids(p.tellManager), ...ids(p.pageDan)], [],
    "a week out, the agent's wait is not over, so nobody else hears yet");
}
{
  const p = plan({ mismatches: [mm()], records: [agentRec("r1", NOW - PACES.relaxed.agentGraceMs)] });
  eq(ids(p.tellManager), ["r1"], "once the agent's wait is over, the manager is told");
  eq(ids(p.tellAgent), [], "the agent is not told twice");
}
{
  // The same record, an hour and a half old: too young for a week out, old enough
  // for a gap tomorrow and for a call already booked inside it.
  const rec = [agentRec("r1", NOW - 90 * 60_000)];
  eq(ids(plan({ mismatches: [mm({ gapStartMs: NOW + 12 * HOUR })], records: rec }).tellManager), ["r1"],
    "a gap starting tomorrow reaches the manager sooner");
  eq(ids(plan({ mismatches: [mm({ bookedInGap: true })], records: rec }).tellManager), ["r1"],
    "a call booked inside the gap reaches the manager sooner");
  eq(ids(plan({ mismatches: [mm()], records: rec }).tellManager), [], "a week out it still waits");
}
{
  const p = plan({
    mismatches: [mm()],
    records: [agentRec("r1", NOW - 5 * DAY), mgrRec("r1", NOW - PACES.relaxed.managerGraceMs + HOUR)],
  });
  eq([...ids(p.tellManager), ...ids(p.pageDan)], [], "the manager's wait is not over, so the alerts channel waits");
}
{
  const p = plan({
    mismatches: [mm()],
    records: [agentRec("r1", NOW - 5 * DAY), mgrRec("r1", NOW - PACES.relaxed.managerGraceMs)],
  });
  eq(ids(p.pageDan), ["r1"], "the alerts channel hears only once neither the agent nor the manager acted");
  eq(ids(p.tellManager), [], "the manager is not told twice");
}
{
  const p = plan({ mismatches: [mm()], records: [agentRec("r1", NOW - 5 * DAY), mgrRec("r1", NOW, { kind: "none" })] });
  eq(ids(p.pageDan), ["r1"], "with no manager to tell, the alerts channel hears without a second wait");
  const q = plan({ mismatches: [mm()], records: [agentRec("r1", NOW - 5 * DAY), mgrRec("r1", NOW, { kind: "unreachable" })] });
  eq(ids(q.pageDan), ["r1"], "with the manager's message undelivered, the alerts channel hears without a second wait");
}
{
  const p = plan({ mismatches: [mm()], records: [agentRec("r1", null)] });
  eq(ids(p.tellManager), ["r1"], "an unreadable stamp counts as the wait being over, the loud direction");
}

// Unmeasured never messages anybody: the plan only ever acts on `mismatches`, the
// findings the judge MEASURED. A request in the approved set that is neither a
// mismatch nor agreed (unmeasured, unreadable, out of the pool) is held exactly.
{
  const held = plan({ records: [agentRec("r1", NOW - 30 * DAY), mgrRec("r1", NOW - 30 * DAY)] });
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
  const p = plan({ agreed: new Set(["r1"]), records: [agentRec("r1", NOW - DAY), mgrRec("r1", NOW - HOUR)] });
  eq(p.clear.length, 1, "a request measured agreeing again is cleared");
  eq(p.clear[0]!.why, "agreed", "and says it agrees again");
  eq(p.clear[0]!.records.map((r) => r.role).sort(), ["agent", "manager"], "everybody who was told hears it");
}
{
  const p = plan({ approved: new Set(), records: [agentRec("r1", NOW - DAY)] });
  eq(p.clear.length, 1, "a request no longer approved (changed, cancelled or passed) is cleared");
  eq(p.clear[0]!.why, "left-approved", "and says the request moved, not that the calendar was fixed");
}
{
  const p = plan({ agreed: new Set(["r1"]) });
  eq(p.clear, [], "an agreeing request nobody was told about sends nothing");
}
{
  const p = plan({ mismatches: [mm({ requestId: "r2" })], approved: new Set(["r1", "r2"]),
    agreed: new Set(["r1"]), records: [agentRec("r1", NOW - DAY), agentRec("r2", NOW - HOUR)] });
  eq(p.clear.map((c) => c.requestId), ["r1"], "one request agreeing clears that request alone");
  eq([...ids(p.tellManager), ...ids(p.tellAgent)], [], "while the other keeps its own clock");
}

// A departed agent is skipped.
{
  const p = plan({
    mismatches: [mm()],
    departedAgents: new Set(["u1"]),
    records: [agentRec("r1", NOW - 30 * DAY), mgrRec("r1", NOW - 30 * DAY)],
  });
  eq([...ids(p.tellAgent), ...ids(p.tellManager), ...ids(p.pageDan)], [], "a departed agent's mismatch messages nobody");
  eq(p.clear, [], "and sends no all-clear to somebody who has left");
  eq(p.forget.length, 2, "their records are dropped quietly");
}

finish();
