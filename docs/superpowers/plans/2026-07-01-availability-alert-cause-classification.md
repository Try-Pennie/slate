# Availability Alert Cause Classification (#570) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the availability dead-end Slack alert say WHY a tier shows no times — agents booked solid (benign, quiet info) vs the cached availability disagreeing with real calendars (a sync/precompute bug, urgent page).

**Architecture:** For each bucket that would page (the rare all-ladder-dry dead-end), recompute availability live from the DB via the existing `getBucketSlots` (reads `busy_blocks`/bookings/schedules, no Google) over the standard horizon window and compare to the cached zero. Recompute 0 = booked solid; > 0 = data anomaly; throw/null = unverified. Data-anomaly + unverified page on a new urgent key; booked-solid becomes a quiet 6-hour info note. Pure classification + wording lives in `availability-health.ts` (node-native testable); the recompute IO lives in the monitor cron route.

**Tech Stack:** Next.js 16 (App Router, TS), Supabase (secret-key admin client), Luxon, node-native test scripts (`node --experimental-strip-types`).

## Global Constraints

- Package manager: `pnpm`.
- No em/en dashes and no hyphen/dash connectors anywhere (copy lint enforces this in `pnpm test`). Hyphens only inside a word.
- TypeScript everywhere, avoid `any`. No comments unless logic is non-obvious.
- `availability-health.ts` stays pure and node-native: NO `@/` imports (the test script runs it directly).
- Visual-only/observability change: do NOT touch booking, routing, availability compute, round-robin, webhooks, auth, DB schema, or the embed contract.
- Cooldowns ship as coded constants here; UI-tunability is issue #571, out of scope.
- Branch already created: `feat/availability-alert-cause-570` (off `origin/main`). Pre-push hook runs `tsc --noEmit`, `pnpm lint`, `pnpm test`, `pnpm cf:build`.

---

### Task 1: Cause classification + wording (pure module)

**Files:**
- Modify: `src/lib/monitor/availability-health.ts` (add types/functions; remove `formatEmptyAvailabilityAlert`)
- Test: `scripts/test-monitor-availability-health.ts`

**Interfaces:**
- Consumes: nothing new (reuses existing `ALERT_NAME_CAP` in the module).
- Produces:
  - `interface DeadEndCause { bookedSolid: string[]; dataAnomaly: string[]; unverified: string[] }`
  - `classifyDeadEndCause(pageCodes: string[], recomputeSlotCount: Map<string, number | null>): DeadEndCause`
  - `formatDataAnomalyAlert(cause: DeadEndCause): string`
  - `formatBookedSolidNotice(bookedSolid: string[]): string`
  - Removes: `formatEmptyAvailabilityAlert`.

- [ ] **Step 1: Write the failing test**

In `scripts/test-monitor-availability-health.ts`, update the import block: remove `formatEmptyAvailabilityAlert`, add the three new names.

```ts
import {
  isWorkingNow,
  anyOnShift,
  failingBuckets,
  classifyEmptyBuckets,
  formatFallbackCoveredNotice,
  classifyDeadEndCause,
  formatDataAnomalyAlert,
  formatBookedSolidNotice,
  type WorkingRule,
} from "../src/lib/monitor/availability-health.ts";
```

Then remove any existing block that calls `formatEmptyAvailabilityAlert` and append, before the final `process.exit` / summary line:

