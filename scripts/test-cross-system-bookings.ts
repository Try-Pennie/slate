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
//    and a partial cal.com read is a failed read (L98, #1134, #1152);
//  - the all clear hangs off a MEASURED fact about the paged booking;
//  - cal.com not configured, or marked retired, skips the read; retired ends the pages;
//  - it reads cal.com once an hour, never on every five minute tick;
//  - the page names the lead, BOTH booking ids and both start times, and no address.
import {
  CROSS_SYSTEM_BOOKING_KEY,
  crossSystemBookingKey,
  crossSystemBookingsDue,
  findCrossSystemBookings,
  formatCrossSystemBookingAlert,
  formatCrossSystemBookingRecovery,
  formatCrossSystemBookingRetired,
  runCrossSystemBookingsCheck,
  type CrossSystemBookingsDeps,
  type SlateUpcomingBooking,
} from "@/lib/monitor/cross-system-bookings";
import { crossSystemBookingsReachedVerdict } from "@/lib/monitor/verdict-freshness";
import type { CalcomUpcomingBooking, CalcomUpcomingRead } from "@/lib/calcom/upcoming-bookings";
import { PARTNER_KEYS } from "@/lib/booking/partner-keys";
import { assert, eq, finish } from "./lib/harness.ts";

// 2026-10-01 01:00:30Z: on the hour, so the check is due.
const NOW = Date.UTC(2026, 9, 1, 1, 0, 30);
const LEAD = "00QUi00000t840LMAQ";
const SUB = "a04Ui00000NDRunIAH";
const SLATE_ID = "aa70212d-aafa-46ad-88d1-c47cdca0d17c";

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
    uid: "hSzsCyr9HbBcg92HpJXg3r",
    start: "2026-10-01T22:00:00.000Z",
    status: "accepted",
    host: "kevin-host",
    submissionId: SUB,
    attendeeEmails: ["lead.person@example.test"],
    ...over,
  };
}

// --- the cadence ------------------------------------------------------------------
{
  assert(crossSystemBookingsDue(Date.UTC(2026, 9, 1, 1, 0, 0)), "the tick on the hour is due");
  assert(crossSystemBookingsDue(Date.UTC(2026, 9, 1, 1, 4, 59)), "a late tick inside the first five minutes is still due");
  assert(!crossSystemBookingsDue(Date.UTC(2026, 9, 1, 1, 5, 0)), "the next five minute tick is not");
  assert(!crossSystemBookingsDue(Date.UTC(2026, 9, 1, 1, 55, 0)), "nor any other tick in the hour");
  let due = 0;
  for (let m = 0; m < 60; m += 5) if (crossSystemBookingsDue(Date.UTC(2026, 9, 1, 3, m, 10))) due++;
  eq(due, 1, "exactly one five minute tick an hour reads cal.com");
}

// --- the judge ----------------------------------------------------------------------
{
  const pairs = findCrossSystemBookings([slate()], [cal()], NOW);
  eq(pairs.length, 1, "the 2026-10-01 duplicate is found");
  eq(pairs[0].matchedOn, "both", "it shares the Submission id and the address");
  eq(pairs[0].leadId, LEAD, "the lead id comes from the Slate booking, since cal.com holds none");
  eq(pairs[0].calcom.map((c) => c.id), [26177051], "with the cal.com twin");
}
{
  // The same booking with the address differing: the Submission id alone is enough.
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
  const pairs = findCrossSystemBookings([slate({ prefill: {}, attendee_email: null })], [cal()], NOW);
  eq(pairs, [], "a Slate booking with neither key cannot be matched, and is not guessed at");
}
{
  const pairs = findCrossSystemBookings([slate()], [cal({ submissionId: null, attendeeEmails: [] })], NOW);
  eq(pairs, [], "a cal.com booking with neither key matches nothing");
}
{
  // A blank address on both sides must not join two strangers.
  const pairs = findCrossSystemBookings([slate({ prefill: {}, attendee_email: "  " })], [cal({ submissionId: null, attendeeEmails: [""] })], NOW);
  eq(pairs, [], "a blank address is no key");
}
for (const status of ["cancelled", "rejected"]) {
  eq(findCrossSystemBookings([slate()], [cal({ status })], NOW), [], `a ${status} cal.com booking is not live`);
}
{
  eq(findCrossSystemBookings([slate()], [cal({ start: "2026-10-01T00:30:00.000Z" })], NOW), [], "a cal.com booking that has started is not upcoming");
}
{
  const pairs = findCrossSystemBookings([slate()], [cal(), cal({ id: 26177999, uid: "second", start: "2026-10-03T15:00:00.000Z" })], NOW);
  eq(pairs.length, 1, "one finding per Slate booking");
  eq(pairs[0].calcom.map((c) => c.id), [26177051, 26177999], "carrying every live cal.com twin, soonest first");
}

