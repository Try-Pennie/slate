# Routing Explainability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist an explainable record of every routing decision (who was chosen and why each candidate was or was not eligible), self-alert on genuine misroutes without blocking the booking, and stamp the outbound booking webhook with whether a fallback was applied so Regal can suppress false alerts.

**Architecture:** Extend the existing per-booking `routing_trace` (bookings column) with richer reason + fallback-tier fields, and add a queryable `routing_decisions` table that also captures attempts producing NO booking. The decision data is built by small pure helpers (unit-tested node-native) and written from the booking orchestration path. A pure invariant check fires a throttled Slack alert when a chosen agent fails the bucket criteria and no fallback was intentional; the booking still completes. A daily cron prunes rows older than 12 months.

**Tech Stack:** Next.js 16 (App Router, TS), Supabase (Postgres, `supabaseAdmin` secret-key client), Luxon, node `--experimental-strip-types` tests + Vitest, Cloudflare Workers cron triggers.

**Companion spec:** `docs/superpowers/specs/2026-06-26-routing-explainability-and-tier-fallback-design.md`. This is **Plan 1 of 2**; the cascading tier-drop fallback behavior is Plan 2 and depends on this plan's log + fields existing. Plan 1 defines the `tier_fallback` / `requested_tier` / `booked_tier` / `rungs_dropped` fields and threads them through, but they stay `false`/`0`/`null` until Plan 2 populates them.

## Global Constraints

- DB types are hand-written in `src/lib/db/types.ts` + `src/lib/db/schema.ts` (no generated types). Add new tables to both.
- Migrations live in `supabase/migrations/NNNN_name.sql`: sequential 4-digit numbering with no gaps, filename matches `NNNN_[a-z0-9_]+\.sql`, NO `public.` prefix in `create table`, and every created table must `enable row level security` (or carry a `-- rls-exempt: <table>` marker). `scripts/test-migrations.ts` enforces this.
- RLS is default-deny; server code uses `supabaseAdmin()` (bypasses RLS). Do not add client-readable policies to the new table.
- Every feature ships a `scripts/test-*.ts` node-native test (run by `pnpm test`, which loops `scripts/test-*.ts` via `node --experimental-strip-types`, then runs `vitest`).
- Before pushing, the `pre-push` hook runs `tsc --noEmit`, `pnpm lint`, `pnpm test`, and `pnpm cf:build`. All must pass.
- User-facing/Slack copy: no em dashes; never reference the platform name "Cadence".
- `routing_trace` is already written at `src/lib/booking/orchestration.ts:970` (fresh create) and `:1138` (legacy create); extend in place, do not add a parallel mechanism.

---

### Task 1: Types + migration + schema for the decision log

**Files:**
- Modify: `src/lib/db/types.ts` (extend `RoutingTrace` ~line 304-313; add `RoutingExclusion`, `RoutingExcludeReason`, `RoutingDecision`)
- Create: `supabase/migrations/0054_routing_decisions.sql`
- Modify: `src/lib/db/schema.ts` (import + register `routing_decisions`)
- Test: `scripts/test-migrations.ts` (already exists; this task must keep it green)

**Interfaces:**
- Produces: `RoutingExcludeReason = "criteria_miss" | "no_availability"`; `RoutingExclusion = { user_id: string; reason: RoutingExcludeReason }`; extended `RoutingTrace` with optional `excluded?`, `tier_fallback?`, `requested_tier?`, `booked_tier?`, `rungs_dropped?`; `RoutingDecision` row type.

- [ ] **Step 1: Extend `RoutingTrace` and add new types in `src/lib/db/types.ts`**

Replace the existing `RoutingTrace` interface (currently at ~304-313) with the extended version and add the new types directly below it:

```typescript
/** Why a candidate was excluded from a routing decision. */
export type RoutingExcludeReason = "criteria_miss" | "no_availability";

export interface RoutingExclusion {
  user_id: string;
  reason: RoutingExcludeReason;
}

/** How a booking routed (for troubleshooting). Stored on bookings.routing_trace. */
export interface RoutingTrace {
  bucket_code: string;
  bucket_id: string;
  considered: string[];
  chosen_user_id: string;
  fallback_applied: boolean;
  reassignments?: { from: string | null; to: string; at: string }[];
  // Explainability (Plan 1):
  excluded?: RoutingExclusion[];
  // Tier-drop fields — populated by Plan 2, default false/0/null here:
  tier_fallback?: boolean;
  requested_tier?: string | null;
  booked_tier?: string | null;
  rungs_dropped?: number;
}

/** One routing decision, including attempts that produced no booking. */
export interface RoutingDecision {
  id: string;
  org_id: string;
  booking_id: string | null;
  bucket_code: string;
  bucket_id: string | null;
  requested_tier: string | null;
  booked_tier: string | null;
  chosen_user_id: string | null;
  considered: string[];
  excluded: RoutingExclusion[];
  empty_pool_fallback: boolean;
  tier_fallback: boolean;
  rungs_dropped: number;
  outcome: "booked" | "no_availability" | "no_eligible_agents" | "error";
  created_at: string;
}
```

