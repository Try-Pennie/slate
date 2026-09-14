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

`MODE=burst` with `START_AT` (epoch ms), `BURST_SLOT` and `BURST_CODE_OVERRIDE`,
all chosen **once** by the setup step (`scripts/loadtest/burst-setup.ts`) and
handed to every driver, because a burst whose drivers each chose their own time is
not a burst: nothing contends and everything succeeds. The code is passed through
rather than re-derived in the driver, so the two cannot fire at different pools
while each reads as correct (L70).

**The pool is MEASURED, not a constant** (#2278). The whole control rests on the
burst's pool being one agent deep, and for months that was a hand written code
nothing checked: the seeded roster gave it three, so a live run answered three
200s on three different agents, which is correct behaviour and a materially weaker
control. It rotted too, and did, when production's Low plus Beyond pool emptied
(#2152) and the constant had to be moved by hand the morning of the next run
(#2319). The setup now reads every pool's depth through the booker's own predicate
(`poolDepthsFrom`, shared with `pnpm loadtest:export-shape` so the two cannot
disagree about one roster), asks the shallowest six what they are offering, and
fires at the first that offers anything. Depth alone cannot choose: a pool one
agent deep whose agent has no free time offers nothing.

**It never fails on depth**, and that is deliberate. The judge asks for one winner
per AGENT (#2273), which holds at any depth, so a run red because the roster has
no one deep pool would be red for a property of the roster, which is how a check
stops being read (L36). What it DOES do is report the depth it ran at, so a reader
knows what the control was worth. A depth it could not measure exits on its own
code rather than guessing, and a hand run that names the code with
`BURST_CODE_OVERRIDE` is reported as **unmeasured** rather than as one deep.

**It runs BEFORE the steady pass, and alone** (#2262). That is a decision rather
than an ordering accident: the steady mix can include whichever code the burst
picked, so a steady driver that happened to take the burst's slot first would make
every burst request `SLOT_TAKEN`, and the winner bar would fail for a reason that
has nothing to do with the unique index it exists to test. Twenty five
simultaneous requests on one slot is the contention being measured either way.

The setup step picks the **last** offered time rather than the first, for the same
class of reason: the preflight books the first time ITS bucket offers, minutes
earlier, and the two buckets can share an agent. It sorts before taking the last,
because a list read out of a response carries no order unless something declares
one (L343). A bucket offering nothing exits on its own code and says so, since an
empty burst file and a run with no burst leg are otherwise the same thing (L98).
Four refusals, each its own code: `2` availability answered for none of the
candidates (the deployment), `3` they answered and none offered a usable time (the
seed), `4` the pools could not be measured at all, `5` not one pool has an agent
in it.

It also emits the DRIVER COUNT, from the app's own `DRIVERS` constant, and both the
matrix size and the judge's expectation read it from there. Two places holding one
number is how a matrix grows to five while the judge goes on expecting four and
calls every run incomplete.

`burst_lead_seconds` (default 300) is how long the burst drivers have to be queued,
checked out and installed before the shared moment. A driver that wakes late fires
nothing, and the judge calls the run incomplete: raise the lead rather than
re-running and hoping.

It runs against `122`, a real code real leads arrive on, whose pool is exactly one
agent deep. The control is **exactly one 200 and the rest SLOT_TAKEN**, which is
`bookings_active_slot_uniq` doing its job.

A driver that wakes up **late exits without firing** and says so, in the file and on
a non-zero exit. A late request meets an already taken slot and records a SLOT_TAKEN
indistinguishable from the contention the control is counting, so the judge would be
handed a staggered burst wearing a simultaneous one's clothes.

## The isolated deployment the run drives (#2242)

There is no staging environment (ADR 0007), so the run gets one for its own
duration: a throwaway Supabase branch and a SECOND Cloudflare Worker,
`env.loadtest` in `wrangler.jsonc`, deployed and torn down by the workflow.

### Everything about it is inheritance, and inheritance is silent both ways

Wrangler splits its keys in two and a reader of the file cannot tell which is
which, so both halves are written out explicitly and
`scripts/test-wrangler-loadtest-env.ts` asserts the RESOLVED config rather than
the text:

- `routes`, `triggers`, `workers_dev`, `preview_urls` and `limits` **inherit**.
  Omitting `routes` does not mean no route, it means this environment claims
  `slate.trypennie.app`, and wrangler says so in its own words: "Deploying this
  environment will reassign these custom domains away from the top-level Worker."
  `routes: []` detaches it and `workers_dev: true` is what then gives it an
  address at all, since the top level turned workers.dev off in #1052.
- `vars`, `ratelimits` and `durable_objects` **do not inherit**, and an
  environment that omits them resolves them EMPTY. That is not a smaller
  configuration, it is a broken one: a missing limiter binding fails OPEN in
  `src/lib/rate-limit.ts`, so the run would measure a deployment with no ceilings
  while the judge attributed its 429s to ceilings that were never there.

The namespace ids are 2001 to 2007 rather than production's 1001 to 1007, because
a namespace id is ACCOUNT scoped: sharing one would have the run's sixty writes a
minute counting against the ceiling real leads are judged by.

### The database address is a BUILD input, not a var

`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and
`NEXT_PUBLIC_APP_URL` are inlined at build time (`src/lib/env.ts` reads each by its
literal name for exactly that reason), so they go into the environment of the
build that produces this Worker rather than into `wrangler.jsonc`. A committed var
naming a branch would be a lie the day after that branch was thrown away, and the
guard fails one. `NEXT_PUBLIC_APP_URL` also namespaces the L1 caches
(`slot-cache.ts` and `eligible-cache.ts` key on `appUrl()`), so the load run's
cached slots can never be served from the same key space as production's.

```
NEXT_PUBLIC_SUPABASE_URL=https://<branch-ref>.supabase.co \
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<branch publishable key> \
NEXT_PUBLIC_APP_URL=https://slate-loadtest.<subdomain>.workers.dev \
pnpm cf:build && npx wrangler deploy --env loadtest
```

### Two refusals, and neither answers for the other

- **the database**, in `publicSupabaseUrl()` (`src/lib/env.ts`): under
  `SLATE_LOADTEST`, a build pointed at the production project ref throws, and so
  does one whose address cannot be read at all. That is the one place every
  Supabase client takes its address from, so it reaches every request and every
  cron tick that would touch data. It is NOT in the Worker entry, where a reader
  looks first, because the inlining above is what makes the value readable and
  wrangler's esbuild pass does none: a guard there would read `undefined` in both
  modes and could only ever stay silent.
- **the address**, in `worker/index.ts`: under `SLATE_LOADTEST`, a Worker
  answering on `slate.trypennie.app` refuses every request with a 503. `routes: []`
  is what should make that unreachable; this is what happens when somebody deploys
  a load test build over production by hand.

The production project ref is ONE constant (`PRODUCTION_SUPABASE_REF` in
`src/lib/loadtest-guard.ts`), shared with the seed, the change path seed, the
preflight and the judge. `/api/smoke/version` reports `loadtest` from the same
predicate the stubs key on, and the preflight reads it before it writes anything.

### Its secrets are its own, and most of them should stay unset

Cloudflare secrets are per environment (`wrangler secret put --env loadtest`), so
a fresh load test deployment starts with NONE of production's. Do not copy them
across wholesale. It needs `SUPABASE_SECRET_KEY` (the branch's), `CRON_SECRET` and
`BOOKING_API_KEY`, and that is the list.

`SLACK_BOT_TOKEN` in particular must stay unset. The lanes that page Slack are
held back below, but the kept ones still alert (`sync` alerts on calendar failures,
and the fault pass makes ninety stubbed agents fail on purpose), and the notifier
no-ops only because `slackBotToken()` is empty. Setting it would page the real
channel about a synthetic roster for ten minutes.

### Which lanes run, and which are held back

The cron triggers are inherited **deliberately**: the run measures recompute
freshness and the outbox drain UNDER the booking load, so those lanes have to be
live. `SLATE_LANES_DISABLED` (honoured in `worker/index.ts` through
`worker/lanes-disabled.ts`) holds back the ones that reach a system the isolated
branch does not have and `SLATE_LOADTEST` does not stub. A name in that list that
matches no lane refuses the WHOLE tick, rather than letting the lane somebody
meant to hold back run unannounced.

| lane | on this deployment | why |
|---|---|---|
| `sync` | runs, Google stubbed | the backstop the freshness sample depends on |
| `recompute` | runs | what the freshness sampler measures |
| `outbox` | runs, webhook POST short circuited | the drain the run is judging |
| `selfheal` | runs, Google stubbed | the reconcile sweeps behind the no-double-booking bar |
| `complete` | runs | the sweep that closes a finished booking |
| `watch` | runs, Google stubbed | renewals are part of the sync lane's cost |
| `hydrate-calendars` | runs, Google stubbed | the seeded calendars need hydrating to the horizon |
| `prune-routing` | runs | deletes only this branch's own rows |
| `prune-webhook-payloads` | runs | deletes only this branch's own rows |
| `prune-busy-blocks` | runs | deletes only this branch's own rows |
| `agents` | **held back** | reads Salesforce and would rewrite the roster the seed just built |
| `bulk-reassign` | **held back** | makes real Google reassignments |
| `monitor` | **held back** | pages Slack about a synthetic org |
| `erasure-audit` | **held back** | pages Slack, and reads a warehouse the branch has no rows in |
| `ooo-digest` | **held back** | sends real email to real managers |
| `ooo-approvals` | **held back** | emails salesmanagers@trypennie.com |
| `snowflake-export` | **held back** | writes the real warehouse |
| `snowflake-reconcile` | **held back** | pages Slack on drift it would itself create |
| `prune-bookings-pii` | **held back** | gates on an export that never ran, and redacts against a mirror that is not there |
| `prune-warehouse-pii` | **held back** | writes the real warehouse |

A lane added later is covered by construction: the known set is derived from
`CRON_ROUTES` rather than listed beside it, so a new lane is either in the disable
list or it runs, and the guard names it either way.

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
| the burst | one winner **per agent** (#2273), every other answer `SLOT_TAKEN`, and each winner really exists. A leg that was configured and produced fewer driver files than fired is **incomplete**, never a skipped bar. The report states the measured depth the control ran at, since one deep and three deep prove different amounts (#2278) |
| freshness | the worst oldest-bucket age across the window under 6 minutes |
| the per address ceiling | its own step aims at a time the deployment is OFFERING, sends three times the ceiling from one address inside one window, and requires SOME refusal. It also reads back the address the deployment keyed on: unidentified, several, or unechoed each get their own conclusion, because all three used to render as "the ceiling is not applying" |
| platform | CPU p99 under the REQUEST budget (`REQUEST_CPU_P99_MS`, half the latency bar, and applied only to a window with no cron in it), the cron half under `limits.cpu_ms`, and **no invocation outcome other than `ok`**. It used to borrow the 200ms LANE budget, which is a different question about a scheduled tick (#2321) |
| the fault pass | at `SLATE_LOADTEST_FAULT_PCT=10`, zero 5xx, and a pass that made no requests fails rather than passing on an empty sample. A pass whose deployment reported a DIFFERENT percentage is incomplete, and zero is the case that matters: it passes the bar having injected nothing |

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

The workflow references eight repo settings that do not exist yet, and
`pnpm check:workflow-settings` names them with the command to create each. They
cannot be created until the isolated Supabase branch and the `loadtest` Cloudflare
environment exist. Nothing can be dispatched into a misconfigured state in the
meantime: **every script the workflow runs refuses an empty value by name** rather
than reading it with a `??` fallback that an empty string would slip past (#1498).

## The first run, and the six things it found (#2261)

Dispatched 2026-09-11 against a throwaway Supabase branch and the `loadtest`
Worker. It took **six attempts to get a run the judge could score**, and every
failure in between was a real defect in machinery that had shipped green. That is
the point worth keeping: a workflow nothing has ever run is a workflow nothing has
ever checked, and none of these was visible to a test.

| # | what stopped it | where |
|---|---|---|
| 1 | ten `pnpm/action-setup` steps with no `version:`, so every job died in setup | the workflow |
| 2 | the seed read `supabase_migrations` over REST, which answers 406 on every project | the seed |
| 3 | every reader declared `slots` as `{ start }` objects and it is a list of ISO strings, so all three saw an empty list on a healthy response | the driver, the preflight, the burst setup |
| 4 | every driver sent one phone number, and the dedupe gate is a PERSON gate | the driver |
| 5 | the fault leg asked whether its own redeploy had landed two seconds after deploying | the fault leg |
| 6 | the commit comparison was equality against a sha the stamper deliberately shortens | the fault leg |

Two more were found by a run that COMPLETED, which is the harder kind to see: the
judge skipped the fault bar entirely when the analytics window was unreadable
(that section returns early and the fault bar sat below it), and all three legs
minted the same external ids, so the burst's winners and the fault pass were
answered by RESCHEDULING the steady pass's bookings. Neither showed as an error
anywhere, because a reschedule is a 200.

### What the run measured, once it could

Run 34658545203, 2026-09-11, 90 seeded agents across five zones:

- **600 attempts, 589 confirmed**, 58.9 a minute against a target of 60
- **zero 5xx and zero unanswered requests**
- p50 1,099ms, p95 2,280ms, max 5,594ms
- 4 refusals from the per address ceiling, from two addresses, which is the
  ceiling doing its job on a runner behind egress NAT
- worst oldest-bucket age **255s**, under the 6 minute bar, sampled once a minute
  UNDER the load
- the burst: 100 simultaneous requests at one slot, **3 answered 200 and 97
  SLOT_TAKEN**, the three on three different agents
- the fault pass: **30 of 30 created with zero 5xx** while Google failed ten
  percent of its calendar reads, which is the booking path degrading rather than
  erroring

### And one real defect in the product

Three pairs of **confirmed, overlapping bookings on one agent** (#2274), each
pair created about 200ms apart by two different leads. The event type is 20
minutes on a 10 minute grid, so adjacent offered times overlap by ten, and
`bookings_active_slot_uniq` is unique on `(assigned_user_id, starts_at)`: two
different starts are two different rows to it. Verify-on-book is blind in the
same window, since neither confirm has the other's busy row yet.

**This is what the run was built to find.** It needs no unusual traffic, only two
leads picking adjacent times in the same moment, and no suite had ever confirmed
two bookings concurrently.

### The bar that took two passes to be able to conclude (#2275)

Read this before reading a ceiling finding, because every wrong turn it names was
taken once.

The DRY RUN is not the problem, though both the issue and the 2026-09-14 run
record say it is. `authorizeBookingApi` is the first statement of the POST
handler and both ceilings live inside it, well above the `if (v.dryRun)` branch,
so a dry run is metered exactly like a real write. The 409s prove it: a request
the limiter had refused would never have reached the application at all.

Two real defects, fixed in the second pass:

- **The request shape could never be allowed.** It aimed at a hardcoded code with
  a start SEVEN days out against a four day booking horizon, so the application
  refused all 180 before the ceiling's answer could be read. It now reads
  `/api/availability` for the hottest codes in the measured mix, aims at a time
  the deployment is actually offering, rotates through every offered time (the
  steady pass is booking against the same roster), and REFUSES by name when no
  code offers anything, rather than sending into a guaranteed refusal.
- **It assumed the premise it rests on.** "N writes from ONE address" was never
  measured, and three different things make it false: an address the deployment
  cannot read is served UNJUDGED by the per address ceiling (#1557) so it can
  never refuse, a runner behind an egress NAT pool spreads the writes over
  several counters, and a deployment echoing nothing leaves the premise
  unmeasured. Each has its own conclusion now. The `x-loadtest-seen-ip` echo
  (#2243) already carried the answer and nothing read it.

So a ceiling finding names one of: the ceiling really is not applying, the
control had nothing to aim at, the app refused everything, the key was rejected,
the caller could not be identified, several addresses were counted, or the
address was never echoed. Only the first is about the ceiling.

The platform half is reported `unmeasured` on every run so far: the analytics API
returns no rows for a window minutes old, which is the lag this repo already
documents (#1533). That is the judge's control working as designed, not a pass.

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

### The booking run's fault leg (#2262)

The booking path run has a fault leg of its own, and it is the only one that says
whether that path DEGRADES rather than 5xxing. Three things about it are worth
knowing before changing it.

**It redeploys, and it has to.** `SLATE_LOADTEST_FAULT_PCT` is read once per isolate
from the deployment's own variables, so there is no way to fault one leg of a run
without faulting the deployment. Overlapping it with the steady pass would make that
pass's own "no 5xx" bar a measurement of the faults this run injected on purpose, so
the leg runs LAST and ALONE. `wrangler deploy --env loadtest --var` MERGES with the
vars block rather than replacing it, so the load test flag, the disabled lanes and
everything else in `env.loadtest` survive that deploy.

**The percentage is MEASURED, never assumed.** A deployment that never received the
setting fails no reads at all: it answers every request perfectly and satisfies the
bar with no fault having happened, which is indistinguishable from a path that
degraded beautifully (L98). So `/api/smoke/version` reports `faultPct` from the same
constant the stub injects from (#2262, L70), and the driver asks the deployment for
it, AND for the commit this leg just deployed, and refuses before sending a single
request when either is not what was asked for. The number the judge sees is the one
the deployment reported, never the one the job intended.

**A faulted deployment is put back, and the preflight checks anyway.** The restore
runs `if: always()` with no `--var`, so it ships exactly the vars block; a run
dispatched with `teardown: false` would otherwise leave the deployment injecting
faults and the NEXT run's steady pass would count them as the path's own 5xx. The
preflight also refuses a deployment already reporting a fault percentage, so a
restore that itself failed is caught at the top of the next run rather than
inherited silently. Two guards, and each is blind where the other looks.

**What it does NOT cover**, said here rather than left to be assumed: the leg faults
the whole deployment, so the cron lanes are faulted too, but nothing about their
behaviour is JUDGED. The bar is the booking path's 5xx count. The lane-level
expectations in the section above (a throttled alert naming the failing agents,
`notACalendarUser` treated as definitive, no lane heartbeat going stale) are read by
a person from the archived log tail; no check scores them.

**Not covered, and deliberately not built here:** a failing calendar WRITE at scale.
The confirm path's writes are never faulted on purpose (`src/lib/google/loadtest-stub.ts`
says why): a failed write there is a 500 by design, so injecting one would make the
run's 5xx count a measurement of the percentage rather than of the code, and the bar
would be unreachable for a reason nobody should fix.

## Teardown
Delete the branch DB. The `SLATE_LOADTEST` flag is inert anywhere it isn't set, so no
production cleanup is needed.
