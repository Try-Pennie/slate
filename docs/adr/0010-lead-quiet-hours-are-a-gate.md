# A booking time must fall inside the lead's calling hours

Slate never offers or books a call whose START falls outside 08:00 to 20:00 on the
lead's clock, judged in the zone the booker is using. This is a gate about the
person being called, beside the org's business hours and the agent's working hours,
which are both about the person calling.

## Status

Accepted, and in production since 2026-09-24 (#2310, commit `0280b5aa`). Backfilled
as a record in #3130: the decision and its two follow up rulings lived in #2310's
comments and in the header of `src/lib/booking/lead-calling-window.ts`.

## The decision, as it was made

#2310 was written on the assumption that Regal's quiet hours rule is about the
lead's local time, and asked for the journey to be read before anything was built.
It was read on 2026-09-24: journey `a0c3d620` (friendly id 246, "Cal.com Call
Created in QH - Cancel Task") keys on `CONTACT_TIMEZONE`, cancels the call task, and
files a "Rebook Request" for any booked call in its `Quiet Hours` queue, with
`skipFromTime 20:00` and `skipToTime 08:00`, the same everywhere.

Three rulings by Dan on 2026-09-24, as recorded on the issue:

- **Whose clock:** "let's default to the system timezone". So the gate uses the zone
  the booker is using: the lead's device zone by default, or whichever zone the lead
  picks. The booker sends it with the booking, so the server enforces the same rule
  rather than trusting the client.
- **The window:** 08:00 to 20:00 in that zone, matching the journey.
- **The boundary:** "the window includes its start and excludes its end. 08:00 local
  may be offered, 07:59 may not; 19:59 may, 20:00 may not", judged on the call's
  start time.

## Why

Both of Slate's existing gates are agent side, so a lead in Honolulu could pick a
9am Eastern slot and be dialled at 3am their time with both gates satisfied (#2310,
`0280b5aa`). Regal's journey would then cancel that call and ask the lead to rebook.
Filtering the offered times means the journey has nothing left to do, which is the
plan #2310 states.

Two shape choices were made in the commit that built it:

- **The availability response and the slot cache are untouched.** They are shared
  by every lead, so a per zone variant would fragment the cache that ADR 0003
  rests on. The shared slot picker splits the served list instead, for the booker
  and both reschedule panels.
- **Refused on the server too.** `createBooking` and `rescheduleBooking` refuse with
  `OutsideCallingWindowError` before any write, so a client that skipped the filter
  is still refused. A missing or unreadable zone is judged in the booker's own
  fallback (Eastern), never waved through.

## What it costs

- **The booker's zone and Regal's can disagree.** Regal derives a contact's zone from
  the zip code, else the phone's area code; the booker uses the device zone or the
  lead's choice. For a lead whose device is not where their phone or address is, the
  two judge differently. Regal's journey stays the backstop, so the gate lowers the
  rate of cancelled calls rather than having to be perfect (#2310, 2026-09-24).
- **A whole day can be empty for some leads.** The picker keeps such a day on the
  strip and says why, rather than showing nothing.

## What would change it

Regal's journey changing its window or what it keys on, since the gate exists to
agree with it. #2310 also asked whether the rule is a legal requirement or an
internal preference; the issue record does not answer that, and the answer would not
change the gate, only how firmly it is held.

## Where the mechanics live

`src/lib/booking/lead-calling-window.ts` (`LEAD_CALLING_WINDOW`,
`withinLeadCallingWindow`, `splitByLeadCallingWindow`), and the refusal in
`src/lib/booking/service.ts`.