- [ ] **Step 2: Create the migration `supabase/migrations/0054_routing_decisions.sql`**

(Confirm `0053_reschedule_lock_pin.sql` is the latest before naming; bump to the next number if a higher one exists.)

```sql
-- Persisted, queryable routing decisions (including no-booking attempts).
-- Answers "why did this booking go to this agent" and "why did this lead get
-- no slots". The per-booking bookings.routing_trace column holds the same data
-- for booked rows; this table additionally captures attempts that never booked.

create table routing_decisions (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null,
  booking_id          uuid references bookings(id) on delete set null,
  bucket_code         text not null,
  bucket_id           uuid,
  requested_tier      text,
  booked_tier         text,
  chosen_user_id      uuid,
  considered          jsonb not null default '[]'::jsonb,
  excluded            jsonb not null default '[]'::jsonb,
  empty_pool_fallback boolean not null default false,
  tier_fallback       boolean not null default false,
  rungs_dropped       int not null default 0,
  outcome             text not null
                        check (outcome in ('booked','no_availability','no_eligible_agents','error')),
  created_at          timestamptz not null default now()
);

create index routing_decisions_created_idx on routing_decisions (created_at);
create index routing_decisions_booking_idx on routing_decisions (booking_id);

-- Server reads/writes via the secret-key admin client; no client access.
alter table routing_decisions enable row level security;
```

- [ ] **Step 3: Register the table in `src/lib/db/schema.ts`**

Add `RoutingDecision` to the type import from `@/lib/db/types`, and add to the `Tables` object (alphabetical-ish, next to the other booking tables):

```typescript
    routing_decisions: Table<RoutingDecision>;
```

- [ ] **Step 4: Run the migration invariant + type checks**

Run: `pnpm test 2>&1 | grep -i migration` and `npx tsc --noEmit`
Expected: `scripts/test-migrations.ts` passes (sequential numbering intact, RLS enabled on `routing_decisions`); `tsc` reports no errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/types.ts src/lib/db/schema.ts supabase/migrations/0054_routing_decisions.sql
git commit -m "Add routing_decisions table and extend RoutingTrace"
```

---

### Task 2: Pure exclusion classifier

**Files:**
- Create: `src/lib/routing/explain.ts`
- Test: `scripts/test-routing-explain.ts`

**Interfaces:**
- Consumes: `matchesCriteria` from `src/lib/availability/match.ts`; `Attributes`, `Criteria`, `RoutingExclusion` from `src/lib/db/types.ts`.
- Produces: `classifyExclusions(orgAgents, manualMemberIds, criteria, freeIds): { considered: string[]; excluded: RoutingExclusion[] }`.

- [ ] **Step 1: Write the failing test `scripts/test-routing-explain.ts`**

```typescript
import { classifyExclusions } from "../src/lib/routing/explain.ts";
import type { Attributes } from "../src/lib/db/types.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); failures++; } else console.log("ok:", msg);
}

const agents: { id: string; attributes: Attributes }[] = [
  { id: "uh1", attributes: { debt_team: "ultra_high" } }, // matches, free
  { id: "uh2", attributes: { debt_team: "ultra_high" } }, // matches, NOT free
  { id: "vh1", attributes: { debt_team: "very_high" } },  // criteria miss
  { id: "man", attributes: { debt_team: "low" } },        // manual member, free
];
const criteria = { debt_team: "ultra_high" };
const manual = new Set<string>(["man"]);
const free = ["uh1", "man"];

const out = classifyExclusions(agents, manual, criteria, free);

