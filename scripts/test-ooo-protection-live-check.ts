// Pure logic for the LIVE time off protection check (#1478). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs \
//     scripts/test-ooo-protection-live-check.ts
//
// Why this exists. `pnpm verify:ooo-protection` asks GOOGLE whether an approved
// time off is really blocking the agent's calendar, because #1464 proved a
// stored "ok" worthless: the request still recorded the busy block as written
// long after the row had been deleted. A check that reads `side_effects` or
// `busy_blocks` would be verifying the code under test against records that same
// code wrote (L58).
//
// The live half cannot be unit tested, and the decision half must not be left
// untested because of it. Everything below drives the pure verdict functions
// through hand written fakes, in BOTH directions (L1): a matching event over a
// window Google reports as occupied verifies, and every way it can be wrong
// refuses with its own reason. A one sided check is satisfied by a function hard
// wired to a single answer.
//
// The refusal reasons are asserted one at a time on purpose (L11). One message
// answering for another is how "could not check" ends up reading as "checked and
// found nothing wrong".
import {
  selectRequests,
  judgeRequest,
  summarize,
  readToleranceMs,
  DEFAULT_TOLERANCE_MINUTES,
  VERDICT_CODES,
  type ApprovedRequestRow,
  type CalendarReading,
  type GoogleEventTimes,
} from "./lib/ooo-protection-live-check.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const MIN = 60_000;
const NOW = Date.UTC(2026, 7, 20, 12, 0, 0);
const iso = (offsetMin: number) => new Date(NOW + offsetMin * MIN).toISOString();

/** An approved request starting in two hours and running for two hours. */
function request(over: Partial<ApprovedRequestRow> = {}): ApprovedRequestRow {
  return {
    id: "req-1",
    status: "approved",
    userId: "user-1",
    agentEmail: "agent@trypennie.com",
    agentName: "Agent One",
    agentDeactivatedAt: null,
    startsAt: iso(120),
    endsAt: iso(240),
    displayTzId: "America/New_York",
    agentEventId: "evt-1",
    busyBlockEffect: "ok",
    agentEventEffect: "ok",
    ...over,
  };
}

/** A Google event covering exactly the request window. */
function event(over: Partial<GoogleEventTimes> = {}): GoogleEventTimes {
  return {
    status: "confirmed",
    start: { dateTime: iso(120), timeZone: "America/New_York" },
    end: { dateTime: iso(240), timeZone: "America/New_York" },
    ...over,
  };
}

/** A reading where Google returned the event and reports the window occupied. */
function reading(over: Partial<Extract<CalendarReading, { kind: "read" }>> = {}): CalendarReading {
  return {
    kind: "read",
    event: { state: "found", event: event() },
    busy: [{ start: iso(120), end: iso(240) }],
    ...over,
  };
}

const judgeOpts = { toleranceMs: MIN, nowMs: NOW };

/**
 * Every verdict this file produces, recorded as it goes, so the completeness
 * check at the bottom can insist that each declared outcome is one this suite
 * actually PRODUCES rather than one it merely lists (L151).
 */
const produced = new Set<string>();
function judge(...args: Parameters<typeof judgeRequest>): ReturnType<typeof judgeRequest> {
  const v = judgeRequest(...args);
  produced.add(v.code);
  return v;
}

// --- reading the tolerance: a setting that cannot be read must REFUSE (L50) ---
{
  const t = readToleranceMs(undefined);
  assert(t.ok, "an unset tolerance takes the default");
  if (t.ok) eq(t.ms, DEFAULT_TOLERANCE_MINUTES * MIN, "which is one minute");
}
{
  const t = readToleranceMs("");
  assert(t.ok, "an EMPTY setting is not a value, so it takes the default too");
  if (t.ok) eq(t.ms, DEFAULT_TOLERANCE_MINUTES * MIN, "rather than becoming zero");
}
{
  const t = readToleranceMs("5");
  assert(t.ok, "a real number of minutes is used");
  if (t.ok) eq(t.ms, 5 * MIN, "converted to milliseconds");
}
{
  const t = readToleranceMs("0");
  assert(t.ok, "zero is a legitimate setting: compare the bounds exactly");
  if (t.ok) eq(t.ms, 0, "and it is not confused with unset");
}
{
  // NaN compares false against everything, so a tolerance nobody could read would
  // make EVERY event look like it does not cover its window: a confident wrong
  // answer for the whole run instead of one refusal.
  const t = readToleranceMs("abc");
  assert(!t.ok, "a tolerance that is not a number refuses");
  if (!t.ok) assert(/not a number/.test(t.why), "and says so");
}
{
  const t = readToleranceMs("-5");
  assert(!t.ok, "a negative tolerance refuses rather than widening the match backwards");
}

