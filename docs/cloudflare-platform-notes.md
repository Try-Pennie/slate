# Cloudflare platform notes

Non obvious facts about how Slate actually behaves on Cloudflare Workers. Each one
cost real time to establish, and several contradict either the public docs or the
tooling's own guidance. Read this before investigating a limits question or
concluding "our logs are missing".

Established across #724 / #760 (limits) and #708 (logs). Numbers refreshed
2026-07-14 against the deployed Worker.

`pnpm dev` (Node) enforces none of these limits. Only the deployed Worker does.

## Each lane is its own placed invocation (#3693), unless it falls back

Until #3693 the four every minute lanes (`sync`, `recompute`, `outbox`, `selfheal`)
ran in process in a single `scheduled()` invocation and shared its CPU and
subrequest budgets. They do not any more: `scheduled()` sends each lane over `SELF`,
a service binding to this same Worker, so each one runs as its own invocation of the
fetch handler. The reason is placement, not the budget. **Placement (smart or a
hint) moves only a fetch handler, never `scheduled()`**, and Cloudflare runs crons
"on underutilized machines": from 2026-10-13 the lanes ran from Mumbai (Supabase
origin p50 about 263ms) and then Amsterdam (about 161 to 166ms), against about 90ms
from Newark before and about 21ms for the placed lead requests at Seattle.

What follows from it:

