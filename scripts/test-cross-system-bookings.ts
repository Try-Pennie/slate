// A lead holding a live booking in BOTH Slate and cal.com (#2933). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-cross-system-bookings.ts
//
// On 2026-10-01, during the 50/50 Low split, lead 00QUi00000t840LMAQ booked cal.com
// (booking 26177051, 22:00Z that day) and then Slate nineteen minutes later on the
// same Submission (aa70212d, 20:00Z the next day). Both stayed live, because Slate's
// one call per lead check reads only Slate. What this file pins:
//  - the known duplicate's shape pages, matched on the Submission id that both halves
//    carry (measured live: Slate's prefill and cal.com's `metadata.sfdc_submission_id`),
//    and a lead whose cal.com booking carries no submission id is still matched on the
//    attendee address (789 of 1,252 upcoming cal.com bookings carry none);
//  - both directions: distinct leads, a cancelled cal.com twin, and a Slate booking
//    made from a test host page are all silent;
//  - a failed read on EITHER side measures nothing: no page, no all clear, no verdict,
//    and a partial or timed out cal.com read is a failed read (L98, #1134, #1152);
//  - the cal.com side all clear rests on a DIRECT read of that booking by uid, never
//    on its absence from the listing, which pages by skip and can drop a row;
//  - the whole run is held to one deadline, driven by an injected clock;
//  - cal.com not configured, or marked retired, skips the read; retired ends the pages;
//  - it reads cal.com once an hour, never on every five minute tick;
//  - the page names the lead, BOTH booking ids and both start times, and no address.
import {
  CROSS_SYSTEM_BOOKING_KEY,
  CROSS_SYSTEM_BUDGET_MS,
  crossSystemBookingKey,
  crossSystemBookingMember,
  crossSystemBookingsDue,
  findCrossSystemBookings,
  formatCrossSystemBookingAlert,
  formatCrossSystemBookingRecovery,
  formatCrossSystemBookingRetired,
  parseCrossSystemBookingMember,
  runCrossSystemBookingsCheck,
  type CrossSystemBookingsDeps,
  type SlateUpcomingBooking,
} from "@/lib/monitor/cross-system-bookings";
import { crossSystemBookingsReachedVerdict } from "@/lib/monitor/verdict-freshness";
import type { CalcomBookingRead, CalcomUpcomingBooking, CalcomUpcomingRead } from "@/lib/calcom/upcoming-bookings";
import { PARTNER_KEYS } from "@/lib/booking/partner-keys";
import { assert, eq, finish } from "./lib/harness.ts";

// 2026-10-01 01:00:30Z: on the hour, so the check is due.
const NOW = Date.UTC(2026, 9, 1, 1, 0, 30);
const LEAD = "00QUi00000t840LMAQ";
const SUB = "a04Ui00000NDRunIAH";
const SLATE_ID = "aa70212d-aafa-46ad-88d1-c47cdca0d17c";
const UID = "hSzsCyr9HbBcg92HpJXg3r";
const MEMBER = crossSystemBookingMember(SLATE_ID, UID);

function slate(over: Partial<SlateUpcomingBooking> = {}): SlateUpcomingBooking {
  return {
    id: SLATE_ID,
    starts_at: "2026-10-02T20:00:00+00:00",
    salesforce_id: LEAD,
    external_id: null,
    agent_name: "Jordan Advisor",
    agent_email: "jordan.advisor@trypennie.com",
    attendee_email: "lead.person@example.test",
    prefill: { [PARTNER_KEYS.submissionId]: SUB, parentOrigin: "https://www.trypennie.com" },
    referrer_origin: "https://www.trypennie.com",
    ...over,
  };
}

function cal(over: Partial<CalcomUpcomingBooking> = {}): CalcomUpcomingBooking {
  return {
    id: 26177051,
    uid: UID,
    start: "2026-10-01T22:00:00.000Z",
    status: "accepted",
    host: "kevin-host",
    submissionId: SUB,
    attendeeEmails: ["lead.person@example.test"],
    ...over,
  };
}