// --- the copy -------------------------------------------------------------------------
{
  const [pair] = findCrossSystemBookings([slate()], [cal()], NOW);
  const text = formatCrossSystemBookingAlert(pair, `https://slate.test/admin/bookings/${SLATE_ID}`);
  for (const want of [LEAD, SLATE_ID, "26177051", "hSzsCyr9HbBcg92HpJXg3r", "Fri, Oct 2", "Thu, Oct 1", "4:00pm ET", "6:00pm ET", "Jordan Advisor", "kevin-host", "Submission"]) {
    assert(text.includes(want), `the page names ${want}`);
  }
  assert(text.includes("https://slate.test/admin/bookings/"), "the page links the Slate booking");
  assert(text.includes("https://app.cal.com/booking/hSzsCyr9HbBcg92HpJXg3r"), "and the cal.com one");
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
  const [pair] = findCrossSystemBookings([slate({ attendee_email: "lead.person@example.test" })], [cal({ submissionId: null })], NOW);
  assert(formatCrossSystemBookingAlert(pair, "u").includes("same email address"), "an address match says that is what matched");
}
{
  const gone = formatCrossSystemBookingRecovery(SLATE_ID, "slate-gone", "u");
  const calGone = formatCrossSystemBookingRecovery(SLATE_ID, "calcom-gone", "u");
  assert(gone !== calGone, "the two endings say different things");
  assert(gone.includes(SLATE_ID) && calGone.includes(SLATE_ID), "each names the booking");
  assert(formatCrossSystemBookingRetired(SLATE_ID).includes("retired"), "the retirement ending says why");
}

// --- the runner -----------------------------------------------------------------------
interface Spy {
  notified: Array<{ key: string; ms: number; text: string }>;
  resolved: Array<{ key: string; text: string }>;
  calcomReads: string[];
  slateReads: number;
}

