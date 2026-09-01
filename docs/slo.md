# What Slate promises, and what watches each promise

Targets, and the check that measures each one. Written because the thresholds already
in the code were folklore: real numbers, chosen for real reasons, findable only by
reading the module that used them (#1047).

Two honest caveats up front, because they change how every number below should be
read:

1. **Slate has taken no real customer traffic yet.** Every booking to date is the
   canary's. So the traffic-fed numbers are starting points, not calibrations, and the
   checks that depend on them are deliberately disarmed until a real cycle produces a
   distribution to fit them to (L56). Where that is true it says so.
2. **These are not contractual.** Nobody outside engineering has agreed to them, and
   there is no error budget anybody spends. They are the numbers the alerts use, so
   that an alert firing means something specific rather than "somebody set a number".

## Availability

| What | Target | What measures it | Where |
|---|---|---|---|
| The app answers at all | `GET /api/health` returns 200 | An external uptime monitor (noodge), plus a 7-lane dead man's switch inside the endpoint | `src/app/api/health/route.ts` |
| The booker is genuinely offering times | `GET /api/health/availability` returns 200 | The availability canary. It answers 503 when a well-staffed tier, or the whole fleet, is silently empty, which `/api/health` cannot see: the database is up and the crons tick while the booker offers nothing | `src/lib/monitor/availability-canary.ts` |
| A booking can be made end to end | One full pass every 6 hours | The smoke canary, against live production on isolated SMOKE fixtures. It is the only automated proof a booking can be created, rescheduled and cancelled | `.github/workflows/smoke-canary.yml` |
| Every scheduled lane is running | Each lane stamps a heartbeat; a lane quiet past its own bound pages | The lane watchdog, on bounds set per lane at about 3x its cadence so jitter cannot page | `LANE_STALE_BOUNDS_MS`, `src/lib/monitor/health.ts` |
| The safety net itself is running | `smoke-canary` within 90 minutes, `smoke-canary-full` within 8 hours | The same watchdog, on separate stamps, because a 30-minute dry tick kept one shared stamp fresh while the 6-hourly full pass silently stopped (#982) | `CANARY_STALE_BOUNDS_MS` |

## Latency

| What | Budget | What measures it |
|---|---|---|
| The cached availability read | median under 500ms across 5 samples, first dropped | The canary's latency step, every 30 minutes (#1047) |

The budget is an order of magnitude above the measured warm read (about 39ms, #256),
and that is deliberate. This is a **regression detector, not a performance target**:
at 39ms warm, a 500ms median means something structural changed, most likely a read
that has stopped being served from the cache. A budget near the real number would page
on ordinary variance, and an alert that cries wolf gets ignored.

The first sample is always discarded: the first request after an idle period pays
isolate startup, so counting it measures how quiet the morning was. The median of the
rest is judged, so one unlucky sample is not a regression.

**Nothing measures the booking confirm's latency**, on purpose: timing it means making
a booking, and the canary already does that on its own schedule with its own teardown.
The confirm's cost is dominated by verify-on-book, which is a live Google call, so its
latency is largely Google's and is not something a threshold here could act on.

## Booking success

| What | Threshold | Status |
|---|---|---|
| Share of booking attempts that end in an error | pages above 20% in a 1-hour window, with at least 20 attempts | **Disarmed.** It logs its measured share every tick, and #1367 arms it once somebody has read a real cycle |
| Booking volume not collapsing | An unusually quiet window pages | Live, tuned for the pre-cutover roster |

The minimum-attempts floor is what stops a quiet hour reading as an outage: 1 failure
out of 2 attempts is 50% and means nothing. It is also why the floor cannot be
lowered without also handling saturation, since a proportion cannot tell one bad out
of two from twelve out of twelve (L139).

## Data integrity

| What | Target | What measures it |
|---|---|---|
| The times offered are really free | Any drift pages | The availability truth probe, asking Google rather than the cache. It carries a second stamp for when it last reached a MEASURED verdict, because a fail-safe detector that reports "could not check" renders identically to one finding nothing wrong (#1394) |
| An approved time off really blocks | Every approved future request verified | `pnpm verify:ooo-protection`, hand-run, both reads required |
| The warehouse mirror matches Supabase | Zero rows behind, no tolerance | The 6-hourly reconcile lane |
| Erased contact data is really gone | Zero residual, everywhere | The erasure audit lane, and the purge's own post-verify |

## What has no target, and why

- **Uptime as a percentage.** There is no measured monthly figure and no error budget,
  because nothing computes one and inventing a number nobody measures is worse than
  admitting there is not one. What exists instead is the set of checks above, each of
  which pages on a specific condition.
- **Time to recover.** Recovery is a revert plus a redeploy, and the deploy is fast,
  but nobody has timed it under pressure. `DEPLOY.md` has the procedure.
- **Anything about Google's own latency or availability.** Slate's design assumes
  Google fails (the cache-first read, the verify-on-book fallback, the three-way
  reachability classification), and no threshold here would change what happens.

## Changing a number here

Change it in the code, then change it here, and say what measurement moved it. A
number in this document that no check reads is worse than an undocumented threshold,
because it reads as a decision while enforcing nothing.