// --- the cadence and the key ------------------------------------------------------
{
  assert(crossSystemBookingsDue(Date.UTC(2026, 9, 1, 1, 0, 0)), "the tick on the hour is due");
  assert(crossSystemBookingsDue(Date.UTC(2026, 9, 1, 1, 4, 59)), "a late tick inside the first five minutes is still due");
  assert(!crossSystemBookingsDue(Date.UTC(2026, 9, 1, 1, 5, 0)), "the next five minute tick is not");
  assert(!crossSystemBookingsDue(Date.UTC(2026, 9, 1, 1, 55, 0)), "nor any other tick in the hour");
  let due = 0;
  for (let m = 0; m < 60; m += 5) if (crossSystemBookingsDue(Date.UTC(2026, 9, 1, 3, m, 10))) due++;
  eq(due, 1, "exactly one five minute tick an hour reads cal.com");

  eq(crossSystemBookingKey(SLATE_ID, UID), `${CROSS_SYSTEM_BOOKING_KEY}:${SLATE_ID}:${UID}`, "one key per pair, carrying the cal.com uid the all clear must read");
  eq(parseCrossSystemBookingMember(MEMBER), { slateId: SLATE_ID, uid: UID }, "a firing member reads back to its pair");
  eq(parseCrossSystemBookingMember(SLATE_ID), null, "a member with no uid is not one this version wrote");
  eq(parseCrossSystemBookingMember(`${SLATE_ID}:`), null, "nor is one with an empty uid");
}

// --- the judge ----------------------------------------------------------------------
{
  const pairs = findCrossSystemBookings([slate()], [cal()], NOW);
  eq(pairs.length, 1, "the 2026-10-01 duplicate is found");
  eq(pairs[0].matchedOn, "both", "it shares the Submission id and the address");
  eq(pairs[0].leadId, LEAD, "the lead id comes from the Slate booking, since cal.com holds none");
  eq(pairs[0].calcom.id, 26177051, "with the cal.com twin");
}
{
  const pairs = findCrossSystemBookings([slate()], [cal({ attendeeEmails: ["other.spelling@example.test"] })], NOW);
  eq(pairs.map((p) => p.matchedOn), ["submission"], "matched on the Submission id alone");
}
{
  // A `review` event type booking: empty metadata, so only the address can match.
  const pairs = findCrossSystemBookings([slate({ attendee_email: "  Lead.Person@Example.TEST " })], [cal({ submissionId: null })], NOW);
  eq(pairs.map((p) => p.matchedOn), ["email"], "a cal.com booking with no Submission id is matched by address, case and space aside");
}
{
  const pairs = findCrossSystemBookings(
    [slate()],
    [cal({ submissionId: "a04Ui00000OTHERxxx", attendeeEmails: ["somebody.else@example.test"] })],
    NOW,
  );
  eq(pairs, [], "a different lead in cal.com is not a duplicate");
}
{
  eq(findCrossSystemBookings([slate({ prefill: {}, attendee_email: null })], [cal()], NOW), [], "a Slate booking with neither key cannot be matched, and is not guessed at");
  eq(findCrossSystemBookings([slate()], [cal({ submissionId: null, attendeeEmails: [] })], NOW), [], "a cal.com booking with neither key matches nothing");
  eq(
    findCrossSystemBookings([slate({ prefill: {}, attendee_email: "  " })], [cal({ submissionId: null, attendeeEmails: [""] })], NOW),
    [],
    "a blank address is no key",
  );
}
for (const status of ["cancelled", "rejected"]) {
  eq(findCrossSystemBookings([slate()], [cal({ status })], NOW), [], `a ${status} cal.com booking is not live`);
}
{
  eq(findCrossSystemBookings([slate()], [cal({ start: "2026-10-01T00:30:00.000Z" })], NOW), [], "a cal.com booking that has started is not upcoming");
}
{
  const pairs = findCrossSystemBookings([slate()], [cal({ id: 26177999, uid: "second", start: "2026-10-03T15:00:00.000Z" }), cal()], NOW);
  eq(pairs.map((p) => p.calcom.id), [26177051, 26177999], "a lead with two cal.com calls is two pairs, soonest first");
}

