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

## Subrequests are NOT a constraint

Cloudflare **removed the old 1,000 subrequest cap on 2026-02-11**. Workers Paid is
now **10,000 per invocation** (configurable up to 10M). Any stale advice built
around the 1,000 cap is obsolete.

Every `fetch()` counts (each PostgREST query, Google call, Slack post).
`caches.default` is colo local and does **not** count.

Code derived budget at 200 agents: steady state is about **760 per tick**, and even
the combined worst case across all four lanes (about 4,300) sits far below 10,000.

**Observability exposes no subrequest counter**, so you cannot measure this
directly. Derive it from the code and watch `$workers.outcome` for a
"Too many subrequests" breach (never yet seen).

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