assert(out.considered.sort().join(",") === "man,uh1", "considered = free eligible agents");
assert(
  out.excluded.some((e) => e.user_id === "uh2" && e.reason === "no_availability"),
  "eligible-but-not-free => no_availability",
);
assert(
  out.excluded.some((e) => e.user_id === "vh1" && e.reason === "criteria_miss"),
  "criteria mismatch => criteria_miss",
);
assert(!out.excluded.some((e) => e.user_id === "man"), "manual member never excluded");

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types scripts/test-routing-explain.ts`
Expected: FAIL — `classifyExclusions` is not exported / module not found.

- [ ] **Step 3: Implement `src/lib/routing/explain.ts`**

```typescript
import { matchesCriteria } from "@/lib/availability/match";
import type { Attributes, Criteria, RoutingExclusion } from "@/lib/db/types";

/**
 * Pure: split a bucket's bookable org pool into the candidates that were
 * considered (eligible AND free for the slot) and the ones excluded, each with
 * a reason. Reuses matchesCriteria so criteria logic is never duplicated.
 *
 * `orgAgents` must already be the bookable, non-deactivated pool (the same set
 * resolveBucketAgentIds queries). `freeIds` is the subset that passed slot
 * availability (freeMembersForSlot output).
 */
export function classifyExclusions(
  orgAgents: { id: string; attributes: Attributes }[],
  manualMemberIds: Set<string>,
  criteria: Criteria,
  freeIds: string[],
): { considered: string[]; excluded: RoutingExclusion[] } {
  const free = new Set(freeIds);
  const hasCriteria = Object.keys(criteria ?? {}).length > 0;
  const considered: string[] = [];
  const excluded: RoutingExclusion[] = [];

  for (const a of orgAgents) {
    const eligible =
      manualMemberIds.has(a.id) || (hasCriteria && matchesCriteria(a.attributes, criteria));
    if (!eligible) {
      excluded.push({ user_id: a.id, reason: "criteria_miss" });
      continue;
    }
    if (free.has(a.id)) considered.push(a.id);
    else excluded.push({ user_id: a.id, reason: "no_availability" });
  }
  return { considered, excluded };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types scripts/test-routing-explain.ts`
Expected: PASS — `ALL PASSED`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/routing/explain.ts scripts/test-routing-explain.ts
git commit -m "Add pure routing exclusion classifier"
```

---

### Task 3: Pure misroute invariant check

**Files:**
- Modify: `src/lib/routing/explain.ts` (add `isMisroute`)
- Test: `scripts/test-routing-explain.ts` (extend)

**Interfaces:**
- Consumes: `matchesCriteria`; `Attributes`, `Criteria` from types.
- Produces: `isMisroute({ chosenAttributes, criteria, emptyPoolFallback, tierFallback }): boolean`.

- [ ] **Step 1: Add a failing test to `scripts/test-routing-explain.ts`**

Append before the final `console.log`:

```typescript
import { isMisroute } from "../src/lib/routing/explain.ts";

// chosen agent satisfies criteria => not a misroute
assert(
  isMisroute({
    chosenAttributes: { debt_team: "ultra_high" },
    criteria: { debt_team: "ultra_high" },
    emptyPoolFallback: false,
    tierFallback: false,
  }) === false,
  "qualified agent is not a misroute",
);

// chosen agent fails criteria, no intentional fallback => misroute
assert(
  isMisroute({
    chosenAttributes: { debt_team: "very_high" },
    criteria: { debt_team: "ultra_high" },
    emptyPoolFallback: false,
    tierFallback: false,
  }) === true,
  "unqualified agent with no fallback is a misroute",
);

// chosen agent fails criteria but it was an intentional fallback => NOT a misroute
assert(
  isMisroute({
    chosenAttributes: { debt_team: "very_high" },
    criteria: { debt_team: "ultra_high" },
    emptyPoolFallback: false,
    tierFallback: true,
  }) === false,
  "intentional tier-drop is not a misroute",
);
assert(
  isMisroute({
    chosenAttributes: { debt_team: "very_high" },
    criteria: { debt_team: "ultra_high" },
    emptyPoolFallback: true,
    tierFallback: false,
  }) === false,
  "intentional empty-pool fallback is not a misroute",
);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types scripts/test-routing-explain.ts`
Expected: FAIL — `isMisroute` is not exported.

- [ ] **Step 3: Implement `isMisroute` in `src/lib/routing/explain.ts`**

```typescript
/**
 * Pure: a misroute is when the chosen agent does NOT satisfy the bucket
 * criteria AND no intentional fallback explains it. Intentional fallbacks
 * (empty-pool designated agent, or a tier-drop) are expected, not bugs.
 */
export function isMisroute(input: {
  chosenAttributes: Attributes;
  criteria: Criteria;
  emptyPoolFallback: boolean;
  tierFallback: boolean;
}): boolean {
  if (input.emptyPoolFallback || input.tierFallback) return false;
  if (Object.keys(input.criteria ?? {}).length === 0) return false;
  return !matchesCriteria(input.chosenAttributes, input.criteria);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types scripts/test-routing-explain.ts`
Expected: PASS — `ALL PASSED`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/routing/explain.ts scripts/test-routing-explain.ts
git commit -m "Add pure misroute invariant check"
```

---

### Task 4: Webhook payload fallback stamp

**Files:**
- Modify: `src/lib/webhooks/types.ts` (`BookingEventPayload`, ~line 15-36; add `RoutingMeta`)
- Modify: `src/lib/booking/orchestration.ts` (`webhookPayload()`, line 570-604)
- Test: `scripts/test-webhook-routing-stamp.ts`

**Interfaces:**
- Consumes: `RoutingTrace` from types; `Booking` (carries `routing_trace`).
- Produces: `BookingEventPayload.routing: RoutingMeta`; `routingMetaFromTrace(trace): RoutingMeta` exported from `src/lib/webhooks/types.ts`.

- [ ] **Step 1: Write the failing test `scripts/test-webhook-routing-stamp.ts`**

```typescript
import { routingMetaFromTrace } from "../src/lib/webhooks/types.ts";
import type { RoutingTrace } from "../src/lib/db/types.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); failures++; } else console.log("ok:", msg);
}