// --- the copy -------------------------------------------------------------------------
{
  const [pair] = findCrossSystemBookings([slate()], [cal()], NOW);
  const text = formatCrossSystemBookingAlert(pair, `https://slate.test/admin/bookings/${SLATE_ID}`);
  for (const want of [LEAD, SLATE_ID, "26177051", UID, "Fri, Oct 2", "Thu, Oct 1", "4:00pm ET", "6:00pm ET", "Jordan Advisor", "kevin-host", "Submission"]) {
    assert(text.includes(want), `the page names ${want}`);
  }
  assert(text.includes("https://slate.test/admin/bookings/"), "the page links the Slate booking");
  assert(text.includes(`https://app.cal.com/booking/${UID}`), "and the cal.com one");
  assert(!text.includes("example.test"), "no lead address is ever in the page");
  assert(!/[\u2014\u2013]/.test(text), "no dash as punctuation");
}
{
  const [pair] = findCrossSystemBookings([slate({ salesforce_id: null, external_id: null })], [cal()], NOW);
  const text = formatCrossSystemBookingAlert(pair, "https://slate.test/x");
  assert(text.startsWith("A lead with no Salesforce lead id"), `a booking with no lead id says so rather than printing null: ${text.slice(0, 60)}`);
  assert(!text.includes("null"), "no null leaks");
}
{
  const [pair] = findCrossSystemBookings([slate()], [cal({ submissionId: null })], NOW);
  assert(formatCrossSystemBookingAlert(pair, "u").includes("same email address"), "an address match says that is what matched");
}
{
  const gone = formatCrossSystemBookingRecovery(SLATE_ID, UID, "slate-gone", "u");
  const calGone = formatCrossSystemBookingRecovery(SLATE_ID, UID, "calcom-gone", "u");
  assert(gone !== calGone, "the two endings say different things");
  assert(gone.includes(SLATE_ID) && calGone.includes(SLATE_ID), "each names the Slate booking");
  assert(calGone.includes(UID), "the cal.com ending names the cal.com booking it read");
  assert(formatCrossSystemBookingRetired(SLATE_ID).includes("retired"), "the retirement ending says why");
}

// --- the runner -----------------------------------------------------------------------
interface Spy {
  notified: Array<{ key: string; ms: number; text: string }>;
  resolved: Array<{ key: string; text: string }>;
  calcomReads: Array<{ afterIso: string; deadlineAtMs: number }>;
  directReads: Array<{ uid: string; deadlineAtMs: number }>;
  slateReads: number;
}

const CLOCK_START = 5_000_000;

function deps(over: Partial<CrossSystemBookingsDeps> = {}, firing: string[] = []): { d: CrossSystemBookingsDeps; spy: Spy } {
  const spy: Spy = { notified: [], resolved: [], calcomReads: [], directReads: [], slateReads: 0 };
  const d: CrossSystemBookingsDeps = {
    nowMs: NOW,
    clock: () => CLOCK_START,
    calcomRetired: async () => false,
    loadSlate: async () => {
      spy.slateReads++;
      return [slate()];
    },
    readCalcom: async (afterIso, deadlineAtMs): Promise<CalcomUpcomingRead | null> => {
      spy.calcomReads.push({ afterIso, deadlineAtMs });
      return { ok: true, rows: [cal()], pages: 1 };
    },
    readCalcomByUid: async (uid, deadlineAtMs): Promise<CalcomBookingRead | null> => {
      spy.directReads.push({ uid, deadlineAtMs });
      return { ok: true, row: cal({ uid }) };
    },
    listFiring: async () => new Set(firing),
    bookingUrl: (id) => `https://slate.test/admin/bookings/${id}`,
    notify: async (key, ms, text) => {
      spy.notified.push({ key, ms, text });
    },
    resolve: async (key, text) => {
      spy.resolved.push({ key, text });
      return true;
    },
    cooldownMs: 6 * 3_600_000,
    ...over,
  };
  return { d, spy };
}