function deps(over: Partial<CrossSystemBookingsDeps> = {}, firing: string[] = []): { d: CrossSystemBookingsDeps; spy: Spy } {
  const spy: Spy = { notified: [], resolved: [], calcomReads: [], slateReads: 0 };
  const d: CrossSystemBookingsDeps = {
    nowMs: NOW,
    calcomRetired: async () => false,
    loadSlate: async () => {
      spy.slateReads++;
      return [slate()];
    },
    readCalcom: async (afterIso): Promise<CalcomUpcomingRead | null> => {
      spy.calcomReads.push(afterIso);
      return { ok: true, rows: [cal()], pages: 1 };
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
  eq(spy.notified.map((n) => n.key), [crossSystemBookingKey(SLATE_ID)], "it pages once, keyed on the Slate booking");
  eq(crossSystemBookingKey(SLATE_ID), `${CROSS_SYSTEM_BOOKING_KEY}:${SLATE_ID}`, "the family key");
  eq(spy.notified[0].ms, 6 * 3_600_000, "at the configured cooldown");
  eq(spy.calcomReads, [new Date(NOW).toISOString()], "cal.com is asked for bookings starting from now");
  eq(spy.resolved, [], "nothing to clear");
  assert(crossSystemBookingsReachedVerdict(r), "a measured comparison is a verdict");
}
{
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
  const { d, spy } = deps({ calcomRetired: async () => true }, [SLATE_ID]);
  const r = await runCrossSystemBookingsCheck(d);
  eq(r.status, "retired", "a retired cal.com is not read");
  eq(spy.calcomReads.length, 0, "no cal.com read");
  eq(spy.resolved.map((x) => x.key), [crossSystemBookingKey(SLATE_ID)], "and every outstanding page ends saying why");
  assert(spy.resolved[0].text.includes("retired"), "with the retirement wording");
  assert(crossSystemBookingsReachedVerdict(r), "retired is a settled answer, so its silence is not blindness");
}
{
  // An unreadable retirement setting keeps today's behaviour, the comparison runs.
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
  ["a cal.com read that throws", { readCalcom: async () => { throw new Error("The operation was aborted due to timeout"); } }],
  ["a Slate read that throws", { loadSlate: async () => { throw new Error("monitor cross system bookings: 500"); } }],
] as const) {
  const { d, spy } = deps(over as Partial<CrossSystemBookingsDeps>, [SLATE_ID, "11111111-2222-3333-4444-555555555555"]);
  const r = await runCrossSystemBookingsCheck(d);
  eq(r.status, "unreadable", `${what} is unreadable`);
  eq(spy.notified, [], `${what} pages nothing`);
  eq(spy.resolved.length, 0, `${what} clears nothing, however many pages are open`);
  assert(!crossSystemBookingsReachedVerdict(r), `${what} is no verdict`);
}
{
  const { d } = deps({ readCalcom: async () => ({ ok: false, reason: "refused", status: 401, page: 0 }) });
  const r = await runCrossSystemBookingsCheck(d);
  if (r.status === "unreadable") {
    eq(r.stage, "calcom", "the refusal names its side");
    assert(r.error.includes("401") && r.error.includes("refused"), `and its cause: ${r.error}`);
  }
}

// The all clear, off measured facts only.
{
  const { d, spy } = deps({ readCalcom: async () => ({ ok: true, rows: [cal({ status: "cancelled" })], pages: 1 }) }, [SLATE_ID]);
  await runCrossSystemBookingsCheck(d);
  eq(spy.resolved.map((x) => x.key), [crossSystemBookingKey(SLATE_ID)], "the cal.com twin cancelled ends the page");
  eq(spy.resolved[0].text, formatCrossSystemBookingRecovery(SLATE_ID, "calcom-gone", d.bookingUrl(SLATE_ID)), "saying the cal.com booking went");
}
{
  const { d, spy } = deps({ loadSlate: async () => [slate({ id: "other-booking", prefill: {}, attendee_email: "x@example.test" })] }, [SLATE_ID]);
  await runCrossSystemBookingsCheck(d);
  eq(spy.resolved[0]?.text, formatCrossSystemBookingRecovery(SLATE_ID, "slate-gone", d.bookingUrl(SLATE_ID)), "the Slate booking no longer upcoming ends the page, saying so");
}
{
  const { d, spy } = deps({}, [SLATE_ID]);
  await runCrossSystemBookingsCheck(d);
  eq(spy.resolved, [], "a pair still live keeps its page");
  eq(spy.notified.length, 1, "and is paged again, subject to the cooldown");
}
{
  // Excluded as a test, so not measured this run: it keeps whatever it has.
  const { d, spy } = deps(
    { loadSlate: async () => [slate({ prefill: { [PARTNER_KEYS.submissionId]: SUB, parentOrigin: "http://localhost:3000" }, referrer_origin: "http://localhost:3000" })] },
    [SLATE_ID],
  );
  const r = await runCrossSystemBookingsCheck(d);
  eq(spy.notified, [], "a booking made from a test host page is never paged");
  eq(spy.resolved, [], "nor cleared as gone");
  if (r.status === "measured") eq(r.testSource, 1, "it is counted as a test");
  assert(!crossSystemBookingsReachedVerdict(r), "test bookings alone are no verdict");
}
{
  const { d, spy } = deps({ listFiring: async () => { throw new Error("alert_state unreadable"); } });
  const r = await runCrossSystemBookingsCheck(d);
  eq(r.status, "measured", "an unreadable firing list does not undo the measurement");
  eq(spy.resolved, [], "but clears nothing");
}
{
  const { d, spy } = deps({ loadSlate: async () => [] }, [SLATE_ID]);
  const r = await runCrossSystemBookingsCheck(d);
  eq(spy.calcomReads.length, 0, "with no upcoming Slate booking cal.com is not asked at all");
  eq(spy.resolved.map((x) => x.key), [crossSystemBookingKey(SLATE_ID)], "and a paged booking that is no longer upcoming is measured gone");
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
