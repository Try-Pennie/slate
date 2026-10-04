// #3248: the pure rules a reroute hold is judged by on the booker's path.
//
// The database refuses a booking on a held advisor (0166), but only AFTER the
// booker has sent that advisor an invite, so the lead would get an invite and then
// a cancellation. These are the rules that let the candidate list skip a held
// advisor first, and the rule that lets the current advisor be judged for keeping a
// booking without the booking counting against itself.
//
// Run: node --experimental-strip-types scripts/test-reroute-hold-rules.ts
import { assert, eq, finish } from "./lib/harness.ts";
import {
  dropHeldAgents,
  holdClashes,
  parseLiveHolds,
  withoutOwnBooking,
  bufferedReadWindow,
  type LiveHold,
} from "../src/lib/booking/reroute-hold.ts";
import { freeMembersAtExactWindow, freeMembersForSlot, type MemberAvailability } from "../src/lib/availability/compute.ts";

const T = (hhmm: string) => Date.parse(`2031-03-04T${hhmm}:00Z`); // a Tuesday
// A held 15:00 to 15:20 call with 10 minute buffers, as place_reroute_hold stores it.
const hold: LiveHold = {
  agentUserId: "B",
  bookingId: "K1",
  startMs: T("15:00"),
  endMs: T("15:20"),
  bufferedStartMs: T("14:50"),
  bufferedEndMs: T("15:30"),
};
const call = (start: string, end: string) => ({ startMs: T(start), endMs: T(end), bufferBeforeMin: 10, bufferAfterMin: 10 });

// --- the clash rule matches the database's, both edges (0166) ---------------------
assert(holdClashes(call("15:00", "15:20"), hold), "the held window itself clashes");
assert(holdClashes(call("15:20", "15:40"), hold), "back to back at the hold's end clashes, inside its buffer");
assert(holdClashes(call("14:35", "14:55"), hold), "a call ending inside the hold's before buffer clashes");
assert(!holdClashes(call("15:30", "15:50"), hold), "exactly one buffer after does not clash");
assert(!holdClashes(call("14:30", "14:50"), hold), "exactly one buffer before does not clash");

// --- the candidate list drops a held advisor, and only them -------------------------
eq(dropHeldAgents(["A", "B", "C"], [hold], call("15:00", "15:20")), ["A", "C"],
  "a held advisor is dropped from the candidates at a clashing window, the order of the rest kept");
eq(dropHeldAgents(["A", "B", "C"], [hold], call("17:00", "17:20")), ["A", "B", "C"],
  "control: the same advisor at a window clear of the hold stays");
eq(dropHeldAgents(["A", "B", "C"], [], call("15:00", "15:20")), ["A", "B", "C"], "control: no holds, nobody dropped");
eq(dropHeldAgents(["A", "B"], [hold], call("15:00", "15:20"), "K1"), ["A", "B"],
  "the booking a hold is FOR is never kept off its own held advisor");

// --- a hold row that cannot be read refuses, never reads as unheld (L50) -------------
{
  const row = {
    agent_user_id: "B", booking_id: "K1",
    booking_starts_at: "2031-03-04T15:00:00Z", booking_ends_at: "2031-03-04T15:20:00Z",
    buffered_starts_at: "2031-03-04T14:50:00Z", buffered_ends_at: "2031-03-04T15:30:00Z",
  };
  eq(parseLiveHolds([row]), [hold], "a hold row parses to the window it stores");
  let threw = "";
  try {
    parseLiveHolds([{ ...row, buffered_ends_at: "not a time" }]);
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  assert(/unreadable window/.test(threw), `an unreadable hold throws rather than being dropped (got ${threw})`);
}

// --- the exact window judge: an off grid start is judged directly (red team 9) -------
const OPEN = { zone: "UTC", rules: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start_minute: 0, end_minute: 1440 })), exceptions: [] };
const rulesInput = {
  durationMin: 20, bufferBeforeMin: 10, bufferAfterMin: 10, minNoticeMin: 0, dailyCap: 2,
  businessHours: OPEN, nowMs: T("08:00"),
};
// An advisor whose shift begins at 09:05: their offering grid is :05, :15, :25 ...
const fiveAgent: MemberAvailability = {
  userId: "F", timezone: "UTC", rules: [{ weekday: 2, start_minute: 9 * 60 + 5, end_minute: 17 * 60 }],
  busy: [], bookingStartsMs: [], dayCounts: new Map(),
};
eq(freeMembersForSlot([fiveAgent], { ...rulesInput, slotIntervalMin: 10 }, T("10:00")), [],
  "control: the grid walk never offers a :05 advisor a 10:00 start, which is what made them invisible to a reroute");
