// Every sentence the coordinator page can show (#4205), read for what a person would see.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-coordinator-copy.ts
import {
  PLACE_CALL_REFUSALS,
  bookedSentence,
  callTimeText,
  movedSentence,
  needsConfirmSentence,
  possibleMatchSentence,
  refusalSentence,
  bookableHoursSentence,
  existingCallSentence,
  type CoordinatorRefusal,
} from "../src/lib/coordinator/coordinator-copy.ts";
import { CUSTOMER_REFUSALS } from "../src/lib/coordinator/customer.ts";
import { PLACED_BOOKING_REFUSALS } from "../src/lib/booking/placed-booking.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ALL: CoordinatorRefusal[] = [...CUSTOMER_REFUSALS, ...PLACED_BOOKING_REFUSALS, ...PLACE_CALL_REFUSALS];
const call = { bookingId: "b", startsAt: "2026-06-09T17:00:00.000Z", timezone: "America/Phoenix", advisorName: "Advisor A", onPlaceholder: false };
const texts: [string, string][] = [
  ...ALL.map((r) => [r, refusalSentence(r, "America/Phoenix")] as [string, string]),
  ["booked advisor", bookedSentence({ on: "advisor", advisorName: "Advisor A", startsAt: call.startsAt, zone: "America/Phoenix", replayed: false })],
  ["booked placeholder", bookedSentence({ on: "placeholder", advisorName: "Marcia", startsAt: call.startsAt, zone: "America/Phoenix", replayed: false })],
  ["booked replay", bookedSentence({ on: "advisor", advisorName: null, startsAt: call.startsAt, zone: "America/Phoenix", replayed: true })],
  ["moved", movedSentence({ on: "advisor", advisorName: "Advisor A", startsAt: call.startsAt, zone: "America/Phoenix" })],
  ["needs confirm", needsConfirmSentence(call, "America/Phoenix")],
  ["possible match", possibleMatchSentence(call, "America/Phoenix", "email-or-phone")],
  ["no call", existingCallSentence({ kind: "none" }, "America/Phoenix")],
  ["call unreadable", existingCallSentence({ kind: "unreadable" }, "America/Phoenix")],
  ["call moves", existingCallSentence({ kind: "found", call, happens: "moves-when-confirmed" }, "America/Phoenix")],
  ["call loose", existingCallSentence({ kind: "found", call, happens: "refused-loose-match", matchedOn: "email-and-phone" }, "America/Phoenix")],
  ["hours unreadable", bookableHoursSentence({ ok: false, reason: "hours-unreadable" }, "America/Phoenix")],
  ["date unreadable", bookableHoursSentence({ ok: false, reason: "date-unreadable" }, "America/Phoenix")],
  ["closed day", bookableHoursSentence({ ok: true, date: "2026-06-13", windows: [] }, "America/Phoenix")],
];
eq(
  bookableHoursSentence(
    { ok: true, date: "2026-06-09", windows: [{ firstStart: "2026-06-09T08:00:00.000-05:00", lastStart: "2026-06-09T16:30:00.000-05:00" }] },
    "America/Chicago",
  ),
  "On Tuesday, June 9, calls can start from 8:00am to 4:30pm Central time (Chicago).",
  "the day's hours read out in the customer's clock",
);
eq(new Set(ALL.map((r) => refusalSentence(r))).size, ALL.length, "every refusal has its own sentence");
for (const [name, text] of texts) {
  assert(text.trim().length > 20, `${name} says something`);
  assert(!/undefined|null|NaN|\[object/.test(text), `${name} leaks no placeholder`);
  assert(!/[—–]/.test(text) && !/ - /.test(text), `${name} carries no dash punctuation`);
  assert(/[.]$/.test(text), `${name} ends as a sentence`);
}
eq(callTimeText("2026-06-09T17:00:00.000Z", "America/Phoenix"), "Tuesday, June 9 at 10:00am Arizona (Phoenix)", "a time is read out in the customer's clock");
eq(callTimeText("not a time", "America/Phoenix"), "the time asked for", "an unreadable time never prints Invalid DateTime");
finish();