const plain: RoutingTrace = {
  bucket_code: "500", bucket_id: "b", considered: ["a"], chosen_user_id: "a",
  fallback_applied: false,
};
let m = routingMetaFromTrace(plain);
assert(m.tier_fallback === false, "plain trace => tier_fallback false");
assert(m.empty_pool_fallback === false, "plain trace => empty_pool_fallback false");
assert(m.rungs_dropped === 0, "plain trace => rungs_dropped 0");

const dropped: RoutingTrace = {
  bucket_code: "500", bucket_id: "b", considered: ["v"], chosen_user_id: "v",
  fallback_applied: false, tier_fallback: true, requested_tier: "ultra_high",
  booked_tier: "very_high", rungs_dropped: 1,
};
m = routingMetaFromTrace(dropped);
assert(m.tier_fallback === true, "tier-drop trace => tier_fallback true");
assert(m.requested_tier === "ultra_high" && m.booked_tier === "very_high", "tiers carried");
assert(m.rungs_dropped === 1, "rungs carried");

const emptyPool: RoutingTrace = {
  bucket_code: "500", bucket_id: "b", considered: ["f"], chosen_user_id: "f",
  fallback_applied: true,
};
assert(routingMetaFromTrace(emptyPool).empty_pool_fallback === true, "empty-pool flag carried");

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types scripts/test-webhook-routing-stamp.ts`
Expected: FAIL — `routingMetaFromTrace` not exported.

- [ ] **Step 3: Add `RoutingMeta` + `routingMetaFromTrace` and extend `BookingEventPayload` in `src/lib/webhooks/types.ts`**

Add the import of `RoutingTrace` to the existing type import from `@/lib/db/types`, then add:

```typescript
/** Routing/fallback summary on the booking event, so Regal can suppress its
 *  "Non-Ultra High Team Booking Detected" alert on intentional tier-drops. */
export interface RoutingMeta {
  empty_pool_fallback: boolean;
  tier_fallback: boolean;
  requested_tier: string | null;
  booked_tier: string | null;
  rungs_dropped: number;
}

export function routingMetaFromTrace(trace: RoutingTrace | null): RoutingMeta {
  return {
    empty_pool_fallback: trace?.fallback_applied ?? false,
    tier_fallback: trace?.tier_fallback ?? false,
    requested_tier: trace?.requested_tier ?? null,
    booked_tier: trace?.booked_tier ?? null,
    rungs_dropped: trace?.rungs_dropped ?? 0,
  };
}
```

Add the field to `BookingEventPayload` (after `reason`):

```typescript
  reason: BookingReasonMeta | null;
  routing: RoutingMeta;
```

- [ ] **Step 4: Populate `routing` in `webhookPayload()` (`src/lib/booking/orchestration.ts:570-604`)**

Add the import `routingMetaFromTrace` from `@/lib/webhooks/types`, then add the field to the returned object (after `reason`):

```typescript
    reason,
    routing: routingMetaFromTrace(booking.routing_trace),
