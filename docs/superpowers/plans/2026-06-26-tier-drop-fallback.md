# Tier-Drop Cascade Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a bucket has zero bookable slots across the whole booking window, surface the next debt-tier-down bucket's slots in the booker, cascading down the tier ladder until a tier has availability, and record/stamp/alert on the drop so it is explainable and Regal can suppress its alert.

**Architecture:** A pure tier-ladder helper turns an XBC code into the ordered list of lower-tier codes to try (511 → 411 → 311 → 211 → 111). For DISPLAY, a server cascade calls the existing cached per-bucket slot fetch for each code in turn and returns the first tier with slots, so the booker shows lower-tier slots transparently under the customer's original code. For BOOKING, the server is authoritative: the booker books with the ORIGINAL code only, and the create-booking path re-derives the tier itself — it tries to assign in the requested bucket for the chosen slot, and only if that bucket has no agent free for that slot does it cascade down the ladder, assigning in the first lower bucket that can serve the slot. The bucket it actually books determines `tier_fallback`/`requested_tier`/`booked_tier`/`rungs_dropped`, which are stamped into `routing_trace`, recorded via Plan 1's recorder, and drive a tiered Slack alert (one-rung = throttled notice, two-plus = escalated). The client never tells the server which tier to use, so a spoofed request cannot mis-route or double-book.

**Tech Stack:** Next.js 16 (App Router, TS), Supabase (`supabaseAdmin`), Luxon, node `--experimental-strip-types` tests + Vitest, Playwright MCP for visual verification, Cloudflare Workers.

**Companion spec:** `docs/superpowers/specs/2026-06-26-routing-explainability-and-tier-fallback-design.md`. This is **Plan 2 of 2**. It DEPENDS ON Plan 1 (`docs/superpowers/plans/2026-06-26-routing-explainability.md`) being implemented first: it reuses the extended `RoutingTrace` fields (`tier_fallback`, `requested_tier`, `booked_tier`, `rungs_dropped`), `recordRoutingDecision()` from `src/lib/routing/record.ts`, and the `RoutingMeta` webhook stamp. Do not start Plan 2 until Plan 1 is merged.

## Global Constraints

- DB types are hand-written (`src/lib/db/types.ts` + `schema.ts`); no migrations are expected in this plan (no new tables — buckets/event types already exist).
- Every feature ships a `scripts/test-*.ts` node-native test (run by `pnpm test`).
- Before pushing, the `pre-push` hook runs `tsc --noEmit`, `pnpm lint`, `pnpm test`, `pnpm cf:build`. All must pass.
- Screenshots against `next dev` hang; before any Playwright capture, freeze motion via the `browser_evaluate` style-injection snippet in `AGENTS.md`, and prefer JPEG. Save captures outside the repo root.
- The booking window/horizon is fixed at **4 days** (`HORIZON_DAYS` in `src/lib/availability/slot-cache.ts:17` and `Booker.tsx:206`). "Exhausted across the window" means zero slots in this horizon for the bucket.
- Tier ladder: drop relaxes ONLY the first XBC digit (debt tier); the backend + legal digits stay fixed (so 511 → 411, never to an unrelated code). Confirmed in spec.
- Embed contract: do not change `widget.js` or the `slate:bookingSuccessful` postMessage shape. The Booker keeps booking through `POST /booking`.
- Slack/customer copy: no em dashes; never reference "Cadence". The customer never sees tier labels; the drop is seamless to them.

---

### Task 1: Pure tier ladder

**Files:**
- Create: `src/lib/routing/tiers.ts`
- Test: `scripts/test-routing-tiers.ts`