{
  const { d, spy } = deps();
  const r = await runCrossSystemBookingsCheck(d);
  eq(r.status, "measured", "the duplicate is measured");
  if (r.status === "measured") {
    eq(r.pairs.length, 1, "one pair");
    eq(r.slateCompared, 1, "one Slate booking compared");
    eq(r.calcomCompared, 1, "against one cal.com booking");
  }
  eq(spy.notified.map((n) => n.key), [crossSystemBookingKey(SLATE_ID, UID)], "it pages once, keyed on the pair");
  eq(spy.notified[0].ms, 6 * 3_600_000, "at the configured cooldown");
  eq(spy.calcomReads, [{ afterIso: new Date(NOW).toISOString(), deadlineAtMs: CLOCK_START + CROSS_SYSTEM_BUDGET_MS }], "cal.com is asked from now, held to the run's deadline");
  eq(spy.directReads, [], "a pair found in the listing needs no direct read");
  eq(spy.resolved.length, 0, "nothing to clear");
  assert(crossSystemBookingsReachedVerdict(r), "a measured comparison is a verdict");
}
{
  eq(CROSS_SYSTEM_BUDGET_MS, 45_000, "the whole run is held to forty five seconds");
  const { d, spy } = deps({ nowMs: Date.UTC(2026, 9, 1, 1, 10, 0) });
  const r = await runCrossSystemBookingsCheck(d);
  eq(r.status, "not-due", "off the hour nothing is read");
  eq(spy.calcomReads.length + spy.slateReads, 0, "no read on either side");
  assert(!crossSystemBookingsReachedVerdict(r), "and no verdict");
}
{
  const { d, spy } = deps({ readCalcom: async () => null });
  const r = await runCrossSystemBookingsCheck(d);
  eq(r.status, "not-configured", "no cal.com key here skips the check");
  eq(spy.notified.length + spy.resolved.length, 0, "and says nothing");
  assert(!crossSystemBookingsReachedVerdict(r), "not configured is not a verdict");
}
{
  const { d, spy } = deps({ calcomRetired: async () => true }, [MEMBER]);
  const r = await runCrossSystemBookingsCheck(d);
  eq(r.status, "retired", "a retired cal.com is not read");
  eq(spy.calcomReads.length + spy.directReads.length, 0, "no cal.com read of either kind");
  eq(spy.resolved.map((x) => x.key), [crossSystemBookingKey(SLATE_ID, UID)], "and every outstanding page ends");
  assert(spy.resolved[0].text.includes("retired") && spy.resolved[0].text.includes(SLATE_ID), "with the retirement wording, naming the booking");
  assert(crossSystemBookingsReachedVerdict(r), "retired is a settled answer, so its silence is not blindness");
}
{
  const { d } = deps({ calcomRetired: async () => null });
  eq((await runCrossSystemBookingsCheck(d)).status, "measured", "an unreadable retirement flag still compares");
}
{
  const { d, spy } = deps({ calcomRetired: async () => { throw new Error("db down"); } });
  eq((await runCrossSystemBookingsCheck(d)).status, "measured", "a retirement read that throws is an unreadable flag, and still compares");
  eq(spy.notified.length, 1, "and still pages");
}