```

- [ ] **Step 5: Run the test + typecheck**

Run: `node --experimental-strip-types scripts/test-webhook-routing-stamp.ts` then `npx tsc --noEmit`
Expected: PASS, and `tsc` clean (every `BookingEventPayload` literal now includes `routing` — `webhookPayload()` is the only builder, so no other call sites break).

- [ ] **Step 6: Commit**

```bash
git add src/lib/webhooks/types.ts src/lib/booking/orchestration.ts scripts/test-webhook-routing-stamp.ts
git commit -m "Stamp booking webhook with routing/fallback metadata"
```

---

### Task 5: Pure retention cutoff + prune cron

**Files:**
- Create: `src/lib/routing/retention.ts`
- Test: `scripts/test-routing-retention.ts`
- Create: `src/app/api/cron/prune-routing/route.ts`
- Modify: `wrangler.jsonc` (add a daily cron trigger)
- Modify: `worker/cron-routes.ts` (map the new schedule)

**Interfaces:**
- Consumes: Luxon `DateTime`.
- Produces: `pruneCutoffIso(nowIso, months = 12): string`.

- [ ] **Step 1: Write the failing test `scripts/test-routing-retention.ts`**

```typescript
import { pruneCutoffIso } from "../src/lib/routing/retention.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); failures++; } else console.log("ok:", msg);
}

assert(pruneCutoffIso("2026-06-26T00:00:00.000Z") === "2025-06-26T00:00:00.000Z", "12 months back");
assert(pruneCutoffIso("2026-06-26T00:00:00.000Z", 6) === "2025-12-26T00:00:00.000Z", "6 months back");

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types scripts/test-routing-retention.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/routing/retention.ts`**

```typescript
import { DateTime } from "luxon";

/** ISO timestamp `months` before `nowIso`; rows older than this are pruned. */
export function pruneCutoffIso(nowIso: string, months = 12): string {
  return DateTime.fromISO(nowIso, { zone: "utc" })
    .minus({ months })
    .toUTC()
    .toISO({ suppressMilliseconds: false })!;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types scripts/test-routing-retention.ts`
Expected: PASS — `ALL PASSED`.

- [ ] **Step 5: Create the cron route `src/app/api/cron/prune-routing/route.ts`**

Mirror the auth/lock pattern from `src/app/api/cron/agents/route.ts`. Verify the exact import paths for `isAuthorizedCron`, `acquireLock`, `releaseLock`, and `supabaseAdmin` against that file before writing.

```typescript
import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron/auth";
import { acquireLock, releaseLock } from "@/lib/cron/lock";
import { supabaseAdmin } from "@/lib/db/admin";
import { pruneCutoffIso } from "@/lib/routing/retention";

const LOCK_TTL_MS = 60_000;

export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return new NextResponse("unauthorized", { status: 401 });
  const lock = await acquireLock("cron_prune_routing", LOCK_TTL_MS);
  if (!lock) return NextResponse.json({ skipped: "overlapping-run" });
  try {
    const cutoff = pruneCutoffIso(new Date().toISOString());
    const { error, count } = await supabaseAdmin()
      .from("routing_decisions")
      .delete({ count: "exact" })
      .lt("created_at", cutoff);
    if (error) throw new Error(error.message);
    return NextResponse.json({ pruned: count ?? 0, cutoff });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`prune-routing cron failed: ${message}`);
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    await releaseLock("cron_prune_routing", lock);
  }
}
```

- [ ] **Step 6: Register the schedule**

In `wrangler.jsonc` add a daily trigger to the `triggers.crons` array:

```jsonc
        "0 3 * * *",        // daily 3am UTC: prune routing_decisions
```

In `worker/cron-routes.ts` add to `CRON_ROUTES`:

```typescript
  "0 3 * * *": "/api/cron/prune-routing",
```

- [ ] **Step 7: Typecheck + build**

Run: `npx tsc --noEmit && pnpm cf:build`
Expected: both succeed (the route resolves and the worker build maps the cron).

- [ ] **Step 8: Commit**

```bash
git add src/lib/routing/retention.ts scripts/test-routing-retention.ts src/app/api/cron/prune-routing/route.ts wrangler.jsonc worker/cron-routes.ts
git commit -m "Prune routing_decisions older than 12 months via daily cron"
```

---

### Task 6: Capture the full pool at resolve time

**Files:**
- Modify: `src/lib/availability/service.ts` (`resolveBucketAgentIds` ~36-75; add a sibling `resolveBucketPool`)
- Test: `scripts/test-routing-pool.ts`

**Interfaces:**
- Produces: `resolveBucketPool(bucket): Promise<{ orgAgents: { id: string; attributes: Attributes }[]; manualMemberIds: Set<string>; criteria: Criteria }>`. `resolveBucketAgentIds` is refactored to call it so there is one source of truth.

This task exists because the decision log (Task 7) needs the FULL bookable pool + manual members + criteria to call `classifyExclusions`, but `resolveBucketAgentIds` currently throws that data away after filtering.

- [ ] **Step 1: Write the failing test `scripts/test-routing-pool.ts`**

```typescript
import { agentIdsFromPool } from "../src/lib/availability/service.ts";
import type { Attributes } from "../src/lib/db/types.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); failures++; } else console.log("ok:", msg);
}