```ts
// --- classifyDeadEndCause: split paged buckets by live-recompute result ---
{
  const counts = new Map<string, number | null>([
    ["FULL", 0], // recompute also 0 -> booked solid
    ["ANOM", 3], // recompute > 0 -> cache disagrees with calendars
    ["NULL", null], // recompute failed -> unverified
    // "MISS" intentionally absent from the map -> unverified
  ]);
  const cause = classifyDeadEndCause(["FULL", "ANOM", "NULL", "MISS"], counts);
  ok(cause.bookedSolid.join() === "FULL", "recompute 0 -> bookedSolid");
  ok(cause.dataAnomaly.join() === "ANOM", "recompute >0 -> dataAnomaly");
  ok(cause.unverified.slice().sort().join() === "MISS,NULL", "null/absent -> unverified");
}

// --- formatDataAnomalyAlert: names anomaly + unverified with runbook, no dashes ---
{
  const msg = formatDataAnomalyAlert({ bookedSolid: [], dataAnomaly: ["ANOM"], unverified: ["NULL"] });
  ok(msg.includes("ANOM") && msg.includes("NULL"), "anomaly alert names both groups");
  ok(/sync|precompute/i.test(msg), "anomaly alert points at the sync/precompute pipeline");
  ok(!/[–—]/.test(msg) && !/ - /.test(msg), "anomaly alert has no dashes");
}

// --- formatBookedSolidNotice: capacity wording, no dashes ---
{
  const msg = formatBookedSolidNotice(["FULL1", "FULL2"]);
  ok(msg.includes("FULL1") && msg.includes("FULL2"), "booked-solid notice names the tiers");
  ok(/capacity|booked solid|staffing/i.test(msg), "booked-solid notice reads as a capacity heads up");
  ok(!/[–—]/.test(msg) && !/ - /.test(msg), "booked-solid notice has no dashes");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types scripts/test-monitor-availability-health.ts`
Expected: FAIL — import error / `classifyDeadEndCause is not a function` (the functions don't exist yet).

- [ ] **Step 3: Write minimal implementation**

In `src/lib/monitor/availability-health.ts`, delete the `formatEmptyAvailabilityAlert` function, and after `formatFallbackCoveredNotice` add:

```ts
/** Why a paged (dead-end) bucket shows no times, from a live recompute vs the
 *  cached zero. `bookedSolid`: recompute also 0 (calendars genuinely full).
 *  `dataAnomaly`: recompute > 0 (cache disagrees with reality). `unverified`:
 *  the recompute failed, so the cause could not be confirmed. */
export interface DeadEndCause {
  bookedSolid: string[];
  dataAnomaly: string[];
  unverified: string[];
}

/** Split the paged bucket codes by live recompute slot count. A code missing
 *  from the map, or mapped to null, is `unverified` (recompute failed): we still
 *  surface it, erring toward flagging a possible problem over going silent. */
export function classifyDeadEndCause(
  pageCodes: string[],
  recomputeSlotCount: Map<string, number | null>,
): DeadEndCause {
  const bookedSolid: string[] = [];
  const dataAnomaly: string[] = [];
  const unverified: string[] = [];
  for (const code of pageCodes) {
    const count = recomputeSlotCount.get(code);
    if (!recomputeSlotCount.has(code) || count === null || count === undefined) {
      unverified.push(code);
    } else if (count > 0) {
      dataAnomaly.push(code);
    } else {
      bookedSolid.push(code);
    }
  }
  return { bookedSolid, dataAnomaly, unverified };
}

/** Truncated "code, code and N more" for one cause group. */
function capList(codes: string[]): string {
  const head = codes.slice(0, ALERT_NAME_CAP).join(", ");
  const more = codes.length > ALERT_NAME_CAP ? ` and ${codes.length - ALERT_NAME_CAP} more` : "";
  return `${head}${more}`;
}

/** Urgent page body for real dead-ends whose cause is a data/sync fault (or could
 *  not be verified). Booked-solid buckets are NOT included here (they are a quiet
 *  info signal). No em/en dashes (copy lint). */
export function formatDataAnomalyAlert(cause: DeadEndCause): string {
  const parts: string[] = [];
  if (cause.dataAnomaly.length) {
    parts.push(
      `${cause.dataAnomaly.length} bucket(s) show NO booking times but the agents' ` +
        `calendars are OPEN (${capList(cause.dataAnomaly)}): the cached availability ` +
        `disagrees with reality. Check the precompute and calendar sync pipeline.`,
    );
  }
  if (cause.unverified.length) {
    parts.push(
      `${cause.unverified.length} bucket(s) could not be verified because the live ` +
        `recompute failed (${capList(cause.unverified)}); treat as a possible sync issue.`,
    );
  }
  return `Slate: ${parts.join(" ")}`;
}

/** Low-priority info body: tiers empty because the agents are booked solid. This
 *  is a capacity fact, not an outage, so it whispers on a long cooldown. No
 *  em/en dashes (copy lint). */