// --- selecting what to check: finding nothing is never a pass (L98) ---
{
  const s = selectRequests([request()], { nowMs: NOW, requestedId: null, includeUnhandled: false });
  assert(s.ok, "an approved future request is selected for checking");
  if (s.ok) eq(s.requests.length, 1, "and exactly that one is checked");
}
{
  const s = selectRequests([], { nowMs: NOW, requestedId: null, includeUnhandled: false });
  assert(!s.ok, "a sweep that finds no approved future request REFUSES, it does not pass");
  if (!s.ok) eq(s.code, "no-approved-future-requests", "with its own reason");
}
{
  // The window has already ended, so there is nothing left to protect. Distinct
  // from having found no rows at all: one means the query matched nothing, the
  // other means everything it matched is behind us.
  const s = selectRequests([request({ startsAt: iso(-240), endsAt: iso(-120) })], {
    nowMs: NOW,
    requestedId: null,
    includeUnhandled: false,
  });
  assert(!s.ok, "a sweep whose only requests have already ended refuses");
  if (!s.ok) eq(s.code, "no-approved-future-requests", "as nothing ahead of us is left to check");
}
{
  const s = selectRequests([request({ status: "pending" })], {
    nowMs: NOW,
    requestedId: null,
    includeUnhandled: false,
  });
  assert(!s.ok, "a sweep ignores requests that were never approved");
}
{
  // The #1485 population: imported from the old Apps Script tool, approved, with
  // no recorded outcome at all because Slate never ran a step for them. Nothing
  // here can be a lost cover, so they are excluded by default and the exclusion
  // is never silent.
  const imported = request({ agentEventId: null, busyBlockEffect: null, agentEventEffect: null });
  const s = selectRequests([imported], { nowMs: NOW, requestedId: null, includeUnhandled: false });
  assert(!s.ok, "a sweep of nothing but imported requests refuses rather than reporting success");
  if (!s.ok) {
    eq(s.code, "only-unhandled-requests", "with its own reason, not the empty one");
    assert(/1/.test(s.why), "and says how many were excluded");
  }
}
{
  const imported = request({ agentEventId: null, busyBlockEffect: null, agentEventEffect: null });
  const s = selectRequests([imported, request({ id: "req-2" })], {
    nowMs: NOW,
    requestedId: null,
    includeUnhandled: false,
  });
  assert(s.ok, "a sweep with one handled request proceeds");
  if (s.ok) {
    eq(s.requests.map((r) => r.id).join(","), "req-2", "checking only the handled one");
    eq(s.skippedUnhandled, 1, "and counting the excluded one rather than hiding it");
  }
}
{
  const imported = request({ agentEventId: null, busyBlockEffect: null, agentEventEffect: null });
  const s = selectRequests([imported], { nowMs: NOW, requestedId: null, includeUnhandled: true });
  assert(s.ok, "the opt in includes the imported ones");
}