// agentIdsFromPool is the pure filter extracted from resolveBucketAgentIds.
const orgAgents: { id: string; attributes: Attributes }[] = [
  { id: "a", attributes: { debt_team: "ultra_high" } },
  { id: "b", attributes: { debt_team: "low" } },
  { id: "c", attributes: { debt_team: "low" } }, // manual member
];
const ids = agentIdsFromPool(orgAgents, new Set(["c"]), { debt_team: "ultra_high" });
assert(ids.sort().join(",") === "a,c", "matched criteria OR manual member");

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types scripts/test-routing-pool.ts`
Expected: FAIL — `agentIdsFromPool` not exported.

- [ ] **Step 3: Extract the pure filter and add `resolveBucketPool` in `src/lib/availability/service.ts`**

Add the exported pure helper (mirrors the existing filter at lines 69-74 exactly so behavior is unchanged):

```typescript
/** Pure: the eligible ids from a resolved pool (manual member OR criteria match). */
export function agentIdsFromPool(
  orgAgents: { id: string; attributes: Attributes }[],
  manualMemberIds: Set<string>,
  criteria: Criteria,
): string[] {
  const hasCriteria = Object.keys(criteria ?? {}).length > 0;
  return orgAgents
    .filter((a) => manualMemberIds.has(a.id) || (hasCriteria && matchesCriteria(a.attributes, criteria)))
    .map((a) => a.id);
}
```

Add `resolveBucketPool` that performs the two reads (copy the existing `Promise.all` query block from `resolveBucketAgentIds` lines 41-67) and returns the raw data:

```typescript
export async function resolveBucketPool(bucket: Bucket): Promise<{
  orgAgents: { id: string; attributes: Attributes }[];
  manualMemberIds: Set<string>;
  criteria: Criteria;
}> {
  const db = supabaseAdmin();
  const [membersRes, agentsRes] = await Promise.all([
    db.from("bucket_members").select("user_id").eq("bucket_id", bucket.id).eq("active", true),
    db.from("users").select("id, attributes, bookable").eq("org_id", bucket.org_id)
      .eq("bookable", true).is("deactivated_at", null),
  ]);
  const manualMemberIds = new Set(
    (unwrap(membersRes, "bucket_members") ?? []).map((m) => (m as { user_id: string }).user_id),
  );
  const orgAgents = (unwrap(agentsRes, "bucket pool agents") ?? []).map((a) => {
    const row = a as { id: string; attributes: Attributes };
    return { id: row.id, attributes: row.attributes };
  });
  return { orgAgents, manualMemberIds, criteria: bucket.criteria ?? {} };
}
```

Refactor `resolveBucketAgentIds` to delegate (keeps one source of truth):

```typescript
export async function resolveBucketAgentIds(bucket: Bucket): Promise<string[]> {
  const { orgAgents, manualMemberIds, criteria } = await resolveBucketPool(bucket);
  return agentIdsFromPool(orgAgents, manualMemberIds, criteria);
}
```

- [ ] **Step 4: Run the test + existing availability tests**

Run: `node --experimental-strip-types scripts/test-routing-pool.ts` then `pnpm test` then `npx tsc --noEmit`
Expected: new test PASS; existing suite still green (the refactor is behavior-preserving).

- [ ] **Step 5: Commit**

```bash
git add src/lib/availability/service.ts scripts/test-routing-pool.ts
git commit -m "Expose resolveBucketPool for routing explainability"
```

---

### Task 7: Write the decision log + fire the misroute alert

**Files:**
- Create: `src/lib/routing/record.ts` (decision-log writer + alert)
- Modify: `src/lib/booking/orchestration.ts` (extend the `routing_trace` literals at ~970 and ~1138; call the recorder)
- Test: `scripts/test-routing-record.ts` (pure parts), plus manual/live verification for the DB write

**Interfaces:**
- Consumes: `classifyExclusions`, `isMisroute` (Task 2/3); `resolveBucketPool` (Task 6); `sendThrottledAlert` from `@/lib/notify/dispatch`; `supabaseAdmin`.
- Produces: `buildRoutingTraceExtras(pool, freeIds): { considered: string[]; excluded: RoutingExclusion[] }`; `recordRoutingDecision(input): Promise<void>`; `MISROUTE_ALERT_COOLDOWN_MS`.

- [ ] **Step 1: Write the failing test `scripts/test-routing-record.ts`** (pure assembly only)

```typescript
import { buildRoutingTraceExtras } from "../src/lib/routing/record.ts";
import type { Attributes } from "../src/lib/db/types.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); failures++; } else console.log("ok:", msg);
}

