# Availability alert: classify the cause (booked solid vs data anomaly) — #570

Date: 2026-07-01
Issue: #570 (follow-up to #567)
Scope: observability only. No change to booking, routing, availability compute,
or the embed contract.

## Problem

The availability-health probe (`src/app/api/cron/monitor/route.ts` +
`src/lib/monitor/availability-health.ts`) now pages only for a true customer
dead-end: a bucket with an eligible agent on shift, a FRESH cached slot row, zero
cached slots, AND whose whole tier-drop ladder is also empty (`classifyEmptyBuckets`
-> `page`). But the Slack copy can't say WHY there are no times. Two very different
situations produce the same page:

1. **Booked solid** — the agents' calendars are genuinely full. Zero slots is
   correct. This is a capacity/staffing fact and, per product framing, often a
   *good* outcome (we filled the calendars). It should be low-noise.
2. **Data anomaly** — the agents actually have open time, but the cached slot row
   says zero because the precompute wrote a wrong/empty payload or the sync
   pipeline is wedged. This is an outage-class bug: customers see no times while
   agents sit free. On-call must know promptly.

Today both page at the same urgency with identical wording. The reader can't tell
"go look at staffing" from "go look at the sync pipeline," and the benign
booked-solid case adds noise to the urgent anomaly case.

Stale/missing cache rows are already excluded from the page (`failingBuckets`
gates on freshness), so this is a readability + noise change, not a correctness
fix to the page trigger.

## Approach

A paged bucket is, by construction, *fresh + on-shift + zero cached slots*. The
only signal that separates "booked solid" from "data anomaly" is whether the
agents' calendars are actually full. We get that by **recomputing availability
live from the DB** and comparing to the cached zero.

For each paged bucket, call the existing `getBucketSlots(code, from, to)` over the
standard horizon window (`slotCacheKey(code, now, HORIZON_DAYS)`). `getBucketSlots`
reads `busy_blocks` + bookings + schedules from Postgres and runs the real slot
engine — it is DB-only (no live Google), so it is safe on the monitor path.

- recompute count `=== 0` -> **booked solid** (cache agrees with calendars: no capacity).
- recompute count `> 0`   -> **data anomaly** (cache disagrees with calendars).
- recompute throws / returns null -> **unverified** (could not confirm).