// --- selecting ONE request by id ---
{
  const s = selectRequests([request()], { nowMs: NOW, requestedId: "req-1", includeUnhandled: false });
  assert(s.ok, "a named approved future request is selected");
}
{
  const s = selectRequests([], { nowMs: NOW, requestedId: "missing", includeUnhandled: false });
  assert(!s.ok, "a named request that does not exist refuses");
  if (!s.ok) eq(s.code, "request-not-found", "saying the id matched no row");
}
{
  const s = selectRequests([request({ status: "pending" })], {
    nowMs: NOW,
    requestedId: "req-1",
    includeUnhandled: false,
  });
  assert(!s.ok, "a named request that is not approved refuses");
  if (!s.ok) {
    eq(s.code, "request-not-approved", "with its own reason");
    assert(/pending/.test(s.why), "and names the status it actually holds");
  }
}
{
  const s = selectRequests([request({ startsAt: iso(-240), endsAt: iso(-120) })], {
    nowMs: NOW,
    requestedId: "req-1",
    includeUnhandled: false,
  });
  assert(!s.ok, "a named request whose window has passed refuses");
  if (!s.ok) eq(s.code, "request-window-passed", "with its own reason, not the not-approved one");
}
{
  const imported = request({ agentEventId: null, busyBlockEffect: null, agentEventEffect: null });
  const s = selectRequests([imported], { nowMs: NOW, requestedId: "req-1", includeUnhandled: false });
  assert(!s.ok, "a named request Slate never acted on refuses by default");
  if (!s.ok) eq(s.code, "request-unhandled", "with its own reason");
}

// --- the verifying direction: an event that matches, over a window Google reports busy ---
{
  const v = judge(request(), reading(), judgeOpts);
  eq(v.code, "verified", "a matching event over an occupied window verifies");
  assert(v.ok, "and is the only verdict that passes");
}
{
  // Sub minute noise is representation, not an edit: the request form works in
  // minutes, so nothing a person can do moves an event by 30 seconds.
  const v = judge(
    request(),
    reading({
      event: {
        state: "found",
        event: event({
          start: { dateTime: new Date(NOW + 120 * MIN + 20_000).toISOString() },
          end: { dateTime: new Date(NOW + 240 * MIN - 20_000).toISOString() },
        }),
      },
    }),
    judgeOpts,
  );
  eq(v.code, "verified", "a sub tolerance difference in the bounds still verifies");
}
{
  // The event may be written as an all day event by hand. The date is read in the
  // event's own zone when Google gives one, and Google's end date is exclusive.
  const allDay = request({
    startsAt: "2026-08-20T04:00:00.000Z",
    endsAt: "2026-08-21T04:00:00.000Z",
    displayTzId: "America/New_York",
  });
  const v = judge(
    allDay,
    {
      kind: "read",
      event: {
        state: "found",
        event: {
          status: "confirmed",
          start: { date: "2026-08-20" },
          end: { date: "2026-08-21" },
        },
      },
      busy: [{ start: "2026-08-20T04:00:00.000Z", end: "2026-08-21T04:00:00.000Z" }],
    },
    { toleranceMs: MIN, nowMs: Date.parse("2026-08-19T12:00:00.000Z") },
  );
  eq(v.code, "verified", "an all day event is read in the request's own display zone");
}