const pool = {
  orgAgents: [
    { id: "a", attributes: { debt_team: "ultra_high" } as Attributes },
    { id: "b", attributes: { debt_team: "very_high" } as Attributes },
  ],
  manualMemberIds: new Set<string>(),
  criteria: { debt_team: "ultra_high" },
};
const extras = buildRoutingTraceExtras(pool, ["a"]);
assert(extras.considered.join(",") === "a", "considered carried from free ids");
assert(
  extras.excluded.some((e) => e.user_id === "b" && e.reason === "criteria_miss"),
  "non-matching agent recorded as criteria_miss",
);

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types scripts/test-routing-record.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/routing/record.ts`**

```typescript
import { classifyExclusions, isMisroute } from "@/lib/routing/explain";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import { supabaseAdmin } from "@/lib/db/admin";
import type { Attributes, Criteria, RoutingExclusion, RoutingDecision } from "@/lib/db/types";

export const MISROUTE_ALERT_COOLDOWN_MS = 30 * 60 * 1000;

interface Pool {
  orgAgents: { id: string; attributes: Attributes }[];
  manualMemberIds: Set<string>;
  criteria: Criteria;
}

/** Pure: the explainability extras to merge into routing_trace / the log row. */
export function buildRoutingTraceExtras(
  pool: Pool,
  freeIds: string[],
): { considered: string[]; excluded: RoutingExclusion[] } {
  return classifyExclusions(pool.orgAgents, pool.manualMemberIds, pool.criteria, freeIds);
}

/** Persist one routing decision and fire a misroute alert if the chosen agent
 *  fails criteria with no intentional fallback. Best-effort; never throws. */
