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

4. **Run an app instance pointed at the branch, in load-test mode.** In a shell:
   ```
   NEXT_PUBLIC_SUPABASE_URL=https://<branch-ref>.supabase.co \
   SUPABASE_SECRET_KEY=<branch secret key> \
   SLATE_LOADTEST=true \
   CRON_SECRET=<any value> \
   pnpm dev
   ```
   `SLATE_LOADTEST=true` activates the Google stub (`src/lib/google/loadtest-stub.ts`);
   without it the lanes would call real Google.

5. **Drive the lanes and read the numbers:**
   ```
   SLATE_BASE=http://localhost:3000 CRON_SECRET=<same value> \
   SUPABASE_URL=https://<branch-ref>.supabase.co SUPABASE_SECRET_KEY=<key> \
   node --experimental-strip-types scripts/loadtest/run.ts
   ```
   Paste the output back for the go/no-go read. Bump `TICKS` for a longer soak.

6. **Subrequest ceiling (Worker-only).** `pnpm dev` (Node) has no subrequest limit, so
   timings/drain are measured locally, but the ~1000-subrequests-per-invocation ceiling
   only exists on a deployed Worker. To check it, either deploy a branch-pointed Worker
   and read Cloudflare observability for the recompute/sync invocations, or reason from
   the per-tick call counts (recompute ≈ 7 reads/bucket × buckets-due-per-tick; sync ≈ a
   few calls/agent × the concurrency cap of 8). Both should sit far under 1000.

## Teardown
Delete the branch DB. The `SLATE_LOADTEST` flag is inert anywhere it isn't set, so no
production cleanup is needed.
