// Node test for the external double-book alert copy (#316's page).
//
// The first version named booking ids and told the reader to "check the agent's
// calendar". The person reading it on a phone could not tell WHEN the clash was,
// and had nowhere to click: the ids opened nothing and the calendar is not theirs
// to open. So the copy must carry, for every clashing call, the call's time, the
// outside event's time, and a link to the booking page, which is where the
// reassign and reschedule controls live.
//
// Pure copy builder, no IO, so this is a node script rather than vitest.
import { assert, finish } from "./lib/harness.ts";
import { externalDoubleBookAlert } from "../src/lib/notify/misc-alert-copy.ts";

const URL_A = "https://slate.trypennie.app/admin/bookings/b1979142-e1a1-456b-aa18-d00c8c42aedb";
const URL_B = "https://slate.trypennie.app/admin/bookings/5b0c7a8e-2f41-4d7e-9a61-0c3f1e2d4b5a";

// 1. One clash: the real 2026-09-29 page. Call 17:00 to 17:20 UTC on Oct 1, an
//    outside event 17:00 to 17:30 UTC, both read in Eastern.
{
  const text = externalDoubleBookAlert("radeyemo@trypennie.com", [
    {
      bookingUrl: URL_A,
      callStart: "2026-10-01T17:00:00Z",
      eventStart: "2026-10-01T17:00:00Z",
      eventEnd: "2026-10-01T17:30:00Z",
    },
  ]);
  assert(text.includes("radeyemo@trypennie.com"), "names the advisor by email");
  assert(text.includes("Thu, Oct 1"), `states the day of the call: ${text}`);
  assert(text.includes("1:00pm ET"), `states the call time in Eastern: ${text}`);
  assert(text.includes("(1:00pm to 1:30pm ET)"),
    `states the outside event's window: ${text}`);
  assert(text.includes(URL_A), "links to the booking page");
  assert(!/booking ids?:/i.test(text), "no longer lists bare booking ids");
  assert(!/check the agent's calendar/i.test(text), "no longer sends the reader to a calendar they cannot open");
  assert(/reassign|reschedule/i.test(text), "names the action the linked page offers");
  assert(!/\(s\)/.test(text), "no (s) pluralisation");
}

// 2. Two clashes: each call gets its own time and its own link, so the reader
//    is never left guessing which link belongs to which call.
{
  const text = externalDoubleBookAlert("dana.whitfield@trypennie.com", [
    {
      bookingUrl: URL_A,
      callStart: "2026-10-01T17:00:00Z",
      eventStart: "2026-10-01T17:00:00Z",
      eventEnd: "2026-10-01T17:30:00Z",
    },
    {
      bookingUrl: URL_B,
      callStart: "2026-10-02T14:00:00Z",
      eventStart: "2026-10-02T13:30:00Z",
      eventEnd: "2026-10-02T14:30:00Z",
    },
  ]);
  const lines = text.split("\n");
  const lineA = lines.find((l) => l.includes(URL_A)) ?? "";
  const lineB = lines.find((l) => l.includes(URL_B)) ?? "";
  assert(lineA.includes("Thu, Oct 1") && lineA.includes("1:00pm ET"), `first call's line carries its time: ${lineA}`);
  assert(lineB.includes("Fri, Oct 2") && lineB.includes("10:00am ET"), `second call's line carries its time: ${lineB}`);
  assert(lineB.includes("9:30am to 10:30am ET"),
    `second call's line carries its outside event: ${lineB}`);
  assert(/\b2 Slate calls\b/.test(text), `counts the calls in words that agree: ${text}`);
}

// 3. An outside event that starts on an EARLIER day than the call (an all night
//    block, say) must say so, or the window reads as a time on the call's day.
{
  const text = externalDoubleBookAlert("x@trypennie.com", [
    {
      bookingUrl: URL_A,
      callStart: "2026-10-01T13:00:00Z",
      eventStart: "2026-10-01T02:00:00Z",
      eventEnd: "2026-10-01T15:00:00Z",
    },
  ]);
  assert(text.includes("Wed, Sep 30"), `an event starting the previous day names that day: ${text}`);
}

finish();