// --- the refusing directions, one distinct reason at a time (L11) ---
{
  const v = judge(
    request(),
    reading({ event: { state: "not-recorded" }, busy: [] }),
    judgeOpts,
  );
  eq(v.code, "event-never-recorded-window-free", "no event and a clear window is the #1464 signature");
  assert(!v.ok, "and it fails");
}
{
  // The window reads occupied while the time off has no event of its own. Busy
  // periods MERGE, so this can be a neighbouring meeting: it proves the window is
  // busy, never that the time off is what is blocking it.
  const v = judge(
    request(),
    reading({ event: { state: "not-recorded" } }),
    judgeOpts,
  );
  eq(v.code, "event-never-recorded-window-busy", "an occupied window with no event of its own is its own finding");
  assert(!v.ok, "and it still fails, because free/busy alone cannot tell what is blocking");
}
{
  const v = judge(request(), reading({ event: { state: "gone" }, busy: [] }), judgeOpts);
  eq(v.code, "event-gone-window-free", "an event Slate recorded that Google no longer has is its own reason");
}
{
  const v = judge(request(), reading({ event: { state: "gone" } }), judgeOpts);
  eq(v.code, "event-gone-window-busy", "and a deleted event over an occupied window is a different one again");
}
{
  const v = judge(
    request(),
    reading({
      event: {
        state: "found",
        event: event({ end: { dateTime: iso(180) } }),
      },
    }),
    judgeOpts,
  );
  eq(v.code, "event-window-uncovered", "an event that stops short leaves part of the window open");
  assert(!v.ok, "which fails");
  assert(/60|minute/i.test(v.detail), "and the detail says how much is uncovered");
}
{
  const v = judge(
    request(),
    reading({
      event: { state: "found", event: event({ start: { dateTime: iso(180) }, end: { dateTime: iso(300) } }) },
    }),
    judgeOpts,
  );
  eq(v.code, "event-window-uncovered", "an event shifted off the window leaves the start open");
}
{
  const v = judge(
    request(),
    reading({
      event: { state: "found", event: event({ start: { dateTime: iso(60) }, end: { dateTime: iso(300) } }) },
    }),
    judgeOpts,
  );
  eq(v.code, "event-window-wider", "an oversized event covers the window but disagrees with the record");
  assert(!v.ok, "and the issue asks for a non zero exit on any window that does not match");
}
{
  const v = judge(
    request(),
    reading({ event: { state: "found", event: event({ status: "cancelled" }) } }),
    judgeOpts,
  );
  eq(v.code, "event-cancelled", "a cancelled event is named as cancelled, not as a window mismatch");
}
{
  const v = judge(
    request(),
    reading({ event: { state: "found", event: event({ transparency: "transparent" }) } }),
    judgeOpts,
  );
  eq(v.code, "event-marked-free", "an event marked free blocks nothing however well its window matches");
  assert(!v.ok, "and that is a failure even while the window reads occupied");
}
{
  const v = judge(
    request(),
    reading({ event: { state: "found", event: event({ end: {} }) } }),
    judgeOpts,
  );
  eq(v.code, "event-window-unreadable", "an event bound Google did not give is refused, never waved through");
}
{
  const v = judge(
    request(),
    reading({ event: { state: "found", event: event({ end: { dateTime: "not a date" } }) } }),
    judgeOpts,
  );
  eq(v.code, "event-window-unreadable", "and so is one that cannot be parsed");
}
{
  const v = judge(request(), reading({ busy: [{ start: "", end: iso(240) }] }), judgeOpts);
  eq(v.code, "busy-unreadable", "one unreadable busy bound refuses the whole free/busy answer");
  assert(!v.ok, "rather than silently shrinking it, which would read as free time");
}
{
  const v = judge(
    request(),
    reading({ busy: [{ start: iso(120), end: iso(200) }] }),
    judgeOpts,
  );
  eq(v.code, "event-matches-but-window-free", "a matching event over a window Google calls partly free is a failure");
  assert(/free|clear/i.test(v.detail), "and the detail says the window is not fully occupied");
}
{
  // Two busy periods that abut cover the window between them. Merging matters:
  // judging each in isolation would report a fully covered window as open.
  const v = judge(
    request(),
    reading({
      busy: [
        { start: iso(120), end: iso(180) },
        { start: iso(180), end: iso(240) },
      ],
    }),
    judgeOpts,
  );
  eq(v.code, "verified", "abutting busy periods cover the window between them");
}
{
  const v = judge(request({ agentEmail: null }), { kind: "no-agent" }, judgeOpts);
  eq(v.code, "no-agent", "a request whose agent cannot be read is its own refusal");
  assert(!v.ok, "and never a pass");
}
{
  // A departed agent. Their Google account is routinely unlicensed on the way
  // out, and nothing can be booked with them, so this is neither proof nor
  // damage. It must not read as either.
  const v = judge(
    request({ agentDeactivatedAt: "2026-08-24T07:52:34.954+00:00" }),
    { kind: "agent-deactivated" },
    judgeOpts,
  );
  eq(v.code, "agent-deactivated", "a departed agent's request is its own outcome");
  assert(!v.ok, "it is never counted as proof");
  assert(v.skipped, "and it is a skip rather than a failure");
  assert(/2026-08-24/.test(v.detail), "the detail says when they left");
}
{
  const v = judge(request(), { kind: "unreadable", detail: "socket hang up" }, judgeOpts);
  eq(v.code, "calendar-unreadable", "a Google read that threw transiently is its own refusal");
  assert(/socket hang up/.test(v.detail), "carrying the reason it threw");
  assert(/again/i.test(v.detail), "and saying a re-run is worth it, which the definitive ones must not");
}
{
  const v = judge(request(), { kind: "refused", detail: "404 notFound" }, judgeOpts);
  eq(v.code, "calendar-refused", "a calendar Google refused is a DIFFERENT refusal from one that threw");
  assert(/404 notFound/.test(v.detail), "carrying the machine reason");
  assert(/re-auth|pool/i.test(v.detail), "and telling the reader it is a credential or membership repair");
}
{
  // Three ways a calendar can fail, not two (#1396). An account that has never
  // been given Calendar is definitive like a refusal, but the person who can fix
  // it is a Workspace admin rather than whoever holds the credentials, so it must
  // never inherit the refusal's advice.
  const v = judge(request(), { kind: "not-provisioned", detail: "403 notACalendarUser" }, judgeOpts);
  eq(v.code, "calendar-not-provisioned", "an account with no Calendar at all is its own outcome");
  assert(!v.ok, "and it is never a pass");
  assert(/Workspace admin/i.test(v.detail), "with its own instruction");
  assert(
    !/re-auth/i.test(v.detail),
    "and NOT the refusal's instruction, which cannot fix an unprovisioned account",
  );
}
{
  const v = judge(
    request({ startsAt: "", endsAt: iso(240) }),
    reading(),
    judgeOpts,
  );
  eq(v.code, "request-window-unreadable", "a stored window that cannot be read is reported, not waved through");
}

