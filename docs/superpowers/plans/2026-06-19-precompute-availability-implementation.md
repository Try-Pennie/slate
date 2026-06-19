# Precompute Availability (bucket_slots) Implementation Plan

> Source of truth: the `/plan-council` run (winner = "Postgres precompute table + short
> Cache-API veneer", cheapest tier) + a spike that VALIDATED it on real Slate prod.
> Execute with `superpowers:executing-plans` / `subagent-driven-development`, TDD per task.

## Why (validated, not estimated)

Today `/api/availability` cache-miss falls through to `getBucketSlots` ->
`loadMembersAvailability`, which fans parallel `.in("user_id", …)` queries across all
eligible agents + a sequential rules read + an org read, then unions. That is cal.com's
team fan-out at smaller scale.

**Measured on prod (spike, all 60 XBC buckets):**
- Today's cold/miss compute: median ~2.0s, max ~3.5s (cal.com: median 8.8s, max 21s, best 6.3s).
- Precompute single-row read: **min 99 / median 120 / max 278 ms** across all 60 buckets, zero failures.
- Warm Cache-API hit: **min 23 / median 30 / max 35 ms**.
- Key finding: the single-row read never spikes into seconds -> today's cold is COMPUTE-bound,
  not connection-bound -> **Hyperdrive is NOT needed** (council judged right). ~$0 new infra.

## Locked product decisions

- **Calendar UI:** build BOTH a compact next-few-days strip (A) AND the month grid (B),
  switchable via a setting. Default = strip (matches the 0-3 day reality); flippable.
- **Freshness:** time-off is internal -> refresh instantly; Google changes refresh via the
  existing push webhook (best-effort <5s) + 1-min cron backstop (<60s guaranteed);
  verify-on-book stays the hard double-book guard. Honest contract: "usually <5s, guaranteed <60s".
- **Empty/failed bucket:** bounded fail-open (compute once, store, self-heal) — never a false "no times".
- **Auto-booker dropped** for Slate: a routing-aware booking API will replace the Puppeteer
  "Marcia" workaround (cal.com couldn't book via API AND honor bucket routing). So the booker
  UI no longer has to be automation-proof, though deterministic DOM is still nice-to-have.

## Non-negotiable invariants

- Booking write path untouched: `createBooking` -> `roundRobinCandidates` -> verify-on-book
  (live Google `freeBusy`) -> active-slot unique index remain the ONLY double-book guards.
- `/api/availability` response shape byte-for-byte: `{bucket:{code,name}, orgName,
  eventType:{name,description,durationMin}, slots}` (route.ts). Reuse `BucketSlots` verbatim.
- Cloudflare-deployable; node-native `scripts/test-*.ts` ships with each phase (pre-push gate).
- Stays cache-first; no new managed services (no Hyperdrive/KV/DO) unless a later measured escalation.

## Reality-check corrections to apply (from the council's own verifier)

- The sync hook point is `syncCalendar` in `src/lib/google/sync.ts` (the single fn that mutates
  busy_blocks, called by BOTH `syncByChannel` (push) and `runIncrementalSync` (cron)). The plan's
  earlier line citations (114/122/146/156/345) were WRONG — hook at the syncByChannel/runIncrementalSync level.
- OOO: hook the actual DB-write deps at `ooo/service.ts` (~130 insert / ~149 delete), NOT the
  `ooo/orchestration.ts:457` comment line.
- Booker request-window fix (Phase 0.2) is LOAD-BEARING, not polish: clamp `loadSlots` to
  `[max(now,today), today+HORIZON]` and make future-month nav render unavailable WITHOUT a fetch
  that could anchor a cold compute. Otherwise month-nav defeats the precompute.

---

## PR 1 — Backend precompute path (Phases 0-3)

### Phase 0 — free wins
1. Horizon 14 -> 4: `HORIZON_DAYS` (slot-cache.ts), `DEFAULT_RANGE_DAYS` (route.ts). Bump cache-key prefix `slots:v2:` -> `slots:v3:` (cache-key.ts).
2. Clamp the Booker request window to the stored horizon (Booker.tsx `loadSlots`); future-month nav renders unavailable, never fetches a cold window.

### Phase 1 — bucket_slots table + read/write split (core; spike-validated)
3. Migration `0035_bucket_slots.sql`: `bucket_code text pk`, `payload jsonb` (full BucketSlots), `computed_at timestamptz`, `status text default 'ok'` ('ok'|'empty'|'failed'). RLS enabled (server-only). Add `BucketSlotsRow` to types.ts + Tables map in schema.ts. (Spike migration already applied to prod.)
4. Writer `recomputeBucketSlots(code)` in `precompute.ts`: call existing `getBucketSlots(code, dayAnchor, +HORIZON)` verbatim, upsert row with status = slots.length ? 'ok' : 'empty'; on throw, keep prior good row, status='failed' only if none, `sendThrottledAlert`. Write-through the Cache-API key after success.
5. Read: rewrite `getCachedBucketSlots` -> Cache-API match (warm ~30ms) -> on miss, single PK select of bucket_slots row (status ok/empty -> return + cache put max-age=5). Bounded fail-open: missing/failed-no-slots -> live `getBucketSlots` + fire-and-forget recompute. Reuse `shapePrecomputedRow` (validated) for safety.
6. `SLOT_TTL_SECONDS` 60 -> 5.
   Tests: `scripts/test-precompute.ts` (recompute status; read returns blob without calling loadMembersAvailability via injected spy; never-computed -> fail-open). Keep `test-precompute-read.ts` (shape).

### Phase 2 — wire ALL busy_blocks writers to refresh (highest value)
7. `bucketsForAgent(userId)` in precompute.ts: load agent attributes + org buckets (~60), run the EXACT predicate from `resolveBucketAgentIds` (service.ts:46-51) incl. `bookable` gate + manual-member union, in memory. Test the manual-only-member branch.
8. Booking path: swap injected `invalidateSlots` (booking/service.ts:72) to recompute the booked bucket.
9. Google path: after `syncCalendar` changes busy_blocks, `bucketsForAgent(userId)` -> debounced fire-and-forget `recomputeBucketSlots` at the syncByChannel/runIncrementalSync level (keep push ACK non-blocking).
10. OOO path: after the busy_blocks write deps (ooo/service.ts:130/149) -> recompute affected buckets.
    Cost guard: dedupe per bucket per tick + skip if computed_at younger than ~2s.
    Tests: `test-buckets-for-agent.ts`; each write path invokes recompute for the right buckets (spy).

### Phase 3 — cron backstop + staleness monitor
11. 1-min sync cron recomputes touched (or all ~60, ~4-day) buckets within `SYNC_TICK_BUDGET_MS`.
12. Staleness monitor: `sendThrottledAlert` if any computed_at older than ~90s.
    Test: `test-cron-sync-recompute.ts`.

### PR1 verification
- `pnpm build`/`lint`/`test` green. Playwright: re-measure warm/cold on the DEFAULT path (no `?src=pre`) — expect warm ~30ms, cold ~120ms. Confirm embed payload byte-for-byte. Remove the spike's `?src=pre` + rate-limiter skip (superseded by the real default path).

---

## PR 2 — Booker UI (Phase 4 + the two layouts)
- Compact strip (A) + month grid (B) behind a per-bucket/org setting; default strip.
- Determinism hooks (nice-to-have): `data-state` (loading|ready|empty|error), `data-slot-iso`, `data-slots-ready`; honor reduced-motion/automation flag. Keep the 409 "just taken" as the only stale degradation.
- status='empty' renders genuine "no times"; 'failed'/never-computed never renders false "no times".
- Verify both themes (Playwright, motion frozen per AGENTS.md), axe, Lighthouse (slate-ui-verification).

## Conditional escalation (do NOT build now)
Only if prod cold read feels too slow: KV L1 in front of the row (re-measure warm KV blob read first; prior art 264ms). Never the DO+Hyperdrive tier unless flat-scaling@200 AND strict push-freshness become hard requirements with the bill accepted.
