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
   set each tick, and no bucket stays stale > 6 min (`stale6m` = 0).
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

6. **Subrequest ceiling (Worker-only).** `pnpm dev` (Node) has no subrequest limit; the
   ~1000-subrequests-per-invocation ceiling (Workers Paid) only exists on a deployed
   Worker. Verified against the deployed Worker (#724, 2026-07-10). Two things the older
   per-lane estimate got wrong:

   - **One shared budget, not per-lane.** The `* * * * *` trigger dispatches FOUR routes
     (`sync`, `recompute`, `outbox`, `selfheal`) and `worker/index.ts` runs them all
     IN-PROCESS in a single `scheduled()` invocation (`handler.fetch(...)`, no network
     hop), so they share ONE ~1000-subrequest budget. Budget the COMBINED total, not each
     lane alone. Every `fetch()` counts: every PostgREST query (supabase-js), every Google
     call, every Slack post. `caches.default` is colo-local and does NOT count.
   - **Observability can't count subrequests.** Cloudflare Workers Logs expose cron,
     `$workers.cpuTimeMs`, `$workers.wallTimeMs`, and `$workers.outcome`, but NO subrequest
     counter. So you can't read the count directly; instead derive it from code and watch
     `$workers.outcome` for resource breaches. (A subrequest-limit breach surfaces as a
     failing outcome / "Too many subrequests" error; none seen in 7 days. Note: the minute
     lane IS hitting the CPU ceiling ~5% of ticks today, tracked in #760, a separate limit.)

   Measured budget at 200 agents (derived from code, #724):
   - **Steady state ≈ 760 subrequests/tick** (safe): sync ~608 (100-agent cap ×~6 each) +
     recompute ~127 (~15 aged buckets ×8) + outbox ~9 + selfheal ~14. The margin rests
     entirely on `MAX_AGENTS_PER_SYNC_TICK=100` and the 4-min recompute freshness window.
   - **A single backlog event can push one lane over 1000.** Worst-case per lane: selfheal
     ~1,850, sync ~1,420, recompute ~493 (hard-capped at 60 buckets × 8), outbox ~550.
   - **Unbounded scaling risks (must cap before 200-agent scale):** the selfheal reconcile
     sweeps loop `bucketsForAgent` (3 subrequests) per freed/missing agent with NO per-tick
     cap (up to 200×3 per sweep, ~1,200 across both); `reconcileMissingBusyBlocks` also
     inserts one un-batched `busy_blocks` row per missing row (up to 200). The sync lane is
     bounded only by the 100-agent cap and does one un-batched Google `syncEvents` per
     calendar, so a multi-calendar fleet multiplies it. recompute is NOT a risk (fixed
     60-bucket ceiling, `.in(userIds)`-batched, agent-count-independent).

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

## Teardown
Delete the branch DB. The `SLATE_LOADTEST` flag is inert anywhere it isn't set, so no
production cleanup is needed.
