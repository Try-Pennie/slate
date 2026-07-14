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

**Cloudflare DOES capture `console.error` and `console.warn`**, at level `error` /
`warn`, with the `Error` object serialized. Verified in production (#708) with a
canary that logged a unique token and read it back.

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

Three more ways to get a convincing false negative:

- **Preview versions emit no observability events at all.** A version from
  `wrangler versions upload` serves traffic on its preview URL but produces zero
  events, not even invocation records. Only the **deployed** version is captured, so
  a log canary must run against a real deploy. Control for this by grouping on
  `$workers.scriptVersion.id` and checking your version even appears.
- **`console.log` did not survive** the same canary where `warn` and `error` did.
  Do not rely on it for anything you need to read back. Log at `warn` or `error` if
  it must persist.
- **A timeframe in the future silently returns zero rows.** Check `date -u` first.
  Observability can also lag by a minute or two, and can miss a brand new Worker
  entirely.

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