// --- every declared verdict is one this suite really produces (L151) ---
{
  eq(new Set(VERDICT_CODES).size, VERDICT_CODES.length, "the declared verdict codes are unique");
  const missing = VERDICT_CODES.filter((c) => !produced.has(c));
  eq(
    missing.join(",") || "none",
    "none",
    "every declared verdict code is reached by a case above, so none is a listing nothing can produce",
  );
  const undeclared = [...produced].filter((c) => !(VERDICT_CODES as readonly string[]).includes(c));
  eq(undeclared.join(",") || "none", "none", "and no verdict is produced that the list does not declare");
}

// --- summarising: one failure fails the run ---
{
  const s = summarize([
    judge(request(), reading(), judgeOpts),
    judge(request({ id: "req-2" }), reading(), judgeOpts),
  ]);
  assert(s.ok, "a run where every request verified passes");
  eq(s.verified, 2, "counting what verified");
  eq(s.failed, 0, "and nothing failed");
}
{
  const s = summarize([
    judge(request(), reading(), judgeOpts),
    judge(request({ id: "req-2" }), reading({ event: { state: "gone" }, busy: [] }), judgeOpts),
  ]);
  assert(!s.ok, "one failing request fails the whole run");
  eq(s.failed, 1, "and it is counted");
  assert(
    s.lines.some((l) => /req-2/.test(l)),
    "and the failing request is named in the output",
  );
}
{
  const s = summarize([]);
  assert(!s.ok, "summarising NOTHING is never a pass (L98)");
}
{
  // A skip is neither proof nor damage: one departed agent must not leave the
  // sweep permanently red (L36), and must not be counted as a window proved.
  const s = summarize([
    judge(request(), reading(), judgeOpts),
    judge(
      request({ id: "req-2", agentDeactivatedAt: "2026-08-24T07:52:34.954+00:00" }),
      { kind: "agent-deactivated" },
      judgeOpts,
    ),
  ]);
  assert(s.ok, "a run of one verified request and one skipped one passes");
  eq(s.verified, 1, "counting only what was really proved");
  eq(s.skipped, 1, "and reporting the skip separately");
  eq(s.failed, 0, "a skip is not a failure");
  assert(
    s.lines.some((l) => /^SKIPPED/.test(l)),
    "and the skipped line says so rather than reading as verified",
  );
}
{
  const s = summarize([
    judge(
      request({ agentDeactivatedAt: "2026-08-24T07:52:34.954+00:00" }),
      { kind: "agent-deactivated" },
      judgeOpts,
    ),
  ]);
  assert(!s.ok, "a run where EVERYTHING was skipped proved nothing, so it is not a pass");
  eq(s.failed, 0, "and it is not dressed up as a failure either");
}

finish();