- **Budget per lane, not the combined total**, for a placed lane. A lane that falls
  back (no usable binding, a binding call that threw before sending, a gradual
  deploy's canary refusing it) runs in process and shares the scheduled invocation
  as before. The `lane timings` line says which path each lane took
  (`<lane>_via`, `<lane>_placement`, `<lane>_fallback`). `lanes_placed` counts the
  lanes SENT over the binding, and `lanes_near_db` the ones whose `cf-placement`
  names a colo beside the database (SEA or PDX, `NEAR_DATABASE_COLOS` in
  `src/lib/monitor/lane-timing.ts`), whichever prefix it carries; #3720 read
  `lanes_placed=4` on ticks where every lane ran `local-BOM`, so sent is never read
  as moved, and a `local-SEA` lane is where it should be.
- **Cost.** About 7,500 extra fetch invocations a day (5,760 of them the minute
  trigger's four lanes). Cloudflare's pricing page: requests over a service binding
  carry no additional request fee, and CPU is billed as the total across both.
- **The hourly cron CPU reading below no longer sees a placed lane's CPU**, only the
  dispatcher and any lane that fell back.
- **Measure it** with the Supabase edge logs (`request.cf.colo` and
  `response.origin_time` on the lanes' tables) and the `cf-placement` value on the
  timings line, read by its colo: beside Oregon is placed, anywhere else is not,
  whichever of `remote-` or `local-` it carries (the next section).
- **The public route beside SELF (#4189, a temporary measurement).** Each tick also
  sends one credential free GET to `https://slate.trypennie.app/api/smoke/version`
  and logs its `cf-placement` as `public_probe` (or `no_header`, `unreadable`,
  `timeout`, `threw`, `skipped_loadtest`), with `public_probe_status`,
  `public_probe_ms`, `public_probe_near_db`, any `public_probe_cf_error`, and on
  `threw` the reason in `public_probe_error` (`worker/public-probe.ts`). Read it with `scripts/logs.ts "tag=cron" --lines` one hour
  at a time and compare each tick's `<lane>_placement` with its `public_probe`.

## Placement is an explicit region hint, not Smart Placement (#3693)

`wrangler.jsonc` pins `"placement": { "region": "aws:us-west-2" }`, the AWS region
the Supabase project is in (West US, Oregon, as the Management API reports it), in
production and in `env.loadtest` alike. `scripts/test-worker-placement.ts` resolves
both through wrangler and fails on Smart Placement, on any other region, and on a
missing block.

Smart Placement was the setting until 2026-10-14 and the lane dispatch above shipped
under it (#3720). It never moved the lanes: their timings line read `local-BOM` or
no header, and Supabase's edge logs showed lane traffic moving from Mumbai (origin
p50 about 261ms) to Stockholm (about 189ms), never to Seattle (about 20ms). Its docs
say why: it forwards a request only when "a candidate location is significantly
faster". A hint has no such judgement. The docs: "Placement Hints run your Worker in
the data center with the lowest latency to your specified cloud region."

Three things follow, all from the same page
(developers.cloudflare.com/workers/configuration/placement/):

- **It applies to every fetch**, lead requests included. They ran at SEA under Smart
  Placement already, so for them the expected change is none; a lead far from Oregon
  pays the forwarding hop to the hinted colo, then makes its several database calls
  from beside the database, which is the trade Slate wants because it is DB bound.
  Static assets are unaffected ("always served from the location nearest to the
  incoming request").
- **It still does not move `scheduled()`**: "Placement only affects the execution of
  fetch event handlers. It does not affect RPC methods or named entrypoints." That is
  why the lanes go over `SELF` to the default fetch handler, with no entrypoint.
- **`cf-placement` is documented only in Smart Placement's terms**: `remote-LHR` routed
  elsewhere, `local-EWR` ran where the request arrived. The docs do not say what a
  hinted request reports, so the lane timings line logs the header raw and the
  airport code is the reading that matters: a colo beside Oregon (SEA is where lead
  requests already measure about 21ms to Supabase) means the hint worked.
  `local-<that colo>` is possible and fine when the cron already ran there;
  `local-BOM` or `local-AMS` means it did not. Confirm it the first day on the
  Supabase edge logs (`request.cf.colo` for the lanes' tables), which do not depend
  on a header Cloudflare says "may be removed before Smart Placement exits beta".

## Where a confirm ran (#3784)

Placement runs every confirm beside Oregon, so a degraded colo there slows Google and
Supabase together with no healthy location in Slate's traffic to compare against. The
`confirm answered` line (`src/lib/booking/confirm-latency.ts`) therefore records where
it ran. Three candidate readings exist inside a placed Worker, and they say different
things:

- **`supabase_edge_colo`: where the confirm RAN.** The suffix of the `cf-ray` on each
  Supabase answer (`coloFromRay`, `src/lib/http/cf-ray.ts`), collected by the call
  budget for every budgeted call and kept per confirm by its profile, comma separated,
  first seen first. Supabase is behind Cloudflare, and a Worker's subrequest enters
  Supabase's zone in the colo the Worker runs in, so this is the same reading as
  `request.cf.colo` in Supabase's own edge logs, which is how placement was confirmed
  above (the lanes showed Mumbai and Stockholm there, the placed lead requests
  Seattle). It costs no extra call. Absent when no Supabase call answered (every one
  stalled or failed) and on the staff time change, which runs no confirm budget, so
  nothing observes its calls.
- **`request_cf_colo`: the runtime's `request.cf.colo`, raw, and probably where the
  lead ENTERED.** `@cloudflare/workers-types` documents it as "the data center that the
  request hit", and the placement page does not mention it. A Cloudflare Community
  thread ("How to determine Worker placement from inside the Worker",
  community.cloudflare.com/t/665739) is quoted by search results as saying it stays the
  colo nearest the client when placement runs the Worker elsewhere; the thread itself
  refused a direct read on 2026-10-23. Nobody has confirmed it on Slate, so it
  is logged under its own name and never read as the run location. Read through
  OpenNext's `getCloudflareContext().cf`, which its worker template fills from the
  incoming `request.cf` (`requestCfColo`, `src/lib/http/request-cf-colo.ts`).
- **`cf-placement`: not on the confirm line.** The placement page says Cloudflare
  "adds a `cf-placement` header to all requests when placement is enabled" and gives
  only Smart Placement's values. The same thread is quoted as saying it is not on the
  request the Worker receives but on the response, which matches how Slate reads it:
  the lane dispatcher reads it off the `SELF` binding's answer (`placementOf`,
  `worker/lane-run.ts`). A confirm cannot read a header added to its own response, so
  the confirm line carries no placement value.

**The production reading that settles `request_cf_colo`.** In Workers observability,
filter `message` to `confirm answered` over an hour of ordinary traffic and group by
`request_cf_colo` and `supabase_edge_colo`. Leads arrive from all over the US, so
`request_cf_colo` spread across several colos (ORD, IAD, DFW) while
`supabase_edge_colo` stays SEA or PDX means `request.cf.colo` is the entry location.
The two always agreeing means it is the run location too. Update this section with the
answer and the date it was read.

**The pages read the same fact (#3784).** When one confirm's slowest Google call and
slowest Supabase call both took 2 seconds or more, the booking timeout page names the
colo (`supabase_edge_colo`) and suspects it before either service; the Google breaker
page does the same when a confirm in this isolate saw a Supabase stall within 5 minutes
of opening (a cron lane's statement is left out: it can take 7.9s while healthy).
One predicate decides both (`src/lib/dependency-stall.ts`, which records the
measurements behind the threshold). What to do with such a page is in
`docs/alerts-runbook.md`, "Google cannot be reached for an agent".

## CPU is the real ceiling, and `limits.cpu_ms` DOES raise it

Cron trigger CPU defaults to **30s** on Workers Paid for a sub hourly interval.
At ~98 agents the shared minute invocation was hitting that ceiling on roughly 5%
of ticks, and Cloudflare killed those invocations outright.

**`limits.cpu_ms` is honored for a sub hourly cron.** This contradicts the
frequency gated table in Cloudflare's docs, which reads as though the cron
interval pins your ceiling. It does not. Two independent proofs:

1. **Canary (#760):** a deliberately burning every minute cron ran to 302s under a
   `300000` limit, rather than being clamped at 30s.
2. **Production, visible in the data (2026-07-14):** before the fix, cron CPU pegged
   at exactly **32,500ms** and those invocations died with outcome `exceededCpu`
   (380 to 400 of them). After `limits.cpu_ms` was raised to `120000`, successful
   runs reach **44.7s**, well past the old 30s ceiling, and `exceededCpu` has been
   **zero since 2026-07-09**.

Headroom for the every minute cron while its four lanes shared it in process (7 days,
19,260 ticks, before #3693):

| metric | value | vs the 120s ceiling |
|---|---|---|
| median CPU | ~10.0s | 8% |
| p95 | ~28.1s | 23% |
| max | ~44.7s | 37% |

CPU is billed on **actual usage, not the limit**, so raising the ceiling costs
nothing by itself. Raise it rather than let invocations get killed.

**Cron CPU is watched hourly from the Worker logs, once `CF_ANALYTICS_TOKEN` is set (#3141).**
The running Worker has no reading of its own CPU, so the hourly tick asks
`/api/cron/cron-budget` to query the Workers Observability telemetry API
(`POST /accounts/<account_id>/workers/observability/telemetry/query`) for every scheduled
invocation of `slate` over the trailing 24 hours, grouped by `$workers.event.cron`, with
the max and p99 of `$workers.cpuTimeMs` and two counts (`cronCpuQueryBody` in
`src/lib/monitor/cron-budget.ts` is the exact body). `cpuTimeMs` is milliseconds.

**It used to read the analytics, and that went dark.** The first version read the raw GraphQL
dataset `workersInvocationsScheduled` (one row per scheduled invocation, `cpuTimeUs` in
MICROSECONDS), which Cloudflare never documented. It stopped being filled for EVERY Worker on
the account at 2026-10-16T15:21:42Z while the crons kept firing, measured 2026-10-18, and the
check reported unmeasured for two days until the watchdog paged. The documented
`workersInvocationsAdaptive` cannot replace it: it counts cron invocations alongside requests
with no dimension separating them (the mixed p99 read 48.9 SECONDS on 2026-09-13, which is the
crons, not a request).

**The logs are sampled at volume.** On 2026-10-18 the minute cron came back with a sample
interval of about 1.05 (1,438 kept ticks), so a clean day's all clear says it was sampled
rather than claiming every tick. An empty day reads as blind and a full set of groups as
possibly truncated, never as zero.

It pages `cron_budget_headroom` when any schedule's worst tick passes half the ceiling
(`CRON_BUDGET_WARN_MS`, derived from `CRON_CPU_LIMIT_MS`, which
`scripts/test-cron-budget.ts` holds equal to `limits.cpu_ms`), and clears on a measured day
under it. The token is an ACCOUNT token on the whole account with the Workers role
Metadata Read-only (the dashboard's name since 2026-09-15 for Workers Observability Read);
a refusal says the permission may be missing. Without the token the check measures nothing and says so in a
daily info line. The table above stays the last hand reading.

What it replaced: #3168 paged on WALL time, the one thing the Worker can time about
itself, and fired on 2026-10-03 for a five minute tick of about 84s that was nearly all
waiting. Wall time is not a CPU bound in either direction (the clock advances only at I/O,
so compute between waits can read as no time at all, which is how a load run tick spent
119s of CPU, below), so that page was switched off. A tick past the line is still logged
under `tag=cron-budget`, and never pages.

### One limit for crons and requests, by decision (#3107)

`limits.cpu_ms` is a single value for the whole Worker, so the 120s the crons need
is also the ceiling on every web request. That is a recorded decision, not an
oversight (Dan, 2026-10-03): **keep the single 120s limit.** The reasons:

- Billing is for **CPU used, not the limit**, so the ceiling costs nothing by itself.
- The crons peak around **45s** (the max in the table above) and need the room.
- Web requests peak around **5s** (CPU p99 4,908ms on 2026-09-14, below), so the
  limit never decides anything for a request in normal running.
- A lower request limit would need the crons split into a **separate Worker**, and
  that split was declined.

What the high ceiling costs is a runaway request path: one that spins would run
to 120s instead of being cut off at a lower limit. That is accepted, and it shows
up in the request CPU percentiles below long before it shows up in spend. The same
reasoning sits beside the value in `wrangler.jsonc`, and
`scripts/test-recorded-decisions.ts` keeps the two in step.

### The `*/5` invocation has its own budget, and it is mostly one lane

Everything above is the **every minute** cron. The `*/5` trigger is a SECOND shared
invocation (`complete`, `watch`, `monitor`, `bulk-reassign`), with its own ceiling,
and until #1238 nothing here said anything about it. Measured live off
`wrangler tail` (`tag=cron msg="lane timings"`, which the worker emits for every
cron expression, not just the minute one):

| lane | tick 1 | tick 2 |
|---|---|---|
| monitor | 15,855 ms | 16,123 ms |
| watch | 1,951 ms | 1,987 ms |
| complete | 1,421 ms | 1,799 ms |
| bulk-reassign | 868 ms | 1,188 ms |
| `total_ms` | 15,855 ms | 16,123 ms |

The lanes run **concurrently**, so `total_ms` equals the slowest lane rather than
their sum, and the monitor lane IS the tick. At ~16s against the 120s ceiling that
is about 13%, so there is real room; what there is not room for is treating the
monitor lane as cheap, because a couple of dozen checks now share it and each one
that adds an unconditional read adds it to the lane that already dominates.

Three caveats, so this is not read as more than it is. **This is wall time, not CPU**
(the runtime exposes no per request CPU reading), and most of it is waiting on
PostgREST rather than burning CPU, so the CPU figure is well under the table. It is
**two ticks**, not the 7 day distribution above, so use it to size a change rather
than as a baseline to alert on; the two agreeing to within 2% is the only reason it
is worth writing down at all. And `wrangler tail` is what produced it, because
listing this from the query API needs a token the repo does not hold, and tail only
sees what arrives while it is attached: 18 minutes of attachment yielded two `*/5`
ticks, not the three or four the schedule implies, so treat the sample count as a
floor. #1246 is the issue that turns this into a watched trend.

The rule it implies for a new monitor check: make the first read the cheap one and
skip the rest when it comes back empty. #1238's coverage-gap check does exactly
that, so an ordinary tick with no approved absences pays for one query.

## The native rate limiter does not bound a concurrent burst

The `ratelimits` bindings are enforced **per datacenter** and counted
**approximately**, which the docs say and the code comment already called
permissive. The size of the gap is the part worth writing down. Measured against
production on 2026-08-17, from one machine, same address, same second, against
`/api/availability` and its 30 a minute ceiling:

| shape | requests | blocked |
|---|---|---|
| 45 sequential down one keep-alive socket, 1.06s | 45 | 16, first 429 at request **30** |
| 60 fired in parallel into one datacenter (EWR), 1.1s | 60 | **0** |

Sequential is enforced at exactly the configured number. Parallel sails straight
through. So the practical guarantee is not 30 a minute, it is 30 a minute **per
isolate**, which a burst spreads across for free. Read `wrangler.jsonc`'s numbers
as "the sustained ceiling for a well behaved caller", never as a bound on abuse.

**Measured again on 2026-09-14, and the gap is wider than "parallel" (#2339).**
The booking path load run (34889873261) sent 180 writes from ONE address, in waves
of twenty across 20 seconds, at the booking API's 60 a minute per address ceiling
(`BOOKING_API_IP_LIMITER`). **Every one was allowed.** The binding was present and
answered `success` every time: the run's `tail` artifact carries no
`tag=rate-limit` line, and a missing or throwing binding logs `limiter failing
open`. So three times the ceiling inside a third of its window produced no
refusal, which means the 2026-08-17 reading above ("sequential is enforced at
exactly the configured number") holds for one request at a time down one socket
and for nothing looser than that.

**Treat every `perMinute` in `EDGE_LIMITERS` as approximate, per Cloudflare
location, and eventually consistent.** The bounds on ONE address that really
refuse are the two behind it: the Durable Object ceiling
(`burstCeilingPerMinute`), exact across isolates, and the hourly rules
(`DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES`, 1,200 an hour), exact full stop, which
since #3416 are counted in the same Durable Object rather than in Postgres. The
load run's ceiling control (`scripts/loadtest/ip-ceiling-control.ts`) is built on
that: it sends until the deployment credits a refusal to the per address ceiling,
up to past the hourly cap, and reports where the refusal landed rather than
demanding one at the per minute number.

**What closes it is a Durable Object**, because it is the only primitive here
that holds ONE count across isolates (#1536 for availability, #1556 for the other
five limiters). `BURST_LIMITER` / `BurstLimiter` is the only DO this project
binds, and ONE namespace serves every endpoint: the object id is derived from a
key carrying the endpoint as well as the caller, so no two endpoints share a
count. Three things about its shape are deliberate and are the parts to preserve
if it is ever changed:

- it sits **behind** the fast check, and is consulted only once an address has
  crossed an escalation threshold **in one isolate**, where counting is exact
  because JavaScript is single threaded. So an ordinary booker load still pays no
  round trip, which is the property the whole cache-first design rests on.
- each ceiling is **ten times** its own endpoint's sustained limit, on purpose,
  and lives beside that limit in `EDGE_LIMITERS` (`src/lib/rate-limit-core.ts`)
  rather than as one shared number, because the ratio is the entire safety
  argument and 300 means "ten times" next to availability's 30 and "a hundred
  times" next to the booking confirm's 3. A large office behind one NAT address is
  a real lead source, and the gap above is the only reason those leads are not
  already being refused, so making the sustained number exact would ship a refusal
  to them. This is a flood backstop, not a tightening.
- it is asked only **after** the native check has allowed the request. A native
  block skips it (the request is already refused), but a native check that failed
  OPEN does not: the two are independent controls, so one missing binding must not
  switch both off.

It fails **open and loud** like every other limiter here, and it declines to
judge a request whose address could not be identified at all, because `"unknown"`
is a shared bucket rather than an address.

**Since #3416 the same object also holds the booking API's hourly ceilings**, and
those are counted differently on purpose. Each booking API request sends ONE hit
per hourly rule (`exactCeilingWithinLimit` in `src/lib/rate-limit.ts`), with no
escalation threshold and no memo, because a ceiling that sampled would not be
exact. They used to be `rate_limit_hit` rows, one Supabase round trip per rule per
request, and load run 37547143303 showed what that cost: a burst of a hundred
confirms for one slot made two hundred of them in one second, every statement in
Postgres was fast, and the Supabase API layer queued them in front of the one
confirm that would book (upstream p95 4 to 9 seconds, only during the bursts).
What moved is where the number is kept, and nothing else:

- the limits, and `rate_limit_hit`'s own window arithmetic: the window opens at
  its first hit (not on the hour), a refused hit still counts, and it resets only
  once strictly older than an hour (`hitAnchoredWindow`);
- the key: the object is `exact:` plus the row's old key
  (`bookapi:h:key:<caller>`, `bookapi:ip:h:ip:<address>`), so a count is shared
  exactly where a row was, and the `exact` space is disjoint from every burst key
  and from the verification command's;
- the refusal (429, `throttled_key` / `throttled_ip`, counted under
  `refused_ceiling_*`) and the per address block page;
- the direction: a hit that cannot be counted (no context, no binding, an error,
  no answer inside one second (`EXACT_CEILING_DEADLINE_MS`, Dan, 2026-10-18,
  #3894; it was the Supabase request's 15 second deadline until #3828) or the call
  budget, whichever ends first, or an answer for a different window, which is
  what an object still running older code gives during a rollout) is SERVED and reported as `rate_limit_broken:<prefix>`,
  exactly as an unreadable row was: a log line each time, and a page only once a
  sustained run of them lands on one server (#3670).

A hit is charged to a confirm's profile as its own dependency, `edge-counter`, so a
run reads the counter's time apart from Supabase's. The objects are keyed by a
caller or an address, which live long, so they are warm (about 11ms a call, below)
rather than created per request.

## A Durable Object call: what it costs, and what a deploy does to it (#3325)

Measured on 2026-10-05 from inside a Worker invocation, against a throwaway Worker
(`slate-confirm-line-spike`, deleted after), 100 samples each:

| call | p50 | p95 | max |
|---|---|---|---|
| first call to a NEW object, same region | 171ms | 266ms | 379ms |
| call to a WARM object, same region | 11ms | 19ms | 20ms |
| first call to a NEW object, cross country (`locationHint: "wnam"` from EWR) | 215ms | 323ms | 452ms |
| call to a WARM object, cross country | 53ms | 59ms | 62ms |

- **Creating an object is the expensive part.** Re-waking one that went idle is
  about a third of the cost: 17ms after 30s idle, about 50ms after 90s, about 55ms
  after 180s. So key objects by something long lived (a pool, a code), never by
  something new on every request (a slot), or every request pays creation.
- **An idle object FORGETS its memory after ten seconds** (#3479). An object with no
  timers set and nothing pending is hibernated after ten seconds with no request, and
  its in memory state is discarded; the next call runs its constructor again
  ([lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)).
  Measured in load run 37601024392: the pool grouping directory, published to once a
  minute and kept only in memory, answered every burst's read (about 48 seconds after the
  last publish) with nothing, while reads arriving every few seconds found it. Anything
  a LATER call depends on goes in the object's storage; memory is a cache in front of it.
  A line holds a pending timer while it has a turn, which is why its memory survives the
  turns it serves.
- **An object idle for minutes answers its first call about a second late, in Slate**
  (#3496). Read from the platform's own invocation records on 2026-10-07, where an
  event's timestamp is when the call ENDED, so its handler started at the timestamp less
  `wallTimeMs`. The daily proof's verification directory, idle 20 hours (17:33 UTC) and
  then 7 minutes (17:40), reached its handler about 0.87s and 1.0s after the first call
  was sent; the handler then took 124ms and 30ms, so the answer missed the 1000ms call
  bound by tens of milliseconds. In the second run a call sent a second after the first
  reached the object at the same moment as the first, which is an object not yet
  available delivering what had queued. The verify group's line object did the same on
  its first enter (about 1.25s and 1.35s from the request's start, inside the line's 1.5s
  reach bound). After a 20 second idle, by contrast, the same directory woke from
  storage and its handler started about 60 to 70ms after the call was sent, so
  hibernation (above) is cheap and the second is something evicted later, somewhere
  between 20 seconds and 7 minutes idle. **What it is not:** the deploy reports
  `Worker Startup Time` of 16 to 20ms on a 21,877 KiB bundle (4,644 KiB gzipped), so it is
  not the global scope; and the throwaway spike above, a tiny Worker, never took more than
  452ms even to create a new object. Whether the second is fetching and compiling Slate's
  bundle on the object's machine was not separated from anything else about the object,
  because that needs a deployed experiment. **Where it does not reach:** the live pool
  grouping directory, called every minute. Over six hours (343 recompute lane puts, each
  timed from its own cron invocation's start, so the caller's clock is the same every
  minute) puts after 45 seconds or more idle reached it at a median 437ms (n=120), no later
  than puts after under 15 seconds (462ms, n=106); a one second cold start would have moved
  the first figure to about 1.4s. The one plainly cold call was the first after a deploy.
- **Concurrency inside one object is cheap.** 100 calls held open on one object (each
  awaiting an in memory promise, nothing in storage, so no input gate closes) were
  all released by one call with no measurable lag.
- **A deploy does NOT cut held calls.** 30 calls held on the old version ran out their
  own 45s timeout there, while new calls reached the new version about 6 seconds into
  the deploy and found none of the old state. Anything holding a request open on an
  object must re-ask on a short cycle, or it is stranded for its whole timeout by
  every merge.
- `wrangler deploy` prints "no such Durable Object class is exported" for classes
  re-exported through the OpenNext entry even when they are (#2334); the binding test
  (`scripts/test-confirm-line-binding.ts`) is what tells the false warning from a
  real one.

## Work after the response is cancelled 30 seconds after it (#2922)

`after()` maps to `ctx.waitUntil`, and Cloudflare cancels whatever is still
running 30 seconds after the response ends, logging
`waitUntil() tasks did not complete within the allowed time after invocation end
and have been cancelled` as a `warn` on the invocation. Nothing in the app can
record that, because the cancelled code never runs again.

Measured on 2026-09-30: 145 of 165 Google pushes in one hour were cancelled, each
invocation running 28 to 34 seconds of wall time and 15 to 24 seconds of CPU. The
calendar sync finished (no `sync_claimed_at` claim was left behind, which a sync
cut off mid pass would leave); the slot refresh after it recomputed every bucket
CODE the agent is in, one after another, at about four seconds each. #2923 made it
compute once per pool inside a time budget. Since #3258 (production, 2026-10-05:
the push path was two thirds of the Worker's CPU and overlapped every lead facing
confirm timeout) it refreshes only when the sync actually moved busy time, goes
through the booking refresh's per pool coalescing window, and refreshes at most
`MAX_PUSH_POOLS_PER_CALL` pools a push (`refreshAgentPoolsAfterPush` in
`src/lib/availability/slot-cache.ts`), leaving the rest to the every minute
recompute lane, which refreshes every pool within its four minute window.

**Measuring it.** A push whose work finished logs
`tag=google-push msg="push work finished"` with its outcome and elapsed `ms`, and
each push refresh logs `tag=slot-cache msg="agent pools refreshed after push"` with
how many pools it refreshed, deferred and failed. A push whose sync moved no busy
time logs no refresh line at all. The cancel rate is the
count of cancellation warnings on invocations whose `$metadata.message` includes
`/api/google/push`, against the count of `push work finished` lines over the same
window. Both sides are needed: the finished count alone cannot tell a quiet hour
from a broken one.

## Subrequests are NOT a constraint

Cloudflare **removed the old 1,000 subrequest cap on 2026-02-11**. Workers Paid is
now **10,000 per invocation** (configurable up to 10M). Any stale advice built
around the 1,000 cap is obsolete.

Every `fetch()` counts (each PostgREST query, Google call, Slack post).
`caches.default` is colo local and does **not** count.

Code derived budget at 200 agents: steady state is about **760 per tick**, and even
the combined worst case across all four lanes (about 4,300) sits far below 10,000.

**Subrequests ARE counted, and this note used to say they were not** (#2279,
re-measured 2026-09-13). The GraphQL analytics dataset
`workersInvocationsAdaptive` exposes `sum { subrequests }`: production returned
**24,087 subrequests over 317 invocations** in one hour, a mean of 76 per
invocation. What is genuinely NOT exposed is a **per invocation maximum**, which is
what a ceiling is actually about, so a sum and a mean are what can be had and
neither can prove a single invocation stayed under a limit. Derive the worst case
from the code as before, and watch the invocation **`status`** dimension for a
breach (never yet seen).

**The dimension is `status`, not `outcome`.** There is no `outcome` field on that
dataset, and asking for one answers HTTP 200 with an `errors` array and a null
`data`, which reads exactly like an empty window. That is what kept the load run's
platform bar blind on every run it ever made. The healthy value is **`success`**.
The full dimension list, read from the live schema: `cacheStatus, coloCode, date,
datetime, datetimeFifteenMinutes, datetimeFiveMinutes, datetimeHour,
datetimeMinute, datetimeSixHours, dispatchNamespaceName, environmentName,
isDispatcher, isPreview, previewSlug, scriptName, scriptTag, scriptVersion,
status, usageModel`.

**That dataset MIXES cron and request invocations**, and nothing in it tells them
apart. Measured 2026-09-13, the production Worker's CPU p50 was 198ms and its p99
was **48.9 seconds**, because 79 of 317 invocations that hour were cron lanes
running under the raised `limits.cpu_ms`. Any per request CPU percentile taken
from it is therefore the cron lanes unless the window contains no cron at all. To
read cron CPU per invocation, attributed to the cron expression that fired it, query
the Worker logs (`$workers.cpuTimeMs` grouped by `$workers.event.cron`, the cron CPU
check's query above). The raw dataset `workersInvocationsScheduled` used to answer
this and has been empty for every Worker on the account since 2026-10-16.

**The lane budget is NOT the request budget, and the load run used to borrow it
(#2321).** The 198ms p50 above is a reading about whatever traffic that hour held,
mixed cron and request, and the load run judged the request path against a 200ms
budget taken from it. Those are different questions: a scheduled invocation is
judged against `limits.cpu_ms` (120,000ms), while a request is about a lead waiting
and about spend on a path Cloudflare scales horizontally. The run derives its own
now (`REQUEST_CPU_P99_MS` in `scripts/loadtest/judge-booking-run.ts`), as a stated
share of its latency bar: CPU is the compute floor under wall time, so a confirm
spending more than half the latency bar on CPU has no headroom left for the
database and Google round trips it also has to make, and the latency bar is about
to fail for a cause the CPU bar can name first.

Measured against it on 2026-09-14 (run 34862015419): **CPU p99 4,908ms over 1,364
invocations with no cron in the window**, against a wall p95 of 4,025ms. CPU
roughly equals wall, so the confirm path is compute bound rather than waiting on
anything. Which part of it is the open half of #2321, and the path times its own
named stages (`src/lib/booking/confirm-profile.ts`), so the next run answers it
from a measurement rather than from reading the code. That is WALL time,
apportioned only because this run measured the two as roughly equal.

**Reading a slow or timed out confirm in production (#3300, #3401).** Every
confirm, a booking or a time change, collects that profile, and its
`tag=booking` (or `tag=booking-api`) `msg="confirm answered"` line carries it
when the confirm timed out (`timed_out=true`) or took 8 seconds or more
(`CONFIRM_PROFILE_SLOW_MS`). `confirm_kind` says which confirm it was (`new`,
`move`, `admin_move`). The fields, counts and milliseconds only:

- `stages_run`, `stages` (`name:ms/runs`, dearest first) and `staged_ms`, the time
  at least one stage was running, overlapping stages counted once;
- `unattributed_ms`, the wall no stage covers, split into
  `unattributed_before_ms`, `_between_ms` and `_after_ms` by where it fell: time in
  the gaps is this confirm computing, or waiting for the isolate to resume it, with
  nothing named in flight. The stages plus the remainder are exactly `response_ms`;
- `rungs_walked` and `rung_ms` (`code:ms`, ladder order), the tier ladder;
- `calls_made`, `calls_ms` and `calls_by` (`dependency:ms/calls/slowest_ms`), every
  budgeted Supabase and Google request. Absent on the admin time change, which runs
  no confirm budget, rather than a zero.

A span runs to the moment the confirm RESUMES after the call, so a stage or call
far longer than Supabase's or Google's own log of the same request is the isolate
being slow to get back to this confirm, not the dependency. A timed out line also
carries `lead_id`, the 15 character Salesforce lead key, so the same lead booking
again can be matched; never a name, email or phone.

**The GraphQL analytics lag is MINUTES, not hours.** Measured 2026-09-13 at **1.9
minutes** behind. The three hour figure recorded elsewhere in this document belongs
to the Workers **Logs** query pipeline (#1533), which is a different system; do not
carry that number over to this one.

**Watch item (#762), and what it turned into (#2357):** the two selfheal reconcile
sweeps and the sync lane's post sync refresh each looped
`recomputeBucketSlotsForToday` over up to 25 (reconcile) or 20 (sync) bucket CODES,
one after another with no time bound. Each call is a whole POOL compute, and sixty
codes resolve to fifteen pools (#2245), so the loop computed the same pools several
times. On the load test Worker, whose stubbed Google answers instantly and turns
every second of that into CPU, it took a minute tick to **119,137ms of CPU against
the 120,000ms kill** (run 34991614423: sync 175s and selfheal 180s of wall in one
tick), and five more ticks to 52 to 61s.

All three now make ONE call, `refreshPoolsForAgents`
(`src/lib/availability/slot-cache.ts`): one compute per pool, at most
`MAX_TOUCHED_POOLS_PER_SWEEP` (5) started, none started after
`TOUCHED_POOLS_BUDGET_MS`. **The count is the ceiling that matters**, because a
Worker's clock does not advance during execution: CPU spent computing reads as no
time at all, so a deadline alone cannot cap a fan-out whose cost is compute. Pools
past the count are left to the recompute lane, as the overflow past the old code
cap always was. `scripts/test-per-code-recompute.ts` refuses a new per code call
site that is not on its named list.

The load run's cron CPU bar now fails past **half** the kill limit
(`CRON_CPU_MARGIN_SHARE`) rather than at it, and its report prints the worst tick's
share of the limit on every run, so a pass at 99 percent no longer reads like a pass
at 3.

## Writing log lines: `src/lib/log.ts`, and joining one booking's lines

Moved out of `AGENTS.md` on 2026-10-15, where every character was loaded into
every session (#2393). `AGENTS.md` keeps the rule and points here; this is the
full text as it stood, with the reasoning, the incidents and the measurements
behind it.

Cloudflare captures **every** console method from the deployed Worker, with the
`Error` object serialized. Nothing is dropped: a 250-line canary (#801) came back
100% at every level. So the "detail is kept server-side in the logs" guarantee in
`internalErrorResponse` (`src/lib/api/errors.ts`) is real.

**Never call `console` directly in `src/`** (ESLint `no-console`, error severity).
Every server line goes through **`src/lib/log.ts`** (#808):

```ts
log.info("recompute", { msg: "cycle", refreshed: 3, util_pct: 42 });
log.warn("lane-watchdog", { msg: "stale lane", lane: "outbox" });
log.error("booking", { msg: "insert failed", booking_id: id }, err);  // Error passed THROUGH
```

which emits `slate tag=recompute msg="cycle" refreshed=3 util_pct=42`. Two things
that kept being decided wrongly per call site now live in one place:

- **The level.** `console.log` is unreachable from the helper. It is the one method
  Cloudflare stores with **no `level` field**, so the line is kept but is invisible
  to every level-filtered query, which reads as a total drop. That "console.log
  doesn't come back" belief (and, before it, "console.error doesn't come back") were
  both the same false negative: a query that verified nothing, read as absence.
- **A searchable `tag=`.** Filter on `tag=booking-api` instead of guessing at a
  message substring. Pass the `Error` itself as the third argument so Cloudflare
  serializes its stack rather than it being flattened into text.

**Stitching one request's lines together needs nothing from us.** Workers Logs has an
Invocations view that groups every line from one invocation, so a request's confirm-path
lines are already a unit. What that CANNOT do is join across invocations, and a booking's
side effects live in a later cron invocation: the join key there is `booking_id`, which
works because the outbox row carries it. That is the whole correlation story (#1047); a
generated request id would be worse for the cross-invocation case, since the drain has no
memory of the originating request unless it is persisted on the row, which is a schema
cost for no gain over the id already there. Some lines deliberately carry no identity at
all: contact data does not go in logs, so a pre-booking failure names the slot and the
agent rather than the lead.

Retention is 7 days and there is no alerting on top of it, so logs are for
forensics after the fact. Anything that must page someone still needs a real
sink (a Slack alert or an `alert_state` row); see the fail-loud rule.

## Reading the logs: the key trap that fakes a total outage

**Cloudflare captures every console method. Nothing is dropped.** Measured in
production (#801) with a canary that emitted 50 tagged lines per method across 5
invocations of the deployed Worker: **250 of 250 came back, a 100% capture rate at
every level.**

| method | captured | `level` on the row |
|--------------------|---------|--------------------|
| `console.debug`    | 50 / 50 | `debug`            |
| `console.log`      | 50 / 50 | **none**           |
| `console.info`     | 50 / 50 | `info`             |
| `console.warn`     | 50 / 50 | `warn`             |
| `console.error`    | 50 / 50 | `error`            |

**The trap is `console.log`: it is stored, but it lands with NO `level` field.** So
any query that filters or groups on level silently drops every `console.log` line,
and you get zero rows from output that is sitting right there. That is what the
#708 canary walked into when it concluded `console.log` "did not survive" (a single
observation, read through a level filter).

Because of that, **`console.log` is banned in `src/`** by an ESLint rule
(`no-restricted-properties`, error severity). Use `console.info` for a routine
operational line, `warn`/`error` for problems. Then everything the Worker emits is
level-filterable. (`scripts/` is exempt: those are node harnesses printing to a
terminal, not the Worker.)

**Filter on the bare `message` and `level` fields, NEVER `$metadata.message` or
`$metadata.level`.**

- `$metadata.*` holds **only invocation records**: the `GET https://slate.trypennie.app/...`
  line, or the cron expression (`* * * * *`) for a scheduled run.
- App console output lives in the bare `message` / `level` fields.
- Query the wrong key and you get **zero rows**, which is indistinguishable from
  "Cloudflare is dropping our logs". That false negative is exactly how the project
  spent months believing `console.error` was dropped. The Cloudflare MCP tool's own
  docs advertise `$metadata.message` as the *preferred* key, so this is easy to walk
  into.

More ways to get a convincing false negative. Every one of these returns **zero
rows** from data that is actually present, so none of them can be told apart from
"the logs are broken" without a positive control:

- **Preview versions emit no observability events at all.** A version from
  `wrangler versions upload` serves traffic on its preview URL but produces zero
  events, not even invocation records. Only the **deployed** version is captured, so
  a log canary must run against a real deploy. Control for this by grouping on
  `$workers.scriptVersion.id` and checking your version even appears.
- **Any level filter hides `console.log`** (see the table above). Searching by
  `message` alone finds it.
- **The MCP tool's `groupBys` on `level` silently returns an empty aggregation**
  even when a `level` filter on the same rows matches them. Group-by is not a
  reliable way to ask "what levels exist"; filter for a level and count instead.
  This one is nasty, because an empty group-by reads as "no such level exists".
- **The MCP `events` view is broken for app log rows.** It throws a schema error
  (`expected string, received undefined` at `$workers.outcome`) because app log
  rows carry no `outcome`, only invocation records do. The error means your query
  *matched* rows. Use the `calculations` view with a `count`.
  Note the boundary: this is the **MCP tool's** validation, not the API's. A
  `view: "events"` query sent straight to
  `/accounts/{id}/workers/observability/telemetry/query` returned app log rows
  normally on 2026-08-17, with the line in `source.message`, so the raw API is a
  way to read actual message text when you need it.
- **A timeframe in the future silently returns zero rows.** Check `date -u` first.
- **A WIDE window silently drops rows (#3299).** On 2026-10-05,
  `tag=booking-reminder msg="cycle"` over 25 hours came back from the events view as
  **26** rows, and as **287** (12 an hour, the lane's real rate) when the same question
  was asked one hour at a time. Nothing in the wide answer says it is partial, so missing
  rows read as absence. Ask one hour at a time and add the results up; `scripts/logs.ts`
  does this for counts and for printed lines, and refuses a slice wider than an hour.
- **A count is an ESTIMATE when the Worker was busy, and the lines it estimates were never
  stored (#3915).** Workers Logs samples at ingestion: it stores some rows and gives each a
  weight, the number of lines it stands for, and a `count` is the SUM of the weights. On
  2026-10-18 15:30 to 16:30 UTC `msg="confirm answered"` counted **69** while the events
  view listed **51**; counting grouped by `$metadata.id` showed 49 rows at weight 1 and 2 at
  weight 10, which is 69. Paging the events view (`offset`) and one minute slices both
  returned the same 51, so no query can list the other 18. A percentile over the listing
  alone under-counts exactly the busy minutes that were sampled, so weight it by each row's
  weight. That grouped count needs its group limit inside `parameters` (`parameters.limit`):
  without it the API returns 10 groups, and the request's own `limit` does not change that.
- **Ingestion lags a minute or two, and a too-narrow window drops late arrivals.**
  A count taken immediately after emitting returns 0, and a window that ends too
  soon undercounts (a 50-line level read back as 30 until the window was widened).
  Wait a couple of minutes and query a window that ends generously past the event.

**Always run a positive control before believing a zero.** Query for something you
know is in the window (the every-minute `tag=recompute` line is a good one). If
the control also returns zero, your query is wrong, not the platform.

**And check the control is RECENT, not merely present (#1533).** A passing control
proves the query shape, the credentials and the field names. It does not prove the
query can see the part of the window you care about, because a line from hours ago
satisfies it just as well as one from a minute ago. Measured on 2026-08-17, the
query pipeline ran about **three hours** behind:

| query | window | count |
|-------|--------|-------|
| `tag=recompute` | 1h | **0** |
| `tag=recompute` | 4h | 50 |
| `tag=recompute` | 8h | 290 |

for a lane that emits every minute, where a healthy 1h window is about 60. In the
same minutes `npx wrangler tail` captured
`slate tag=edge-limiter msg="monitor edge-limiter: healthy runtime=Cloudflare-Workers bindings=6"`
and a cycle line carrying `ms_edge_limiters=235 steps=24` live from production,
while the query API returned **0** for both over a 4h window. The Worker was
emitting; the API was behind.

That cost a wrong conclusion the same day: a 4h window covering 14:44 returned zero
for the needle and 101 for the control, which read as a trustworthy absence when the
recent end of the window simply held nothing yet.

So the ingestion lag is not "a minute or two" as a rule you can plan around; it is
usually small and can be hours. Two practical consequences:

- **For anything within the last few hours, use `npx wrangler tail`**, which streams
  live from the deployed Worker and was accurate every time it was checked. It only
  shows traffic while it is attached, so for a cron lane, attach and wait one cadence.
- **`scripts/logs.ts` checks this**: it reads the control's newest non-empty bucket
  and, when that is more than `CONTROL_FRESHNESS_MS` behind the end of a slice, says
  the data is BEHIND in its own wording, so a lagging pipeline is never mistaken for a
  broken query. Today it WARNS beside an absence rather than refusing it
  (`CONTROL_FRESHNESS_MODE`), until #1535 has measured the normal lag.

### The sync lane's cycle line

`tag=sync msg="cycle"` is emitted once per minute tick and, like the recompute
line, is unconditional, so it works as a positive control too:

```
slate tag=sync msg="cycle" agents=98 deferred=0 processed=98 gone_skipped=3 truncated=false
```

`gone_skipped` (#1187) is how many calendars the tick held back because they are
established as gone (#1049 gives each one attempt per `GONE_RETRY_INTERVAL_MIN`
rather than all 1440 a day). It is the only place the SIZE of that population is
visible: the backoff removes the failing Google calls, and those calls were the
incidental signal that delegation had been revoked, so a Workspace change that
kills thirty agents at once makes this lane quieter rather than louder. A
`gone_skipped` that climbs and stays high is a revocation wave, not noise.

Read it as a per-tick sample, not a fleet census: the tick is capped at
`MAX_AGENTS_PER_SYNC_TICK` and can end early on the budget deadline, so the
number covers only the agents that tick reached. That partial coverage is why it
is a log field rather than an alert threshold; the persistent-failure paging
stays with the `sync_failures` alert, which judges stored streaks.

**Don't hand-roll the query: use `scripts/logs.ts` (#807).** It encodes every trap
above and *refuses* to report a zero unless the positive control found something in
the same window, so "absent" and "my query is broken" can never be confused again:

```sh
node --experimental-strip-types --import ./scripts/register-paths.mjs \
  scripts/logs.ts "tag=booking-api" --minutes 120
```

Add **`--lines`** to PRINT every matching line (UTC timestamp, level or a dash for a
`console.log` line, text) instead of only counting them (#3664). It lists through the
raw API's events view, which serves app rows normally; only the MCP tool's validation
breaks on them. A narrow window in the past is `--from <iso> --to <iso>` (`--minutes`
beside `--from` is refused, since it could only be ignored).

Every request covers **at most one hour** (#3299, above). A wider window is read one
hour at a time, summed and merged, and the output says how many slices it read and
prints each slice's needle and control counts. `--slice-minutes` asks for narrower
slices, from 1 to 60 minutes; a run reads at most 168 slices (7 days at one hour),
because they are read one after another. The positive control is judged PER SLICE: a hit in a
slice whose control is live is a hit, but one slice whose control found nothing makes
an absence over the whole window unverifiable, since nobody could see into it.

`--lines` also reads each stored row's sample weight (above), and judges the listing
against the rows Cloudflare STORED rather than against the count. A row standing for more
than one line prints `weight=N` between its level and its text, and a listing short of the
stored rows is asked for once more before it is reported, because one hour listed 4 of its
19 stored rows once on 2026-10-20 and all 19 on every later ask.

Exit codes are grep-like, with distinct ones for the cases that must not be believed:
**0** found, **1** trustworthy absence, **2** UNVERIFIABLE or refused (the control came
back empty, the token is missing, the API refused), **3** found but the printed list is
incomplete (a slice listed fewer rows than Cloudflare stored, or filled the 2,000 row request
limit, or carried an event whose text or, in a sampled slice, whose weight could not be
read), **4** found and every stored row printed, but Cloudflare sampled the window: a
`SAMPLED:` line beside the verdict says how many rows stand for how many counted lines. On a
3 the count is the answer and the printed list is not every line; on a 4 the list is every
line that exists to list, and any figure over it is weighted by `weight=` (as
`scripts/loadtest/google-timings.ts` does).

### The token (read only, one per Mac)

The tool needs a read only API token carrying the Workers role **Metadata Read-only**. It reads it from
`.env.local` at the checkout root under the name **`CLOUDFLARE_LOGS_READ_TOKEN`**, or
from `CLOUDFLARE_API_TOKEN` set in the shell for one run. It reads only that one name
from the file and never prints the token, not even inside an API error body.

**Never store it in `.env.local` as `CLOUDFLARE_API_TOKEN`.** Wrangler 4 loads `.env`
AND `.env.local` into its own environment on every command (`getDefaultEnvFiles`,
read in wrangler 4.127.1 on 2026-10-13) and signs in with `CLOUDFLARE_API_TOKEN`
whenever it is set, so a read only token under that name would replace the OAuth login
for every `wrangler tail` and deploy run from that checkout, and they would fail.

To create one, in the Cloudflare dashboard, signed in to the Pennie account:

1. My Profile, **API Tokens**, **Create Token**, then **Create Custom Token**.
2. Name it `Slate logs read only (<which Mac>)`.
3. Permissions: under **Developer Platform**, the **Workers** row, role **Metadata
   Read-only**. Nothing else. That is the dashboard's name since 2026-09-15; where the
   page still offers the legacy **Account**, **Workers Observability**, **Read**, it does
   the same job. Never Editor or Admin.
4. Account Resources: **Include**, **Pennie**.
5. **Continue to summary**, then **Create Token**. It is shown once.
6. Add it to `.env.local` in the checkout as `CLOUDFLARE_LOGS_READ_TOKEN=` followed by
   the token. Never paste it into a command or a chat.
7. Check it from the checkout root; it must print PRESENT and exit 0:

   ```sh
   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/logs.ts "tag=recompute" --minutes 60
   ```

One more trap it encodes, found while building it: the REST API's `timeframe` takes
**Unix milliseconds** and 400s on ISO strings, even though the Cloudflare MCP tool
happily accepts them.

Retention is **7 days** with **no alerting** on top. Logs are forensics after the
fact, not a pager. Anything that must actively page someone still needs a real sink
(a Slack alert or an `alert_state` row).

## Recipes that actually work

Query CPU and outcomes through the Workers Observability API (the Cloudflare
observability MCP `calculations` view works; its `events` view is currently broken
and errors on any event missing `outcome`). Use an **absolute** `from` / `to`.

CPU headroom for the every minute cron: filter `$metadata.service = slate` and
`$metadata.trigger = "* * * * *"`, then calculate `median` / `p95` / `max` over
`$workers.cpuTimeMs`.

CPU kills and other failures: same filter, group by `$workers.outcome`, and count.
Healthy output is `ok` only. `exceededCpu` means Cloudflare killed the invocation
mid flight, and the lanes that had not finished simply did not run.

The GraphQL analytics API (`workersInvocationsAdaptive`) is the fallback if
observability is lagging or has not picked up a new Worker. Note its `cpuTime` is in
**microseconds**, not milliseconds, and it also wants an absolute from / to.