// Failure paths: each measures nothing, pages nothing, clears nothing.
for (const [what, over] of [
  ["a refused cal.com page", { readCalcom: async () => ({ ok: false, reason: "refused", status: 429, page: 2 }) }],
  ["an unreadable cal.com payload", { readCalcom: async () => ({ ok: false, reason: "unreadable", status: 200, page: 0 }) }],
  ["a partial cal.com read past its budget", { readCalcom: async () => ({ ok: false, reason: "too-many-pages", status: 200, page: 40 }) }],
  ["a cal.com walk that ran out of its deadline", { readCalcom: async () => ({ ok: false, reason: "deadline", status: 0, page: 3 }) }],
  ["an unreachable cal.com", { readCalcom: async () => ({ ok: false, reason: "unreachable", status: 0, page: 0 }) }],
  ["a cal.com read that throws", { readCalcom: async () => { throw new Error("boom"); } }],
  ["a Slate read that throws", { loadSlate: async () => { throw new Error("monitor cross system bookings: 500"); } }],
] as const) {
  const { d, spy } = deps(over as Partial<CrossSystemBookingsDeps>, [MEMBER, "11111111-2222-3333-4444-555555555555:otherUid"]);
  const r = await runCrossSystemBookingsCheck(d);
  eq(r.status, "unreadable", `${what} is unreadable`);
  eq(spy.notified.length, 0, `${what} pages nothing`);
  eq(spy.resolved.length, 0, `${what} clears nothing, however many pages are open`);
  eq(spy.directReads.length, 0, `${what} spends no direct read`);
  assert(!crossSystemBookingsReachedVerdict(r), `${what} is no verdict`);
}
{
  const { d } = deps({ readCalcom: async () => ({ ok: false, reason: "deadline", status: 0, page: 3 }) });
  const r = await runCrossSystemBookingsCheck(d);
  if (r.status === "unreadable") {
    eq(r.stage, "calcom", "the refusal names its side");
    assert(r.error.includes("deadline"), `and its cause by name: ${r.error}`);
  }
}
{
  // The deadline is computed from the injected clock at the start of the run, so a run
  // that starts late is held to the same forty five seconds from when it started.
  const { d, spy } = deps({ clock: () => 9_000_000 }, [MEMBER]);
  await runCrossSystemBookingsCheck({ ...d, readCalcom: async (a, dl) => { spy.calcomReads.push({ afterIso: a, deadlineAtMs: dl }); return { ok: true, rows: [], pages: 1 }; } });
  eq(spy.calcomReads[0].deadlineAtMs, 9_045_000, "the listing gets the run's deadline");
  eq(spy.directReads[0]?.deadlineAtMs, 9_045_000, "and so does the direct read: one budget for the whole run");
}