This runs ONLY for buckets that already page (normally zero), so the extra reads
are off the hot path. It reuses the real compute engine instead of a bespoke
busy-block coverage heuristic (consolidation: one source of truth for "is this
slot bookable").

### Why recompute, not a hand-rolled coverage check

`getBucketSlots` already encodes duration, buffers, min-notice, daily cap, slot
interval, DST-correct working hours, and multi-agent free/busy stitching. A
separate coverage calc would duplicate that and drift. Reusing it means the
monitor's notion of "bookable" is identical to the booker's by definition.

## Alert urgency mapping (noise control)

Per product framing, filling calendars is not an incident; a broken sync is.

| Cause         | Channel | Key                          | Cooldown | Runbook direction                    |
|---------------|---------|------------------------------|----------|--------------------------------------|
| Data anomaly  | page    | `availability_data_anomaly`  | 30 min   | Check precompute / sync pipeline.    |
| Unverified    | page    | `availability_data_anomaly`  | 30 min   | Could not verify; treat as possible sync issue. |
| Booked solid  | info    | `availability_booked_solid`  | 6 h      | Capacity heads-up; check staffing.   |

- Data anomaly + unverified share the urgent page (one consolidated message via
  `sendThrottledAlert`), so a real problem is never hidden behind a benign one.
- Booked solid goes to `sendThrottledInfo` with a long cooldown, mirroring the
  existing fallback-covered info signal (`FALLBACK_COVERED_*`). It is a chronic
  capacity fact, not an outage, so it must not buzz on-call repeatedly.
- The old single `EMPTY_AVAIL_ALERT_KEY` page for all dead-ends is replaced by
  this split. `covered` (fallback-covered info, #567) is untouched.

## Components

### 1. `src/lib/monitor/availability-health.ts` (pure, node-native)

Add:

```ts
export interface DeadEndCause {
  bookedSolid: string[];   // recompute also 0
  dataAnomaly: string[];   // recompute > 0 (cache wrong)
  unverified: string[];    // recompute threw / null
}

// pageCodes = classifyEmptyBuckets(...).page
// recomputeSlotCount: bucket code -> live recompute slot count, or null if the
// recompute failed. A code absent from the map is treated as unverified.
export function classifyDeadEndCause(
  pageCodes: string[],
  recomputeSlotCount: Map<string, number | null>,
): DeadEndCause
```

Add two formatters (no em/en dashes, per the copy lint):

```ts
// Urgent page: dataAnomaly + unverified. Names each group with its runbook line.
export function formatDataAnomalyAlert(cause: DeadEndCause): string

// Low-noise info: bookedSolid capacity heads-up.
export function formatBookedSolidNotice(bookedSolid: string[]): string
```

`formatEmptyAvailabilityAlert` is removed (replaced by `formatDataAnomalyAlert`);
`formatFallbackCoveredNotice` and `classifyEmptyBuckets` are unchanged.

### 2. `src/app/api/cron/monitor/route.ts` (IO)

After computing `{ page, covered }`:

1. If `page.length`, recompute each paged bucket with bounded concurrency
   (`mapWithConcurrency`, `PROBE_CONCURRENCY`, under the existing lock deadline),
   building `Map<code, number | null>` (null on throw/null return).
2. `const cause = classifyDeadEndCause(page, counts)`.
3. If `cause.dataAnomaly.length || cause.unverified.length`, `sendThrottledAlert`
   with `AVAILABILITY_DATA_ANOMALY_KEY` and `formatDataAnomalyAlert(cause)`.
4. If `cause.bookedSolid.length`, `sendThrottledInfo` with
   `AVAILABILITY_BOOKED_SOLID_KEY` (6 h cooldown) and
   `formatBookedSolidNotice(cause.bookedSolid)`.
5. Extend the `console.log` breakdown with the three cause counts.

New constants: `AVAILABILITY_DATA_ANOMALY_KEY`, `AVAILABILITY_BOOKED_SOLID_KEY`,
`BOOKED_SOLID_COOLDOWN_MS` (6 h). Remove `EMPTY_AVAIL_ALERT_KEY` /
`EMPTY_ALERT_COOLDOWN_MS` (superseded).

The window for the recompute: reuse `slotCacheKey(code, new Date().toISOString(),
HORIZON_DAYS)` so it matches exactly what the precompute lane caches. Import
`getBucketSlots` and the window helper from the availability service.

### 3. Test — `scripts/test-monitor-availability-health.ts`

Extend (node-native, per `slate-test-convention`):

- `classifyDeadEndCause`: recompute 0 -> bookedSolid; >0 -> dataAnomaly;
  missing/null -> unverified; mixed set splits correctly.
- `formatDataAnomalyAlert`: names anomaly + unverified groups, includes the
  sync-pipeline runbook line, no dashes.
- `formatBookedSolidNotice`: names booked-solid buckets, capacity wording, no dashes.

## Error handling

- A recompute that throws or returns null does NOT drop the bucket from alerting;
  it becomes `unverified` and pages under the data-anomaly key. Erring toward
  surfacing a possible problem beats going silent.
- The recompute loop is bounded by `PROBE_CONCURRENCY` and the existing lock TTL
  deadline, so a slow recompute can't overrun the monitor lane.
- Recompute only runs for `page` buckets (normally zero), so a healthy fleet pays
  nothing extra.

## Out of scope

- **UI-tunable alert settings (split to its own issue, decided 2026-07-01).** The
  cooldowns here (`availability_data_anomaly` 30 min, `availability_booked_solid`
  6 h) ship as coded constants with env-var fallback in THIS change. A separate
  follow-up issue adds a `monitor_settings` store + an admin screen so the alert
  cooldowns AND the destination Slack channel (and the existing low-volume alert
  timings) can be changed without a redeploy; that issue then points these
  constants at the store. Do not build the settings UI as part of #570.
- Stale/missing cache rows (already excluded from the page; recompute lane owns them).
- Thin-tier staffing early warning (#569) and tier-drop frequency (#500).
- Any change to the `covered` fallback-covered info signal (#567).
- Booking, routing, availability compute, embed contract.

## Verification

`tsc --noEmit`, `pnpm lint`, `pnpm test` (includes the node-native monitor test
and the copy/dash lint), `pnpm cf:build`. No UI surface, so no browser pass.
