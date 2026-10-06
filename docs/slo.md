# What Slate promises, and what watches each promise

Targets, and the check that measures each one. Written because the thresholds already
in the code were folklore: real numbers, chosen for real reasons, findable only by
reading the module that used them (#1047).

Two caveats up front, because they change how every number below should be read:

1. **The numbers come from the pilot.** Real leads have booked through Slate since the
   pilot went live on 2026-09-29, and since 2026-10-01 15:46 UTC trypennie's split has
   sent half of every tier on every page here. The monthly targets below were set from
   the first five days of that traffic (#3141), each a little below what the pilot
   actually achieved. Five days is a start, not a season: re-derive them once a full
   month has been read.
2. **These are internal measures, not promises** (Dan, 2026-10-03). Nobody outside
   engineering has agreed to them. The error budgets say how much room there is before a
   month counts as worse than the pilot, so a bad week reads as "spent half the budget"
   rather than as a feeling.

## Monthly targets

Both are shares of **counted booking requests**: every outcome the hourly failure page
counts (created, rescheduled, cancelled, deduped, confirm required, and every error),
non-test rows only, from `booking_api_outcome_daily`, which both the public booker and
the booking API write. One population, so the monthly figure and the hourly page can
never disagree about what a request is.

| Target | Monthly | Error budget | Pilot measured |
|---|---|---|---|
| Booking success | **98.5%** of counted booking requests end without an error | **1.5%** of requests, about **199** a month | **98.92%** (13 errors in 1,206) |
| Availability | **99.5%** of counted booking requests end without a server fault | **0.5%** of requests, about **66** a month | no server fault in 1,206, so at most **0.25%** at 95% confidence |

**Booking success counts every error**, including the ordinary ones (a lead picking a
time somebody took a second earlier, a malformed request). That is deliberate: it is what
a lead experiences, and it is the population the hourly page already judges. A month that
spends this budget on contention rather than faults is still a month where more leads were
turned away than in the pilot, which is worth knowing.

**Availability counts only server faults**: an answer in the 5xx range that the lead did
nothing to cause. The codes are derived from the refusal catalog
(`src/lib/booking/refusal-catalog.ts`), every counted error path whose answer is a 5xx, so
a new 5xx path joins this list by being catalogued:

Server fault codes: `booking_pause_unreadable`, `lead_code_unavailable`, `existing_call_unavailable`, `verify_unavailable`, `internal`, `VERIFY_UNAVAILABLE`, `INTERNAL`, `API_NOT_CONFIGURED`, `reschedule_verify_unavailable`, `reschedule_lock_unavailable`, `reschedule_internal`, `reschedule_write_failed`, `cancel_write_failed`, `cancel_internal`.

### The arithmetic

Production `booking_api_outcome_daily`, non-test rows, 2026-09-29 to 2026-10-03 (the
last day partial), read 2026-10-03. The measurement and every figure derived from it live
in `src/lib/monitor/slo-targets.ts`.

- **Requests counted:** 1,092 created, 40 rescheduled, 57 cancelled, 4 deduped, 0 confirm required and 13 errors, **1,206** in all.
- **Errors:** 6 `slot_unavailable`, 5 `invalid_request`, 2 `reschedule_slot_taken`. None is a server fault, so the measured success share is 1 minus 13 / 1,206 = **98.92%**, and the server fault share is zero.
- **A month of requests:** 357 and 446 created on the two whole days after the split, 401.5 a day, times 1,206 / 1,092 requests per booking created, times 30 days = about **13,302**.
- **Booking success budget:** 100 minus 98.5 = **1.5%**, 1.5% of 13,302 = about **199** errored requests a month.
- **Availability budget:** 100 minus 99.5 = **0.5%**, 0.5% of 13,302 = about **66** server faults a month. Zero faults in 1,206 bounds the true rate below 3 / 1,206 = **0.25%** at 95% confidence (the rule of three), and the target sits under that.

The monthly counts move with traffic; the percentages are the targets. If the split's
share changes, the budget in requests changes with it and the share does not.

### Reading a month

The monitor lane computes both every tick (`booking_budget` step, `src/lib/monitor/slo-budget.ts`) and pages `booking_budget:success` or `booking_budget:availability` once **50%** of a month's budget is spent, judging the same non-test, on site population as the hourly failure page.

To read a month by hand (at month end, or to check what the page said), this query
counts the same rows (read only, in the SQL editor). Off site rows (a booking from a host
that is not the production site, usually a tester, #2752) are left out, as the automated check leaves them
out.

```sql
select
  sum(count) as requests,
  sum(count) filter (where outcome = 'error') as errors,
  sum(count) filter (where outcome = 'error' and error_code
  in ('booking_pause_unreadable', 'lead_code_unavailable', 'existing_call_unavailable', 'verify_unavailable', 'internal', 'VERIFY_UNAVAILABLE', 'INTERNAL', 'API_NOT_CONFIGURED', 'reschedule_verify_unavailable', 'reschedule_lock_unavailable', 'reschedule_internal', 'reschedule_write_failed', 'cancel_write_failed', 'cancel_internal')
  ) as server_faults
from booking_api_outcome_daily
where not is_test and host_class <> 'offsite'
  and outcome in ('created', 'rescheduled', 'cancelled', 'deduped', 'confirm_required', 'error')
  and day >= date '2026-10-01' and day < date '2026-11-01';
```

Booking success is `1 - errors / requests`; availability is `1 - server_faults / requests`.

**What this cannot see.** A request that never reached Slate (the Worker down, the
platform refusing it) records nothing, so it is invisible to both figures. That is what
the external uptime monitor on `/api/health` is for, below.

## Availability

| What | Target | What measures it | Where |
|---|---|---|---|
| The app answers at all | `GET /api/health` returns 200 | An external uptime monitor (noodge), plus a 7-lane dead man's switch inside the endpoint | `src/app/api/health/route.ts` |
| The booker is genuinely offering times | `GET /api/health/availability` returns 200 | The availability canary. It answers 503 when a well-staffed tier, or the whole fleet, is silently empty, which `/api/health` cannot see: the database is up and the crons tick while the booker offers nothing | `src/lib/monitor/availability-canary.ts` |
| A booking can be made end to end | One full pass every 6 hours | The smoke canary, against live production on isolated SMOKE fixtures. It is the only automated proof a booking can be created, rescheduled and cancelled | `.github/workflows/smoke-canary.yml` |
| Every scheduled lane is running | Each lane stamps a heartbeat; a lane quiet past its own bound pages | The lane watchdog, on bounds set per lane at about 3x its cadence so jitter cannot page | `LANE_STALE_BOUNDS_MS`, `src/lib/monitor/health.ts` |
| The safety net itself is running | `smoke-canary` within 90 minutes, `smoke-canary-full` within 8 hours | The same watchdog, on separate stamps, because a 30-minute dry tick kept one shared stamp fresh while the 6-hourly full pass silently stopped (#982) | `CANARY_STALE_BOUNDS_MS` |
| Cron CPU headroom | No scheduled tick past **60s** of CPU, half the **120s** `limits.cpu_ms`, in any **24 hours** | The hourly check at `/api/cron/cron-budget`, reading Cloudflare's `cpuTimeUs` for every scheduled invocation (needs `CF_ANALYTICS_TOKEN`) | `src/lib/monitor/cron-budget.ts` |

**The cron headroom row is CPU, read from Cloudflare, not timed by the Worker.** A running
Worker has no reading of its own CPU, so the first version of this row (#3168) judged WALL
time, and on 2026-10-03 it paged for a five minute tick of about 84s that was almost all
waiting on the database and Google. Cloudflare kills on CPU, and wall time is no bound on it
in either direction (the clock advances only at I/O), so that page was switched off the same
day. Now the hourly tick reads a day of `workersInvocationsScheduled` from the GraphQL
Analytics API, keeps each schedule's max and p99 CPU, and pages `cron_budget_headroom` when
a schedule's worst tick passes the line. One GraphQL call an hour is the whole cost.

What it will not claim. An answer it cannot read (a refused token, a schema error, an empty
or full page, a tick with no CPU figure) is unmeasured: it pages nothing, clears nothing, and
leaves `verdict:cron-budget` unstamped, so a check that keeps failing goes stale and the lane
watchdog pages after 6 hours. Without `CF_ANALYTICS_TOKEN` it measures nothing at all and
says so in a daily info line (`cron_cpu_not_configured`) rather than paging or claiming
health; DEPLOY.md says how to create the token. Wall time is still logged for a slow tick
(`tag=cron-budget`), and is never a page.

## Latency

| What | Budget | What measures it |
|---|---|---|
| The cached availability read | median under **500ms** across **5** samples, first dropped | The canary's latency step, every 30 minutes (#1047) |

The budget is an order of magnitude above the measured warm read (about 39ms, #256),
and that is deliberate. This is a **regression detector, not a performance target**:
at 39ms warm, a 500ms median means something structural changed, most likely a read
that has stopped being served from the cache. A budget near the real number would page
on ordinary variance, and an alert that cries wolf gets ignored.

The first sample is always discarded: the first request after an idle period pays
isolate startup, so counting it measures how quiet the morning was. The median of the
rest is judged, so one unlucky sample is not a regression.

**The booking confirm has no latency budget yet, because nobody has read the
production distribution and set one from it.** The data is there: every confirm, a
time change included (#3401), writes a `confirm answered` line with its `response_ms`
(#3221), so a production p95 is readable from Workers Logs. Its stages
(`src/lib/booking/confirm-profile.ts`) are logged only for a slow or timed out confirm
(#3300), so they explain an outlier rather than measure the distribution. The load run's
reading (wall p95 4,025ms on 2026-09-14) was against a stubbed Google and says nothing
about a real verify-on-book call.

How it will be measured, passively, from traffic that already exists: a week of
`confirm answered` lines read as a p95 of `response_ms` (the time the lead waits, which
an invocation's wall time is not, since that runs on through work deferred past the
response), with the recompute line as the positive control the logs section of
`AGENTS.md` requires, is the measurement; the budget is then set a little
above that p95, the same "from pilot data" rule as the targets above, and recorded here
with the reading it came from. It needs an account token with Observability read, which
the deployment does not hold, so it is a hand read like the CPU table in the platform
notes, not a check.

## Booking success, hour by hour

| What | Threshold | Status |
|---|---|---|
| Share of booking attempts that end in an error | pages above **20%** in a rolling **3 hour** window, with at least **20** attempts | behind the "customers are failing to book" switch under Admin, Alerts |
| Booking volume not collapsing | An unusually quiet window pages | behind its own switch (`docs/parallel-run-plan.md`) |

Both switches are database settings (`monitor_alert_config`), so whether either is on is
read under Admin, Alerts rather than stated here. The failure page's was switched on
2026-10-01 (#1367, #2513).

The threshold pair is derived from measured traffic at the split's share
(`src/lib/monitor/failure-rate-thresholds.ts`), not typed by hand. The minimum-attempts
floor is what stops a quiet hour reading as an outage: 1 failure out of 2 attempts is 50%
and means nothing. It is also why the floor cannot be lowered without also handling
saturation, since a proportion cannot tell one bad out of two from twelve out of twelve
(L139).

This page and the monthly booking success target judge the same population. The page
answers "is something failing right now", at a fifth of attempts; the target answers "was
this month as good as the pilot", at one and a half percent. A month can spend its whole
budget without the page ever firing, which is the point of having both.

## Data integrity

| What | Target | What measures it |
|---|---|---|
| The times offered are really free | Any drift pages | The availability truth probe, asking Google rather than the cache. It carries a second stamp for when it last reached a MEASURED verdict, because a fail-safe detector that reports "could not check" renders identically to one finding nothing wrong (#1394) |
| An approved time off really blocks | Every approved future request verified | `pnpm verify:ooo-protection`, hand-run, both reads required |
| The warehouse mirror matches Supabase | Zero rows behind, no tolerance | The 6-hourly reconcile lane |
| Erased contact data is really gone | Zero residual, everywhere | The erasure audit lane, and the purge's own post-verify |

## What has no target, and why

- **Uptime as a time based percentage.** The availability target above is per request,
  measured from what Slate recorded. Minutes of outage are what the external uptime
  monitor sees, and it pages on the condition rather than computing a monthly figure.
- **Time to recover.** Recovery is a revert plus a redeploy, and the deploy is fast,
  but nobody has timed it under pressure. `DEPLOY.md` has the procedure.
- **Anything about Google's own latency or availability.** Slate's design assumes
  Google fails (the cache-first read, the verify-on-book fallback, the three-way
  reachability classification), and no threshold here would change what happens.

## Changing a number here

Change it in the code, then change it here, and say what measurement moved it. A
number in this document that no check reads is worse than an undocumented threshold,
because it reads as a decision while enforcing nothing. `scripts/test-slo-doc.ts` holds
every number above to the constant it comes from, so changing one without the other fails
the build.
