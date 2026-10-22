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
   Create it in **us-west-2**, production's region: `env.loadtest` is pinned to the
   placement hint `aws:us-west-2` (#3693), so a branch anywhere else would put the
   Worker beside nothing and the run would measure a latency production never sees.
   The Management API's create branch call takes an optional `region`; confirm the
   branch's region afterwards (the connector's `get_project` on the branch ref).
   Create it at **production's compute size**, and check both before dispatching
   (#3751). A branch is created at whatever size it is asked for (`supabase branches
   create --size`), independent of production, so a production resize leaves the test
   behind with nothing saying so. Under load a confirm's time is mostly database time,
   and on a smaller instance it is a different number: on 2026-10-14 the same code
   failed at 3.0 times the baseline on a micro branch (run 38655870683) and passed at
   1.7 times on a Large one matching production (run 38662741980). Read the size from
   each database itself, since neither the CLI's branch listing nor its project listing
   reports it: `select name, setting from pg_settings where name in ('max_connections',
   'shared_buffers')` on production and on the branch (the connector's `execute_sql`
   on each ref, or the SQL editor), and dispatch only when both pairs are equal. Both
   settings follow the compute size by default and either can be overridden on a
   project, so a mismatch is certain evidence and a match is strong but not proof; the
   dashboard's Compute and Disk page names the size itself when the two disagree.
   Production read 160 and 262144 (2GB in 8kB pages, Large) on 2026-10-14, after
   reading 60 and 32768 (256MB, micro) on 2026-10-07; take the size from the reading, never
   from this paragraph.

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
   Tunables: `BLOCKS_PER_DAY=12` and `ROSTER_SHAPE_FILE` to point at a fresher
   export from `pnpm loadtest:export-shape`. `CALS_PER_AGENT` is refused at anything
   but 1: each agent's one calendar is seeded under the agent's EMAIL, the id the
   Google stub's calendar list gives it, because any calendar the stub does not list
   is deleted with its busy blocks by the watch lane's first reconcile (#3103).

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

## The peak the load run's bar rests on (#3124)

(Titled "The peak the 60 a minute bar rests on" until the bar moved to 70; migration
0193 cites it by that name, and an applied migration is not edited.)

The booking path run's bar is **70 confirmed bookings a minute for ten minutes**,
and it lives in ONE place: `LOAD_RUN_BOOKINGS_PER_MINUTE` in `src/lib/load-bar.ts`.
The steady pass is sized from it (`steadyPacingFor` in `book-plan.ts`, below), the
daily busy minute alert judges against it, and `scripts/test-load-bar-literals.ts`
fails the build on a copy of it in the load test code.

**70 since 2026-10-20.** Dan raised it from 60 that day
([decision](https://github.com/Try-Pennie/slate/issues/3124#issuecomment-6299370108)),
which keeps it **ten times over the whole traffic peak of 7 a minute** measured the
same afternoon
([reading](https://github.com/Try-Pennie/slate/issues/3124#issuecomment-6299234214)):
cal.com's routed responses and Slate's routed bookings over the 30 days from
2026-09-20 19:15 UTC, added minute by minute. The busiest minute, 7, was reached
twice: 2026-10-01 14:20 UTC (7 on cal.com, none on Slate) and 2026-10-02 13:23 UTC
(3 on cal.com, 4 on Slate). Against that peak 60 was only 8.6 times over.

That premise has to be re-checkable, because it is the whole reason the bar is the
number it is. **60 was set on 2026-09-11** in the plan on #2240 beside a measured
busiest minute of 6, ten times over the peak measured then. What was measured, from
the plan's own comment on #2240: routed cal.com form responses ran **450 to 1,013 a
day** over the ten days before, and the **busiest minute in 30 days held 6**. Those
came from cal.com, since Slate took no real bookings then.

Slate's own traffic answers the same question now. This query reads the last 30 days
of real routed bookings (test buckets excluded, the same `is_test` the canary
isolation uses, and agent link bookings excluded by `kind = 'routed'`, since they do
not route, migration 0144) and reports the busiest minute, when it was, the busiest day, and how many
times over that minute the bar sits:

<!-- runbook-verified: 2026-10-20 (98c199b0) run verbatim against production (drukfvgaynzrralbzkzj) through the Supabase connector at 21:40 UTC, after the bar moved to 70; returned bookings_30d 8573, busiest_day 512, busiest_minute 5 at 2026-10-10 15:30 UTC, bar_over_peak 14.0 (Slate's share only; the whole traffic peak is 7, see above). A control read the newest routed booking at 21:37 UTC, three minutes before, so the window reached the present. Its shape is also pinned offline by scripts/test-capacity-peak-sql.ts. -->
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
  round(70.0 / nullif((select max(bookings) from per_minute), 0), 1) as bar_over_peak;
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

`bar_over_peak` divides **70**, the bar it was last verified against (2026-10-20, the
marker above). The block is held verbatim to that run, so when the bar moves again the
number in it moves too and the block is run against production again, as it was on
2026-10-20. Or read `busiest_minute` directly: above **7** the bar is under ten times
the peak, the premise no longer holds, and the bar should be raised before the next
run is dispatched. (Slate's half alone cannot show the whole peak before cutover; the
daily lane below adds cal.com's.)

**Nobody has to remember to re-read it** (#3124). The daily `busy-minutes` lane
counts the last 7 UTC days the same way (this query's `real_bookings`, through the
`routed_bookings_per_minute` RPC, plus cal.com's routed responses minute by minute
until cal.com is marked retired) and pages `load_bar_outgrown` when a minute of more
than a tenth of `LOAD_RUN_BOOKINGS_PER_MINUTE` (`src/lib/load-bar.ts`) happened on 3
or more of them. The alert's threshold is derived from that constant, so raising the
bar moves the alert with it. The run itself was measured at 90
seeded agents (run 34658545203, 2026-09-11) against a design target of 100 to 200;
running the booking leg at 200 is #3829, below ("The 200 advisor run").

**First reading against production, 2026-10-16 (#3124).** Run at 20:23 UTC (16:23
ET), the query above, then dividing 60, returned:

| bookings in 30 days | busiest day | busiest minute | when | bar over peak |
|---|---|---|---|---|
| 6,886 | 512 | 5 | 2026-10-10 15:30 UTC (11:30 ET) | 12.0 |

**Second reading, 2026-10-20, after the bar moved to 70.** Run verbatim at 21:40 UTC
(5:40 PM ET) with the query computing against 70: 8,573 bookings in 30 days, busiest
day 512, busiest minute still 5 at 2026-10-10 15:30 UTC, bar over peak 14.0. The
control read the newest routed booking three minutes before. That is Slate's share
only; the whole traffic peak the bar is set against is 7 (above).

A second read only query in the same session, over the same rows, is the control
that the window reached the present rather than older data alone (L171): the newest
routed booking was 2026-10-16 20:22 UTC, a minute before the read, with 445 in the
last 24 hours and an average of 409 a day over the last seven. It also showed what
the 30 days really hold: the earliest real routed booking is 2026-09-22 15:56 UTC,
so the window holds 25 calendar days of Slate traffic (counting both ends), 23 of
them with a routed booking (UTC days), not 30, and the busiest day was
2026-10-08 (UTC).

What that reading says, and what it does not:

- **On Slate's own traffic the premise held**: 60 a minute was 12 times the busiest
  minute Slate had carried (70 is 14 times it).
- **That traffic is the pilot's share, not the whole.** Since 2026-10-02 the
  Salesforce pilot sends Slate half of the leads on tiers 1 to 5 (ADR 0009).
  If the whole of the traffic peaks in proportion, the busiest minute at cutover is
  at least twice this one, about 10, and 60 is then about six times it, under the
  ten the premise asks for. Peaks do not have to scale in proportion, so that is an
  estimate, not a measurement: the measurement is cal.com's routing form responses
  over the same 30 days, read the way the 2026-09-11 figure (6) was, and it has to
  be read before cutover (#65) to settle whether 60 stays the bar. **Settled
  2026-10-20**: the whole peak was 7, so 60 was 8.6 times over it, and Dan raised the
  bar to 70 (above).

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
  resolve to a pool of exactly **one**, and since #3429 that one deep top rung is what
  the tier drop burst needs: a crowd that meets its rung's last advisor and must drop
  to the Low tier below. A seed staffing those pools sixty deep produces a drop burst
  whose crowd never has to drop at all.

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

### The 200 advisor run (#3829)

Slate is designed for 100 to 200 advisors and production has about 90, so the run
can also be driven at 200. Three things change and nothing else does:

- **The roster.** `SCALED_200_SHAPE` in `roster-shape.ts` is production's measured
  shape scaled to 200 by the seed's own scaling: the same mix by tier, backend and
  zone (70, 52, 36, 18, 7, 7, 4 and 4 advisors by profile; 64 Eastern, 56 Phoenix,
  36 Mountain, 33 Pacific, 11 Central), with the two Beyond advisors still pinned so
  every `x2x` pool stays one deep. It is checked in as numbers so the run names the
  roster it measured, and `scripts/test-loadtest-roster-shape.ts` fails the day the
  numbers stop being what the seed builds. Seed it with `ROSTER=200`; `ROSTER=90`, or
  nothing, is production's.
- **The steady traffic.** Held at the load bar's rate PER ADVISOR (70 a minute over
  90), so 200 advisors is about 156 a minute: twelve drivers at fourteen each, 168
  a minute (`steadyDriversFor`, rounded up so no run drives less per advisor than the
  bar), each on its own runner and so its own address. The bursts keep their sizes,
  because a crowd on one slot does not grow with the roster.
- **The dispatch.** `roster: 200` on the workflow. The burst setup COUNTS the
  advisors on the branch, refuses on **exit 12** when the count is not the roster
  the run names (a 200 run on a branch seeded with 90 would pass every bar about the
  wrong roster), and emits the steady driver list the drive matrix and the judge both
  read, so the two can never disagree. The report's header names the roster and the
  steady driver count.

The bars are the 90 advisor run's, unchanged. The cron lanes are what grow with the
roster (sync and recompute do work per advisor and per pool), and the report's cron
tick line judges the worst scheduled tick's CPU against the 120,000ms kill. A tick
that breaks the subrequest ceiling is killed with a status other than success, which
the platform outcome bar fails by name; Cloudflare publishes no per tick subrequest
COUNT, so the report prints the window's mean per invocation and says so rather than
inventing one.

All the drivers share the one load test API key, so at 200 the steady pass asks about
168 writes a minute of a per key ceiling of 120. That ceiling is Cloudflare's native
limiter, approximate and per location (#2339); the exact bounds on the key are 1,200
a minute and 6,000 an hour, which the whole run stays under (at 200: 1,680 steady
writes, about 212 in the bursts, 27 baseline, the fault pass's few dozen and the
ceiling control's 1,201 from one address, about 3,200 in the hour). Any 429 it does
give is counted in the outcome mix against the rate bar's floor rather than hidden.

**The 200 advisor run's speed bar was calibrated at 135 a minute**, not 168: the
1800ms limit on the steady p95 (`latency-bar.ts`) comes from the 200 advisor runs of
#3829 at nine drivers. The 90 advisor run at 70 is still far lighter than those runs.
A 200 advisor run at 168 a minute is the rig changing, which is when that comment
says to recalibrate.

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

**Five drivers at 90 advisors, twelve at 200** (#3829, above), **fourteen a minute
each for ten minutes**, so at 90 the drivers together drive exactly the load bar of
70 (#3124). The sizing is derived, never written: `steadyPacingFor` takes
`LOAD_RUN_BOOKINGS_PER_MINUTE` and returns the fewest drivers at no more than fifteen
a minute each (`MAX_PER_DRIVER_PER_MINUTE`, the pace every run at 60 kept) whose share
is a whole number, so raising the bar moves the drivers, their pace, the deadline and
the job timeouts with it. A higher bar takes MORE drivers rather than faster ones,
because a driver sends one request at a time and fifteen a minute already stretched
to fourteen to sixteen minutes on a slow deployment (#3222).

At the old bar the four drivers at fifteen added up to **sixty**, exactly the per
address write ceiling (`BOOKING_API_IP_LIMITER.perMinute`), and that was read as the
run sitting on the ceiling. In the workflow it never did: each driver is its own
runner and so its own address, at fourteen of that ceiling's sixty. At 70 the pass
as a whole is above it, which only matters for a hand run of every driver from one
machine. The limiter constants are still imported from the app rather than copied,
so a run can never drift into measuring a ceiling somebody changed, and that ceiling
is APPROXIMATE (#2339); what the run's 429s are attributed against is the ceiling
control's own step below.

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
- **The slot is picked at RANDOM** from what the bucket offered on the steady and fault
  legs, and it is the only deliberately non-deterministic choice in the run. The
  steady drivers each taking the first offered time would contend on one slot all run, which
  measures the unique index over and over and never measures the path at a rate. The
  baseline is the exception: it books one at a time, at rest, and takes the SOONEST
  time so it stays clear of the times the bursts are planned on (#3782, below).
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
- **What the deployment says about each confirm is recorded too** (#3325), on five
  more headers sent under `SLATE_LOADTEST` only: which confirm line served it
  (`x-loadtest-confirm-line`: `shared`, `isolate` or `fallback`), why
  (`x-loadtest-confirm-line-reason`), under which kind of key
  (`x-loadtest-confirm-line-key`: `ladder`, `code`, `link` or `none`), the whole
  milliseconds the confirm spent in calls to the line (`x-loadtest-confirm-line-ms`),
  and the deployment's own epoch milliseconds when it built the answer
  (`x-loadtest-answered-at`). The names, the allowed values, the builders the
  deployment writes through and the parser the driver reads through are ONE
  definition in `src/lib/loadtest-echo.ts`. Each field is recorded as read, as
  **unreadable** with what was sent (a value the contract does not know), or as
  **absent**, so a header that never arrived is never recorded as a value, least of
  all as a zero. The answer stamp is on every answer the booking route gives,
  stamped where the handler is wrapped; the line headers come from the shared
  confirm line itself.
- **A bucket offering nothing is RECORDED**, with an outcome of its own, rather than
  skipped in silence. An offered-nothing run and a run nobody drove otherwise
  produce the same empty file.

### The burst

`MODE=burst` with `BURST_PLAN`, ONE value chosen **once** by the setup step
(`scripts/loadtest/burst-setup.ts`) and handed to every driver: for each of the run's
**three** bursts its kind, its two sibling codes, one slot, one moment, its share per
driver and what was measured about its capacity (#3325, #3429), and the tier each code
had on show when the setup read its availability (#3495). Every booking hands its own
code's tier back, as the booker hands back the tier it had on show, so the confirm
records it instead of reading the availability cache for it; a steady driver does the
same from its own availability reads. A burst whose drivers
each chose their own time is not a burst: nothing contends and everything succeeds.
The plan is passed through rather than re-derived in the driver, so the two cannot
fire at different codes, slots or moments while each reads as correct (L70). The
driver reads it strictly (`readBurstPlan` in `book-plan.ts`) and refuses a plan it
cannot read by name.

**Two kinds of burst (#3429).** #3338 made a confirm in a crowd walk the tier ladder
like any confirm (Dan, 2026-10-06, built in #3437), so a crowd now books one advisor
per free advisor across its code's whole ladder rather than one. A hundred confirms at
`120`, whose ladder is `120, 130, 110` and whose lower rungs are the whole Low tier,
mostly WIN, and the refusal path and the line's settle path would go untested. So the
run fires `BURST_SEQUENCE` (`book-plan.ts`): a refusal control, a tier drop burst, and
a second refusal control.

- **The refusal control** keeps the crowd of a hundred (`BURST_REQUESTS_DEFAULT`, 25 a
  driver) and fires it at the ladder whose WHOLE capacity is smallest and genuinely
  smaller than the crowd (`refusalLadders` in `burst-target.ts`): the distinct
  advisors across every rung, with the Low exclusion each rung applies (#2842), read
  through the booker's own eligibility judge. A ladder is a hard bound at any slot, so
  somebody is refused whatever the slot. On the seeded roster that is the Ultra ladder
  `500, 400, 300, 200` (with `501`), which holds sixteen advisors because every rung
  below Ultra skips Low carriers. The other way to give a crowd one advisor by
  construction, a named advisor link burst (`link:<userId>`, migrations 0144 and
  0155), is not available: the booking API's request names a bucket only
  (`parseDirectBookingRequest`), and the public booker route that does take a link is
  behind per address ceilings and stamps no load test echo, so the crowd is sized
  against a measured capacity instead. It is fired twice because its loser speed bar
  is a timing claim (L395).
- **The tier drop burst** fires about ten confirms (`DROP_BURST_REQUESTS_PER_DRIVER`, 3
  a driver, twelve in all) at the ladder whose top rung is shallowest, which has a rung
  below it and holds at least `DROP_CAPACITY_HEADROOM` (2) times the crowd
  (`dropLadders`), never the refusal control's own. On the seeded roster that is `120`
  and `121`: one Beyond advisor on top, the Low tier below. Its slot is chosen by
  asking, through the booker's own candidate read on every rung
  (`roundRobinCandidates`, read only), who is free there: somebody on the top rung, so
  the crowd meets that rung's LAST advisor; fewer than the crowd there, so somebody has
  to drop; and twice the crowd across the ladder (`dropSlotFit`). On a build that walks
  the ladder every confirm wins, at least one below the requested rung, on distinct
  advisors. It proves the #3338 drop happens at all.

What the setup measured for each burst (the most its ladder holds, and how many were
free at the slot when planned) travels inside the plan to the drivers' files and from
there to the report's burst lines, which is how the report says what each control was
worth (#2278).

```
SLATE_BASE=https://<loadtest>.workers.dev BOOKING_API_KEY=<key> RUN_ID=<run> \
DRIVER=0 OUT=results/burst-0.json MODE=burst BURST_PLAN='<the setup step's burst_plan>' \
node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/loadtest/book.ts
```

**Three bursts, each judged on its own** (#3325). One burst is one spread of
simultaneous requests over the deployment's isolates, and one lucky spread can pass
a run that a second would fail (L395). So the setup picks three slots at least an
hour apart (`BURST_SLOT_GAP_MS`, longer than any appointment plus its buffers, so no
burst's bookings overlap another burst's slot) and three moments a minute apart
(`BURST_SPACING_MS`, twice a request's own abort bound, so one burst is over before
the next fires). Each driver fires all three and writes **one file per burst**,
`burst-<driver>-leg-<k>.json`, each carrying which burst it holds. A driver that
wakes late for one burst fires nothing for THAT burst, writes it as missed, fires the
others, and exits non-zero, so a late wake costs the run one burst rather than three.
The burst job's timeout is held against the lead, all three bursts, the last one's
probe and the runner's setup by `scripts/test-loadtest-driver-deadline.ts`.

**Each driver reads two facts from the deployment for the judge (#3429)**, both
recorded in its own burst files so they are paired with the burst by being in it
(`burst-probe.ts`):

- **The confirm crowd rule**, once before the first burst, from `/api/smoke/version`'s
  `confirmCrowdRule`: `stops` (a crowd behind a leader that booked its rung's last
  advisor is answered SLOT_TAKEN, every build before #3437) or `walks` (#3437). It is
  `CONFIRM_CROWD_RULE` in `src/lib/confirm-crowd-rule.ts`, and #3437 sets it to `walks`
  in the change that makes it so. A deployment that does not say is recorded as absent.
- **The slot's probe**, once the burst has SETTLED: the latest a driver may fire
  (`BURST_GRACE_MS`) plus a request's own abort bound (`REQUEST_TIMEOUT_MS`), past
  which no burst request is in flight and the confirm's own budget is spent
  (`burstSettleAtMs`). It asks `/api/bookings/bookable`, which runs the routing a real
  book runs, read only, of the code the driver opened on, under its own
  `BURST_PROBE_TIMEOUT_MS` (20s), and is answered before the next moment. The probes
  run beside the next burst's wait, never before it, and the file is written once
  without the probe and again with it, so a driver that dies before its probe still
  hands the judge its burst. `BURST_SETTLE_MS` is a test seam that can only shorten
  the wait.

**Each burst is split across two sibling codes** (#3325). The shared confirm line
keys a crowd on the whole fallback LADDER, so a follower is only told "taken" by a
leader who walked the same pools at every rung. Two codes qualify when every rung of
their ladders (`tierLadder`) resolves to the same pool (`poolKeyFor`: criteria, hand
named members, fallback advisor, event type) with the same Low exclusion
(`rungExcludesLow`), and the setup MEASURES that from the branch's own bucket rows,
read through the app's own pool reader (`listPoolBuckets`), rather than assuming the
legal digit is inert. On the seeded roster the pair is `120` and `121` (Low, Beyond,
legal digits 0 and 1), whose ladders `120, 130, 110` and `121, 131, 111` are the same
pools at every rung; a bucket given a hand named member or a fallback advisor splits
off its siblings at once. Each driver alternates its requests between the two codes,
opening on a different one per driver, so a burst of four drivers is fifty fifty.
Each sibling is asked what it offers too, and the slots are chosen from the times
BOTH offer, because a time only one offers would be refused for the other half of the
burst for a reason that is not contention.

**The ladders are MEASURED, not constants** (#2278, #3429). The control used to rest
on the burst's POOL being one agent deep, and for months that was a hand written code
nothing checked: the seeded roster gave it three, so a live run answered three 200s
on three different agents. It rotted too, when production's Low plus Beyond pool
emptied (#2152) and the constant had to be moved by hand the morning of the next run
(#2319). Since #3338 the control rests on the code's whole LADDER instead, and the
setup reads the roster and its buckets through the app's own pool reader
(`listPoolBuckets`) and the booker's own eligibility judge (`eligibleFromRoster`),
names each ladder by its first code paired with its next (`ladderCandidates`, one pair
per ladder), and asks at most three ladders of each kind what both codes offer.

**It refuses rather than firing a control that cannot prove anything.** "Winners equal
capacity" is not a bar (L63), so a roster with no ladder smaller than the refusal
crowd is a refusal of the setup by name, never a smaller crowd, and a roster with no
ladder or slot where the drop burst fits is refused the same way. A hand run has no
override any more: the drop burst's slot has to be measured against the branch
database, so a plan nobody measured would be the unmeasured control #2278 removed.

**It runs BEFORE the steady pass, and alone** (#2262). That is a decision rather
than an ordering accident: the steady mix can include whichever codes the burst
picked, so a steady driver that happened to take a burst's slot first would make
every burst request `SLOT_TAKEN`, and the winner bar would fail for a reason that
has nothing to do with the unique index it exists to test. A hundred simultaneous
requests on one slot is the contention being measured either way.

The setup picks the **last** offered time first and walks back from it, for the same
class of reason: the preflight books the first time ITS bucket offers, minutes
earlier, and the two buckets can share an agent. It sorts before choosing, because a
list read out of a response carries no order unless something declares one (L343).
The drop burst's slot is at least an hour from both refusal slots, and at most
`DROP_SLOTS_TO_MEASURE` (144, two working days of slots, #3529) of its ladder's times are measured, furthest first.
Each refusal is its own code: `2` availability answered for none of one kind's
ladders (the deployment), `3` they answered and no refusal ladder offered two usable
times both codes share (the seed), `4` the roster and its ladders could not be
measured at all, `5` not one pool has an agent in it, `6` no staffed code shares its
whole fallback ladder with another, so a burst cannot be split across two codes of
one line (the bucket rows), `7` no ladder holds fewer advisors than the refusal crowd
of a hundred, `8` no ladder can host the drop burst (a sibling, somebody on the top
rung, a rung below, twice the crowd across the ladder, and not the refusal control's
own), `9` no offered time fits the drop burst, saying for each ladder asked how many times it
measured and how close its closest slot came (#3771),
`10` who is free at a slot could not be read, and `11` no offered time on the refusal
control's ladders has `HARD_REFUSAL_MIN_FREE` (5) advisors free across the ladder with some
below the requested rung. The first refusal crowd takes the measured time with the MOST
free over that floor, so every run meets the hardest crowd the seed offers (#3565); the
seed rarely leaves ten free on the sixteen advisor ladder, so the floor is not ten. An empty burst file and a
run with no burst leg are otherwise the same thing (L98).

It also emits the DRIVER COUNT, from the app's own `DRIVERS` constant, and the BURST
COUNT, from `BURST_LEGS`, and both the matrix and the judge's expectations read them
from there. Two places holding one number is how a matrix grows to five while the
judge goes on expecting four and calls every run incomplete.

`burst_lead_seconds` (default 600) is how long the burst drivers have to be queued,
checked out and installed before the FIRST burst's moment. A driver that wakes late
fires nothing for that burst, and the judge fails that burst: raise the lead rather
than re-running and hoping. It was 300 until run 38912230442, whose last burst runner
started 395s after the plan was made (GitHub's queue was backed up after a billing
block; 3 to 86s on the runs before it), so that driver missed all three bursts.
`BURST_RUNNER_START_WORST_SECONDS` records that measurement and
`scripts/test-loadtest-driver-deadline.ts` holds the default above it plus a driver's
setup. The deeper fix, deciding the moments only once every driver is running, is
not built: the burst tail, the driver files and the judge all read the moments the
setup chose.

The control on each burst is **one winner per agent**, which is
`bookings_active_slot_uniq` doing its job, every confirm on the shared line, and **no
SLOT_TAKEN while the slot still answers available** (#3429). Then by kind: the refusal
control's every other answer is SLOT_TAKEN and is told within two seconds of the last
winner on the deployment's clock; the drop burst's every confirm wins and at least one
is booked below the requested rung. Each is held to the crowd rule the deployment
declares; see "The burst, judged against the build's own rule" below.

A driver that wakes up **late for a burst does not fire it** and says so, in that
burst's file and on a non-zero exit. A late request meets an already taken slot and
records a SLOT_TAKEN indistinguishable from the contention the control is counting,
so the judge would be handed a staggered burst wearing a simultaneous one's clothes.

The burst driver's exits: **1** a setting it cannot read (an unknown `MODE`, a
`BURST_GRACE_MS` that is not a whole number of milliseconds, a plan it refuses, or a
lead outside the phone's digits), with nothing sent; **3** a burst it woke too late
for; **4** a burst whose probe it could not record, which it names, with every other
burst still fired, probed and written, since each probe's failure is held from the
moment the probe starts rather than left to end the driver (#3446 review, L749).

#### The burst tail, and where each burst's time went (#3416)

Run 37520312761 failed two of its three bursts: every burst confirm took about ten
seconds, against three to four on run 37390071571, and the slowest losers were refused
`503 VERIFY_UNAVAILABLE` instead of `409 SLOT_TAKEN`. Nobody could say which stage
took the time, because no burst confirm's log line was kept: the `archive` job needs
the burst job, so its tail starts after the bursts.

So the **`burst-tail` job** streams `wrangler tail --env loadtest --format json` across
the bursts. It needs only `setup-burst`, so it starts beside the burst drivers and is
streaming well inside the five minute lead, and it stops at a moment DERIVED from the
plan (`burstTailStopAtMs` in `book-plan.ts`): the LAST burst's moment, plus the
lateness a driver may still fire at (2s), a burst request's own abort bound (30s, so
no answer the driver records comes later), the work the platform allows after an
answer (an invocation's event is written when it ENDS, and Cloudflare cancels deferred
work 30s after the response), and the stream's own lag (10s). The slowest burst answer
seen, 14119ms, is inside that by construction. It copies the cold job's tail pattern
(`setsid`, a `timeout` ceiling, the stream backgrounded, stderr to its own file, the
stop sent to the process group) for the same reasons. `scripts/loadtest/burst-tail-wait.ts`
holds it open and exits 0 when the window covered every burst, 1 when the plan or the
ceiling could not be read, and 3 when it could not cover every burst (it started after
the first moment, or `BURST_TAIL_CEILING_MINUTES` ends before the stop: raise both with
the lead). The upload is always made, as the `burst-tail` artifact.

**It is its own file, `burst-tail.jsonl`, read for the burst section only.** A crowd
of a hundred confirms on one slot is a different load shape from the steady pass, so
its confirms must never join the startup bar's population, which comes from the
archive's `tail.jsonl` alone. The cold leg's `cold-tail.jsonl` is kept out the same
way. `scripts/test-loadtest-burst-tail.ts` holds the wiring: the job's needs, its
ceiling and timeout against the default lead, its artifact, the judge waiting for it
and downloading it, the archive still needing the burst job and the burst tail, and `run-judge.ts` never
handing the burst tail to a reader of the startup population.

**Two tails on the Worker must never overlap (#3450).** Stopping one `wrangler tail`
silences every other tail attached to the same Worker. Measured 2026-10-06 (times ET):
tail A and tail B both received the 8:30 PM crons, B was stopped at 8:30:34 PM, and A received nothing
for the next two and a half minutes while the every minute cron kept firing; one tail
alone received every minute's. Run 37547143303's archive attached while the burst tail
was still open and went deaf at 7:49:22 PM ET on 2026-10-06, the moment the burst tail was stopped, so its
startup bar was judged on 1 of 24 confirms. So `drive`, `freshness` and `archive` all
wait for `burst-tail` to CLOSE (with `!cancelled()`, so a failed burst tail never skips
them), and the drive and the archive still start together.
`scripts/test-loadtest-tail-overlap.ts` reads every job that runs `wrangler tail` and
fails unless each pair is ordered by `needs`. **The same goes for a person: never stop
a local `wrangler tail --env loadtest` while a run is in flight**, because it deafens the
run's archive. An archive that ends early while its process stayed attached is this, not
a quiet Worker.

**The report's "where each burst's time went" lines** (`scripts/loadtest/burst-breakdown.ts`,
never a bar) match every burst request to its own confirm's log lines and then say,
per burst, where the winner's, the SLOT_TAKEN losers' and every other refusal's time
went: the driver's wall time and the route's own answer time, the invocation's CPU,
the wait before the profile by span, the stage profile a slow or timed out confirm's
`confirm answered` line carries (#3300), and the refusing stage. For SLOT_TAKEN the
stage is tallied by name; for every other refusal it carries its per rung counts
(`code:members/read/claimed/checked`, #3272), and a refusal whose line names no stage
(a dependency timeout) is said to have none and whether it timed out.

The pairing of a confirm's lines with each other is the archive's ONE reader,
`tailInvocations` in `confirm-startup.ts`, the same the startup split uses. What is
added is tying each request in the driver's burst files to its invocation, by the
deployment's own answer stamp: the route writes `confirm answered` and then stamps
`x-loadtest-answered-at` with no I/O between, and a Worker's clock moves only at I/O,
so the line's timestamp IS the stamp the driver recorded. Checked against run
37520312761's steady pass: all 528 answer lines its archive held matched one request
each, none ambiguously, every invocation starting within two seconds of its request
being sent, and a control with every stamp moved by one millisecond matched none. The
72 requests left unmatched were all missing from the archive (70 sent before its
tail connected, 2 in its first seconds while it attached). A burst answers many
requests on one millisecond (32 of burst 1's 100 share address, stamp and status
with another), so the key also carries what the deployment echoed about the line
(which line, why, which key, its milliseconds), which leaves 2 and 4 in a hundred
sharing a key. Requests with an identical key, as many as the confirms carrying it,
all ending the same way, are matched as one block, since which is whose cannot change
a figure reported per outcome. Anything else sharing a key is counted as ambiguous
and left out, never assigned by a guess (L521).

Every way of learning nothing is **UNMEASURED** in its own words, never a quiet burst
(L98): the burst tail never arriving, arriving unreadable or empty, holding no burst
confirm's answer line, and a burst none of whose requests matched (with when the tail
ran and when the burst fired). A run that was not judged still prints the section.

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

Before the FIRST deploy of a fresh setup, deploy the object workers the load test binds
(#3500, #3555, #3512): `node --experimental-strip-types scripts/deploy-object-workers.ts --env loadtest`.
The load test Worker's `CONFIRM_LINE`, `BURST_LIMITER` and `TOKEN_HOLDER` name
`slate-confirm-line-loadtest`, `slate-burst-limiter-loadtest` and
`slate-token-holder-loadtest` by script, so a Slate deployed without them has no object
to reach. The run's arm job runs the same script when it redeploys, and like the
production deploy it deploys a Worker only when its bundle or config differs from the
version serving (#3561), printing which it skipped and why, so an unchanged line object is
not restarted between runs.

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

**Between runs the Worker holds none of them, and is idle (#3310).** The load test
Worker is kept between runs, and teardown takes all three secrets away rather than
deleting it. A deployment missing ANY of the three is idle (`loadtestIdle` in
`src/lib/loadtest-secrets.ts`): every request is answered with a 503 whose body names
what is missing, `{"error":"loadtest deployment idle","missing":[...]}`, before the
app is reached, and every cron tick runs no lane and logs one `loadtest-idle` line.
That line is how you see, between runs, that Cloudflare is still delivering the
Worker's crons (`npx wrangler tail --env loadtest`). So provisioning a run means
putting all three with `wrangler secret put <NAME> --env loadtest`, which prompts for
the value. A run dispatched one short stops at the preflight, which names what is
missing rather than waiting out the cron deadline for lanes that cannot run.

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
| `busy-minutes` | **held back** | reads cal.com and pages Slack about the branch's synthetic bookings (#3124); the lane also stands itself down on `isLoadtest()` |

A lane added later is covered by construction: the known set is derived from
`CRON_ROUTES` rather than listed beside it, so a new lane is either in the disable
list or it runs, and the guard names it either way.

## Judging the booking path run (#2244)

`.github/workflows/loadtest.yml`, **`workflow_dispatch` only**, because a run
creates about seven hundred bookings at 90 advisors. `concurrency: { group: loadtest,
cancel-in-progress: false }`: a half run leaves a seeded branch, a deployment and
hundreds of bookings behind, and the next run seeded on top of them would report
clashes this one created. Every job carries a timeout.

### A freshly created deployment is not warm, and the preflight waits for it (#2347)

**Since #3310 the cron wait below is paid once, not on every run.** Teardown keeps
the Worker and takes its secrets, so its crons go on arriving between runs, and a
run's deploy is a redeploy of a Worker that is already ticking: a redeploy kept
delivery flowing on 2026-10-05. Before that, every teardown deleted the Worker and
every run created a new one, and Cloudflare took 27, 28, 33, 38 to 50, and 105
minutes to deliver a new Worker's first cron. The wait now applies only when the
Worker is first created, or after somebody deletes it, and the preflight still waits
for it whenever it does.

**A Worker that was created a minute ago will offer no times, and nothing is
wrong.** Run 34974744173 failed preflight forty seconds after the deploy on
`bucket 112 is offering no times`, and two minutes later the same deployment
offered 42. Teardown runs on `if: always()`, so that refusal destroyed the Worker
and the branch it had not tested, costing about fifteen minutes to rebuild.

Two things about a brand new Worker, both measured on 2026-09-15:

- **Cron delivery is not immediate and is not a fixed delay.** One Worker received
  its first scheduled invocation about six minutes after it was created; the one
  before it never received one in the seventeen minutes it lived. On 2026-10-04
  (#3229) a healthy Worker had all 13 schedules listed at deploy time (17:41 UTC)
  and stamped its first lane at 18:07 UTC, **27 minutes later**. Until then
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
   `WARMUP_CRON_DELIVERY_DEADLINE_MS`, **38 minutes**. It was twelve until run
   37221540890 refused a healthy deployment whose first tick arrived at 27
   minutes (#3229), so it now sits well past the slowest delivery measured and
   stays bounded (L110). The preflight job's `timeout-minutes` is 60, the ceiling
   every job carries, and `scripts/test-loadtest-warmup.ts` fails if it drops
   below the deadline plus two stored row waits (#3236) plus ten,
   so a slow delivery ends in the preflight's own wording rather than a job
   cancellation;
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

**Before dispatching, confirm the lanes are stamping.** After the `loadtest`
Worker is created or redeployed, read the branch's `lane_heartbeats` (read only)
and wait until at least one lane in `DELIVERY_LANES` (`scripts/loadtest/preflight.ts`)
has a `last_ran_at` no older than `WARMUP_CRON_FRESH_MS`
(`scripts/loadtest/preflight-checks.ts`). That is the same test the preflight
applies, so read the lane list and the bound from those two constants rather than
from this page. The read is the preflight's own, with `<DELIVERY_LANES>` standing for
that list joined with commas:

<!-- runbook-reference: a PostgREST path template, not a command; `<DELIVERY_LANES>` is
     a placeholder for the constant in scripts/loadtest/preflight.ts, which builds the
     same path and reads `lane` and `last_ran_at` (columns from
     supabase/migrations/0055_lane_heartbeats.sql). Read only, against the loadtest
     branch, never production. -->
```
lane_heartbeats?select=lane,last_ran_at&lane=in.(<DELIVERY_LANES>)
```

A dispatch onto a Worker that is not yet ticking spends its preflight waiting, and
if the delivery outruns even `WARMUP_CRON_DELIVERY_DEADLINE_MS` the run refuses and
measures nothing. Waiting outside the run costs no Actions minutes; waiting inside it does.

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
  not on for that deployment and the run is about to create hundreds of real
  calendar events and send hundreds of real invitations, which is the single most
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

Ahead of the control booking, before it drives a lane or writes anything, it refuses a
branch whose **shared confirm line switch is off** (#3325). The run exists to measure
that line, whatever production's switch says, so the seed writes
`booking_settings.shared_confirm_line = true` (`SEED_BOOKING_SETTINGS`), the load test
Worker's `SHARED_CONFIRM_LINE_DEFAULT` is `"on"` for an isolate that has not read it
yet, and the preflight reads the branch's row and names which way it was wrong: off, no
settings row (the current seed did not finish), or a read the branch refused (a 400
usually means it predates migration 0169).

### CPU cannot be apportioned by stage, and the report says what it can (#2353)

Run 34980777198 failed one bar: request CPU p99 **2,777ms** against 2,500ms. It
was not cold start (3 of 588 confirms were the first on their isolate, by the module stamp then in use). The six
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

**Placed lanes (#3693).** A tick now sends each lane over the Worker's binding to
itself, so a lane's CPU is spent in its own FETCH invocation, addressed to
`https://slate-loadtest.invalid/api/cron/<lane>`, and the scheduled invocation holds
only the dispatcher. The archive reader counts those placed invocations as cron work
under `placed /api/cron/<lane>`, and checks them against the `lanes_placed` count on
each tick's `lane timings` line. Ticks reporting placed lanes with none of them in the
archive refuse the cron half rather than judging the dispatcher; a few missing (a
stream attached mid tick) are counted as unread CPU. The analytics dataset holds
scheduled invocations only, so once lanes are placed the archive is the source.

### What the judge refuses to do

**It will not judge an incomplete run.** Three driver files out of four, or a
sampler that stopped after two minutes, is computable and every rate looks
plausible: the p95 of a short run is lower and the confirmed-per-minute of a
missing driver is a quarter down, and nothing in the numbers says which. So
`incomplete` is its own verdict on its own exit code and **nothing is measured at
all** (L288).

**A burst that did not happen as configured FAILS that burst instead (#3222).** A
burst driver that missed its moment, a burst file that never arrived, or a driver
that fired part of its plan is a `the burst` finding with its reason, naming WHICH of
the three bursts (#3325), and the contention questions are not asked of that burst
(one winner per agent, and every #3429 clause, would be answered by however many
drivers happened to arrive).
The other bursts are still asked it. Two files claiming one driver inside ONE burst
is incomplete; the same driver across three bursts is the plan. It used to be incompleteness, and since a
late burst driver exits non-zero by design, the burst job failed and the steady
pass, freshness and the archive (and the ceiling and fault legs behind them) were
skipped: one late driver cost the run every figure. Those jobs now run on an
explicit `if: ${{ !cancelled() && ... }}` that requires the preflight and the burst
setup but not the burst, held by `scripts/test-loadtest-driver-deadline.ts`.

**A slow run is not an incomplete one (#3222).** The drivers send one request at a
time, so a slow deployment stretches the run: on 2026-10-04 (run 37215457763) a ten
minute plan took fourteen to sixteen, one driver met the job's timeout, wrote
nothing, and the judge could only call the run incomplete, so the run produced no
verdict on the latency bar it should have failed. Each steady and fault driver now
keeps a deadline of its own (`driverDeadlineMs` in `book-plan.ts`: the time the plan
takes when every request sits at the 5,000ms bar plus the slowest overhead seen, held
at three quarters of the deadline: about twenty one minutes for a steady plan of
fourteen a minute), stops there, writes a whole file marked `cutShort` with the count it made,
and exits zero so the ceiling check and the fault pass still run. Every request also
carries its own abort (`requestAbortMs`: thirty seconds, and never more than a minute
past the deadline, inside the grace before the job's timeout), so a request that never
answers is recorded as `timed-out` and fails its own **timed out requests** bar rather
than keeping the driver from writing its file. The same abort covers a body that stalls after its headers and the fault leg's version polling. A FIRST availability read for a code that is refused (a 429 from the shared per address ceiling), times out or fails leaves the driver with no view of the bucket's times, so the request is recorded as `availability-unread` and fails its own **requests never sent** bar (#3348); it used to read as `no-slots-offered`, a bucket offering nothing, for a request never sent. Later reads that fail keep the last view, as before. The availability read has its own test seam, `DRIVE_AVAILABILITY_TIMEOUT_MS`, apart from the booking request's `DRIVE_REQUEST_TIMEOUT_MS`. The archive's log window is derived too (`archiveTailMinutes`, one minute past the drive job's timeout), so a slow run keeps its last log lines. The judge scores
that file: the latency bar on what ran, and a failing **planned bookings completed**
bar naming the driver, how far it got and the share of the run that completed. The
drive job's `timeout-minutes` is derived from the same deadline plus setup and grace
(`driveJobTimeoutMinutes`), and `scripts/test-loadtest-driver-deadline.ts` holds the
workflow's number equal to it. A steady driver with NO usable file stays incomplete,
named by its cause: a `driver-N.json` that could not be parsed, one in another mode,
or no file at all (it hung or crashed before writing one, or its artifact never
arrived). The fault drivers' files get the same file checks as the steady ones.

### The bars

| bar | what it is |
|---|---|
| planned bookings completed | every steady driver ran its whole plan. A driver that stopped at its own deadline FAILS this with the driver, how far it got and the run's completed share (#3222); every other bar is still scored on what ran |
| confirmed a minute | at or above 80 percent of target, with the full outcome mix printed so a short run says WHY. The target is the steady drivers times their pace: at 90 advisors exactly the load bar, `LOAD_RUN_BOOKINGS_PER_MINUTE` (70, so a floor of 56); at 200, twelve at fourteen (168, floor 134.4) |
| latency | p50, p95 and max over ALL responses. The p95 of the **200s** must pass TWO checks (#3258, #3517): the **ratio**, at most `LOAD_OVER_REST_RATIO_BAR` (2.5) times the median of the **same day baseline** (bookings at rest on the same deployment just before the steady pass, sent from `BASELINE_RUNNERS` (3) runners taking turns (#3914), each runner's first `BASELINE_WARMUP` (2) dropped as a warm up and the median pooled over the `BASELINE_BOOKINGS` (21) measured after them), and the **fixed limit**, at most `STEADY_P95_LIMIT_MS` (1,800ms) whatever the baseline reads. A failure names which check failed, the ratio, the fixed limit or both, and states both numbers. The fixed limit is not applied to a run dispatched with a Google delay (#3490), which it was not calibrated for, and the report says so. A run with no baseline leg (a hand run) is held to the old fixed 5,000ms bar and says why; a baseline the workflow ran that did not arrive, arrived twice from one runner, is missing a runner, could not be read, came from another run or has a runner that confirmed fewer than `BASELINE_MIN_OK_PER_RUNNER` (5) of its 7 measured bookings voids the **speed verdict only** (Dan, 2026-10-05): every other bar is still judged; a run clean on all of them is UNMEASURED (exit 3), never a pass, and a failure on any of them still FAILS it. See "Latency is judged against its own day" below |
| 5xx and no reply | counted **separately** and both fail: a request answered badly and one never answered send two different people to two different places |
| resent requests | a request whose connection dropped (no reply of any kind, not the driver's own timeout) is sent once more after a 500ms pause, by the same rule the booker's confirm uses for a lead (`resendOnce`, #3566), and its record carries `resentAfter`, the first send's failure with its cause. One answered on its resend is not unanswered; one still silent fails under no reply. The run fails at **3 or more** resent requests over steady, bursts and the fault pass (`RESENT_FAIL_AT`, Dan 2026-10-14), because a cluster means something is turning connections away. The report prints the count and causes on every run |
| requests never sent | a request whose bucket's times could not be read at all (`availability-unread`, #3348) fails here, never under no reply: no booking was sent to go unanswered, and the run did not drive the load it planned |
| double bookings | no two run-scoped ACTIVE bookings overlap on one agent in `[starts_at, ends_at)`, read through a **paginating** list, and the preflight must have seen `bookings_active_slot_uniq` actually REFUSE a planted duplicate (without that, an absence of overlaps proves nothing). The count is printed in the measured section on EVERY run, with its denominator and the same-slot count beside it, because a measured zero and a check that never ran read the same when neither prints (#2323) |
| every 200 left a row | a booking row carrying the request's external id, an idempotency key, and a `busy_blocks` row |
| the burst | judged **per burst**, three a run (#3325), and any one failing fails the run; every finding names its burst and its kind (`burst 2 of 3, the tier drop burst (slot)`), and the report opens with a line naming each burst that failed. Per burst: one winner **per agent** (#2273), every answer that is not a 200 a `SLOT_TAKEN` (the losers bar, so a 503 the line could not serve inside its wait fails here on either kind), and each winner really exists. A burst that was configured and produced fewer driver files than fired, a driver that missed its moment, or one that fired part of its plan **fails** that burst with its reason (#3222), never a skipped bar. Each burst's report line states what its ladder held and how many were free at the slot when planned, since that is what the control was worth (#2278, #3429) |
| the burst's refusals | no `SLOT_TAKEN` while the slot still answers available once the burst settled, by every driver's probe of `/api/bookings/bookable` (#3429). Free on the requested rung itself **fails on any build**; free a rung or more down **fails naming #3338** on a deployment that says a crowd walks the ladder, is **named, not failed**, on one that says it stops (the rule before #3437), and **cannot conclude** on one that said nothing. A probe that could not be used (refused, unreadable, never recorded, sent before the burst settled, or probes that disagree) **cannot conclude**, never a pass |
| the tier drop | the drop burst only (#3429), held to the declared rule. On `walks`: every confirm wins (a `SLOT_TAKEN` the slot still answers available for has already failed the refusals bar; one where the slot was honestly spent means the crowd outran the ladder and **cannot conclude**), and at least one winner says it was booked below the requested rung, or it **cannot conclude** (an answer that does not say which rung is never read as dropped). On `stops`: it must see a `SLOT_TAKEN` while a rung below is free, the defect that build declares, or it **cannot conclude**. With no declared rule it **cannot conclude** |
| the burst's line | every answered confirm in the burst carried `x-loadtest-confirm-line: shared` (#3325). Otherwise it fails naming the counts by line and reason (`shared/ok 96, fallback/reach-timeout 3, no line header 1`). A deployment that says nothing at all fails as "the deployment did not say which line served the burst", which is every run until the shared line ships: nothing to object to is never a pass (L98). The share of the burst's confirms that took a `ladder` key is **reported**, not barred |
| the burst's speed | the **refusal control** only (#3429): every `SLOT_TAKEN` was answered within `BURST_LOSER_LAG_MS` (2,000ms) of the burst's **last** 200, both read on the deployment's own `x-loadtest-answered-at` stamps rather than four runners' clocks (#3325). The last winner, not the first, because a crowd walking a ladder produces one winner per free advisor at different moments. Once a crowd walks the ladder its losers are still answered from a leader's verdict, now the verdict of the confirm that spent the WHOLE ladder, so the bar keeps its meaning: how soon a crowd is told once the last free advisor anywhere on the ladder is gone. It **fails as unmeasured**, never passes, when any burst answer carries no readable stamp, when nobody won (no winner to measure against), and when nobody lost (nothing tested). The drop burst is not asked it: on a build that walks it has no losers, and "every confirm wins" already bounds its time, because a confirm the line cannot serve inside its wait answers a 503; its report line gives the first to last winner's spread instead, never a bar |
| freshness | the worst oldest-bucket age across the window under 6 minutes |
| the per address ceiling | its own step, run AFTER the steady pass so it has the API key's budget to itself, sends from one address until the deployment CREDITS a refusal to the per address ceiling, up to past the exact 1,200 an hour cap. It reads back both echoes: the address it was keyed on (unidentified, several, or unechoed each get their own conclusion) and WHICH ceiling refused, so a per key refusal is never counted as proof of the per address one (#2339) |
| confirm startup | what a lead waits BEFORE the confirm begins, read from the run's own archived log and judged only on the confirms that were their isolate's FIRST request by the Worker's own count (`isolate_invocation_index=0` on the confirm's `confirm answered` line: no earlier HTTP request, cron tick or receipt had run the app on that isolate, #3418), with EVERY such confirm, the slowest included, under `REQUEST_STARTUP_MS` (what is left of the latency bar once the confirm's own CPU share is taken out; Dan, 2026-10-16). Three ways it FAILS without a slow start: no archive at all, an archive holding nothing readable (the stream is written under a `wrangler tail` timeout, so its last line is routinely half written), and a reading in which nothing was its isolate's first request (said as a reading that broke, unless the module stamp shows confirms that loaded the confirm's code on an isolate already running, in which case isolates started on other requests first and it says that instead). Two more since #3418: a reading in which no confirm carried the invocation index (an older deployment, or the answer line lost), and one in which SOME did not, because a first request among them would be missing from the population judged. Each has its own sentence, because nothing to check is never a pass (#2340, L98). The bar used to judge the module stamp's cold (the confirm module evaluated inside the request), which also counts the first CONFIRM on an isolate that had already run the app: run 37520312761 printed 8 cold by the stamp and 4 by the Worker, and the 4 the stamp alone counted had no gap at all between the invocation starting and the Worker's handler being entered, against 585 to 1,021ms on the 4 real first requests. Its cold p95 was 2801ms either way, because the slowest was a real first request. The stamp now only names where it disagrees, on the report's wall time line, which states one count. The report's "wait before the profile, by span" line splits the wait this bar judges, from marks each confirm takes at fixed points (Worker entry, handler, auth, the first line call, the line's answer, the person decision, the profile), filed cold and warm. Each side leads with the isolate's own start (#3436), measured from the invocation's `eventTimestamp` in the tail to the Worker's entry stamp on the answer line (`wait_entry_at_ms`): every mark begins at the entry, so on run 37520312761 that start (585 to 1,021ms on the four first requests, 0 to 2ms on every other confirm) was in no span, and the "whole" span (now "whole from the Worker's entry") read as the whole wait. A confirm with no entry stamp is counted on its side, never read as zero. The bar does not read this span, because the wait it judges already starts at the invocation; only its sentence names it. It names no cause on its own: on run 37390071571 the confirm line, not only the bundle, was in that wait. It was judged on the cold p95 until 2026-10-16, which is `s[floor(0.95 n)]`: the slowest of a handful (4 on run 37520312761, #3418) but the second slowest of 22, so run 38933668981 passed on a cold p95 of 1699ms with one cold confirm waiting 4562ms; it now judges the slowest, as #3353 always meant it. Two more report lines beside it (#3354), neither a bar. "By origin" files every confirm under the Worker version that served it and the leg that sent it (each sender names its leg on an `x-loadtest-leg` header: the four driver modes, `preflight` and `ceiling`), with each group's cold count, its slowest cold confirm and its warm p95. Read on run 37390071571's archive, the slowest cold confirm (2782ms) came from the main deployment, not from the fault leg's redeploy (whose four were at most 2275ms). "The shared line's wait" splits each traced confirm's `wait_line_ms` by the line object's own log of the calls it waited for: polls (held behind a leader), the object's work on every other call (never the lead's ack, which the client sends without waiting for it, #3813), and what is left, which is the network, the object starting and the client's own work between calls. The client sends a trace only under SLATE_LOADTEST, so the object logs nothing for a production call. A traced confirm whose calls never reached the archive is counted as missing, never as a split of zeroes. Since #3500 the object runs in its own Worker and logs its calls to THAT Worker's tail, so the archive job also tails it into `line-tail.jsonl` and the judge reads the two together (#3781); before that every traced confirm read as missing (run 38833395446: 0 of 537), and a run whose `line-tail.jsonl` never arrived says so on this line. The live tail samples at load test volume (run 38912230442 caught about one line call in five), so the judge reads the calls from Cloudflare's stored logs (`scripts/loadtest/stored-line-calls.ts`, #3815), one minute at a time, halving any window that fills a page, and joins each log row to its invocation record for the wall time; it falls back to the tail when the stored logs hold fewer calls than the tail caught (not yet ingested) or refuse the token, and the line says which it read and both counts. The cold leg does not tail the line Worker, so its own split still reads as missing |
| platform | CPU p99 under the REQUEST budget (`REQUEST_CPU_P99_MS`, half the latency bar, and applied only to a window with no cron in it), the cron half under `limits.cpu_ms`, and **no invocation outcome other than `ok`**. The cron half is reconciled against the run's own archived log (#2352): `workersInvocationsScheduled` has never once reported a tick for a load test Worker, so a zero from it alone is the reader being blind and the window may only be called empty when BOTH sources say so. It used to borrow the 200ms LANE budget, which is a different question about a scheduled tick (#2321). The finding NAMES the startup split beside it, because this percentile counts the isolate's own startup as the confirm's compute (#2340) |
| the fault pass | at `SLATE_LOADTEST_FAULT_PCT=10` on the systems in `fault_targets` (calendar reads by default), zero 5xx while every faulted system is one the path degrades around, and a pass that SENT no requests fails rather than passing on an empty sample. The fault drivers run the steady loop, so an attempt whose bucket's times could not be read is counted and never sent; the pass is judged on the requests it sent (#3348), and with only degrading systems faulted an unsent one fails its own **fault pass requests never sent** bar. With `google-write` or `supabase` faulted the 5xx count is reported, not barred, because a failure there is a 5xx by design (#3104), and so is the unsent count, since the availability read meets the same designed failure. A pass whose deployment reported a DIFFERENT percentage or different systems is incomplete, and zero is the case that matters: it passes the bar having injected nothing |
| the cron lanes under fault | sampled every 15 seconds for the whole faulted window by `fault-lane-sampler.ts` and scored by `fault-lanes.ts` (#3104): no lane the deployment runs goes past its stale bound at any reading, every one minute lane stamps inside the window (when EVERY lane stops together for longer than the shortest bound, that stretch is reported as the crons not firing rather than a dependency, and each lane's stale readings inside it point at it; still a failure, #3746), the lane watchdog records no stale page, and, when calendar reads are faulted, the `sync_failures` page is recorded once per change: a second send naming no new agent and no worse band is the throttle failing (#3801, #3890). A missing lane file, or a series with a hole in it, is incomplete rather than healthy |

**The steady pass's line is reported, never barred** (#3325): the share of its
answered confirms per line and reason, and `x-loadtest-confirm-line-ms` p50 and p95,
labelled as the absolute time the line added per confirm. It sits beside the speed
ratio bar because the ratio alone hides an overhead the at rest baseline pays too. A
confirm with no readable time is counted as unread, never scored zero, and with no
readable time anywhere the percentile is null rather than 0.

### The burst, judged against the build's own rule (#3429)

The walking crowd rule #3437 proposed shipped inside #3522 (`CONFIRM_CROWD_RULE =
"walks"` on main since 2026-10-15), and #3437 itself was closed as superseded. The judge
still never assumes which build it measured: each burst is held to the confirm crowd rule its drivers read from the
deployment, and neither build passes a bar that never asked. What each burst shows,
and how it is read:

| | build that says `stops` (before #3437) | build that says `walks` (#3437) |
|---|---|---|
| refusal control | the top rung's free advisors win, the rest `SLOT_TAKEN`, and the slot still answers available a rung down: #3338's known defect, **named on the burst and in the summary, not failed** | at most the ladder's capacity wins, the rest `SLOT_TAKEN`, and the slot answers taken: **passes**. A `SLOT_TAKEN` while it still answers available **fails naming #3338** |
| tier drop burst | the top rung's one advisor wins and the rest are `SLOT_TAKEN` while a rung below is free: the control that the defect is visible, **named, not failed**. No such `SLOT_TAKEN` at all **cannot conclude** | every confirm wins, at least one a rung down, on distinct advisors: **passes**. A `SLOT_TAKEN` while a rung below is free **fails naming #3338** |

Either way, a slot still free on the REQUESTED rung itself while confirms were told
it was taken fails on any build, because that is not #3338's shape. A deployment that
declares no rule (one built before #3429) leaves the drop burst nothing to be held to,
and it cannot conclude.

**Cannot conclude is its own outcome.** A clause that could not conclude is listed
under "What the bursts could not conclude" in the report, beside the findings and
never among them, and the burst's line says COULD NOT CONCLUDE. On a run with no
finding the verdict is **INCONCLUSIVE** (exit 5) with every figure still measured, never
a pass (L98); a real finding anywhere outranks it and the run fails. It has its own
code rather than INCOMPLETE's (exit 2), which means the run did not happen as asked and
nothing was measured: "re-run it" and "read why the burst could not conclude" are two
different things to do. It outranks the
two readings that measured nothing, an unmeasured speed verdict and a platform half
the analytics could not give, which are still reported beside it. A clause that a
refusals finding has already failed (a slot still free on the requested rung) is not
asked again by the tier drop bar, so one fault is reported once. A declaration
that disagrees with the build is caught in both directions: a build that walks while
saying `stops` gives a drop burst where everyone won, which cannot conclude, and one
that stops while saying `walks` fails the drop burst naming #3338. The first is not a
failure on purpose: on a `stops` build a confirm that is not held behind another walks
the ladder on its own (`assignAgentWithTierFallback`), so twelve winners, some a rung
down, is also what a stops build gives a drop burst whose confirms never met in one
crowd, and nothing a confirm's answer carries says whether it was held behind a leader.

**When a burst settled** is its moment plus the longest grace any of its drivers
recorded (`BURST_GRACE_MS`, how late a driver may still fire) plus the longest request
bound they recorded, computed by the judge from what each driver was configured with,
never from a driver's own word about its settle. A file that records neither is read on
the defaults every workflow run uses; a recorded figure that is not a whole number of
milliseconds leaves the settle unknown, and the burst's refusals cannot conclude.

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

### Latency is judged against its own day (#3258)

The fixed 5s p95 bar was judging the throwaway environment more than the code. The
09-15 code passed it on 2026-09-15 at 3.5s and measured 7.0s on 2026-10-04 on the same
rig, and that day's three arm experiment measured 6.6s with the suspect removed. No
change could pass on its merits on such a day, and a pass on a fast day said nothing
about the code either.

So the workflow's `baseline` job books at rest, one every ten seconds, after the
preflight and before the burst and steady passes, and the judge holds the steady p95
to a multiple of that baseline's median (`scripts/loadtest/latency-bar.ts`). The
multiple is what the code controls: how much the steady load slows one booking down.
The environment cancels, because both halves ran on it within minutes.

**The baseline drops a warm up and takes twenty (#3517).** Twelve bookings at four a
minute swung the median from 580 to 842ms on three runs of ONE commit while the steady
pass's own p50 sat at 595 to 625ms, so the verdict followed the baseline. Measured on
the recorded runs: the first at rest booking is the slowest on most runs (1.58 times
the rest on the median run, over 1.5 times on 9 of 13), because it is the first call
to the per address exact ceiling's object for the baseline runner's address and this
run, which took 251 to 350ms against about 45ms afterwards. Cold isolates were not
the cause at this pace (1 of 36 baseline confirms read from the server logs). The
rest was one runner's placement: on the slow run that same object answered in 215ms on
the median call against 42 and 55ms on the other two, and the baseline is a single
runner while the steady pass is nine. So each driver drops its first `BASELINE_WARMUP`
(2) by position, never by speed, and the median is taken over more bookings, which a
bootstrap over the pooled runs puts at plus or minus 5.6 percent for twenty rather than
8 for twelve.

**And it is spread across three runners (#3914).** Dropping the warm up left the
per runner part: one runner's address still decided the whole baseline, and a FAST
placement could make the ratio too strict as easily as a slow one made it loose. So the
`baseline` job is a matrix of `BASELINE_RUNNERS` (3), each its own address and so its
own limiter object, each sending `BASELINE_PLANNED` (9: its warm up and 7 measured), and
the judge pools the median over all 21 measured bookings, the way the steady p95 is
pooled over its drivers. One runner whose object answers slowly or quickly is then a
third of the sample, not all of it. Two things keep it a measurement at rest:

- the runners **take turns** on one ten second clock (`baselineStartAtMs`): mark k of
  the epoch belongs to runner k modulo three, and each runner books once every three
  marks from its first turn, so the deployment sees one baseline booking every ten
  seconds and never two at once, however the runners' starts fall;
- each offered time **belongs to one runner** (`baselineOwner`, a hash of the instant),
  so two runners never book one time and none walks a ladder another emptied.

Judging the ratio on the server's own time instead was weighed and rejected: the 215ms
was measured on the server, inside the confirm's call to that object, so a server side
time carries the same placement. The judge refuses a short spread rather than pooling
it: a runner whose file never arrived, or that confirmed fewer than
`BASELINE_MIN_OK_PER_RUNNER` (5) of its 7, makes the speed UNMEASURED, naming the
runner. The report's latency line gives the pooled median, each runner's own median
and warm up times, and how many addresses the deployment saw across the runners (the
limiter keys on that address, so fewer addresses than runners means some runners
shared an object, and the line says so).

**What it costs.** About a minute more on the run's critical path (each runner is 240s
of bookings plus up to 30s for its first turn, against 210s), and about ten more billed
minutes a run on ubuntu-latest: three jobs of about five minutes each against one of
four or five. Three runner slots for those minutes, at a point in the run where nothing
else runs. The fixed limit below stays, for a change that slows every booking at rest.

**And a fixed limit holds whatever the baseline reads (#3517, Dan, 2026-10-18).** The
steady p95 must also be at most `STEADY_P95_LIMIT_MS`, 1,800ms, so a run whose baseline
read slow cannot pass at a slow absolute speed. It was calibrated on the 200 advisor
runs of #3829, Large compute, the Google stand in answering at once, after #3884: runs
3 to 9 measured 1310 to 1609ms (passing runs 4, 7, 8 and 9: 1488, 1446, 1423, 1609),
mean 1466ms. 1,800 is 12 percent over the slowest and about three deviations over the
mean, clear of the dense middle (L172), and run 2's measured regression (1989ms, cold
isolates before #3884) fails it. A run dispatched with a Google delay (#3490) is judged
on the ratio alone and its report says the limit was not applied. Recalibrate it,
beside the figures in `latency-bar.ts`, when the rig changes.

Each baseline booking takes the SOONEST time its code offers that the baseline has not
already booked, never a random one
(#3782). The bursts are planned on the latest times, after the baseline, and the tier
drop burst's ladders offer only four or five; a baseline booking that landed on one
took an advisor the burst could not spare and its setup ended on exit 9 (runs
38761057057 and 38800509328, both with a baseline booking on 312 at the drop slot).

**What the ratio cannot see:** a change that makes every booking slower at rest
raises the baseline and the ratio bar with it. The fixed limit is what catches that,
and the baseline median is printed on every run beside both checks.

**An unusable baseline voids only the speed verdict** (Dan, 2026-10-05). Missing,
doubled from one runner, short of a runner, unreadable or malformed, from another run,
a runner with fewer than 5 of its 7 measured bookings confirmed, or a
results directory that could not be listed: the burst, steady, fault, overlap and
freshness bars are judged as usual. If any of them fails, the run FAILS (exit 4) and
the verdict line adds that the speed was also unmeasured. If every one passes, the
run is **UNMEASURED** (exit 3), never a pass, so the workflow is not green: finding
nothing about speed is not a result about speed (L98). The line reads "every other
bar passed, and speed was UNMEASURED because ...".

**The multiple, 2.5, is no longer provisional (#3517).** Dan approved it on 2026-10-05
as provisional, set from the 2026-10-04 arms with single at rest bookings standing in
for a baseline. The runs since then carried a real baseline: the passing 200 advisor
runs on edc42c10 read 2.5, 1.7 and 2.4 times, and the known regression (run 2 of #3829)
2.7. What moved those ratios was the baseline rather than the steady pass, so #3517
steadied the baseline and added the fixed limit, and kept the multiple.

### The report outlives the branch

The judge writes ONE dated report and uploads it `if: always()`. Teardown `needs`
the judge, so it cannot race the read. It then deletes the branch and takes the
Worker's secrets, confirming each by reading the result rather than trusting the
command that did it (see Tearing down).

### One hand-off before the first run

The workflow references eight repo settings that do not exist yet, and
`pnpm check:workflow-settings` names them with the command to create each. They
cannot be created until the isolated Supabase branch and the `loadtest` Cloudflare
environment exist. Nothing can be dispatched into a misconfigured state in the
meantime: **every script the workflow runs refuses an empty value by name** rather
than reading it with a `??` fallback that an empty string would slip past (#1498).

## The run record (#3103)

**When a run is due.** A push to main that changes the confirm path or a cron lane
opens one "Load run due" issue, or comments the push onto the one already open
(`.github/workflows/loadtest-due.yml`, the paths in
`scripts/lib/loadtest-due-paths.ts`). That issue closes from the pull request that
adds a passing run below, and only once the run covers every push listed on it.

**What a row records.** The run id, the commit it ran, and the figures the judge
printed, read from the judge job's own report (`gh api
repos/Try-Pennie/slate/actions/jobs/<judge job id>/logs`, or the run's
`loadtest-report` artifact), never copied from a summary. Steady p95 is judged
against the same day baseline median (#3258, bar 2.5 times); cold is the wait
before the confirm on confirms that were their isolate's first request; the worst
cron tick is CPU against the 120,000ms kill. Every run below is on a Large branch
matching production (#3751), with the post confirm recompute arm on.

| run | commit | judged (UTC) | confirmed | baseline median | steady p95 (ratio) | cold n | cold p95 (slowest) | worst cron tick | 5xx | overlaps | fault pass | bursts |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 38822483471 | c434960a | 2026-10-16 00:04 | 598 of 600 | 801ms | 1077ms (1.3x) | 24 | 1845ms (1909ms) | 1989ms | 0 | 0 of 676 | 0 5xx of 30 | 3 of 3 |
| 38828051296 | c434960a | 2026-10-16 01:00 | 598 of 600 | 729ms | 932ms (1.3x) | 12 | 1530ms (1530ms) | 2236ms | 0 | 0 of 676 | 0 5xx of 30 | 3 of 3 |
| 38833395446 | c434960a | 2026-10-16 02:01 | 600 of 600 | 1007ms | 1045ms (1.0x) | 14 | 1832ms (1832ms) | 2195ms | 0 | 0 of 678 | 0 5xx of 30 | 3 of 3 |
| 38933668981 | f61d18b0 | 2026-10-16 17:42 | 580 of 600 | 912ms | 1334ms (1.5x) | 22 | 1699ms (**4562ms**) | 1858ms | 0 | 0 of 644 | 0 5xx of 30 | 3 of 3 |

Common to all four: no request went unanswered, timed out at the driver or was
resent, the fault pass failed 10 percent of Google reads with no 5xx, the cron
lanes under fault failed none of 21 or 22 readings, and every burst passed. The
refusal controls (bursts 1 and 3) had 16 and 7 winners out of 100 on each of the
three c434960a runs, and 7 and 3 on 38933668981; every loser answered SLOT_TAKEN within the 2000ms bound; the tier
drop burst booked 12 of 12, 11 of them a rung below the one asked for, on a
deployment that declares a crowd walks the ladder. The other 20 of 600 on
38933668981 and 2 on two of the c434960a runs were SLOT_TAKEN, which is the run's
own leads meeting each other, not a failure.

What the record says, and what it does not:

- **The three c434960a runs are consecutive passes on the same code**, the first
  streak since the branch was made Large, and each holds every cold confirm under
  `REQUEST_STARTUP_MS` (2500ms), the bar as it reads since #3824.
- **38933668981 passed under the bar as it read that morning, and would not pass
  under the bar as it reads now.** It was judged on the cold p95 (1699ms), and its
  slowest cold confirm waited 4562ms. That is exactly the case that made #3824 hold
  every cold confirm, so the row stands as a pass of its day and as the evidence for
  the stricter bar, not as proof a first confirm on f61d18b0 is fast.
- **The cron CPU worry #3103 named is gone on these runs.** Run 34991614423 passed a
  minute tick at 119,137ms of the 120,000ms kill (#2357, below); the worst tick on
  these four is 1858 to 2236ms, 1.5 to 1.9 percent (the judge prints it rounded
  down, as 1%), with the placed lanes judged under
  their own names from the run's archived log (#3693).
- **Main has moved past every run here.** 38933668981 covers each push the due
  issue (#3213) had listed when it ran, the last a943f6c9; three confirm path or
  cron pushes landed after it the same day (d7616956, 062855d4, e19e2455), so a
  run on main after e19e2455 is still due and #3213 stays open for it.

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
`docs/cloudflare-platform-notes.md`, watch item #762. Re-measured on the passing
runs of 2026-10-16 ("The run record" above): the worst tick was 1858 to 2236ms,
1.5 to 1.9 percent of the limit.

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

Every tail a run keeps (the archive's `tail.jsonl`, the cold leg's `cold-tail.jsonl`
and the burst tail's `burst-tail.jsonl`, #3416) has its confirms read through one
reader, `tailInvocations` in `confirm-startup.ts`, so a confirm's answer line, its
profile and its marks are paired one way wherever they are read. (The cron tick count
reads the same objects through `tailObjects`, the brace scan underneath it.)

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
rather than inferring which ceiling a 429 came from. That matters because a per
KEY refusal is the answer whatever the per address ceiling said (the two are asked
side by side since #3124, and the key's verdict wins), so without the echo a per key
refusal would be credited to the ceiling under test.
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

## The diagnostic cold leg (#3354)

A run yields a handful of confirms that are their isolate's first request (4 of 522 on run 37520312761, by the Worker's own count, #3418), and the startup
bar holds the slowest of them (#3824), so under the three run rule chosen on 2026-10-06
one slow cold confirm in any of the three fails the set. Re-read on 2026-10-06, four
runs' cold maxima were 2219, 2365, 2232 and 2782ms over 7, 24, 7 and 10 cold confirms (counted by the module stamp then in use, which also counted the first confirm on an isolate already running).
That is too few to tell a startup change from noise.

Dispatch with `cold_samples` set (30 is the target and the most, which is what fits in the 60 minute bound every job is held to) and the `cold` job
runs after the archive and the fault leg. It reads every code's offered times once
and picks times at least `COLD_SLOT_GAP_MS` (an hour) apart across every code, since
buckets can share an advisor and two neighbouring times on the seed's 10 minute grid
can land on one advisor, the later confirm then refused as taken. Then for each sample
it deploys a new version (`wrangler deploy --env loadtest`, keeping
the run's recompute arm), waits `COLD_SETTLE_MS` and sends ONE confirm with the
`cold` leg, so each confirm is a fresh version's first request. A deploy that fails
sends no confirm, because one sent then would land on the old version and read warm.
The job streams its own tail as `cold-tail.jsonl`, separate from the main archive,
so none of these confirms join the startup bar's population.

The report's "cold after deploy" line says how many deploys made a version, how many
confirms went and how many of those were refused rather than booked, how many the tail
shows on the version just deployed, how many were their isolate's first request (one count, the Worker's, with any confirm that carried no invocation index named apart), their wait before the profile
(p50, p95 and max) and the median of each span. Every figure is read from the cold
leg's own confirms only: the tail is read with `leg: "cold"`, and a confirm another leg
sent into the same window is left out and counted on the line.
A cold count under 30 is called short. It is a diagnostic and never fails the run: a
lost sample (a deploy that failed, a confirm with no answer) is named on the line and
the job still passes. The job goes red only when no sample got an answer, since a leg
that measured nothing must not read as a quiet one, and when `cold_samples` is not a
whole number from 0 to 30, which is refused before anything is installed.
At 0 (the default) the job is skipped and the line says it was not asked for.

It costs about a minute of runner time per sample on top of one build: about 35
billed minutes at 30 samples. Its decisions are pinned by
`scripts/test-loadtest-cold-plan.ts`, including the workflow wiring above.

## The post confirm recompute arms (#3258)

Every booking on a user facing path schedules a recompute of the booked bucket's
slots after its response (`invalidateSlots`, `post-confirm-recompute` in the per job
line). Run 37229344882 measured the confirm's "assign and verify" stage about 1.7s
slower at the median than a same day control on the 2026-09-15 code, while that
stage's own reads had not changed, so the recompute running beside the next confirms
is the suspect. To measure it rather than infer it, the deployment can run one of
three ARMS, set by `SLATE_LOADTEST_POST_CONFIRM_RECOMPUTE`:

| arm | what a booking schedules after its response | per job line name |
|---|---|---|
| `on` (default) | the refresh exactly as production: since #3324, a create splices the booked window into every pool the booked advisor serves (`spliceBookedTimeAfterBooking`) | `post-confirm-recompute` |
| `off` | nothing; the recompute lane keeps slots fresh | none |
| `reads-only` | the reads of the same splice (`readSpliceInputsAfterBooking`), the cap widening included, no compute, no row write | `post-confirm-recompute-reads-only` |

**Since #3324 the arms measure the splice, not a pool recompute.** A create no longer
computes a whole pool: it re-judges a call or so either side of the booked time (the
advisor's whole local day when the booking takes them to their cap), in each of the
advisor's pools, and splices that into the stored rows without moving `computed_at`. Its reads are
batched across the advisor's pools: seven statements per booking whatever the pool
count (three roster reads, schedules, the cap count, busy time, the affected rows),
plus one compare and swap per code whose offer actually changed. Watch the database
side of the next run as closely as the CPU side, since that is where the cost moved.
Since #3334 a reschedule or reassign splices too: the new time out of every pool its
advisor serves and the old time back into every pool the old advisor serves, from the
same seven reads (one busy statement covers both windows however far apart they are),
with one compare and swap per changed code carrying both windows. Only cancels still
schedule the coalesced pool refresh (`refreshPoolOf`), under the same job
name, and the reads only arm reads that refresh's inputs for them. So runs from before #3324 (the #3293 coalesced
refresh, and the 2026-10-04 per code refresh) are a different `on`: compare a new arm
only with new arms. What to read off the next run, per #3324: computes per booking
(should fall to zero whole pool computes from creates), CPU per booking request at
the p99, the `booked time spliced` lines (`spliced`, `failed`, `widened`), the
`merged a compute with a booking spliced after it began` lines (how often a lane
compute met a fence and merged rather than being refused), and that the booked time
is gone from every pool within seconds.

`off` against `on` says whether the recompute is what the confirms wait on;
`reads-only` against both says whether its cost is the database reads or the CPU of
the compute, which decides the fix. Expect `off` to report a worse "worst recompute
age", since freshness falls back to the lane: that is the arm, not a defect.

Both arms make the same reads for the same booking (#3293, #3324), so `reads-only` is
the reads of the very splices `on` computes. The 2026-10-04 figures predate it: there, both arms ran
per code per booking, so compare a new arm only with new arms, never with that day's.

**Production cannot reach it.** It is read only when `SLATE_LOADTEST` is "true"
(`src/lib/booking/post-confirm-recompute.ts`); otherwise every value, a typo
included, is `on`. It is committed nowhere: `scripts/test-wrangler-loadtest-env.ts`
fails the build if production or env.loadtest carries it.

**An unknown value fails loud.** The Worker logs it at error once per isolate and
runs `on`, `/api/smoke/version` reports it as `postConfirmRecomputeUnknown`, and the
preflight refuses before anything is driven.

**Setting it.** Dispatch the workflow with the `post_confirm_recompute` input. For
`on` nothing changes. For `off` or `reads-only` the workflow's `arm` job rebuilds
and redeploys the Worker with `--var "SLATE_LOADTEST_POST_CONFIRM_RECOMPUTE:<arm>"`,
exactly as the fault leg adds its own settings, and the preflight then asks
`/api/smoke/version` which arm the deployment runs and refuses on any mismatch. The
report's header names the arm. The fault leg carries the same arm; its restore step
deploys with no `--var`, which puts the deployment back to `on`.

For a fair comparison, run the three arms back to back on one day, from the same
commit, and compare "assign and verify" from the confirm profile line.

### Three arms on one branch and one deployment

A fresh environment per arm costs a secrets set up and the wait for the first cron
delivery (27 minutes on 2026-10-04). The arms can share one instead, provided each
starts where the first did, which is what `scripts/loadtest/reset.ts` is for. Run it
against the BRANCH between arms:

```
RESET_BRANCH_REF=<branch-ref> \
SUPABASE_URL=https://<branch-ref>.supabase.co \
SUPABASE_SECRET_KEY=<branch secret key> \
node --experimental-strip-types scripts/loadtest/reset.ts
```

**It acts only on a target it can positively prove is a seeded load test branch.**
"Anything but production" would be a blocklist, and pointed at staging or a dev
project it would empty real data. So, before a single row is deleted, both of these
must hold, and each failure is refused in its own words:

- the address's project ref EQUALS `RESET_BRANCH_REF`, the ref recorded for this
  run (an unset value, an address that only contains the ref, or one with no ref at
  all refuses);
- the database carries the seed's own marker: the `Loadtest Org` organization
  (`SEED_ORG_ID`) as its ONLY organization, with agents at
  `loadtest-agent-<n>@loadtest.local`. A real project holds its own org, and a
  project the seed was once run into still does. The constants live in
  `seed-guards.ts` and are what `seed.ts` and `generate.ts` write.

It deletes, in order, `bookings`, `booking_outbox`, `booking_reservations`,
`pending_event_deletions`, `routing_decisions` and `rate_limits`, and prints how
many rows each lost. Why each matters to the next arm: the previous arm's bookings
make agents busier (their busy blocks, the daily cap count) and widen every candidate
read; outbox rows and reservations would be drained by the lanes during the next
arm's window; any rate limit rows left behind could refuse the next arm.

**The booking API's hourly ceilings are not in that table any more, and the reset does
not need to reach them** (#3456). Since #3416 the per caller (6,000 an hour) and per
address (1,200 an hour) ceilings are counts in the `BURST_LIMITER` Durable Object, and
since #3310 the object Worker the load test binds is kept between runs, so emptying
`rate_limits` stopped resetting them. Every driver books under one caller, and a run
sends about 2,000 hits, so a third run or arm inside one hour met the per caller ceiling
partway through, and its refusals read as the booking path throttling.

They are scoped per RUN instead. Every booking API request a driver sends names its
`RUN_ID` in the `x-loadtest-run` header (`loadtestRunHeaders` in `book-plan.ts`), and under
`SLATE_LOADTEST` the authorizer counts that run's hits in objects of its own
(`src/lib/loadtest-run-scope.ts`). `RUN_ID` is unique per dispatch and per attempt, so
every arm starts at zero with nothing to delete, and the earlier run's counts age out on
the object's own alarm. Re-keying was chosen over clearing because clearing would need an
endpoint able to delete a security control's state over HTTP; re-keying adds nothing that
can write, clear or lower a count. It cannot reach production's limiter: production never
reads the header (`readLoadtestRunScope` returns before looking), the load test binds its
own object Worker (`slate-burst-limiter-loadtest`), and a scope only ever adds a prefix.
`src/lib/rate-limit.test.ts` drives two arms and requires the second to start at one;
`src/lib/booking/route-auth.test.ts` requires production to ignore the header. A hand run
that reuses a `RUN_ID` shares that run's counts, by design.

- **DELETE, never TRUNCATE.** Deleting bookings cascades only to the busy blocks a
  booking wrote. `TRUNCATE bookings CASCADE` would empty `busy_blocks` entirely,
  seeded calendar time included, and reseeding does not undo a booking's rows either
  (the seed only merges, it never deletes).
- **It refuses production first** through the same guard the seed uses
  (`productionRefusal` in `seed-guards.ts`), with no FORCE escape, even if
  somebody recorded production's ref as the branch.
- **It refuses on any bulk reassign row**, naming it, before deleting anything:
  `bulk_reassign_items` references bookings with no delete rule, and the lane is off
  here, so such a row is unexpected and worth looking at first.

What it leaves alone, deliberately: `bucket_slots` and the slot cache (the preflight
recomputes by hand and waits for fresh rows), the `BURST_LIMITER` object (its per minute
burst windows clear themselves within two minutes, and its hourly ceilings are scoped to
the run as above, so the next arm never sees the last one's), alert cooldowns (Slack is
off under load test), lane heartbeats, and `audit_log` (append only, and its insert cost
does not grow with its size).

The sequence, every dispatch from the same commit the deployment was built from:

1. Build, deploy and seed once, as above.
2. Dispatch with `post_confirm_recompute` = `on` and `teardown` off.
3. Run `reset.ts`. Before dispatching again, confirm the calendar sync lanes have
   recovered from the fault leg's injected read failures.
4. Dispatch with `post_confirm_recompute` = `off` and `teardown` off. The `arm` job
   redeploys the existing Worker, so there is no new wait for cron delivery.
5. Run `reset.ts` again, and check the sync lanes again.
6. Dispatch with `post_confirm_recompute` = `reads-only`, `teardown` on and
   `branch_name` set, so the environment goes when the last arm is judged.

## The Google delay (#3490)

The Google stand in (`src/lib/google/loadtest-stub.ts`) answers every call at once, while a
production confirm waits on its live free/busy check and its calendar write, so a load
run's confirm latency and burst timings left those out. **No figure for either call had
been measured when this was built.** The "p50 4.8s, p95 8.0s" once quoted here as
production's confirm read was the WHOLE confirm's response time in #3258 (489 confirms on
2026-10-05), and the "about 3s and 5s" were the contention model's assumed Google times
(`PRODUCTION_PROFILE` in `scripts/lib/confirm-load-model.ts`), not a measurement. Whole
confirms now run about three times faster, measured on the evening of 2026-10-18 ET over
the seven days before it (2026-10-12 to 2026-10-19 UTC, ending at the reading): booker new
bookings p50 1,598ms and p95 3,861ms over 2,800 confirms, booking API new bookings p50 1,439ms
and p95 3,360ms over 572. The read and the write are parts of the confirm, so at the median
they take less than that, an upper bound and not a measurement of either.
Inside the confirm a load run now reads about 200ms at the median, so the stand in's zero is most of the gap between a load run and a production confirm, and the
burst bars (a crowd walking the tier ladder inside the confirm line's wait) had never had
Google time in them.

`SLATE_LOADTEST_GOOGLE_DELAY` makes the stand in take that time. It names a median and a
95th percentile in milliseconds for the live checks, the calendar writes, or both:

```
read=3000/5000,write=5000/8000
```

| | |
|---|---|
| **which calls** | the ones a lead waits on, which are the ones production cuts off at `GOOGLE_CONFIRM_TIMEOUT_MS`: `freeBusy` and each `freeBusyMany` wave chunk (read), `createEvent`, `updateEventTime`, `deleteEvent` and `updateEventContact` (write). Cron lanes keep answering at once. `scripts/test-loadtest-google-delay.ts` derives the list from `calendar.ts`, so the next such call is covered or fails the build |
| **the shape** | a lognormal fitted through exactly the two figures given, drawn at random per call. Random rather than keyed on the call, because a crowd of confirms for one slot reads the same calendars, and a keyed draw would hand every one of them the identical wait |
| **the caps** | never longer than the call's own deadline (8s) or what the confirm's budget has left, which is where production cuts a real call off; then it ANSWERS. A timeout is the fault switch's job (`google-read`), so a delayed steady pass's "no 5xx" bar still measures the code |
| **off** | unset or blank, which is every run before this. A value that does not parse delays nothing, is logged at error once per isolate, reported by `/api/smoke/version` as `googleDelayUnknown`, and refused by the preflight |

**Production cannot reach it.** The calls above reach the stand in only under
`SLATE_LOADTEST`, and the delay asks `isLoadtest()` again before it even reads the
setting. It is committed nowhere: `scripts/test-wrangler-loadtest-env.ts` fails the build if
production or `env.loadtest` carries it, and `/api/smoke/version` reports it only under
load test.

**Setting it.** Dispatch the workflow with the `google_delay` input. Empty (the default)
changes nothing. Anything else makes the `arm` job redeploy the Worker with
`--var "SLATE_LOADTEST_GOOGLE_DELAY:<value>"`, beside the recompute arm; the preflight then
asks `/api/smoke/version` which delay the deployment takes and refuses on any mismatch,
including an undelayed run against a deployment an earlier run left delayed. The fault leg
and the cold leg carry the same value on their redeploys, the fault leg's restore deploys
with no `--var`, which puts the deployment back to no delay, and the report's header names
the rig.

**Choosing the values.** Take them from production's CURRENT Google timings for those
calls, never from the figures above: production has moved since, and they were never
Google timings. Two runs are comparable only on the same setting, so every latency figure,
and the steady pass bar's same day baseline ratio (#3517), is read against runs that used
the same delay.

**Where the timings come from (#3490).** Every `confirm answered` line carries the
confirm's Google time, read off the stage profile every confirm already collects
(`googleTimingFields` in `src/lib/booking/confirm-profile.ts`, which says exactly what
each field does and does not measure):

| field | covers |
|---|---|
| `google_read_ms`, `google_read_calls` | `google freeBusy` and `google freeBusy.many`, the live check |
| `google_write_ms`, `google_write_calls` | `google events.insert`, `google events.patch`, `google events.delete`, the calendar writes |
| `google_mint_ms`, `google_mint_calls` | `google token mint`, which the stand in does NOT delay |

`_ms` is the covered wall time of that group's calls (parallel calls counted once), from
each call starting to the confirm resuming after its response, excluding reading the
response body and getting the token. A group the confirm made no call in is ABSENT from the
line, never 0. `scripts/test-loadtest-google-delay.ts` holds the read and write labels
against the very calls the stand in delays, so the fields and the delay cover the same set.

**Reading the values off production.** Two to three days of confirms (about 480 a day),
from a deploy that carries the fields, then two commands from a checkout of current main
holding the logs token (`scripts/logs.ts` header). The first lists the lines and saves
logs.ts's exit code, the second turns them into the value. The dates are an example: the
window must start after the deploy that added the fields.

```
node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/logs.ts 'msg="confirm answered"' --from 2026-10-20T00:00:00Z --to 2026-10-23T00:00:00Z --lines > google-timings-lines.txt; echo $? > google-timings-exit.txt
```

```
node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/loadtest/google-timings.ts google-timings-lines.txt --logs-exit "$(cat google-timings-exit.txt)"
```

It prints, per group, the p50, p95 and max per CALL (from confirms that made exactly one
such call, since the stand in draws one delay per call and a confirm's covered time over
several calls is not one call's time) and per CONFIRM beside it, then the line
`google_delay: read=<p50>/<p95>,write=<p50>/<p95>` to dispatch with. Percentiles are
nearest rank, the judge's own (`percentiles` in `judge-booking-run.ts`), weighted by each
row's `weight=` (#3915): when the Worker is busy Cloudflare stores some confirms in place of
several it never keeps, logs.ts exits 4 and prints the weight on those rows, and the report
weights every figure by it and says the window was sampled. Dry runs are left out. It exits
0 on a whole listing, sampled or not, 2 when there is nothing to stand on (logs.ts exited
anything but 0, 3 or 4, the file has no verdict line, no line carries the fields, which is a
window from before the deploy, or neither kind gave a usable value), and **3 when the listing is short**: `logs.ts --lines` can list fewer
rows than Cloudflare stored (its own exit 3), and then the report says INCOMPLETE and names how
many of how many the percentiles are over, judged from both the exit code given and the
numbers in the file (the rows' weights must add up to the count). List again, narrowing
`--slice-minutes`, rather than using a short listing's value. Under 100 single call confirms
it warns that the p95 is a handful of rows.

**Measured 2026-10-22 (#3490).** Over 2026-10-19 03:00 to 2026-10-22 14:00 UTC, the first
three and a half days carrying the fields: 2,782 confirms counted, 2,590 rows listed standing
for 2,824 (Cloudflare sampled 19 of the 83 hours), 156 dry runs left out.

| | per call p50 | per call p95 | max | single call confirms |
|---|---|---|---|---|
| read | 215ms | 468ms | 6,629ms | 2,128 |
| write | 582ms | 862ms | 2,716ms | 2,047 |
| mint (not delayed) | 135ms | 206ms | 247ms | 117 |

```
google_delay: read=215/468,write=582/862
```

The weighting held: the 64 hours Cloudflare kept in full read `read=216/471,write=578/882`
alone and the 19 sampled hours `read=215/455,write=596/821`, within 7 percent of each other.
That is the value `MEASURED_PRODUCTION_GOOGLE_DELAY` holds and the contention model's
production profile takes its p95s from (`scripts/lib/confirm-load-model.ts`). The window was
listed an hour at a time and stitched, because the observability API answered an occasional
query 403 and one refusal fails a whole multi day listing; six hours listed short at 60
minute slices and were listed again at 15.

Record in the pair's notes the window, the value used, the listed and counted numbers, and
that the stand in delays free/busy and event calls only, never token mints, which caused
most of the slow confirms of 2026-10-12 to 18 (the mint figure the report prints is the
size of what the pair leaves out).

## Tearing down (#2322)

`teardown` does **two** things: it takes the load test Worker's secrets, keeping the
Worker (#3310), and it deletes the Supabase branch. For months it said it deleted two
things while deleting one. The job removed the Worker and nothing in it touched the Supabase branch; the
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
| 11 | the delete was accepted and the branch is still in the listing after it was read again for about two minutes |

Exits 10 and 11 exist for the same reason the Worker half re-reads the Worker's
secrets: the teardown is done when the reads say so, never when the delete command
exited. The branch listing lags an accepted delete the way the secrets listing does
(#3787: run 38812653636 exited 11 on a branch a read minutes later showed gone), so
while it still names the branch it is read again every 5 seconds for up to two
minutes, through the same `relistUntil` (`scripts/loadtest/relist.ts`) the Worker half
uses. A re-read that fails ends the wait as exit 10.

### The Worker is kept, idle (#3310)

The Worker half used to `wrangler delete` the Worker and confirm it was gone (#2277).
Every run's deploy then created a new Worker, and Cloudflare has taken up to 105
minutes to deliver a new Worker's first cron, so every run waited and a slow delivery
lost the run. Now `scripts/loadtest/keep-worker-idle.ts` keeps it and takes its
secrets:

1. It checks which Worker it may touch. It deletes by name, so `LOADTEST_WORKER_NAME`
   must equal the Worker `wrangler deploy --env loadtest` deploys, read from
   `wrangler.jsonc`, and production's own name is refused whatever else is true.
2. It deletes every secret the Worker lists, plus the three a run puts. A secret
   already gone answers 404 and counts as done, so the step is safe to run twice, and
   one failed delete does not stop the others.
3. It reads the secrets listing again and the cron schedules. Idle is what those reads
   say, never what the deletes answered: only a positively readable empty listing
   counts as holding nothing, and a kept Worker with no schedules is a finding,
   because keeping it bought nothing. The listing can lag the deletes (#3783: run
   38800509328's listing still named all three secrets right after every delete
   answered, and none ten minutes later), so a listing that still names a secret is
   read again every 5 seconds for up to two minutes, and only a name still listed then
   is exit 8. A delete that failed skips the wait and is exit 7 at once.

With no secrets and the branch deleted, the idle Worker can reach nothing. It costs
nothing extra: about 2,000 cron invocations a day, mostly the every minute schedule,
which is about 60,000 a month against the 10 million the plan includes. Each answers
in the Worker entry before the app loads.

Every outcome is pinned offline in `scripts/test-loadtest-idle-worker.ts`:

| exit | what it met |
|---|---|
| 0 | kept, holding no secrets, with its cron schedules |
| 1 | no API token, account id or Worker name here; nothing was touched |
| 2 | the name is not the load test Worker `wrangler.jsonc` deploys, or is production's; nothing was touched |
| 3 | Cloudflare never answered, so whether it is idle is unknown |
| 4 | a 404: the Worker is not on this account (deleted, or the account id is wrong), so the next run waits for a first delivery |
| 5 | Cloudflare answered with another status |
| 6 | a 200 this cannot read, which is never read as holding nothing |
| 7 | a secret delete failed; it is named with its reason |
| 8 | a secret is still listed after every delete answered and the listing was read again for about two minutes |
| 9 | holds nothing and has no cron schedules; redeploy it with `wrangler deploy --env loadtest` |

A Worker that lives on keeps its Durable Object migration history the way production
does, so the pull request check from #3352 (`scripts/lib/do-migration-plan.ts`)
refuses an edit to, or the removal of, a tag in `env.loadtest.migrations` as well.
Adding one still needs no label, because the load test deploys whole.

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

A calendar SYNC read is the exception (#3103). Its fault is keyed on the calendar
alone, so the same agents fail on every pass, and it is always the `403
notACalendarUser` shape raised as the error the classifier reads, so it is recorded as
not-provisioned. That is what lets the `sync_failures` page fire inside the fault
window: a transient kind needs four consecutive passes, about 270 seconds at the load
test Worker's sync cadence, which a five minute window cannot reliably hold, while a
definitive kind pages on the second. The key used to carry the sync token, which
changes every pass, so no agent ever failed two passes running and the page never
fired. `scripts/test-loadtest-sync-fault-streak.ts` drives the stub through the real
paging predicate.

What a faulted run should show: the failing agents are named in a throttled page rather
than one per failure; a `notACalendarUser` agent is treated as definitively failing
rather than retried every minute; the booker still offers times from agents who are
fine; and no lane's heartbeat goes stale, because a Google failure must not stop a lane
running. On the booking run the page and the heartbeats are now SCORED by the judge
(the fault leg section below), not read by a person.

The confirm's verify wave is faulted too (#3845). Its bulk read and the per agent read
it falls back to are keyed apart, as they are two different Google calls, so a pass
reaches all three outcomes: read in bulk; missed in bulk and rescued by the direct read;
read by neither, which scores the agent unverified and re-routes the lead to the next
free advisor. In the fault leg's Worker logs the bulk miss carries nothing of its own;
the direct read failing logs `tag=booking msg="agent calendar read failed, reporting it
could not tell rather than free"` naming the advisor with the `(loadtest fault)` error,
once for each advisor whose direct read failed. (An advisor whose calendar LIST read
fails is unverified too, as before, and pages `verify_on_book_calendars_read` instead.)
A confirm answers a retriable 503 (`VERIFY_UNAVAILABLE`) only when nobody it read could
be confirmed free.

When EVERY lane stops stamping in the same minutes, for longer than the shortest lane
bound, the judge says the crons did not fire rather than blaming a dependency (#3746):
no fault reaches `lane_heartbeats`, and a fault failing a share of calls cannot hold
every lane still at once. Run 38635866855 was that case, during Cloudflare's cron
trigger incident. It still fails the bar, because nothing about the lanes under fault
was measured; rerun once the platform fires the crons again.

### Which systems fail (#3104)

`SLATE_LOADTEST_FAULT_TARGETS` names the systems, comma separated. Unset is
`google-read` alone, which is the switch exactly as it was before the others existed.

| target | what fails | key a verdict is hashed on | what it exercises |
|---|---|---|---|
| `google-read` | every stubbed calendar read, in the three shapes above; the confirm's bulk verify wave as a calendar Google would not report on (#3845) | the call (`freeBusy:<email>`, `freeBusyMany:<calendar>`, `calendarList:<email>`, the sync window) | the coalescer, the classifier, the streak page, verify-on-book's fallback and re-route |
| `google-write` | the stubbed create, patch and delete, in the same three shapes | the operation and the event id, so a retry meets the same answer | the confirm path's failed create, `pending_event_deletions`, the outbox's resume |
| `supabase` | every call through the secret key client EXCEPT `lane_heartbeats` and `alert_state`: half are held 1.5 seconds and let through, half answer a PostgREST shaped **500** | the method, address and body, inside the minute, so a fixed read is not failed on every tick for the whole run | the fail loud reads (`unwrap`), the lanes' failure boundaries, and every read behind the decision to page |
| `salesforce` | a call is held 3 seconds, past the booking path's 2.5 second calling number deadline, then fails as a timeout | the request address, so one lead is slow on every run | the deadline branch, which the instant load test refusal (#2335) could never reach |
| `webhook` | the synthetic delivery records a 503 instead of a success | the delivery AND the attempt, so some land on a retry and some reach the dead letter | the outbox retry and the dead letter page |

The two tables the lane judge reads as its evidence, `lane_heartbeats` and `alert_state`,
are never faulted (`SUPABASE_FAULT_EXEMPT_TABLES`), reads and writes alike: a fault there
would produce exactly the stale lane or missing page the judge reports, caused by the
injector rather than the code. What decides whether to page (the failure streak, the
failing agents read) is still faulted, because a page lost to those is real behaviour.

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
- with calendar reads faulted (as CONFIGURED for the run, never as the deployment reported;
  the two disagreeing is incomplete), the `sync_failures` page recorded, and recorded once
  per CHANGE: an unchanged condition reposts only after a day (#3801), so a second stamp
  naming nothing new is the throttle failing. A second stamp naming an agent the first
  did not, or a worse band, is the change post Dan's rule sends at once, and at 200
  advisors it is expected, since the sync lane reads the calendars over more than one tick
  and a second agent can cross its streak a minute after the first (run 5 of #3829). The
  sampler reads `alert_state.subjects` and `band` to tell the two apart; a send whose state
  was not read is counted as a repeat.

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
