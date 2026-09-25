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

## Arming the failing bookings page on flip day

The failing bookings page is one of the three signals that would say "Low bookings
have stopped" (#2484), and it is OFF. There are TWO switches behind it, and the
work that calibrated the floors threw neither:

1. **Somebody ticks it on, by hand, under Admin, Alerts**: "Send a Slack alert when
   customers are failing to book". It is `monitor_alert_config.failure_rate_armed`,
   stored false, and an unset value reads as false (`resolveFailureRateArmed`, the
   observe first default from L56). No deploy applies it, no code change has ever
   set it, and #2489 armed the WATCH on the detector rather than the page itself.
   #1367 is the issue that closes when somebody ticks it.

2. **Its never concluded watch is parked until real leads book** (#2499). The check
   refuses to judge until a floor of booking attempts has accumulated inside its
   rolling window, and the smoke canary cannot supply them: the read excludes test
   attempts (#1637), so a canary attempt counts zero. The park comes out on #2513,
   and nobody has to remember it, because the watchdog pages by itself the moment a
   parked detector reaches a verdict.

**Read the check after the first busy hour rather than reading the silence.** Below
the floor every tick reports `insufficient`, which renders exactly like a healthy
hour and is the state #1394 exists to notice.

## Arming the low volume alarms

The tier alarm (#1956) and the per page alarm (#2738) share one switch, "Send a Slack
alert when bookings drop off" under Admin, Alerts (`monitor_alert_config.low_volume_armed`).
Before ticking it, run `pnpm verify:parallel-run-readiness` and read its "Before arming
the low volume alarms" heading (#2767). Two things must hold, and while the switch is
off the command reports them there without changing its exit:

1. **Each Low page's bookings carry their `source`.** The per page alarm counts pages by
   `bookings.source`; a page whose links carry no `?source=` records `not-given` and,
   armed, pages every 30 minutes as a page that stopped booking. This needs real bookings
   from each page after the flip, so before then it reads as unmeasured, never as met.
2. **Every federal holiday in the next 90 days is decided** in the business hours
   exceptions: closed, or open because Pennie works that day. Without one both alarms
   page through the holiday (eight times on Labor Day 2026-09-07 in the replay).

Once the switch is on, each unmet one becomes a finding with its own exit (14 to 16, in
`docs/verify-commands.md`).

This is not the whole flip day list, which lives on #65 and the Cutover milestone.
It is the part decided here rather than on the day.

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
