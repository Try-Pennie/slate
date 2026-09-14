# Cloudflare platform notes

Non obvious facts about how Slate actually behaves on Cloudflare Workers. Each one
cost real time to establish, and several contradict either the public docs or the
tooling's own guidance. Read this before investigating a limits question or
concluding "our logs are missing".

Established across #724 / #760 (limits) and #708 (logs). Numbers refreshed
2026-07-14 against the deployed Worker.

`pnpm dev` (Node) enforces none of these limits. Only the deployed Worker does.

## The four minute lanes share ONE budget

The four every minute lanes (`sync`, `recompute`, `outbox`, `selfheal`) run
in process in a single `scheduled()` invocation (`worker/index.ts` calls
`handler.fetch(...)`, no network hop). They therefore share that one invocation's
CPU and subrequest budgets. **Budget the combined total, never per lane.**

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

Current headroom for the every minute cron (7 days, 19,260 ticks):

| metric | value | vs the 120s ceiling |
|---|---|---|
| median CPU | ~10.0s | 8% |
| p95 | ~28.1s | 23% |
| max | ~44.7s | 37% |

CPU is billed on **actual usage, not the limit**, so raising the ceiling costs
nothing by itself. Raise it rather than let invocations get killed.

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
(`burstCeilingPerMinute`), exact across isolates, and the hourly rules in Postgres
(`DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES`, 1,200 an hour), exact full stop. The
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
from it is therefore the cron lanes unless the window contains no cron at all. Use
the separate raw dataset **`workersInvocationsScheduled`** (fields `cpuTimeUs`,
`cron`, `datetime`, `environmentName`, `scheduledDatetime`, `scriptName`,
`status`) to read cron CPU per invocation, attributed to the cron expression that
fired it.

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
anything. Which part of it is the open half of #2321, and the path now times its
own named stages under `SLATE_LOADTEST` (`src/lib/booking/confirm-profile.ts`), so
the next run answers it from a measurement rather than from reading the code. That
is WALL time, apportioned only because this run measured the two as roughly equal.

**The GraphQL analytics lag is MINUTES, not hours.** Measured 2026-09-13 at **1.9
minutes** behind. The three hour figure recorded elsewhere in this document belongs
to the Workers **Logs** query pipeline (#1533), which is a different system; do not
carry that number over to this one.

**Watch item (#762):** the two selfheal reconcile sweeps loop `bucketsForAgent`
(about 3 subrequests plus CPU) per freed or missing agent with no per tick cap, up
to about 1,200 subrequests across both during a backlog. Not a subrequest threat at
a 10,000 ceiling, but it is a real CPU contributor worth capping.

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
- **`scripts/logs.ts` now enforces this**: it reads the control's newest non-empty
  bucket and reports **UNVERIFIABLE** when that is more than `CONTROL_FRESHNESS_MS`
  behind the window's end, with its own wording so a lagging pipeline is never
  mistaken for a broken query.

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
CLOUDFLARE_API_TOKEN=... node --experimental-strip-types --import ./scripts/register-paths.mjs \
  scripts/logs.ts "booking-api: authenticated request" --minutes 120
```

Exit codes are grep-like, with a distinct one for a broken query: **0** found,
**1** trustworthy absence, **2** UNVERIFIABLE (the control came back empty, so
believe nothing). The token needs Workers Observability read.

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