// The all clear, off measured facts only.
{
  // The twin is missing from the listing, which pages by skip and can drop a row, so
  // the booking itself is read: it is still upcoming, so the page stays open.
  const { d, spy } = deps({ readCalcom: async () => ({ ok: true, rows: [], pages: 1 }) }, [MEMBER]);
  const r = await runCrossSystemBookingsCheck(d);
  eq(spy.directReads.map((x) => x.uid), [UID], "a paged twin missing from the list is read directly by uid");
  eq(spy.resolved.length, 0, "a twin the direct read says is still upcoming keeps its page");
  if (r.status === "measured") eq(r.stillLive, 1, "and is counted as still live");
}
for (const [what, direct] of [
  ["refused", { ok: false, reason: "refused", status: 404 }],
  ["unreadable", { ok: false, reason: "unreadable", status: 200 }],
  ["out of time", { ok: false, reason: "deadline", status: 0 }],
  ["unreachable", { ok: false, reason: "unreachable", status: 0 }],
] as const) {
  const { d, spy } = deps({ readCalcom: async () => ({ ok: true, rows: [], pages: 1 }), readCalcomByUid: async () => direct }, [MEMBER]);
  const r = await runCrossSystemBookingsCheck(d);
  eq(spy.resolved.length, 0, `a direct read that is ${what} clears nothing`);
  if (r.status === "measured") eq(r.unconfirmed, 1, `and the page is counted unconfirmed (${what})`);
}
{
  const { d, spy } = deps({ readCalcom: async () => ({ ok: true, rows: [], pages: 1 }), readCalcomByUid: async () => { throw new Error("boom"); } }, [MEMBER]);
  await runCrossSystemBookingsCheck(d);
  eq(spy.resolved.length, 0, "a direct read that throws clears nothing");
}
for (const [what, row] of [
  ["cancelled", cal({ status: "cancelled" })],
  ["rejected", cal({ status: "rejected" })],
  ["started", cal({ start: "2026-10-01T00:30:00.000Z" })],
] as const) {
  const { d, spy } = deps({ readCalcom: async () => ({ ok: true, rows: [], pages: 1 }), readCalcomByUid: async () => ({ ok: true, row }) }, [MEMBER]);
  await runCrossSystemBookingsCheck(d);
  eq(spy.resolved.map((x) => x.key), [crossSystemBookingKey(SLATE_ID, UID)], `a direct read saying the twin ${what} ends the page`);
  eq(spy.resolved[0]?.text, formatCrossSystemBookingRecovery(SLATE_ID, UID, "calcom-gone", d.bookingUrl(SLATE_ID)), "saying the cal.com booking went");
}
{
  // The listing still shows the twin but marked cancelled: the direct read decides.
  const { d, spy } = deps({ readCalcom: async () => ({ ok: true, rows: [cal({ status: "cancelled" })], pages: 1 }) }, [MEMBER]);
  await runCrossSystemBookingsCheck(d);
  eq(spy.directReads.map((x) => x.uid), [UID], "even a cancelled row in the listing is confirmed by a direct read");
  eq(spy.resolved.length, 0, "and a direct read saying it is live keeps the page");
}
{
  const { d, spy } = deps({ loadSlate: async () => [slate({ id: "other-booking", prefill: {}, attendee_email: "x@example.test" })] }, [MEMBER]);
  await runCrossSystemBookingsCheck(d);
  eq(spy.resolved[0]?.text, formatCrossSystemBookingRecovery(SLATE_ID, UID, "slate-gone", d.bookingUrl(SLATE_ID)), "the Slate booking no longer upcoming ends the page, saying so");
  eq(spy.directReads.length, 0, "with no cal.com read needed");
}
{
  const { d, spy } = deps({}, [MEMBER]);
  await runCrossSystemBookingsCheck(d);
  eq(spy.resolved.length, 0, "a pair still live keeps its page");
  eq(spy.notified.length, 1, "and is paged again, subject to the cooldown");
}
{
  const { d, spy } = deps({}, [SLATE_ID]);
  await runCrossSystemBookingsCheck(d);
  eq(spy.resolved.length, 0, "a member this version did not write is never cleared");
}
{
  const { d, spy } = deps(
    { loadSlate: async () => [slate({ prefill: { [PARTNER_KEYS.submissionId]: SUB, parentOrigin: "http://localhost:3000" }, referrer_origin: "http://localhost:3000" })] },
    [MEMBER],
  );
  const r = await runCrossSystemBookingsCheck(d);
  eq(spy.notified.length, 0, "a booking made from a test host page is never paged");
  eq(spy.resolved.length, 0, "nor cleared as gone");
  if (r.status === "measured") eq(r.testSource, 1, "it is counted as a test");
  assert(!crossSystemBookingsReachedVerdict(r), "test bookings alone are no verdict");
}
{
  const { d, spy } = deps({ listFiring: async () => { throw new Error("alert_state unreadable"); } });
  const r = await runCrossSystemBookingsCheck(d);
  eq(r.status, "measured", "an unreadable firing list does not undo the measurement");
  eq(spy.resolved.length, 0, "but clears nothing");
}
{
  const { d, spy } = deps({ loadSlate: async () => [] }, [MEMBER]);
  const r = await runCrossSystemBookingsCheck(d);
  eq(spy.calcomReads.length, 0, "with no upcoming Slate booking cal.com is not asked at all");
  eq(spy.resolved.map((x) => x.key), [crossSystemBookingKey(SLATE_ID, UID)], "and a paged booking that is no longer upcoming is measured gone");
  assert(!crossSystemBookingsReachedVerdict(r), "comparing zero Slate bookings is never a verdict");
}
{
  const { d, spy } = deps({
    notify: async () => { throw new Error("slack down"); },
    resolve: async () => { throw new Error("slack down"); },
  });
  const r = await runCrossSystemBookingsCheck(d);
  eq(r.status, "measured", "a failing dispatch never fails the tick");
  eq(spy.notified.length, 0, "the spy saw no successful send");
}
assert(!crossSystemBookingsReachedVerdict(null), "a step that threw concluded nothing");

finish();
