# Parallel run validation: testing Slate while cal.com stays live

This records the reasoning that does not change. Status lives in the
[Parallel run validation milestone](https://github.com/Try-Pennie/slate/milestone/39),
which tracks the work; nothing here claims what is currently done, because a doc
cannot notice an issue closing.

## Why running both systems at once is safe

Two structural facts make a parallel run safe, and both are properties of the
design rather than of any configuration that could drift:

1. **Bookability and lead routing are independent switches.** Flipping agents to
   `bookable = true` turns on calendar sync, availability computation, and the
   routing pool. It does not put Slate in front of a single lead: that only
   happens when the trypennie repo swaps the embed script (#65). The gap between
   the two switches is the testing window. Slate can run fully hot, mirroring
   real calendars and computing real availability, while 100% of leads still
   book through cal.com.

2. **Google Calendar is the shared source of truth.** cal.com writes its
   bookings to Google. Slate mirrors Google into `busy_blocks` (push
   notifications plus the one minute sync backstop), and its last act before
   confirming any booking is a live Google read (verify-on-book in
   `src/lib/booking/service.ts`). cal.com likewise checks the connected
   calendar at its own confirm time. So a booking in either system blocks the
   slot in the other within seconds, in both directions, and the residual race
   is the seconds between a booking and its Google event. That bound holds for
   as long as both systems take bookings, which is exactly the state during a
   staged cutover.

## The phases

- **Phase 0, continuous.** The six hourly canary books, reschedules, and
  cancels on live prod against the isolated test agents; the truth probe and
  the OOO sweep verify against real calendars. This proves Slate works
  mechanically. It cannot prove the real roster at scale, real traffic, or the
  Regal consumer, which is what the remaining phases exist for.

- **Phase 1, hot shadow.** Real agents bookable, embed untouched. Slate syncs
  90+ real calendars and computes availability nobody can book. The confidence
  number comes from the parity probe: diff cal.com's offered slots against
  Slate's `/api/availability` per bucket, with the legitimate divergences
  (horizon, buffers, minimum notice) named and filtered explicitly. Alarms that
  only need bookability, not cutover, get armed here so the shadow runs
  watched.

- **Phase 2, controlled real bookings.** A small number of internal leads book
  designated pilot agents for real: real invite, real `booking.created` to
  Regal, then a real cancel. This is the only way to exercise the Regal side of
  the webhook contract, because `is_test` bookings are deliberately suppressed
  at `fire()` and so the canary can never reach it.

- **Phase 3, one landing page.** The plan recorded on #65: flip the lowest
  volume landing page to the Slate embed, watch a day of real bookings in
  admin, everything else stays on cal.com. Rollback is reverting one trypennie
  PR. In flight cal.com bookings ride to completion on cal.com; nothing
  migrates.

- **Phase 4, full swap**, once Phase 3 shows a clean day and the parity probe
  has stayed quiet.

## Decisions this plan carries

- **The publicly reachable booker during the shadow phase.** With agents
  bookable, someone constructing a booker URL with a valid bucket code could
  create a real booking before any landing page links to Slate: real invite,
  real webhook. Nothing links to it, rate limits and the honeypot apply, and a
  stray booking is visible in admin. Whether that residual risk is accepted or
  guarded is decided out loud on the Phase 1 issue, not inherited by default.

- **Parity is measured on demand first.** The parity probe starts as a
  `verify:` script run by a person, like `verify:availability-truth`, and is
  promoted to a scheduled check only if the shadow period shows drift arriving
  between manual runs. A scheduled check spends the shared cron budget and
  earns its place by catching something.