**Interfaces:**
- Consumes: `DEBT_TIER` from `src/lib/xbc.ts`.
- Produces: `tierLadder(code: string): string[]` (requested code first, then each lower tier); `tierKeyOf(code: string): string | null` (the `debt_team` key for a code's first digit).

- [ ] **Step 1: Write the failing test `scripts/test-routing-tiers.ts`**

```typescript
import { tierLadder, tierKeyOf } from "../src/lib/routing/tiers.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); failures++; } else console.log("ok:", msg);
}

assert(tierLadder("511").join(",") === "511,411,311,211,111", "ultra high cascades to low, same backend/legal");
assert(tierLadder("412").join(",") === "412,312,212,112", "very high cascades down, digits 1+2 preserved");
assert(tierLadder("111").join(",") === "111", "low tier has no lower rung");
assert(tierLadder("bad").join(",") === "bad", "invalid code returns itself only");

assert(tierKeyOf("511") === "ultra_high", "first digit 5 => ultra_high");
assert(tierKeyOf("411") === "very_high", "first digit 4 => very_high");
assert(tierKeyOf("bad") === null, "invalid code => null");

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types scripts/test-routing-tiers.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/routing/tiers.ts`**

```typescript
import { DEBT_TIER } from "@/lib/xbc";

const XBC = /^[1-5][0-3][0-2]$/;

/**
 * The ordered list of bucket codes to try for a tier-drop fallback: the
 * requested code first, then each lower debt tier with the SAME backend + legal
 * digits. "511" => ["511","411","311","211","111"]. Invalid codes return [code].
 */
export function tierLadder(code: string): string[] {
  if (!XBC.test(code)) return [code];
  const adv = Number(code[0]);
  const rest = code.slice(1);
  const out: string[] = [];
  for (let t = adv; t >= 1; t--) out.push(`${t}${rest}`);
  return out;
}

/** The debt_team key for a code's first digit, or null if the code is invalid. */
export function tierKeyOf(code: string): string | null {
  if (!XBC.test(code)) return null;
  return DEBT_TIER[code[0]]?.key ?? null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types scripts/test-routing-tiers.ts`
Expected: PASS — `ALL PASSED`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/routing/tiers.ts scripts/test-routing-tiers.ts
git commit -m "Add pure tier-ladder helper for fallback"
```

---

### Task 2: Pure cascade selection

**Files:**
- Create: `src/lib/routing/tier-fallback.ts`
- Test: `scripts/test-tier-fallback.ts`

**Interfaces:**
- Consumes: `tierLadder` (Task 1).
- Produces: `selectWithTierFallback(code, fetchSlots): Promise<{ effectiveCode: string; slots: string[]; rungsDropped: number } | null>` where `fetchSlots(code) => Promise<string[] | null>` (null = bucket does not exist; treated as "skip to next").

- [ ] **Step 1: Write the failing test `scripts/test-tier-fallback.ts`**

```typescript
import { selectWithTierFallback } from "../src/lib/routing/tier-fallback.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); failures++; } else console.log("ok:", msg);
}
async function run() {
  // requested tier has slots: no drop
  let r = await selectWithTierFallback("511", async (c) => (c === "511" ? ["s1"] : []));
  assert(r?.effectiveCode === "511" && r?.rungsDropped === 0, "slots in requested tier => no drop");

  // requested empty, two tiers down has slots
  r = await selectWithTierFallback("511", async (c) => (c === "311" ? ["s1", "s2"] : []));
  assert(r?.effectiveCode === "311" && r?.rungsDropped === 2, "drops two rungs to first tier with slots");

  // a missing bucket (null) is skipped, not treated as available
  r = await selectWithTierFallback("511", async (c) => (c === "411" ? null : c === "311" ? ["s"] : []));
  assert(r?.effectiveCode === "311" && r?.rungsDropped === 2, "null bucket is skipped");

  // nothing anywhere => null
  r = await selectWithTierFallback("511", async () => []);
  assert(r === null, "no availability anywhere => null");

  console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
run();
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types scripts/test-tier-fallback.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/routing/tier-fallback.ts`**

```typescript
import { tierLadder } from "@/lib/routing/tiers";

/**
 * Walk the tier ladder for `code`, calling fetchSlots for each tier in turn.
 * Returns the first tier that has slots, with how many rungs were dropped
 * (0 = the requested tier itself). Returns null if no tier has availability.
 * fetchSlots returns null for a non-existent bucket, which is skipped.
 */
export async function selectWithTierFallback(
  code: string,
  fetchSlots: (code: string) => Promise<string[] | null>,
): Promise<{ effectiveCode: string; slots: string[]; rungsDropped: number } | null> {
  const ladder = tierLadder(code);
  for (let i = 0; i < ladder.length; i++) {
    const slots = await fetchSlots(ladder[i]);
    if (slots && slots.length > 0) {
      return { effectiveCode: ladder[i], slots, rungsDropped: i };
    }
  }
  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types scripts/test-tier-fallback.ts`
Expected: PASS — `ALL PASSED`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/routing/tier-fallback.ts scripts/test-tier-fallback.ts
git commit -m "Add pure tier-fallback cascade selection"
```

---

### Task 3: Server availability cascade + response shape

**Files:**
- Modify: `src/lib/availability/service.ts` (add `getBucketSlotsWithFallback`; near `getBucketSlots` ~260 and `resolveBucketByCode` ~164)
- Modify: `src/lib/availability/slot-cache.ts` (reuse `getCachedBucketSlots`)
- Modify: `src/app/api/availability/route.ts` (call the cascade; extend response with `routing`)
- Test: `scripts/test-tier-fallback.ts` already covers the pure selection; this task is integration, verified by typecheck/build + a live check.

**Interfaces:**
- Consumes: `selectWithTierFallback` (Task 2); `getCachedBucketSlots(code, from, horizonDays?)` (slot-cache.ts:44); `resolveBucketByCode` (service.ts:164); `tierKeyOf` (Task 1).
- Produces: `getBucketSlotsWithFallback(code, from): Promise<(BucketSlots & { routing: AvailabilityRoutingMeta }) | null>`; exported `interface AvailabilityRoutingMeta`.

- [ ] **Step 1: Add `AvailabilityRoutingMeta` + `getBucketSlotsWithFallback` to `src/lib/availability/service.ts`**

```typescript
import { selectWithTierFallback } from "@/lib/routing/tier-fallback";
import { tierKeyOf } from "@/lib/routing/tiers";

export interface AvailabilityRoutingMeta {
  requested_code: string;
  effective_code: string;
  tier_fallback: boolean;
  rungs_dropped: number;
  requested_tier: string | null;
  booked_tier: string | null;
}

/**
 * Cached slots for `code`; if the whole 4-day horizon is empty, cascade down
 * the tier ladder and return the first lower tier that has slots, with a
 * routing descriptor. Returns null only when the requested bucket itself does
 * not exist. When no tier (including lower ones) has slots, returns the
 * requested bucket with empty slots and tier_fallback=false.
 */
export async function getBucketSlotsWithFallback(
  code: string,
  from: string,
): Promise<(BucketSlots & { routing: AvailabilityRoutingMeta }) | null> {
  const requested = await getCachedBucketSlots(code, from);
  if (!requested) return null; // requested bucket doesn't exist => 404 upstream

  const noFallback = (slotsFor: BucketSlots, rungs: number): BucketSlots & { routing: AvailabilityRoutingMeta } => ({
    ...slotsFor,
    routing: {
      requested_code: code,
      effective_code: slotsFor.bucket.code,
      tier_fallback: rungs > 0,
      rungs_dropped: rungs,
      requested_tier: tierKeyOf(code),
      booked_tier: tierKeyOf(slotsFor.bucket.code),
    },
  });

  if (requested.slots.length > 0) return noFallback(requested, 0);

  // Horizon empty: cascade. Cache the lower-tier BucketSlots we fetch so we can
  // return the winning one without a second round-trip.
  const seen = new Map<string, BucketSlots | null>([[code, requested]]);
  const winner = await selectWithTierFallback(code, async (c) => {
    if (!seen.has(c)) seen.set(c, await getCachedBucketSlots(c, from));
    return seen.get(c)?.slots ?? null;
  });

  if (!winner || winner.rungsDropped === 0) return noFallback(requested, 0);
  const winningSlots = seen.get(winner.effectiveCode);
  if (!winningSlots) return noFallback(requested, 0);
  return noFallback(winningSlots, winner.rungsDropped);
}
```

(Confirm the exact name/return of `getCachedBucketSlots` and the `BucketSlots` interface in `slot-cache.ts`/`service.ts` before writing; the research shows `getCachedBucketSlots(code, fromIso, horizonDays = HORIZON_DAYS)` returning the same shape as `getBucketSlots`.)

- [ ] **Step 2: Wire the cascade into `src/app/api/availability/route.ts`**

Replace the `getCachedBucketSlots(code, from)` call (line 38) with `getBucketSlotsWithFallback(code, from)`, and add the `routing` block to the response object (after `slots`):

```typescript
  const result = await getBucketSlotsWithFallback(code, from);
  // ... existing null-check / 404 ...
  return NextResponse.json({
    bucket: { code: result.bucket.code },
    orgName: result.orgName,
    eventType: {
      name: result.eventType.name,
      description: result.eventType.description,
      durationMin: result.eventType.duration_min,
    },
    slots: result.slots,
    routing: result.routing,
  });
```

Note: `bucket.code` here is the EFFECTIVE (possibly lower) bucket, since `result.bucket` is the winning tier's bucket. `result.routing.requested_code` preserves the original. The Booker (Task 4) reads `routing.effective_code` for booking.

- [ ] **Step 3: Run the pure cascade test + typecheck + build**

Run: `node --experimental-strip-types scripts/test-tier-fallback.ts && npx tsc --noEmit && pnpm cf:build`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add src/lib/availability/service.ts src/app/api/availability/route.ts
git commit -m "Cascade to lower tier when a bucket's window is empty"
```

---

### Task 4: Booker renders fallback slots (no booking change)

**Files:**
- Modify: `src/components/Booker.tsx` (`AvailabilityResponse` ~35-41 — type only, optional)
- Test: Visual verification via Playwright MCP (no node-native test for React UI here)

**Interfaces:**
- Consumes: the availability response's `slots` (already lower-tier when a display fallback occurred, Task 3).
- Produces: nothing new on the booking submit. The booker continues to book with its original `bucketCode` prop; the server re-derives the tier (Task 5).

In the strict model the booker does NOT change how it books. The availability cascade (Task 3) already returns lower-tier slots in `slots`, so the booker renders them transparently under the customer's original code, and books that original code via the unchanged `POST /booking` body at `Booker.tsx:311-326`. The only optional edit is documenting the new informational `routing` field on the response type. The customer never sees tier labels; the fallback is silent per spec.

- [ ] **Step 1: (Optional) document the informational `routing` field on `AvailabilityResponse` (Booker.tsx ~35-41)**

```typescript
interface AvailabilityResponse {
  bucket: { code: string };
  orgName: string;
  eventType: { name: string; description: string | null; durationMin: number };
  slots: string[];
  // Informational only — the booker still books with its original bucketCode;
  // the server re-derives the tier at booking time (see Plan 2 Task 5).
  routing?: {
    requested_code: string;
    effective_code: string;
    tier_fallback: boolean;
    rungs_dropped: number;
  };
}
```

Do NOT change the `POST /booking` body. Leave `bucketCode` as the component's original prop.

- [ ] **Step 2: Visual verification — normal path unaffected**

Start the app (`/run` or `pnpm dev`), open a booker for a bucket WITH availability. Inject the motion-freeze style (AGENTS.md snippet) via `browser_evaluate`, then `browser_take_screenshot` (JPEG). Confirm slots render and a booking still succeeds. Save the capture outside the repo.

- [ ] **Step 3: Visual verification — display fallback path**

Point the booker at a bucket whose entire 4-day horizon is empty but whose next tier down has slots (temporarily mark the requested tier's agents unavailable, or use a known-empty test bucket). Confirm the booker shows slots (sourced from the lower tier) and that submitting books successfully. In the network panel confirm the `POST /booking` body still carries only the ORIGINAL `bucketCode` (no effective/requested split — the server resolves the tier). Screenshot.

- [ ] **Step 4: Commit (only if the optional type edit was made)**

```bash
git add src/components/Booker.tsx
git commit -m "Document informational routing field on availability response"
```

If no code changed (you skipped Step 1), there is nothing to commit for this task; the verification screenshots are the deliverable.

---

### Task 5: Stamp + record + alert on the tier-drop at booking time

No change to `/booking` or its zod schema, and none to the booker — the server re-derives the tier, so no new request field is added.

**Files:**
- Create: `src/lib/routing/tier-alert.ts` (pure alert selector)
- Modify: `src/lib/booking/orchestration.ts` (add `assignAgentWithTierFallback`; use it in `createBooking` ~905-979 and `legacyCreateBooking` ~1094-1138; stamp `routing_trace`; record + alert)
- Test: `scripts/test-tier-alert.ts`

**Interfaces:**
- Consumes: `tierKeyOf`, `tierLadder` (Task 1); `resolveBucketByCode`, `assignAgent`, `bookingWindow` (existing in orchestration); `recordRoutingDecision` (Plan 1, `src/lib/routing/record.ts`); `resolveBucketPool` (Plan 1 Task 6); `sendThrottledAlert`.
- Produces: `assignAgentWithTierFallback(...)` (internal to orchestration); `tierFallbackAlert({ requestedCode, effectiveCode, rungsDropped }): { key: string; cooldownMs: number; text: string } | null`.

- [ ] **Step 1: Write the failing test `scripts/test-tier-alert.ts`**

```typescript
import { tierFallbackAlert } from "../src/lib/routing/tier-alert.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); failures++; } else console.log("ok:", msg);
}

assert(tierFallbackAlert({ requestedCode: "511", effectiveCode: "511", rungsDropped: 0 }) === null, "no drop => no alert");

const one = tierFallbackAlert({ requestedCode: "511", effectiveCode: "411", rungsDropped: 1 })!;
assert(one.key === "tier_fallback:511", "single-rung key");
assert(one.cooldownMs === 60 * 60 * 1000, "single-rung is a 60-min throttled notice");
assert(!/ALERT/.test(one.text), "single-rung text is a notice, not an alert");

const deep = tierFallbackAlert({ requestedCode: "511", effectiveCode: "311", rungsDropped: 2 })!;
assert(deep.key === "tier_fallback_deep:511", "deep-drop key is distinct");
assert(deep.cooldownMs === 5 * 60 * 1000, "deep drop escalates (shorter cooldown)");
assert(/ALERT/.test(deep.text), "deep-drop text is a loud alert");

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types scripts/test-tier-alert.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/routing/tier-alert.ts`**

```typescript
/**
 * Pure: choose the Slack alert for a tier-drop. A single-rung drop is a quiet
 * throttled notice; a two-plus-rung drop escalates (distinct key, short
 * cooldown, loud text) because a deep cascade is near-impossible under normal
 * load and signals a capacity or systems problem. Returns null when no drop.
 */
export function tierFallbackAlert(input: {
  requestedCode: string;
  effectiveCode: string;
  rungsDropped: number;
}): { key: string; cooldownMs: number; text: string } | null {
  if (input.rungsDropped <= 0) return null;
  const escalate = input.rungsDropped >= 2;
  if (escalate) {
    return {
      key: `tier_fallback_deep:${input.requestedCode}`,
      cooldownMs: 5 * 60 * 1000,
      text: `Slate routing ALERT: a booking for bucket ${input.requestedCode} dropped ${input.rungsDropped} tiers to ${input.effectiveCode} because every higher tier had no availability across the booking window. This should almost never happen. Check for a capacity crunch, mass time off, or a roster or availability problem.`,
    };
  }
  return {
    key: `tier_fallback:${input.requestedCode}`,
    cooldownMs: 60 * 60 * 1000,
    text: `Slate routing notice: a booking for bucket ${input.requestedCode} dropped one tier to ${input.effectiveCode}; the requested tier had no availability across the booking window.`,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types scripts/test-tier-alert.ts`
Expected: PASS — `ALL PASSED`.

- [ ] **Step 5: Add the server-side cascade `assignAgentWithTierFallback` in `src/lib/booking/orchestration.ts`**

Place it next to `assignAgent` (~536). It tries the requested bucket, and only on a genuine "no availability for this slot" outcome cascades down the ladder. It does NOT cascade on a verify outage (a transient calendar-read failure must not be mistaken for an exhausted tier).

```typescript
interface TierAssignResult {
  bucket: Bucket;
  eventType: EventType;
  startIso: string;
  endIso: string;
  userId: string;
  email: string;
  candidates: string[];
  rungsDropped: number;
}

/**
 * Assign for the requested bucket; if that bucket has no agent free for the
 * slot, cascade down the debt-tier ladder and assign in the first lower bucket
 * that can serve it. The server is the authority here — the client never says
 * which tier to use. Cascades only on SlotUnavailable / NoEligibleAgents (the
 * tier is genuinely exhausted), never on VerifyUnavailable (a transient outage),
 * which is rethrown so an outage can't masquerade as a tier-drop.
 */
async function assignAgentWithTierFallback(
  deps: BookingDeps,
  requested: { bucket: Bucket; eventType: EventType },
  startInstantIso: string,
  allowTestBuckets: boolean,
): Promise<TierAssignResult> {
  const ladder = tierLadder(requested.bucket.code);
  let lastErr: unknown = null;
  for (let i = 0; i < ladder.length; i++) {
    const resolved = i === 0 ? requested : await deps.resolveBucketByCode(ladder[i]);
    if (!resolved) continue; // a lower tier with no bucket row: skip
    if (resolved.bucket.is_test && !allowTestBuckets) continue;
    const { startIso, endIso } = bookingWindow(startInstantIso, resolved.eventType.duration_min);
    try {
      const { userId, email, candidates } = await assignAgent(
        deps, resolved.bucket, resolved.eventType, startIso, endIso,
      );
      return {
        bucket: resolved.bucket, eventType: resolved.eventType,
        startIso, endIso, userId, email, candidates, rungsDropped: i,
      };
    } catch (err) {
      if (err instanceof SlotUnavailableError || err instanceof NoEligibleAgentsError) {
        lastErr = err; // this tier can't serve the slot; drop a rung
        continue;
      }
      throw err; // VerifyUnavailableError and anything unexpected: do not mask
    }
  }
  throw lastErr ?? new SlotUnavailableError();
}
```

(Import `tierLadder` from `@/lib/routing/tiers`. `BookingDeps` already exposes `resolveBucketByCode` — confirm; it is used at `orchestration.ts:905`.)

- [ ] **Step 6: Use the cascade in `createBooking` and book against the resolved bucket**

In `createBooking` (`orchestration.ts`), the requested bucket is resolved at line 905 (`bucket`, `eventType`) and the window at 915. Replace the single `assignAgent(...)` call at 936-942 with the cascade, then rebind `bucket`/`eventType`/`startIso`/`endIso` to the RESOLVED (possibly lower) tier so the booking insert and reservation use the booked bucket:

```typescript
  const tier = await assignAgentWithTierFallback(
    deps,
    { bucket, eventType },
    input.startIso,
    input.allowTestBuckets ?? false,
  );
  const bookedBucket = tier.bucket;
  const bookedEventType = tier.eventType;
  const { userId, email, candidates } = tier;
  const startIso = tier.startIso;
  const endIso = tier.endIso;
```

Update the `bookingInsert` (948-979) to use `bookedBucket`/`bookedEventType` for `org_id`, `bucket_id`, `event_type_id`, and extend the `routing_trace` literal (970, already extended in Plan 1) with the tier-drop stamp:

```typescript
    routing_trace: {
      bucket_code: bookedBucket.code,            // matches bucket_id (the booked tier)
      bucket_id: bookedBucket.id,
      considered: candidates,
      chosen_user_id: userId,
      fallback_applied:
        bookedBucket.fallback_user_id != null &&
        candidates.length > 0 &&
        candidates.every((id) => id === bookedBucket.fallback_user_id),
      excluded: traceExtras.excluded,            // Plan 1, computed against bookedBucket
      tier_fallback: tier.rungsDropped > 0,
      requested_tier: tierKeyOf(input.bucketCode),
      booked_tier: tierKeyOf(bookedBucket.code),
      rungs_dropped: tier.rungsDropped,
    },
```

(Import `tierKeyOf`. Compute `traceExtras` from `resolveBucketPool(bookedBucket)` + the candidate set, per Plan 1 Task 7. Note: `bucket_code` is now the BOOKED tier; verify no consumer expects the requested code there — `src/lib/availability/fairness.ts` reads `routing_trace.considered`, not `bucket_code`, so it is unaffected.)

- [ ] **Step 7: Mirror the cascade in `legacyCreateBooking`**

`legacyCreateBooking` (the anonymous/no-idempotency path, called at `orchestration.ts:923`) has its own `assignAgent` call and `routing_trace` literal (~1138). Apply the same `assignAgentWithTierFallback` + booked-bucket rebind + `routing_trace` stamp there, so anonymous bookings also tier-drop and stamp correctly.

- [ ] **Step 8: Record + fire the tiered alert on the post-commit side-effects path**

Alongside the `booking.created` webhook fire (~1077) and the `recordRoutingDecision` call from Plan 1 Task 7 (which already persists the decision with the tier fields), add the Slack notice:

```typescript
  const tierAlert = tierFallbackAlert({
    requestedCode: input.bucketCode,
    effectiveCode: booking.routing_trace?.bucket_code ?? input.bucketCode,
    rungsDropped: Math.max(0, booking.routing_trace?.rungs_dropped ?? 0),
  });
  if (tierAlert) {
    await sendThrottledAlert(tierAlert.key, tierAlert.cooldownMs, tierAlert.text).catch(() => {});
  }
```

- [ ] **Step 9: Typecheck, build, run all tests**

Run: `npx tsc --noEmit && pnpm test && pnpm cf:build`
Expected: all green.

- [ ] **Step 10: Live verification (user-run)**

Make a fallback booking (requested tier empty across the horizon, lower tier has slots) through the booker. Confirm: (a) the booking lands on a lower-tier agent; (b) `bookings.routing_trace` shows `tier_fallback: true` with correct `requested_tier`/`booked_tier`/`rungs_dropped`; (c) a `routing_decisions` row exists with `tier_fallback = true`; (d) the booking webhook payload to Regal carries `routing.tier_fallback = true` (check the outbox/webhook log); (e) a single-rung drop produced the throttled Slack notice, not the loud alert. Also confirm the normal path is unchanged: a booking in a tier WITH availability does no cascade (`rungs_dropped = 0`, `tier_fallback = false`). Needs a real booking + DB/webhook inspection, so it is the user's to run.

- [ ] **Step 11: Commit**

```bash
git add src/lib/booking/orchestration.ts src/lib/routing/tier-alert.ts scripts/test-tier-alert.ts
git commit -m "Re-derive tier server-side and stamp, record, alert on tier-drop bookings"
```

---

## Self-Review

**Spec coverage:**
- Tier-drop cascade (UH→VH→…→Low, one rung at a time, same backend+legal) → Tasks 1, 2.
- Triggers only when the whole window is empty → Task 3 (cascade runs only when `requested.slots.length === 0` over the 4-day horizon).
- Changes what the booker SHOWS (surfaces next tier's slots) → Task 3 (server returns lower-tier slots) + Task 4 (booker renders them, no booking change).
- Books against the resolved tier; seamless to the customer (no tier labels) → Task 5 (server re-derives the tier at booking time).
- Stamp on `routing_trace` + webhook (`tier_fallback`, `requested_tier`, `booked_tier`, `rungs_dropped`) → Task 5 (+ Plan 1's `RoutingMeta` reads these through to the webhook automatically).
- Recorded in `routing_decisions` → Task 5 reuses Plan 1's `recordRoutingDecision`.
- Single-rung = throttled notice; two-plus = escalated alert → Task 5 (`tierFallbackAlert`).

**Type consistency:** `tierLadder`/`tierKeyOf` (Task 1) used in Tasks 2, 3, 5. `selectWithTierFallback` (Task 2) used in Task 3. The availability `routing` block (Task 3) is informational-only on the booker (Task 4). `tierFallbackAlert` (Task 5) signature matches its call site.

**Trust model (RESOLVED — strict / server-authoritative):** the booker books with the ORIGINAL code only; the server re-derives the tier at booking time by attempting assignment per bucket down the ladder, each gated by verify-on-book. The client cannot influence which tier is booked, so a spoofed request cannot mis-route or double-book. (This replaced an earlier client-trust design where the booker sent an "effective" code.)

**Open implementer notes (verify against live code, do not assume):** exact `getCachedBucketSlots` signature + `BucketSlots` interface (Task 3); that `BookingDeps` exposes `resolveBucketByCode` and the `bookingWindow`/error-class imports are in scope in the new helper (Task 5 Step 5); that rebinding `bucket`/`eventType` to the booked tier does not collide with later uses of the requested `bucket`/`eventType` in `createBooking`/`legacyCreateBooking` (Task 5 Steps 6-7); the precise post-commit side-effects site shared with Plan 1 Task 7 (Task 5 Step 8); confirm no consumer reads `routing_trace.bucket_code` expecting the REQUESTED (not booked) code.
