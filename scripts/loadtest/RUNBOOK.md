# Load testing Slate

Two runs live here, and they measure different things:

- the **cron lane** run (#273 Increment 5), everything up to "Backstop retention
  decision". It drives recompute, sync, watch and the outbox at 200 agents.
- the **booking path** run (#2243, #2244), the two sections at the end. It drives
  the path a lead actually takes.

**The July soak proved the lanes and never confirmed a single booking.** That is
worth stating plainly, because it read as a 200-agent pass for a year: the memory
note for #440 records a soak that went green, and the confirm path was not in it.
`createEvent` was never stubbed, so a booking could not have completed under
`SLATE_LOADTEST` even if the run had tried (#2241). Anything relying on "the load
test passed" should say WHICH run.

# 200-agent load test (#273 Increment 5)

The final gate before cutover: prove the free three-lane cron design holds at the
200-agent target, or learn which knob to turn (the recompute freshness window) or
whether the paid Durable-Objects fallback is needed.

The cron lanes are **global** (no org filter), so this MUST run against an isolated
database, never production. The harness seeds a 200-agent org and a Google **stub**
(gated behind `SLATE_LOADTEST`) so both lanes run end-to-end without real Google
accounts. `seed.ts` refuses to run against the prod project ref.

## What "pass" means (updated for the #295 design)
Real bookings/calendar changes refresh in seconds via the live push/booking path; the
recompute lane only owns the day-window slide + missed-push backstop. So the bar is:

1. **Recompute holds up** — per-tick time well under the 50s budget, it drains its due
   set each tick, and no bucket stays stale > 6 min. Read this from a **soak** run
   (`SOAK_MINUTES=10`, below), not the default one-shot snapshot: the sequential run
   measures freshness once at the very end, after the sync + watch phases have let the
   buckets age, so it always reports "all stale > 6m" even when recompute is healthy
   (a false alarm, #303). The soak interleaves recompute with a freshness sample once a
   minute and reports the **measured** max oldest-bucket age over the window.
2. **No lane errors** and the sync/watch lanes finish comfortably within their budgets.
3. **No subrequest-ceiling risk** — see step 6.

If recompute can't hold the bar: first widen the freshness window (`RECOMPUTE_FRESH_MS`
in `src/app/api/cron/recompute/route.ts`) and re-measure; if it still can't, that's the
trigger for the Durable-Objects fallback (a paid, escalated decision).

### Added for #440 P5 (booking-outbox crash safety)
4. **The outbox drain lane self-heals a crash backlog and does not starve sync.** After
   seeding a cancel-outbox backlog (step 3b), `/api/cron/outbox` drains it to **0 pending
   rows**, and the sync lane interleaved on every drain pass stays **well under its 25s
   budget** (the two lanes have separate locks, so the drain must never block the tail).
5. **Every invariant holds** (`run.ts` checks these against the DB after the soak):
   - every outbox row reached `delivered` (no stuck crash rows),
   - **no cancelled booking keeps a `slate` busy_block** (the stuck-slot / double-book
     window is closed by the outbox + the `#428` reconcile backstop),
   - **exactly-once webhooks**: zero duplicate `(endpoint, event, dedupe_key)` deliveries
     (the migration-`0046` partial unique index held under the concurrent drain).

## Steps

1. **Create a branch DB** (Supabase dashboard → Branches, or CLI). Note its project URL
   and secret key. (A branch is a paid resource while it exists — delete it after.)

2. **Apply the schema to the branch** — run the repo migrations against it
   (`supabase db push` with the branch linked, or apply `supabase/migrations/*` in order).

3. **Seed it** (points at the branch, not prod):
   ```
   SUPABASE_URL=https://<branch-ref>.supabase.co \
   SUPABASE_SECRET_KEY=<branch secret key> \
   node --experimental-strip-types scripts/loadtest/seed.ts
   ```
   Tunables: `AGENTS=200`, `BLOCKS_PER_DAY=12`, `CALS_PER_AGENT=1`.

3b. **Seed the crash backlog for the outbox drain (#440).** After the base seed, add a
   batch of `cancel` outbox rows left in every mid-sequence crash state (Google-delete
   already done, the rest pending), plus their cancelled bookings, stuck busy_blocks, and
   one webhook endpoint:
   ```
   SUPABASE_URL=https://<branch-ref>.supabase.co \
   SUPABASE_SECRET_KEY=<branch secret key> \
   OUTBOX_BACKLOG=500 \
   node --experimental-strip-types scripts/loadtest/seed-changepath.ts
   ```

4. **Run an app instance pointed at the branch, in load-test mode.** In a shell:
   ```
   NEXT_PUBLIC_SUPABASE_URL=https://<branch-ref>.supabase.co \
   SUPABASE_SECRET_KEY=<branch secret key> \
   SLATE_LOADTEST=true \
   CRON_SECRET=<any value> \
   pnpm dev
   ```
   `SLATE_LOADTEST=true` activates the Google stub (`src/lib/google/loadtest-stub.ts`) so
   the read lanes run without real Google, **and** short-circuits the webhook POST
   (`src/lib/webhooks/emit.ts`) so a dead sink can't turn every notify into a timeout.
   The delivery row is still written, so the exactly-once dedupe index is exercised for real.

5. **Drive the lanes and read the numbers:**
   ```
   SLATE_BASE=http://localhost:3000 CRON_SECRET=<same value> \
   SUPABASE_URL=https://<branch-ref>.supabase.co SUPABASE_SECRET_KEY=<key> \
   node --experimental-strip-types scripts/loadtest/run.ts
   ```
   It drives recompute/sync/watch, then drains `/api/cron/outbox` to empty (re-driving sync
   each pass), drives complete, then drives `/api/cron/selfheal` **to convergence** (reconcile
   is capped at 200 blocks/tick, so it loops until a tick frees nothing) before reading the
   invariants. The invariant checks use **uncapped server-side counts** (`scripts/loadtest/
   invariants.ts`), so a large soak can't truncate a result set past PostgREST's 1000-row cap
   and false-pass the stuck-slot check (the trap the first #440 soak hit). Exit code 0 =
   backlog drained and all invariants ok. Paste the output back for the go/no-go read. Bump
   `TICKS` for a longer read, `OUTBOX_BACKLOG` for a bigger drain.

5b. **Measure recompute freshness with a soak (#303).** The default run's freshness line is
   a post-lane snapshot and will read "all stale" (expected, not a failure). To get the
   real verdict, add `SOAK_MINUTES` (and optionally `SOAK_INTERVAL_MS`, default 60000) to
   the step-5 command:
   ```
   SLATE_BASE=http://localhost:3000 CRON_SECRET=<same value> \
   SUPABASE_URL=https://<branch-ref>.supabase.co SUPABASE_SECRET_KEY=<key> \
   SOAK_MINUTES=10 \
   node --experimental-strip-types scripts/loadtest/run.ts
   ```
   It drives `/api/cron/recompute` once per minute for the window, sampling the oldest
   bucket's age after each tick, and reports the **max** age observed. Pass = that measured
   max stays under 6 min (a healthy lane drains its due set each minute, so the oldest
   bucket never crosses the bar). The soak verdict is factored into the exit code; when
   `SOAK_MINUTES=0` the run notes freshness is extrapolated, not measured.

6. **Resource ceilings on a deployed Worker (CPU is the real one; subrequests are not).**
   The platform facts behind this (why `limits.cpu_ms` works on a sub-hourly cron, the
   10,000 subrequest ceiling, how to query CPU and outcomes, and the observability traps)
   live in **[`docs/cloudflare-platform-notes.md`](../../docs/cloudflare-platform-notes.md)**.
   Read that first; it is the single source of truth. The load-test-specific reads are:

   - `pnpm dev` (Node) enforces neither limit, so a ceiling can only be measured against the
     deployed Worker.
   - The four every-minute lanes share ONE invocation's CPU and subrequest budget. Budget the
     COMBINED total, never per-lane.
   - **Subrequests are comfortable at 200 agents:** steady state ≈ **760/tick** against a
     10,000 ceiling; even the worst case across all four lanes (~4,300) has ample room.
   - **CPU is the ceiling to watch.** After the #760 fix (`limits.cpu_ms` = 120000) the
     every-minute cron runs at ~10s median / ~28s p95 / ~44.7s max, with zero `exceededCpu`
     since 2026-07-09. If a soak pushes max toward 120s, that is the signal to act.
   - **Watch item (#762):** the two selfheal reconcile sweeps loop `bucketsForAgent`
     (~3 subrequests + CPU) per freed/missing agent with NO per-tick cap (up to ~1,200
     subrequests across both during a backlog). Not a subrequest-ceiling threat at 10,000,
     but a CPU contributor worth capping.

## The booking path run (#2243)

Everything above drives the CRON LANES. It never confirmed a booking, which is why
`createEvent` was unstubbed for a year and nobody noticed (#2241). This section is
the run that drives the path a lead actually takes.

### What is copied from production rather than invented

Both were measured on 2026-09-11 and both matter to what the run can find:

- **The event type**: 20 minutes on a **10 minute** grid, 120 minutes notice, no
  buffers. The seed used to say 30 on 15, which offers a third fewer times a day
  and so understates how much four drivers contend for them.
- **The roster shape** (`roster-shape.ts`): 90 agents across 5 zones, and the
  attribute distribution. The old distribution was measured in June and gave the
  Beyond backend **60 percent** of the roster; production gives it **two agents**.
  That is not a rounding difference: two agents is what makes every `x2x` bucket
  resolve to a pool of exactly **one**, and a one agent pool is the whole positive
  control for the burst. A seed staffing those pools sixty deep produces a run that
  cannot fail the control it was built for.

Re-export the shape before a run if the roster has moved:

```
pnpm loadtest:export-shape > /tmp/shape.json
ROSTER_SHAPE_FILE=/tmp/shape.json node --experimental-strip-types scripts/loadtest/seed.ts
```

The exporter is read only and refuses to print an empty shape. Its **pool depths**
are recorded but are NOT an input to the seed: the seed derives depth from the
profiles it generates, and the exported depths are what that output is checked
against, so a generator that drifts is caught by two independently produced numbers
rather than by trusting the generator to have applied its own input.

### The seed refuses a branch whose migrations do not match

Count AND highest version, both, against what the checkout ships. The highest alone
is not enough: the migration directory has never been replayed from empty, so a
branch can carry the newest file and be missing one in the middle, and every finding
of the run would then be about the schema. It refuses rather than warning, because a
seed is cheap to re-run and a ten minute run judged against the wrong schema is not.

### Busy blocks are day aligned per zone

They sit inside each agent's **own local** Mon to Fri 09:00 to 17:00, not at a fixed
offset from the seed instant. The roster spans five zones, so a UTC anchored block
lands mid morning for an Eastern agent and after hours for a Pacific one, and an
agent whose blocks all fall outside their own hours simply reads as free all day:
the seed would understate contention in exactly the zones the run is meant to press.

### Driving it

Four drivers, **fifteen a minute each for ten minutes**. Fifteen times four is
**sixty**, which is exactly the per address write ceiling
(`BOOKING_API_IP_LIMITER.perMinute`), and that is deliberate: the run sits on the
ceiling so the judge can attribute the 429s it produces. The pacing constants are
imported from the app rather than copied, so a run can never drift into measuring a
ceiling somebody changed.

```
SLATE_BASE=https://<loadtest>.workers.dev BOOKING_API_KEY=<key> \
RUN_ID=<run> DRIVER=0 OUT=results/driver-0.json \
node --experimental-strip-types scripts/loadtest/book.ts
```

- **Codes are weighted by real traffic**, measured from 25,735 routed cal.com leads
  in the 30 days to 2026-09-11. It is enormously lopsided (112 alone is 31 percent),
  and the lopsidedness IS the load: the hot codes have the largest pools and the
  most contended slot cache, the cold ones have one agent pools where every second
  booking is a conflict. The sequence is interleaved so any prefix is representative.
- **The slot is picked at RANDOM** from what the bucket offered, and it is the only
  deliberately non-deterministic choice in the run. Four drivers each taking the
  first offered time would contend on one slot all run, which measures the unique
  index over and over and never measures the path at a rate.
- **Availability reads are cached** and refreshed on a pace derived from the 30 a
  minute per address ceiling divided by the number of drivers sharing that address.
  A read before every booking would spend four times the budget and the run would be
  measuring the limiter.
- **`externalId` is `<run_id>-<driver>-<n>`**, unique across the run. A repeat is
  not a duplicate row: `external_id` IS the Salesforce id to Slate, so the booker
  would answer with the FIRST booking and the run would silently stop creating
  anything.
- **Every response is recorded** with status, outcome, wall time, the slot asked
  for, and **the address Slate saw**, echoed on the `x-loadtest-seen-ip` header
  under `SLATE_LOADTEST` only. A CI runner sits behind egress NAT, so it cannot work
  out for itself which address the ceiling was keyed on, and a run that assumed its
  own would report the limiter refusing IT when something else spent the budget.
- **A bucket offering nothing is RECORDED**, with an outcome of its own, rather than
  skipped in silence. An offered-nothing run and a run nobody drove otherwise
  produce the same empty file.

### The burst

`MODE=burst` with `START_AT` (epoch ms) and `BURST_SLOT`, both chosen **once** by
the setup step and handed to every driver, because a burst whose drivers each chose
their own time is not a burst: nothing contends and everything succeeds.

It runs against `122`, a real code real leads arrive on, whose pool is exactly one
agent deep. The control is **exactly one 200 and the rest SLOT_TAKEN**, which is
`bookings_active_slot_uniq` doing its job.

A driver that wakes up **late exits without firing** and says so, in the file and on
a non-zero exit. A late request meets an already taken slot and records a SLOT_TAKEN
indistinguishable from the contention the control is counting, so the judge would be
handed a staggered burst wearing a simultaneous one's clothes.

## Judging the booking path run (#2244)

`.github/workflows/loadtest.yml`, **`workflow_dispatch` only**, because a run
creates six hundred bookings. `concurrency: { group: loadtest,
cancel-in-progress: false }`: a half run leaves a seeded branch, a deployment and
six hundred bookings behind, and the next run seeded on top of them would report
clashes this one created. Every job carries a timeout.

### Before anything is believed: the preflight

`scripts/loadtest/preflight.ts` runs first and everything downstream rests on it.
It makes ONE real booking and checks three things:

- the booking left a row, an idempotency key and a `busy_blocks` row, and its
  **reservation row is gone** (the confirm path deletes it on success, so its
  ABSENCE is the assertion);
- the `gcal_event_id` is the **stub's shape**. If it is not, `SLATE_LOADTEST` is
  not on for that deployment and the run is about to create six hundred real
  calendar events and send six hundred real invitations, which is the single most
  expensive way this can go wrong;
- the database really **refuses a planted clash**, and the judge's own overlap
  predicate really goes red on one and stays quiet on a back to back pair. Both
  directions, or a judge hard wired to report no overlaps would satisfy it.

It writes that last answer to `results/preflight.json`, and the judge reads it
rather than looking the index up in the catalogue. Two reasons: PostgREST does not
expose `pg_indexes` at all (measured 2026-09-11, it answers 404 everywhere), so a
catalogue lookup reported the index missing on EVERY run, which is how a check
stops being read; and behaviour is the stronger proof anyway, because an index
present but not enforcing reads as fine to a name lookup.

### What the judge refuses to do

**It will not judge an incomplete run.** Three driver files out of four, or a
sampler that stopped after two minutes, is computable and every rate looks
plausible: the p95 of a short run is lower and the confirmed-per-minute of a
missing driver is a quarter down, and nothing in the numbers says which. So
`incomplete` is its own verdict on its own exit code and **nothing is measured at
all** (L288). A burst driver that missed its moment counts as incomplete too: it
recorded nothing, so "exactly one 200" would be answered by however many drivers
happened to arrive.

### The bars

| bar | what it is |
|---|---|
| confirmed a minute | at or above 80 percent of target, with the full outcome mix printed so a short run says WHY |
| latency | p50, p95 and max over ALL responses, and the p95 of the **200s** under 5,000ms |
| 5xx and no reply | counted **separately** and both fail: a request answered badly and one never answered send two different people to two different places |
| double bookings | no two run-scoped ACTIVE bookings overlap on one agent in `[starts_at, ends_at)`, read through a **paginating** list, and the preflight must have seen `bookings_active_slot_uniq` actually REFUSE a planted duplicate (without that, an absence of overlaps proves nothing) |
| every 200 left a row | a booking row carrying the request's external id, an idempotency key, and a `busy_blocks` row |
| the burst | exactly **one** 200 against the one agent pool, every other answer `SLOT_TAKEN`, and the winner really exists |
| freshness | the worst oldest-bucket age across the window under 6 minutes |
| the per address ceiling | its own step sends 61 writes from one address in one window and requires the 61st refused |
| platform | CPU p99 under the lane budget, and **no invocation outcome other than `ok`** |
| the fault pass | at `SLATE_LOADTEST_FAULT_PCT=10`, zero 5xx, and a pass that made no requests fails rather than passing on an empty sample |

**Subrequests are deliberately not a bar**, and that is a decision rather than an
omission. Cloudflare's observability exposes **no subrequest counter**
(`docs/cloudflare-platform-notes.md`), so the bar could never be measured and the
judge would be permanently unable to conclude, which is the shape #2240's first
cal.com probe shipped in. The BREACH is measurable and arrives as a non-`ok`
invocation outcome, so that is what is judged.

**The platform half has a control.** The analytics API's invocation count is
compared against the number of requests the run itself made, and a count far under
it is reported as `unmeasured` on its own exit code rather than as a pass: the
pipeline has been measured **three hours behind** (#1533), and a low CPU reading
from a lagging pipeline looks exactly like a cheap run. Its `cpuTime` is in
**microseconds**.

### The report outlives the branch

The judge writes ONE dated report and uploads it `if: always()`. Teardown `needs`
the judge, so it cannot race the read; it deletes the deployment and then
**confirms the listing is empty**, because a zero exit from `wrangler delete` is
not the same as the deployment being gone. That confirmation checks the listing's
own exit status before its content: piping straight into `grep` reports the
parser's status, so a listing that failed matches nothing and the step prints "no
deployment remains" (L183).

### One hand-off before the first run

The workflow references seven repo settings that do not exist yet, and
`pnpm check:workflow-settings` names them with the command to create each. They
cannot be created until the isolated Supabase branch and the `loadtest` Cloudflare
environment exist. Nothing can be dispatched into a misconfigured state in the
meantime: **every script the workflow runs refuses an empty value by name** rather
than reading it with a `??` fallback that an empty string would slip past (#1498).

## Backstop retention decision (#440: retire #401 / #428 only if fully subsumed)
**Decision: keep both `#401` and `#428` running. Neither is subsumed by the outbox.**

- **`#401` `pending_event_deletions`** is not a redundant backstop, it is the durable-retry
  primitive the outbox's own `cancel:gcal_delete` step delegates to. That step calls
  `deleteEventBestEffort`, which on a failed Google delete enqueues into
  `pending_event_deletions` and returns success. Retiring `#401` would strand every
  calendar delete that fails on the first try.
- **`#428` `reconcileCancelledBusyBlocks`** covers windows the outbox structurally cannot:
  orphan `slate` busy_blocks with a `null` booking_id (the outbox deletes strictly by
  booking_id), any cancel that never produced an outbox row (legacy rows), and any outbox
  row given up past its retry cap. The soak's "no cancelled booking keeps a slate
  busy_block" invariant deliberately relies on both lanes together.

Revisit only if a future change routes 100% of cancels through the outbox AND the outbox
is shown to be the cheaper mechanism for the orphan/legacy windows.

## What this harness does and does not cover (honest scope)
- **Covers, at 200-agent scale, against the real DB:** outbox-drain lane-starvation vs the
  sync tail, self-heal of cancel-path crashes at every mid-sequence point, and exactly-once
  webhooks under the concurrent drain (the migration-`0046` unique index).
- **Not driven here (covered by the node-native unit suite instead):** the create/reservation
  drain and reschedule move, which need real Google create/patch calls. Their crash-resume
  and exactly-once behaviour is proven deterministically by `scripts/test-booking-orchestration.ts`,
  `scripts/test-create-resume-reservation.ts`, and `scripts/test-booking-outbox.ts`. Seeding
  the cancel path (whose Google step is pre-marked done) exercises the same shared drain
  executor and dedupe index without needing a Google write stub.

## The fault-injection variant (#1050)

The stub always succeeded, so a soak proved the lanes work when Google works, which was
never the half in doubt. Degrading gracefully is what the sync coalescer, the
reachability classifier, the failure-streak alerting and the verify-on-book re-route all
exist for, and none of them had been exercised at scale.

Add `SLATE_LOADTEST_FAULT_PCT=<0..100>` to the same run to fail that percentage of
calendar reads:

<!-- runbook-reference: the fragment is one env var added to the seeded soak command
     above; it is not a command to run on its own. The injector's own behaviour (the
     three failure shapes, determinism, the percentage tracking the setting, and that all
     three stubbed reads really throw when it is set) is driven in a real process by
     scripts/test-loadtest-fault-injection.ts. -->

```
SLATE_LOADTEST=true SLATE_LOADTEST_FAULT_PCT=20 ...
```

It is **deterministic**, not random, and that is the point. A random rate makes a soak
irreproducible: a run that passed and a run that failed differ by the dice. The verdict
is a hash of each call's own key, so the same agent fails on every pass. That also
matters for what is under test, because the streak alerting fires on CONSECUTIVE
failures for one agent, which a per-call coin flip would rarely produce.

Each fault is one of the three shapes the reachability classifier distinguishes (a 503,
a timeout, and a `403 notACalendarUser`), chosen by the key, so a run exercises every
branch rather than the transient one repeatedly. Every message is marked
`(loadtest fault)`, so an injected failure is never mistaken for a real Google one while
reading the results.

What to look for in a faulted run: the failing agents are named in a throttled Slack
alert rather than one per failure; a `notACalendarUser` agent is treated as definitively
failing rather than retried every minute; the booker still offers times from agents who
are fine; and no lane's heartbeat goes stale, because a Google failure must not stop a
lane running.

**Not covered, and deliberately not built here:** a concurrent request-level burst
(parallel availability reads plus simultaneous same-slot confirms). It needs a target
that is not production, and there is not one (ADR 0007 records why there is no staging
environment). The honest prerequisite is a Supabase branch plus a second Worker
environment, which is the same reversal that ADR names; building the script first would
leave a load test nobody has ever run, which is worse than not having it.

## Teardown
Delete the branch DB. The `SLATE_LOADTEST` flag is inert anywhere it isn't set, so no
production cleanup is needed.