export function formatBookedSolidNotice(bookedSolid: string[]): string {
  return (
    `Slate (info): ${bookedSolid.length} tier(s) show no booking times because the ` +
    `agents are booked solid (${capList(bookedSolid)}). Calendars are full, not ` +
    `broken; this is a capacity heads up, so check staffing if it persists.`
  );
}
```

Note: `capList` centralizes the truncation `formatFallbackCoveredNotice` also does; leave `formatFallbackCoveredNotice` as-is (do not refactor it in this task — keep the diff focused).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types scripts/test-monitor-availability-health.ts`
Expected: PASS — every `ok:` line prints, no `FAIL:`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/monitor/availability-health.ts scripts/test-monitor-availability-health.ts
git commit -m "Classify availability dead-end cause: booked solid vs data anomaly (#570)"
```

---

### Task 2: Wire live recompute into the monitor cron route

**Files:**
- Modify: `src/app/api/cron/monitor/route.ts`

**Interfaces:**
- Consumes: `classifyDeadEndCause`, `formatDataAnomalyAlert`, `formatBookedSolidNotice`, `type DeadEndCause` (Task 1); `getBucketSlots` (`@/lib/availability/service`); `slotCacheKey` (`@/lib/availability/cache-key`); `HORIZON_DAYS` (`@/lib/availability/slot-cache`); existing `mapWithConcurrency`, `sendThrottledAlert`, `sendThrottledInfo`.
- Produces: nothing consumed downstream (terminal wiring).

This task has no new unit test (the pure logic is covered in Task 1; the route is IO glue). Verification is `tsc --noEmit` + the build, run in Step 4.

- [ ] **Step 1: Update imports and constants**

In `src/app/api/cron/monitor/route.ts`, change the availability-health import to drop `formatEmptyAvailabilityAlert` and add the new names + type:

```ts
import {
  anyOnShift,
  classifyEmptyBuckets,
  classifyDeadEndCause,
  formatDataAnomalyAlert,
  formatBookedSolidNotice,
  formatFallbackCoveredNotice,
  type BucketHealth,
  type WorkingRule,
} from "@/lib/monitor/availability-health";
```

Add the recompute imports below the existing `eligibleAgentIdsCached` import:

```ts
import { getBucketSlots } from "@/lib/availability/service";
import { slotCacheKey } from "@/lib/availability/cache-key";
import { HORIZON_DAYS } from "@/lib/availability/slot-cache";
```

Replace the old empty-alert constants:

```ts
const EMPTY_ALERT_COOLDOWN_MS = 30 * 60_000;
// One consolidated alert (not one per bucket) so a broad outage is a single
// Slack message, not a storm — the cooldown throttles repeats.
const EMPTY_AVAIL_ALERT_KEY = "empty_availability";
```

with:

```ts
// Urgent page: a dead-end whose cache disagrees with the real calendars (or could
// not be verified). One consolidated message so a broad outage is one Slack post,
// not a storm; the cooldown throttles repeats. (Cooldown becomes UI-tunable in #571.)
const DATA_ANOMALY_ALERT_KEY = "availability_data_anomaly";
const DATA_ANOMALY_COOLDOWN_MS = 30 * 60_000;
// Quiet info: a dead-end because agents are booked solid. Full calendars are a
// good outcome, not an incident, so this whispers on a long cooldown. (#571)
const BOOKED_SOLID_INFO_KEY = "availability_booked_solid";
const BOOKED_SOLID_COOLDOWN_MS = 6 * 60 * 60_000;
```

- [ ] **Step 2: Replace the page-dispatch block with cause classification**

Find the block that currently reads:

```ts
    if (page.length) {
      await sendThrottledAlert(
        EMPTY_AVAIL_ALERT_KEY,
        EMPTY_ALERT_COOLDOWN_MS,
        formatEmptyAvailabilityAlert(page),
      ).catch(() => {});
    }
    if (covered.length) {
```

Replace everything from `if (page.length) {` up to (but NOT including) `if (covered.length) {` with:

```ts
    // For each paged bucket (the rare all-ladder-dry dead-end), recompute
    // availability live from the DB (busy_blocks/bookings/schedules, no Google) and
    // compare to the cached zero: recompute 0 = booked solid; > 0 = the cache
    // disagrees with the calendars (data anomaly); a failed recompute = unverified.
    const recomputeCounts = new Map<string, number | null>();
    if (page.length) {
      const { results: recomputes } = await mapWithConcurrency<string, { code: string; count: number | null }>(
        page,
        PROBE_CONCURRENCY,
        async (code) => {
          const { fromIso, toIso } = slotCacheKey(code, new Date(now).toISOString(), HORIZON_DAYS);
          try {
            const res = await getBucketSlots(code, fromIso, toIso);
            return { code, count: res ? res.slots.length : null };
          } catch {
            return { code, count: null };
          }
        },
        { deadlineMs: now + MONITOR_LOCK_TTL_MS },
      );
      for (const r of recomputes) if (r) recomputeCounts.set(r.code, r.count);
    }
    const cause = classifyDeadEndCause(page, recomputeCounts);
    if (cause.dataAnomaly.length || cause.unverified.length) {
      await sendThrottledAlert(
        DATA_ANOMALY_ALERT_KEY,
        DATA_ANOMALY_COOLDOWN_MS,
        formatDataAnomalyAlert(cause),
      ).catch(() => {});
    }
    if (cause.bookedSolid.length) {
      await sendThrottledInfo(
        BOOKED_SOLID_INFO_KEY,
        BOOKED_SOLID_COOLDOWN_MS,
        formatBookedSolidNotice(cause.bookedSolid),
      ).catch(() => {});
    }
```

- [ ] **Step 3: Update the console.log breakdown**

Find the existing `console.log` that starts ``monitor: ${page.length} dead-end + ${covered.length} fallback-covered`` and change its first line to include the cause split:

```ts
    console.log(
      `monitor: ${page.length} dead-end (${cause.dataAnomaly.length} anomaly, ` +
        `${cause.bookedSolid.length} booked-solid, ${cause.unverified.length} unverified) + ` +
        `${covered.length} fallback-covered of ${buckets.length} bucket(s)` +
        (page.length ? ` [page: ${page.join(", ")}]` : "") +
        (covered.length ? ` [covered: ${covered.map((c) => `${c.code}->${c.via}`).join(", ")}]` : "") +
        (truncated ? " [scan truncated by budget]" : ""),
    );
```

- [ ] **Step 4: Verify the whole suite (types, lint, unit, build)**

Run: `node --experimental-strip-types scripts/test-monitor-availability-health.ts && npx tsc --noEmit && pnpm lint && pnpm test`
Expected: monitor test all `ok:`, `tsc` clean (proves `getBucketSlots`/`slotCacheKey`/`HORIZON_DAYS` imports resolve and `res.slots` typechecks), lint clean, `pnpm test` green (including the copy/dash lint).

Then confirm no stale references remain:

Run: `grep -rn "formatEmptyAvailabilityAlert\|EMPTY_AVAIL_ALERT_KEY\|EMPTY_ALERT_COOLDOWN_MS" src scripts`
Expected: no output (all removed).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/cron/monitor/route.ts
git commit -m "Recompute paged buckets to page on data anomaly, whisper on booked-solid (#570)"
```

---

## Verification (whole change)

- [ ] `node --experimental-strip-types scripts/test-monitor-availability-health.ts` — all `ok:`.
- [ ] `npx tsc --noEmit` — clean.
- [ ] `pnpm lint` — clean.
- [ ] `pnpm test` — green (unit + copy/dash lint + migration invariants).
- [ ] `pnpm cf:build` — succeeds (the pre-push hook runs this; a build-only break must be caught locally).
- [ ] Push: `git push -u origin feat/availability-alert-cause-570`, open PR referencing #570.

## Self-Review notes

- Spec coverage: recompute-based split (Task 2), three-way classification + two formatters (Task 1), urgency mapping — anomaly/unverified page, booked-solid quiet info (Task 2 constants + dispatch), node-native tests (Task 1). Constants-not-UI per the #571 split (Global Constraints).
- The unverified bucket (deadline-skipped or recompute-thrown) is absent-or-null in `recomputeCounts`, which `classifyDeadEndCause` maps to `unverified`, which pages — matches "err toward surfacing."
- Names are consistent across tasks: `classifyDeadEndCause`, `formatDataAnomalyAlert`, `formatBookedSolidNotice`, `DeadEndCause`, `DATA_ANOMALY_ALERT_KEY`, `BOOKED_SOLID_INFO_KEY`.