export async function recordRoutingDecision(input: {
  orgId: string;
  bookingId: string | null;
  bucketCode: string;
  bucketId: string | null;
  criteria: Criteria;
  considered: string[];
  excluded: RoutingExclusion[];
  chosenUserId: string | null;
  chosenAttributes: Attributes | null;
  emptyPoolFallback: boolean;
  tierFallback: boolean;
  rungsDropped: number;
  requestedTier: string | null;
  bookedTier: string | null;
  outcome: RoutingDecision["outcome"];
}): Promise<void> {
  try {
    await supabaseAdmin().from("routing_decisions").insert({
      org_id: input.orgId,
      booking_id: input.bookingId,
      bucket_code: input.bucketCode,
      bucket_id: input.bucketId,
      requested_tier: input.requestedTier,
      booked_tier: input.bookedTier,
      chosen_user_id: input.chosenUserId,
      considered: input.considered,
      excluded: input.excluded,
      empty_pool_fallback: input.emptyPoolFallback,
      tier_fallback: input.tierFallback,
      rungs_dropped: input.rungsDropped,
      outcome: input.outcome,
    });
  } catch (err) {
    console.error(`routing_decisions insert failed: ${String(err)}`);
  }

  if (
    input.chosenAttributes &&
    isMisroute({
      chosenAttributes: input.chosenAttributes,
      criteria: input.criteria,
      emptyPoolFallback: input.emptyPoolFallback,
      tierFallback: input.tierFallback,
    })
  ) {
    await sendThrottledAlert(
      `misroute:${input.bucketCode}`,
      MISROUTE_ALERT_COOLDOWN_MS,
      `Slate routing check: booking ${input.bookingId ?? "(none)"} in bucket ${input.bucketCode} went to agent ${input.chosenUserId ?? "(none)"}, who does not match the bucket criteria, and no fallback was applied. This looks like a routing bug; the booking was allowed through. Inspect routing_decisions for this booking.`,
    ).catch(() => {});
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types scripts/test-routing-record.ts`
Expected: PASS — `ALL PASSED`.

- [ ] **Step 5: Thread capture into the create path (`src/lib/booking/orchestration.ts`)**

At the fresh-create site (~936-980), after `assignAgent` returns and before/around building the booking literal, resolve the pool and extras, then extend the `routing_trace` literal (line 970-979) to include `excluded` and the tier fields (defaults), and call `recordRoutingDecision` after the booking is persisted. Concretely, extend the `routing_trace` object to:

```typescript
    routing_trace: {
      bucket_code: input.bucketCode,
      bucket_id: bucket.id,
      considered: candidates,
      chosen_user_id: userId,
      fallback_applied:
        bucket.fallback_user_id != null &&
        candidates.length > 0 &&
        candidates.every((id) => id === bucket.fallback_user_id),
      excluded: traceExtras.excluded,
      tier_fallback: false,
      requested_tier: bucket.criteria?.debt_team
        ? String(bucket.criteria.debt_team)
        : null,
      booked_tier: null,
      rungs_dropped: 0,
    },
```

where `traceExtras` is computed just above from `resolveBucketPool(bucket)` + the free candidate set. Add the `recordRoutingDecision({...})` call on the post-commit side-effects path (alongside the `booking.created` webhook fire at ~1077), passing `chosenAttributes` loaded for the chosen agent, `outcome: "booked"`. Mirror the same `routing_trace` extension at the legacy-create literal (~1138).

Note for the implementer: `requested_tier` vs `booked_tier` differ only under a tier-drop (Plan 2); in Plan 1 `booked_tier` stays null and `tier_fallback` false.

- [ ] **Step 6: Record no-booking attempts**

In `assignAgent` / the create path's error handling, when assignment throws `NoEligibleAgentsError`, `VerifyUnavailableError`, or `SlotUnavailableError`, call `recordRoutingDecision` with `bookingId: null`, `chosenUserId: null`, `chosenAttributes: null`, and `outcome` of `"no_eligible_agents"` (NoEligibleAgents) or `"no_availability"` (the other two), so "why did this lead get no slots" is captured. Keep it best-effort (the recorder already swallows errors) and do not change the thrown error/control flow.

- [ ] **Step 7: Typecheck, build, and live-verify the write**

Run: `npx tsc --noEmit && pnpm test && pnpm cf:build`
Expected: all green.

Live check (requires a deployed/preview env with DB): make one booking through the booker, then confirm a `routing_decisions` row exists with `outcome = 'booked'`, the chosen agent, and an `excluded` array; and confirm the `bookings.routing_trace` for that booking now carries `excluded`. (Use the Supabase MCP `execute_sql` against the slate project, or the admin tooling. This step is the user's to run since it needs a real booking — see handoff.)

- [ ] **Step 8: Commit**

```bash
git add src/lib/routing/record.ts scripts/test-routing-record.ts src/lib/booking/orchestration.ts
git commit -m "Record routing decisions and alert on misroutes"
```

---

## Self-Review

**Spec coverage:**
- Decision log (spine) → Tasks 1, 2, 6, 7 (table + classifier + pool + writer; captures no-booking attempts in Task 7 Step 6).
- Misroute bug alert (alert + allow) → Task 3 (pure check) + Task 7 (wire, best-effort, booking still completes).
- Webhook fallback stamp → Task 4.
- 12-month prune → Task 5.
- Tier-drop fallback behavior → intentionally Plan 2; Plan 1 only defines/threads the fields (`tier_fallback`, `requested_tier`, `booked_tier`, `rungs_dropped`) as inert defaults.
- Finer availability exclusion reasons (daily_cap vs working_hours vs busy) → deliberately collapsed to a single `no_availability` reason in Plan 1; note in spec if finer breakdown is wanted later.

**Type consistency:** `RoutingExclusion`/`RoutingExcludeReason`/`RoutingTrace`/`RoutingDecision` defined in Task 1 and used identically in Tasks 2, 4, 6, 7. `routingMetaFromTrace` reads only fields defined on the extended `RoutingTrace`. `classifyExclusions`/`isMisroute` signatures match their call sites in Task 7.

**Open implementer notes (verify against live code, do not assume):** exact import paths for `isAuthorizedCron`, `acquireLock`/`releaseLock`, `supabaseAdmin` (Task 5/7 — confirm from `src/app/api/cron/agents/route.ts`); the precise post-commit side-effect site for the booked-path recorder call (Task 7 Step 5); whether the legacy-create path (~1138) is still reachable (extend it anyway for safety).