eq(freeMembersAtExactWindow([fiveAgent], rulesInput, T("10:00")), ["F"],
  "the exact window judge finds the :05 advisor free for the booking's own 10:00 time");
eq(freeMembersAtExactWindow([fiveAgent], rulesInput, T("09:00")), [],
  "and still refuses a window outside their shift");
eq(freeMembersAtExactWindow([{ ...fiveAgent, busy: [{ start: T("10:25"), end: T("11:00") }] }], rulesInput, T("10:00")), [],
  "and still refuses a window whose after buffer runs into busy time");
eq(freeMembersAtExactWindow([{ ...fiveAgent, dayCounts: new Map([["2031-03-04", 2]]) }], rulesInput, T("10:00")), [],
  "and still refuses an advisor at their daily cap");

// --- the current advisor, without the booking counting against itself ---------------
{
  const own = { startMs: T("10:00"), endMs: T("10:20") };
  const current: MemberAvailability = {
    userId: "A", timezone: "UTC", rules: fiveAgent.rules,
    // Their own write through block for the booking, and one real meeting later on.
    busy: [{ start: own.startMs, end: own.endMs }, { start: T("13:00"), end: T("13:30") }],
    bookingStartsMs: [],
    dayCounts: new Map([["2031-03-04", 2]]),
  };
  eq(freeMembersAtExactWindow([current], rulesInput, own.startMs), [],
    "control: as loaded, the advisor is busy and capped by the very booking being asked about");
  const adjusted = withoutOwnBooking(current, own);
  eq(freeMembersAtExactWindow([adjusted], rulesInput, own.startMs), ["A"],
    "with the booking taken out of their busy time and their cap count, they can keep it");
  eq(adjusted.busy, [{ start: T("13:00"), end: T("13:30") }], "only the booking's own block is removed");
  eq(adjusted.dayCounts?.get("2031-03-04"), 1, "and the booking comes off its own day's count, once");
  const clashing = withoutOwnBooking({ ...current, busy: [{ start: T("09:55"), end: T("10:15") }] }, own);
  eq(freeMembersAtExactWindow([clashing], rulesInput, own.startMs), [],
    "a real meeting reaching outside the booking still makes them busy");
  const atCapAnyway = withoutOwnBooking({ ...current, busy: [], dayCounts: new Map([["2031-03-04", 3]]) }, own);
  eq(freeMembersAtExactWindow([atCapAnyway], rulesInput, own.startMs), [],
    "an advisor over their cap with other calls is still capped once this one is taken off");
  const legacy = withoutOwnBooking({ ...current, dayCounts: undefined, bookingStartsMs: [own.startMs, T("12:00")] }, own);
  eq(legacy.bookingStartsMs, [T("12:00")], "without a server count, the booking's own start is removed from the starts");
}

// --- the current advisor's busy time is READ over the buffered window (review) --------
{
  eq(
    bufferedReadWindow({ starts_at: "2031-03-04T10:00:00Z", ends_at: "2031-03-04T10:20:00Z" }, { buffer_before_min: 10, buffer_after_min: 15 }),
    { fromIso: "2031-03-04T09:50:00.000Z", toIso: "2031-03-04T10:35:00.000Z" },
    "a 10:00 to 10:20 call with 10 and 15 minute buffers is read from 09:50 to 10:35, so a meeting inside a buffer is seen",
  );
  let threw = false;
  try { bufferedReadWindow({ starts_at: "nope", ends_at: "2031-03-04T10:20:00Z" }, { buffer_before_min: 0, buffer_after_min: 0 }); } catch { threw = true; }
  assert(threw, "an unreadable booking window throws rather than reading nothing");
}

finish();
