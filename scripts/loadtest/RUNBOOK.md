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

1. **Create a branch DB** (Supabase dashboard, Branches, or CLI). Note its project URL
   and its **publishable** key: a branch created through the connector exposes no
   secret key at all, which is why step 2b exists. A branch is a paid resource for as
   long as it exists, so name it `loadtest-<issue>` and hand that name to the
   workflow's `branch_name` input, which is what deletes it at teardown (#2322).

2. **Apply the schema to the branch**: run the repo migrations against it
   (`supabase db push` with the branch linked, or apply `supabase/migrations/*` in order).

2b. **Run the two grants** the publishable key makes necessary (row security off,
   and execute on the functions). They are ONLY ever run against a throwaway, and the
   reason for each is in "A fresh branch has no secret key" below. Skipping them costs
   the first hour of a run: every read answers nothing and the seed dies on its own
   migration check with `42501`.

3. **Seed it** (points at the branch, not prod):
   ```
   SUPABASE_URL=https://<branch-ref>.supabase.co \
   SUPABASE_SECRET_KEY=<branch secret key> \
   node --experimental-strip-types scripts/loadtest/seed.ts
   ```
   Tunables: `BLOCKS_PER_DAY=12`, `CALS_PER_AGENT=1`, and `ROSTER_SHAPE_FILE` to point
   at a fresher export from `pnpm loadtest:export-shape`.

   **The roster SIZE comes from the shape, not from you** (#2320). `AGENTS` used to
   default to 200 while the shape carried the measured count (90 baked in, 94 on the
   2026-09-14 export), and the seed printed the shape's count in its own log line
   before ignoring it: the first branch for the #2284 re-run came up 200 deep against
   production's 94, with pool depths roughly double the real ones, and had to be
   thrown away and re-created. It fails GREEN, which is why it is now a refusal
   rather than a matter of care (L354). Setting `AGENTS` to something the shape does
   not say is REFUSED, because the shape's pool depths are what the seeded output is
   checked against and a different total makes that check meaningless. A deliberate
   experiment sets `ALLOW_AGENT_COUNT_MISMATCH=1`, and the seed then says out loud
   that it is building a roster the shape does not describe.

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

## The peak the 60 a minute bar rests on (#3124)

The booking path run's bar is **60 confirmed bookings a minute for ten minutes**,
set on 2026-09-11 in the plan on #2240 beside a measured busiest minute of 6, so it
sits ten times over the peak measured then. That premise has to be re-checkable, because it is the whole reason 60 is the
number. What was measured, from the plan's own comment on #2240: routed cal.com
form responses ran **450 to 1,013 a day** over the ten days before, and the
**busiest minute in 30 days held 6**. Those came from cal.com, since Slate took no
real bookings then.

Slate's own traffic answers the same question now. This query reads the last 30 days
of real routed bookings (test buckets excluded, the same `is_test` the canary
isolation uses, and agent link bookings excluded by `kind = 'routed'`, since they do
not route, migration 0144) and reports the busiest minute, when it was, the busiest day, and how many
times over that minute the bar sits:

<!-- runbook-unverified: read only; not run against production from the change that added it, because that change runs no SQL against the live database. Its shape is pinned offline by scripts/test-capacity-peak-sql.ts: it holds no write, names only columns the bookings and buckets row types declare, excludes test buckets, keeps to routed bookings, and reads a 30 day window. -->
```sql
-- Busiest minute and day of real bookings, last 30 days. Read only.
with real_bookings as (
  select b.created_at
  from bookings b
  join buckets k on k.id = b.bucket_id
  where not k.is_test
    and b.kind = 'routed'
    and b.created_at >= now() - interval '30 days'
),
per_minute as (
  select date_trunc('minute', created_at) as minute, count(*) as bookings
  from real_bookings
  group by 1
),
per_day as (
  select date_trunc('day', created_at) as day, count(*) as bookings
  from real_bookings
  group by 1
)
select
  (select count(*) from real_bookings) as bookings_30d,
  (select max(bookings) from per_day) as busiest_day,
  (select max(bookings) from per_minute) as busiest_minute,
  (select minute from per_minute order by bookings desc, minute desc limit 1) as busiest_minute_at,
  round(60.0 / nullif((select max(bookings) from per_minute), 0), 1) as bar_over_peak;
```

Two things to know before reading the answer:

- **Before cutover it counts only the pilot's share.** Slate carries the leads the
  Salesforce pilot switch sends it (ADR 0009), so its busiest minute is a floor on
  the real one, not the real one. Scale by the share Slate carries, or read cal.com's
  routing form responses as the 2026-09-11 figure did, until cutover (#65) makes this
  the whole of it.
- **It counts bookings, not attempts.** A refused or failed attempt writes no
  bookings row, so a minute of heavy refusals reads as quiet here. The booking API's
  attempt tallies (`booking_api_outcome_daily`) are daily, so they cannot answer a per
  minute question.

`bar_over_peak` under ten means the premise no longer holds and the run's bar should
be raised before the next one is dispatched. The run itself was measured at 90
seeded agents (run 34658545203, 2026-09-11) against a design target of 100 to 200;
running the booking leg at 200 is tracked on #3124 and has not been done.

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
ceiling somebody changed. That ceiling is APPROXIMATE (#2339), so sitting on it is
a statement about what the drivers are asking for rather than a prediction that
they will be refused at it; what the run's 429s are attributed against is the
ceiling control's own step below.

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

**Build in a tree with no `.env` files**, which the next section is about. The
worktree you build in must not hold a copy of `.env.local`, whatever it was put
there for; `pnpm cf:build` refuses one now, and the refusal names what it found.

```
NEXT_PUBLIC_SUPABASE_URL=https://<branch-ref>.supabase.co \
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<branch publishable key> \
NEXT_PUBLIC_APP_URL=https://slate-loadtest.<subdomain>.workers.dev \
pnpm cf:build && npx wrangler deploy --env loadtest
```

### Three refusals, and no one of them answers for the others

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

- **the credentials**, in `worker/index.ts` (#2335): under `SLATE_LOADTEST`, a
  deployment holding any of production's own settings refuses every request with a
  503 and every cron tick before a lane runs, naming them. This is the one the
  other two cannot see. A build that baked production's `.env.local` into its
  bundle is pointed at the right branch and answering on the right address, so
  both of the refusals above stay correctly silent while it holds a live Slack
  token. It is in the ENTRY, and each of the three reasons is load bearing: only
  the entry sees BOTH sources (a value baked into the bundle and one set on the
  environment by hand, and neither answers for the other), it sees them on the
  FIRST request (anything reading `process.env` in front of the generated handler
  is empty until that handler has populated it once), and it is never bundled for
  the browser. That last one is not a nicety. The first version of this refusal
  lived in `publicSupabaseUrl()`, and measured against a real build all twenty
  three names shipped in a public `_next/static` chunk, because `supabaseAdmin`'s
  module graph is pulled into client chunks; a guard against leaking credentials
  must not publish the inventory of them. `scripts/check-bundle-env.ts` re-measures
  that after every build rather than trusting the comment.

  The list is `PRODUCTION_ONLY_SECRETS` in `src/lib/loadtest-secrets.ts`, which is
  `DEPLOY.md`'s own `wrangler secret put` inventory minus the three this
  environment holds; `scripts/test-loadtest-secret-inventory.ts` fails the build
  when a secret is added to the runbook and left unclassified, so a name can never
  be quietly exempt from the guard written to catch it. `/api/smoke/version` is the
  ONE path a contaminated deployment still answers, because it is how the run
  learns what is wrong: it is key authed, reads no data and calls nothing out, and
  refusing it would leave the preflight reporting a 503 about the one request that
  could have named the settings instead.

The production project ref is ONE constant (`PRODUCTION_SUPABASE_REF` in
`src/lib/loadtest-guard.ts`), shared with the seed, the change path seed, the
preflight and the judge. `/api/smoke/version` reports `loadtest` from the same
predicate the stubs key on, and the preflight reads it before it writes anything.
It reports `productionSecrets` from the same place, which is how the preflight
refuses a contaminated deployment by name rather than through whatever the first
broken read happens to be. That field exists ONLY under the flag: production holds
every one of those settings by design, and listing which ones it has on a
reachable endpoint would be a configuration leak wearing a safety check's clothes.

### Its secrets are its own, and the BUILD can hand it production's (#2335)

Cloudflare secrets are per environment (`wrangler secret put --env loadtest`), so
a fresh load test deployment starts with NONE of production's. Do not copy them
across wholesale. It needs `SUPABASE_SECRET_KEY`, `CRON_SECRET` and
`BOOKING_API_KEY_CANARY`, and that is the list (`LOADTEST_ALLOWED_SECRETS` in
`src/lib/loadtest-secrets.ts`). The booking key goes in the CANARY slot: the
preflight asks `/api/smoke/version` whether the deployment is in load test mode,
and that endpoint accepts the canary's key and nothing else (#2854), so a
deployment holding the key under any other name answers 503 and the run refuses
before writing anything. There is no shared `BOOKING_API_KEY` any more (#2865). The drivers
still read the value from their own `BOOKING_API_KEY` variable, fed from the
`LOADTEST_BOOKING_API_KEY` repo secret; the Worker's per caller ceilings are the
same for every caller, so which slot holds it changes nothing the run measures. **What goes in `SUPABASE_SECRET_KEY` is
not a secret key**, and the next section is why.

**The secrets are not the only way a credential arrives, and the other way has no
prompt and no record.** `@opennextjs/cloudflare`'s build step reads `.env`,
`.env.<mode>`, `.env.local` and `.env.<mode>.local` out of the build tree and
writes their values into `.open-next/cloudflare/next-env.mjs`, which ships INSIDE
the bundle. At runtime `populateProcessEnv` applies the Worker's own bindings
first and then fills in every name they did not set (`process.env[key] ??= ...`).
So a build run in a tree holding a copy of `.env.local` deploys production's
credentials to whatever environment it is deployed to, and `env.loadtest` sets
only three bindings, so every other name applies.

That is not hypothetical. On 2026-09-14 the second re-run of #2284 was built in a
worktree holding such a copy; the Worker came up with production's
`SLACK_BOT_TOKEN`, `SLACK_ALERTS_CHANNEL`, `GOOGLE_SA_PRIVATE_KEY`,
`SF_CLIENT_SECRET` and twenty others, and the `sync` lane paged the real alerts
channel for six minutes about `loadtest-agent-0@loadtest.local`. The run was
killed and produced no verdict. Until then the rule was a sentence in this file
saying `SLACK_BOT_TOKEN` must stay unset, which nothing enforced (L27, L407), and
the notifier no-opped only because the token happened to be empty.

Three guards now, and each is blind where the others look:

- **the build refuses to ship them.** `pnpm cf:build` runs
  `scripts/check-bundle-env.ts` after the build, which reads
  `.open-next/cloudflare/next-env.mjs` and fails on any name that is not
  `NEXT_PUBLIC_*`, naming the offenders and the `.env` file they came from, and
  never their values. It is on `cf:build` rather than on a deploy step because
  wrangler has no predeploy hook, so the build is the last place ONE check can
  stand in front of every deploy: this one, the fault leg's redeploy, CI's and the
  pre-push gate's. A tree with no `.env` files produces three empty objects and
  passes, which is what CI and the gate's isolated checkout both do.
  `ALLOW_ENV_IN_BUNDLE=1` gets a local build through a contaminated tree and says
  loudly that the result must not be deployed. Never use it for a build you are
  about to deploy. The same step also scans the CLIENT assets for any of those
  names, which is a different question: a value baked into the bundle is a
  credential, a name in a browser chunk is the inventory of what Slate integrates
  with, and only a real build can say which bundle a module landed in.
- **the deployment refuses to serve.** The credentials refusal two sections up,
  in the Worker entry. It catches what the build check cannot: a credential that
  arrived some other way, a `wrangler secret put` somebody ran by hand, or a
  bundle built somewhere the check never ran.
- **the clients refuse to call.** Under `SLATE_LOADTEST` the Slack notifier
  (`src/lib/notify/slack.ts`), Salesforce (`fetchSfWithRetry`), Twilio
  (`fetchTwilioWorkers`) and cal.com (`calcomFetch`) refuse by the FLAG rather
  than by an absent credential, through `refuseUnderLoadtest`
  (`src/lib/loadtest-guard.ts`). Slack no-ops, because every caller is fire and
  forget; the other three throw, because a roster read that quietly returned
  nothing is indistinguishable from an empty Salesforce and the sync would write
  that emptiness back over the roster the seed just built. Both directions are
  driven offline by `scripts/test-loadtest-external-refusals.ts`: a client that
  could not reach anything at all would satisfy a one sided test.

The lanes that page Slack are held back below, but the kept ones still alert
(`sync` alerts on calendar failures, and the fault pass makes ninety stubbed
agents fail on purpose), which is why the refusal is in the notifier itself rather
than in the lane list.

### A fresh branch has no secret key, so two grants have to be run by hand (#2324)

This section exists because the two steps below are needed on EVERY run, are in
nobody's head after the first one, and were rediscovered from scratch on
2026-09-14 after the July soak had already met them. **Both are only ever run
against a throwaway branch.** Disabling row security anywhere else is the exact
opposite of what the same words mean in production, so if you find yourself
running either against a database you did not create an hour ago, stop.

**A Supabase branch created through the connector exposes only a PUBLISHABLE key.**
There is no secret key to hand the Worker without a management token, so the run
does what the July soak did: it puts the branch's publishable key in
`SUPABASE_SECRET_KEY`. That key authenticates as the `anon` role rather than
`service_role`, and everything below follows from that one substitution.

**1. Row security.** `supabaseAdmin` normally bypasses RLS because it holds a
secret key; on `anon` it does not, and Slate's RLS is default deny (the only
client readable row is a user reading itself). So every read the run makes
answers nothing, which is indistinguishable from an empty branch. Disable it on
the throwaway, generated from the catalogue rather than typed as a list, so a
table added later is covered without anybody remembering:

```sql
do $$ declare t record; begin for t in select tablename from pg_tables where schemaname = 'public' loop execute format('alter table public.%I disable row level security', t.tablename); end loop; end $$;
```

**2. Execute on the functions.** The seed's own migration check calls
`applied_migration_versions()` over the API, and that call answers
`42501 permission denied` on a fresh branch. Two migrations put it there and
both are deliberate: 0072 revokes execute from `public, anon, authenticated`, and
0121 (the replay grants) re-grants execute on every function to **`service_role`
only**, because granting it to `anon` as well would undo seventeen deliberate
revokes. Production is unaffected by any of this, since its server side calls
arrive as `service_role`. The run arrives as `anon`, so:

```sql
grant execute on all functions in schema public to anon;
```

Neither belongs in a migration. They exist only because the run is holding the
wrong kind of key, and a migration granting `anon` execute on every function
would ship that hole to production. The durable fix is a real secret key for the
branch, which needs `SUPABASE_ACCESS_TOKEN` and the management API; until then
these are the two hand steps, and they are written down here so the next run
costs minutes rather than the first hour.

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
| `prune-regal-calls` | runs | deletes only this branch's own rows |
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

### A freshly created deployment is not warm, and the preflight waits for it (#2347)

**A Worker that was created a minute ago will offer no times, and nothing is
wrong.** Run 34974744173 failed preflight forty seconds after the deploy on
`bucket 112 is offering no times`, and two minutes later the same deployment
offered 42. Teardown runs on `if: always()`, so that refusal destroyed the Worker
and the branch it had not tested, costing about fifteen minutes to rebuild.

Two things about a brand new Worker, both measured on 2026-09-15:

- **Cron delivery is not immediate and is not a fixed delay.** One Worker received
  its first scheduled invocation about six minutes after it was created; the one
  before it never received one in the seventeen minutes it lived. Until then
  `lane_heartbeats` is empty and every bucket answers `emptyBecause: busy`, which
  reads like a roster problem and is not one.
- **Hydration is far slower than one recompute cycle.** `hydrate-calendars` runs
  every fifteen minutes and covers twelve calendars a tick, so a 93 agent roster is
  about two hours away on its own cadence. Buckets start offering times as soon as
  the first dozen are hydrated (bucket 112 offered 156 times with 24 of 93
  hydrated), so **"offering at least one time" is much the weaker condition**: a run
  dispatched there loads a fraction of the roster the shape claims to test.

So the preflight climbs a three step ladder before it books anything, and it
**drives** the lanes rather than waiting on their cadence, which is why the job
holds `LOADTEST_CRON_SECRET`:

1. **wait** for any of the every minute lanes (`sync`, `outbox`, `selfheal`) to
   stamp a heartbeat inside `WARMUP_CRON_FRESH_MS`. Waited for and never driven, or
   a stamp the preflight wrote itself would answer the question with its own work
   (L58). Deliberately not `recompute`, which step three drives. The deadline is
   `WARMUP_CRON_DELIVERY_DEADLINE_MS` (twelve minutes, twice the longest delivery
   measured);
2. **drive** `/api/cron/hydrate-calendars` until `agent_calendars.sync_window_to`
   is set on EVERY calendar of every bookable agent. About eight passes at the
   seeded roster, a few seconds each. Drives that cover nothing more three times
   running are a fault rather than a wait, and say so;
3. **drive** `/api/cron/recompute` until the bucket offers times.

Two states are refused immediately rather than waited on, because nothing the
preflight can drive would change them: a branch with no bookable agents (the seed
did not run) and a bookable agent with no `agent_calendars` row (the seed is
incomplete). Each carries its own wording; one message answering for another is how
somebody spends an afternoon on a cache that was never the problem (L11).

The ladder is pure (`warmupStep` in `preflight-checks.ts`) and pinned offline by
`scripts/test-loadtest-warmup.ts`, so every rung and every refusal is driven with
no deployment, no database and no real waiting.

**A preflight refusal no longer tears anything down.** `teardown` requires
`needs.preflight.result == 'success'`, so a run that measured nothing leaves the
Worker and the branch standing to be re-dispatched, and the judge writes that into
the run summary in words (a skipped job is a grey box that reads the same as one
nobody configured). Teardown still runs after a preflight that PASSED, whatever the
judge concluded.

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

### CPU cannot be apportioned by stage, and the report says what it can (#2353)

Run 34980777198 failed one bar: request CPU p99 **2,777ms** against 2,500ms. It
was not cold start (3 of 588 confirms were the first on their isolate). The six
most expensive confirms were WARM, at 2.8 to 3.4s of CPU on a 6.5s invocation,
with a handler of 2.7 to 3.2s and about **3.5s spent after the response had
gone**, which is the deferred webhook send and the tally beside it.

**A per stage CPU reading is not obtainable from inside a Worker**, and that is a
platform design decision rather than a gap. `Date.now()` returns the time of the
LAST I/O and does not advance during execution, no other timer is provided, and
concurrency is withheld so none can be constructed: it is the Spectre mitigation
Workers were built around in 2017 (Cloudflare's own security model page). Workers
tracing states the same limit from the other side, that a span containing no I/O
reports 0ms. So `performance.now()` around a stage measures I/O wall, never
compute, and the only true CPU figure is the runtime's own ONE number per
invocation. Apportioning that by stage needs a controlled comparison between
runs, not an in process clock.

What CAN be measured, and now is: **each deferred job's own span, by name.** Every
`afterResponse` job logs its own line under `SLATE_LOADTEST` (and reads no clock
at all without it, exactly like the confirm profile), a failed job included,
because a failing send is exactly the one worth profiling and one recorded only
on success reads as free. `readDeferredSpans` collects them and the report carries
a per job line, so "3.5s after the response" stops being one opaque number and
says whether it is the webhook send or the tally. A line carrying no readable time
is counted rather than scored zero, because a zero is the cheapest possible span
and would pull the percentile down while looking like a measurement.

The request CPU finding now SAYS the percentile includes that span and cannot be
split, with the reason, so the next reader does not re-open the question. Which
of the two dominates is a question for the next run's report.

### Where the judge learns that a cron fired (#2352)

**`workersInvocationsScheduled` does not carry a load test Worker's ticks.**
Measured live over 2026-09-15 13:20 to 14:05 UTC: 61 rows for `slate`
(production) and ZERO for `slate-loadtest`, while the branch's `lane_heartbeats`
advanced every minute from 13:58 and the run's own archived log held 19 scheduled
invocations at about 27 seconds of CPU each. The same ticks DO appear in
`workersInvocationsAdaptive` filtered on the script name, each carrying
`scriptName: "__unknown__"` in its own dimensions.

So on every load run the cron half of the CPU bar measured nothing, and the judge
wrote "with no cron in the window" into a report as a fact about the deployment
when it was a fact about the read. That zero is also what unlocks the per request
CPU budget, so the false reading was on the load bearing branch.

The second source is the run's own archived `wrangler tail` stream, and it is the
better evidence: one row per invocation carrying the runtime's own `cpuTime` and
the cron expression that fired it, where the adaptive dataset offers a percentile
over a group that mixes requests and crons. The `__unknown__` script name was
deliberately not built on: it is an undocumented behaviour seen on two Workers on
one afternoon, and nothing can re-read it once the Worker is gone.

`reconcileScheduled` (`platform-reading.ts`) settles the two, and the rule that
matters is that **an archive reporting zero is never on its own evidence of an
empty window**: the stream is attached by hand under a timeout, so it can begin
after the tick it would have seen. A window may be called empty only when both
sources say zero, which the judge asks for by name (`cronSource` must be
`agreed-empty`) rather than trusting its caller. Every report now carries a line
saying how many ticks were counted and WHICH source counted them.

Pinned offline by `scripts/test-loadtest-scheduled-source.ts`.

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
| double bookings | no two run-scoped ACTIVE bookings overlap on one agent in `[starts_at, ends_at)`, read through a **paginating** list, and the preflight must have seen `bookings_active_slot_uniq` actually REFUSE a planted duplicate (without that, an absence of overlaps proves nothing). The count is printed in the measured section on EVERY run, with its denominator and the same-slot count beside it, because a measured zero and a check that never ran read the same when neither prints (#2323) |
| every 200 left a row | a booking row carrying the request's external id, an idempotency key, and a `busy_blocks` row |
| the burst | one winner **per agent** (#2273), every other answer `SLOT_TAKEN`, and each winner really exists. A leg that was configured and produced fewer driver files than fired is **incomplete**, never a skipped bar. The report states the measured depth the control ran at, since one deep and three deep prove different amounts (#2278) |
| freshness | the worst oldest-bucket age across the window under 6 minutes |
| the per address ceiling | its own step, run AFTER the steady pass so it has the API key's budget to itself, sends from one address until the deployment CREDITS a refusal to the per address ceiling, up to past the exact 1,200 an hour cap. It reads back both echoes: the address it was keyed on (unidentified, several, or unechoed each get their own conclusion) and WHICH ceiling refused, so a per key refusal is never counted as proof of the per address one (#2339) |
| confirm startup | what a lead waits BEFORE the confirm begins, read from the run's own archived log and judged only on the confirms that were the FIRST on their isolate, under `REQUEST_STARTUP_P95_MS` (what is left of the latency bar once the confirm's own CPU share is taken out). Three ways it FAILS without a slow start: no archive at all, an archive holding nothing readable (the stream is written under a `wrangler tail` timeout, so its last line is routinely half written), and a reading in which nothing was ever the first on its isolate. Each has its own sentence, because nothing to check is never a pass (#2340, L98) |
| platform | CPU p99 under the REQUEST budget (`REQUEST_CPU_P99_MS`, half the latency bar, and applied only to a window with no cron in it), the cron half under `limits.cpu_ms`, and **no invocation outcome other than `ok`**. The cron half is reconciled against the run's own archived log (#2352): `workersInvocationsScheduled` has never once reported a tick for a load test Worker, so a zero from it alone is the reader being blind and the window may only be called empty when BOTH sources say so. It used to borrow the 200ms LANE budget, which is a different question about a scheduled tick (#2321). The finding NAMES the startup split beside it, because this percentile counts the isolate's own startup as the confirm's compute (#2340) |
| the fault pass | at `SLATE_LOADTEST_FAULT_PCT=10` on the systems in `fault_targets` (calendar reads by default), zero 5xx while every faulted system is one the path degrades around, and a pass that made no requests fails rather than passing on an empty sample. With `google-write` or `supabase` faulted the 5xx count is reported, not barred, because a failure there is a 5xx by design (#3104). A pass whose deployment reported a DIFFERENT percentage or different systems is incomplete, and zero is the case that matters: it passes the bar having injected nothing |
| the cron lanes under fault | sampled every 15 seconds for the whole faulted window by `fault-lane-sampler.ts` and scored by `fault-lanes.ts` (#3104): no lane the deployment runs goes past its stale bound at any reading, every one minute lane stamps inside the window, the lane watchdog records no stale page, and, when calendar reads are faulted, the `sync_failures` page is recorded exactly once. A missing lane file, or a series with a hole in it, is incomplete rather than healthy |

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

### The CPU bar is not measuring the confirm, and it is not the isolate either (#2340)

Run 34889873261 judged the request path at a CPU p99 of 2,988ms against the
2,500ms request budget, and the 32 confirms over two seconds of CPU were doing no
more confirm work than the 409 under half a second: their stage profiles are the
same shape, stage for stage.

**#2340 concluded that the difference was isolate startup, and its own artifact
says otherwise.** That issue computed ONE number, the invocation's wall minus the
profile's own total, and read it as the time BEFORE the handler started. It is
both sides at once. Read apart, on the same 613 confirms:

| span | the 32 over 2s CPU | the 409 under 0.5s CPU |
|---|---|---|
| before the profile | 297ms | 209ms |
| inside it | 2,355ms | 1,561ms |
| **after it was logged** | **2,758ms** | **258ms** |

The expensive confirms are not starting up slowly. Their invocations carry on for
seconds after the booking is written, which on this path is the webhook send
deferred by #884. **The response has already gone, so no lead waits for it**, and
the CPU it spends is still charged to the invocation the CPU bar reads. A budget
derived as a share of the latency bar does not fit an invocation that continues
after the response, which is a separate question and is filed as its own issue.

So the bar could not pass whatever the confirm did, and the reason is not the one
the issue named. The reader measures all three spans now and the judge reports them
apart, because a single number covering both sides of the handler is what produced
the wrong diagnosis.

**Correction, from the first run that carried the per job line (34991614423, #2345).**
The post response span is **not the webhook send on this Worker**: every one of its
597 confirms logged `tag=webhook-emit msg="no subscriber for event"`, because the load
test Worker has no webhook endpoint, so no send was ever deferred. The only named job
was `booking-api-tally` (x596, p95 412ms), against a post response span of p95
1,493ms. The rest was work the per job line could not see: the booked bucket's slot
refresh (`invalidateSlots`), a whole pool compute started as a FLOATING promise in the
middle of the confirm, sharing the isolate's one thread with what the lead waits for
and running on past the response. On the user facing paths it now goes through
`afterResponse("post-confirm-recompute", ...)`, so the next run's per job line names
it and the confirm no longer competes with it for CPU. The cron drains keep the #503
float. What only the next run can show is how much of the 1,493ms that was. Moving
the webhook send onto the outbox drain would change nothing this run can measure and
would make Regal learn of a booking up to a minute later, so it was not done.

### The cron half of the CPU bar holds a margin (#2357)

Run 34991614423 PASSED a minute tick at **119,137ms of CPU against the 120,000ms
kill**, in the same words it would have used for 4,000. The cron half now fails past
`CRON_CPU_MARGIN_SHARE` (half) of `limits.cpu_ms`, and the report prints the worst
tick's share of the limit on every run. The cause of that tick was the sync lane's
post sync refresh and both self heal reconciles each looping a whole pool compute per
bucket CODE (20 and 25 of them, no time bound); they now share one pooled, counted
refresh (`refreshPoolsForAgents`, at most five pools a sweep). See
`docs/cloudflare-platform-notes.md`, watch item #762.

The platform's own percentile cannot separate them: it is one number per
invocation with nothing in it saying whether that invocation also paid for the
isolate. So the split is read from the run's OWN archived log
(`scripts/loadtest/confirm-startup.ts`), which carries both halves: the
invocation's start, and the confirm profile's total logged when the confirm
finished. What is left over is everything before the profile began.

**Cold and warm are told apart by a measurement, not by a threshold.** The confirm
profile carries how long before it started that the isolate evaluated Slate's
confirm module, so the isolate became ready inside this request exactly when that
age is no greater than the time since the invocation began. Reading it off the
bimodality of a histogram would be an inference from a distribution rather than a
reading of the thing itself (L203).

The judge's gather step used to copy only `*.json`, and the archive is
`tail.jsonl`, so the judge had never once seen an artifact the run was already
producing.

**What a lead actually met**: invocation wall 4.9 to 7.1 seconds on those 32,
against a 1.3 to 2.6 second handler. The run's latency p95 passed at 3.1s and its
max was 5.5s, so this is the whole of that tail.

#### The archive is NOT one object per line, despite the name

`wrangler tail --format json` PRETTY PRINTS each event, so run 34889873261's
`tail.jsonl` is 1,336 invocations over 179,056 lines. The first version of this
reader split on newlines and required each line to start with a brace, which that
file satisfies 1,336 times with a bare `{` that parses as nothing: it would have
read ZERO confirms from every archive the run has ever produced, and every fixture
agreed with it because they were written by the same hand that assumed the shape
(L52). The objects are scanned out by brace depth now, string aware because every
event carries a request URL, and the fixtures are pretty printed the way the real
file is. Proven against that artifact: 1,336 objects, 613 confirm profiles, none
unparsable.

The same reading is where `cpuTime` and `wallTime` came from. The archive carries
the runtime's own per invocation numbers, which is what makes the three way split
possible at all: the analytics API reports CPU as one percentile over every
invocation with nothing in it saying which invocations it came from.

#### What the first request evaluates, measured

The deployed script is **one 17.8 MB `index.js`**, and the isolate parses and
evaluates it before serving anything. Almost all of it is the Next.js server
runtime, which app code cannot defer: that is the biggest lever here and it is
deliberately not pulled (L308). Note the measurement above: the time before the
profile starts is 209 to 297ms, so whatever this costs, it is not where the
run's CPU p99 is going.

One thing in it was Slate's to remove. `src/app/apple-icon.tsx` generated a
**static** 180 by 180 touch icon at runtime through `next/og`, which put
`resvg.wasm` (1.38 MB), `yoga.wasm` (72 KB) and a 126 KB font into the bundle as
**top level imports**, so every isolate compiled them at startup for an image that
never changes. It is a committed PNG now. Measured on the same build inputs, before
and after:

| | index.js | wasm and font | total the isolate loads |
|---|---|---|---|
| before | 17,847,818 | 1,576,049 | 19,423,867 |
| after | 16,966,408 | none | 16,966,408 |

That is **2.46 MB, about 12.6 percent**, off what every isolate loads, and the
WebAssembly compilation gone entirely. It is a measurement of the BUNDLE and not of
the startup: whether it moves the bar is for the next run's own reading to say.

### The bar that took three passes to be able to conclude (#2275, #2339)

Read this before reading a ceiling finding, because every wrong turn it names was
taken once.

The DRY RUN is not the problem, though both the issue and the 2026-09-14 run
record say it is. `authorizeBookingApi` is the first statement of the POST
handler and both ceilings live inside it, well above the `if (v.dryRun)` branch,
so a dry run is metered exactly like a real write. The 409s prove it: a request
the limiter had refused would never have reached the application at all. That
same fact is why an APPLICATION refusal is now fine here: a 409 was counted
against the address exactly like a 200, so the control no longer depends on the
roster offering a bookable time.

Three real defects, and the third is the one worth carrying forward:

- **The request shape could never be allowed.** It aimed at a hardcoded code with
  a start SEVEN days out against a four day booking horizon, so the application
  refused all 180 before the ceiling's answer could be read. It reads
  `/api/availability` for the hottest codes in the measured mix and aims at a time
  the deployment is actually offering, rotating through every offered time (the
  steady pass is booking against the same roster).
- **It assumed the premise it rests on.** "N writes from ONE address" was never
  measured, and three different things make it false: an address the deployment
  cannot read is served UNJUDGED by the per address ceiling (#1557) so it can
  never refuse, a runner behind an egress NAT pool spreads the writes over
  several counters, and a deployment echoing nothing leaves the premise
  unmeasured. Each has its own conclusion now. The `x-loadtest-seen-ip` echo
  (#2243) already carried the answer and nothing read it.
- **THE BAR ASKED FOR SOMETHING THE PLATFORM NEVER PROMISED.** Run 34889873261
  sent 180 writes from one measured address in 20 seconds against the 60 a minute
  ceiling, with the binding present and answering `success` every time, and every
  one was allowed. That is the documented behaviour of the native binding, which
  Cloudflare calls "permissive, eventually consistent, and intentionally designed
  to not be used as an accurate accounting system", with "a unique limit per
  Cloudflare location". A bar built on it fails for a reason nobody should fix,
  which is how a bar stops being read (L36).

So the control aims at the bound that IS exact: the per address HOURLY cap in
Postgres (1,200), and it reads the deployment's own `x-loadtest-refused-by` echo
rather than inferring which ceiling a 429 came from. That matters because the per
KEY ceiling is checked FIRST and returns before the per address one is reached, so
without the echo a per key refusal would be credited to the ceiling under test.
For the same reason the step now runs AFTER the steady pass rather than alongside
it: the two share one API key, and a control sending fast enough to trip the key
ceiling would both miss its own target and throttle the drivers.

Where the refusal landed is REPORTED, never judged. A refusal before the hourly
cap says a tighter layer refused; a refusal only at the cap says the approximate
per minute ceiling refused nothing, which is a real fact about the deployment and
not a fault.

So a ceiling finding names one of: the per address protection really is not
applying, too few writes were counted to reach a bound anything guarantees, every
refusal came from the per key ceiling, a refusal said nothing about which ceiling
made it, the key was rejected, the caller could not be identified, several
addresses were counted, or the address was never echoed. Only the first is about
the ceiling.

The platform half is reported `unmeasured` on every run so far: the analytics API
returns no rows for a window minutes old, which is the lag this repo already
documents (#1533). That is the judge's control working as designed, not a pass.

## Tearing down (#2322)

`teardown` deletes **two** things now, and for months it said so while deleting one.
The job removed the Worker and nothing in it touched the Supabase branch; the
workflow had no token to. On 2026-09-14 the run finished, teardown reported
success, and `loadtest-2284` was still ACTIVE_HEALTHY and billing until somebody
deleted it by hand twenty minutes later: a success report about work never
attempted (L98). **A branch is paid for while it exists.**

Dispatch with **`branch_name`** set to the throwaway (`loadtest-<issue>`) and the
teardown deletes it. Leave it empty and the branch is LEFT STANDING and the job
says so, loudly, as a workflow warning: that is still not a clean teardown and it
must not read as one.

The choosing is pinned offline (`scripts/test-loadtest-branch-teardown.ts`),
because deleting a branch acts on a real project and the guard has to be testable
with no token. Two hazards it holds off, both measured rather than imagined:

- **The project carries a branch literally named `main`**, `is_default: true`,
  whose `project_ref` is the production project itself. The name shape, the default
  flag and the parent ref are three separate refusals, so no spelling of "delete the
  branch" reaches that row.
- **`DELETE /v1/branches/{id}` deletes one branch; `DELETE /v1/projects/{ref}/branches`
  DISABLES PREVIEW BRANCHING for the whole project.** An empty id is one slash from
  the second, so an id that is not a uuid is refused before any request is built.

| exit | what it met |
|---|---|
| 0 | the branch is gone, confirmed by re-reading the listing, or none was named (and the job says the branch is still there) |
| 1 | no access token or no project ref here; nothing was attempted |
| 2 | the name is not one a load run creates, so nothing was even looked up |
| 3 | the branch listing could not be READ, which is not an empty project |
| 4 | no branch of that name, so something may still be billing under another |
| 5 | more than one of that name |
| 6 | the match is the project default |
| 7 | the match points at the parent project |
| 8 | the id is not a branch id, so no request was built |
| 9 | the delete was refused |
| 10 | the delete was accepted and the listing could not be re-read, so it is unconfirmed |
| 11 | the delete was accepted and the branch is still in the listing |

Exits 10 and 11 exist for the same reason the Worker half re-reads the account
listing (#2277): the teardown is done when the thing is GONE, never when the delete
command exited.

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

What a faulted run should show: the failing agents are named in a throttled page rather
than one per failure; a `notACalendarUser` agent is treated as definitively failing
rather than retried every minute; the booker still offers times from agents who are
fine; and no lane's heartbeat goes stale, because a Google failure must not stop a lane
running. On the booking run the page and the heartbeats are now SCORED by the judge
(the fault leg section below), not read by a person.

### Which systems fail (#3104)

`SLATE_LOADTEST_FAULT_TARGETS` names the systems, comma separated. Unset is
`google-read` alone, which is the switch exactly as it was before the others existed.

| target | what fails | key a verdict is hashed on | what it exercises |
|---|---|---|---|
| `google-read` | every stubbed calendar read, in the three shapes above | the call (`freeBusy:<email>`, `calendarList:<email>`, the sync window) | the coalescer, the classifier, the streak page, verify-on-book's re-route |
| `google-write` | the stubbed create, patch and delete, in the same three shapes | the operation and the event id, so a retry meets the same answer | the confirm path's failed create, `pending_event_deletions`, the outbox's resume |
| `supabase` | every call through the secret key client: half are held 1.5 seconds and let through, half answer a PostgREST shaped **500** | the method, address and body, inside the minute, so a fixed read is not failed on every tick for the whole run | the fail loud reads (`unwrap`), the lanes' failure boundaries, the heartbeat writes themselves |
| `salesforce` | a call is held 3 seconds, past the booking path's 2.5 second calling number deadline, then fails as a timeout | the request address, so one lead is slow on every run | the deadline branch, which the instant load test refusal (#2335) could never reach |
| `webhook` | the synthetic delivery records a 503 instead of a success | the delivery AND the attempt, so some land on a retry and some reach the dead letter | the outbox retry and the dead letter page |

The database failure is a 500 and not a 503 on purpose: postgrest-js retries a 503 on
every read with a 1, 2 and 4 second ladder, the retry meets the same verdict, and every
faulted read would be held seven seconds and then failed anyway, which measures the
client's backoff rather than Slate (`scripts/test-loadtest-fault-targets.ts` asserts the
client sends it once).

`google-write` and `supabase` are **fails loud** systems (`FAULT_TARGET_CONTRACT` in
`src/lib/loadtest-fault.ts`): a failure there is a 5xx by design, because the event or
the booking was not written. With either named, the fault pass reports its 5xx count
rather than barring it, and the cron lanes are what is judged. With only the others
named, "no 5xx under fault" holds as before.

**It cannot be turned on in production**, by two facts that must both hold for anything
to fire: every injector asks `SLATE_LOADTEST` at call time, and the percentage is
committed nowhere. `scripts/test-wrangler-loadtest-env.ts` fails the build if the
production block (or the committed `env.loadtest` block) carries the flag or either fault
setting, and `scripts/test-loadtest-fault-targets.ts` drives every wired injector in a
real process at 100 percent with every target named and no flag, and requires each to
do nothing.

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

**The systems are measured too (#3104).** The `fault_targets` input goes to the
deployment as `SLATE_LOADTEST_FAULT_TARGETS`, `/api/smoke/version` reports the list the
injectors read (`faultTargets`, plus `faultTargetsUnknown` for a name that matched
nothing and so faults nothing), and the driver refuses on a mismatch exactly as it does
on the percentage. The judge holds the pass to the bar the DEPLOYMENT'S list implies.

**The cron lanes are judged, not read (#3104).** The leg faults the whole deployment,
so the lanes run under it, and `scripts/loadtest/fault-lane-sampler.ts` reads the
branch's `lane_heartbeats` and `alert_state` every 15 seconds beside the driver and for
`FAULT_LANE_TAIL_MINUTES` (default 3) after it, while the deployment is still faulted.
It reads the branch directly, never through the Worker under test. The judge then
requires, through `scripts/loadtest/fault-lanes.ts`:

- every lane the deployment runs (the watchdog's bounded lanes minus the held back ones,
  handed to the judge as `EXPECT_LANES_DISABLED`, a copy of `env.loadtest`'s
  `SLATE_LANES_DISABLED` that `scripts/test-fault-lanes.ts` holds equal to wrangler's
  value; missing or naming no lane makes the run incomplete) inside its stale bound at
  every reading, and never missing;
- every one minute lane to have stamped INSIDE the window, since its ten minute bound
  would otherwise be satisfied by a stamp from before the faults began;
- no `cron_lane_stale:<lane>` page recorded in the window, the watchdog's own verdict;
- with calendar reads faulted, the `sync_failures` page recorded, and recorded ONCE: its
  thirty minute cooldown outlasts the sampler's twenty minute ceiling, so a second
  stamp in one window is the throttle failing.

Slack refuses every load test post (#2335) and the deployment holds no bot token, so
`sendThrottledAlert` RECORDS a load test page in `alert_state` in place of sending it,
with the cooldown applied as production applies it and no firing marker (nobody was
told, so no all clear is owed). That record is what the judge counts. The sampler
counts each distinct stamp as one send, which is why it samples rather than reading
once: both tables hold only the latest value, so one read at the end could not tell
one page from one a minute, or a lane that stalled and recovered from one that never
stalled. A missing lane file, or a series with a hole in it, is incomplete.

**What it does NOT cover:** `notACalendarUser` being treated as definitive is still not
scored at scale; it is pinned by the classifier's unit tests (`isDefinitiveFailure`).
And a calendar WRITE or database fault pass judges the lanes rather than the booking
path's 5xx count, which on such a pass is the percentage showing through by design.

## Teardown
Delete the branch DB. The `SLATE_LOADTEST` flag is inert anywhere it isn't set, so no
production cleanup is needed.
