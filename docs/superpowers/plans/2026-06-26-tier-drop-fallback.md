# Tier-Drop Cascade Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a bucket has zero bookable slots across the whole booking window, surface the next debt-tier-down bucket's slots in the booker, cascading down the tier ladder until a tier has availability, and record/stamp/alert on the drop so it is explainable and Regal can suppress its alert.

**Architecture:** A pure tier-ladder helper turns an XBC code into the ordered list of lower-tier codes to try (511 → 411 → 311 → 211 → 111). A server cascade calls the existing cached per-bucket slot fetch for each code in turn and returns the first tier with slots, plus a routing descriptor. The availability API returns the effective (possibly lower) bucket code; the Booker books against that effective code while passing the original requested code so the booking path can stamp `tier_fallback` into `routing_trace`, record the decision (Plan 1's recorder), and fire a tiered Slack alert (one-rung drop = throttled notice, two-plus = escalated).

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

### Task 4: Booker consumes the effective tier

**Files:**
- Modify: `src/components/Booker.tsx` (`AvailabilityResponse` ~35-41; availability fetch ~218-223; booking submit ~311-326)
- Test: Visual verification via Playwright MCP (no node-native test for React UI here)

**Interfaces:**
- Consumes: the `routing` block on the availability response (Task 3).
- Produces: booking `POST /booking` body now includes `requestedBucketCode` when a fallback occurred; books against the effective code.

- [ ] **Step 1: Extend `AvailabilityResponse` (Booker.tsx ~35-41)**

```typescript
interface AvailabilityResponse {
  bucket: { code: string };
  orgName: string;
  eventType: { name: string; description: string | null; durationMin: number };
  slots: string[];
  routing?: {
    requested_code: string;
    effective_code: string;
    tier_fallback: boolean;
    rungs_dropped: number;
  };
}
```

- [ ] **Step 2: Track the effective code from the response**

Where the response is stored (`setMeta(...)` ~line 223), the effective booking code is `meta.routing?.effective_code ?? bucketCode`. Add a derived value near where the component reads `meta`:

```typescript
  const effectiveCode = meta?.routing?.effective_code ?? bucketCode;
  const didTierFallback = !!meta?.routing?.tier_fallback;
```

The customer-facing UI does NOT change (no tier label shown); the fallback is silent per spec. `effectiveCode` is used only for the booking submit.

- [ ] **Step 3: Book against the effective code, pass the requested code**

In the `POST /booking` body (~314-325), replace `bucketCode,` with:

```typescript
        bucketCode: effectiveCode,
        requestedBucketCode: didTierFallback ? bucketCode : undefined,
```

(Leave the rest of the body unchanged. When no fallback, `requestedBucketCode` is omitted and behavior is identical to today.)

- [ ] **Step 4: Visual verification — normal path unaffected**

Start the app (`/run` or `pnpm dev`), open a booker for a bucket WITH availability. Inject the motion-freeze style (AGENTS.md snippet) via `browser_evaluate`, then `browser_take_screenshot` (JPEG). Confirm slots render and a booking still succeeds. Save the capture outside the repo.

- [ ] **Step 5: Visual verification — fallback path**

Point the booker at a bucket whose entire 4-day horizon is empty but whose next tier down has slots (set this up by temporarily marking the requested tier's agents unavailable, or against a known-empty test bucket). Confirm the booker shows slots (sourced from the lower tier) and that submitting books successfully. In the network panel confirm the `POST /booking` body carries `requestedBucketCode` (the original) and `bucketCode` (the lower/effective). Screenshot.

- [ ] **Step 6: Commit**

```bash
git add src/components/Booker.tsx
git commit -m "Booker books against the effective fallback tier"
```

---

### Task 5: Stamp + record + alert on the tier-drop at booking time

**Files:**
- Modify: `src/app/booking/route.ts` (zod `schema` ~before line 33; pass `requestedBucketCode` into `createBooking`, ~58-70)
- Modify: `src/lib/booking/service.ts` (`createBooking` input type ~1066) and `src/lib/booking/orchestration.ts` (thread `requestedBucketCode`; stamp `routing_trace`; alert)
- Create: `src/lib/routing/tier-alert.ts` (pure alert selector)
- Test: `scripts/test-tier-alert.ts`

**Interfaces:**
- Consumes: `tierKeyOf`, `tierLadder` (Task 1); `recordRoutingDecision` (Plan 1, `src/lib/routing/record.ts`); `sendThrottledAlert`.
- Produces: `tierFallbackAlert({ requestedCode, effectiveCode, rungsDropped }): { key: string; cooldownMs: number; text: string } | null`.

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

- [ ] **Step 5: Accept `requestedBucketCode` at the `/booking` boundary**

In `src/app/booking/route.ts`, add `requestedBucketCode` to the zod `schema` as an optional string (mirror the existing `bucketCode` field's validation), and pass it into `createBooking` (after line 69):

```typescript
      prefill: parsed.data.prefill,
      requestedBucketCode: parsed.data.requestedBucketCode ?? null,
```

- [ ] **Step 6: Thread + stamp in the orchestration**

In `src/lib/booking/service.ts`, add `requestedBucketCode?: string | null` to the `createBooking` input type and forward it to `orchestration.createBooking`. In `src/lib/booking/orchestration.ts`, where the `routing_trace` literal is built (~970 and ~1138 — already extended in Plan 1), compute the tier-drop fields from `input.requestedBucketCode` vs `input.bucketCode`:

```typescript
      // Tier-drop stamp: requested code (original tier the customer came in on)
      // vs the bucket actually booked. Same code => no drop.
      tier_fallback:
        input.requestedBucketCode != null &&
        input.requestedBucketCode !== input.bucketCode,
      requested_tier: tierKeyOf(input.requestedBucketCode ?? input.bucketCode),
      booked_tier: tierKeyOf(input.bucketCode),
      rungs_dropped:
        input.requestedBucketCode != null
          ? tierLadder(input.requestedBucketCode).indexOf(input.bucketCode)
          : 0,
```

(Import `tierKeyOf`, `tierLadder` from `@/lib/routing/tiers`. `indexOf` returns the rung count, or -1 if the booked code isn't on the requested ladder — guard a -1 to 0.)

- [ ] **Step 7: Fire the tiered alert on the post-commit side-effects path**

Alongside the `booking.created` webhook fire (~1077) and the `recordRoutingDecision` call added in Plan 1 Task 7, add:

```typescript
  const alert = tierFallbackAlert({
    requestedCode: input.requestedBucketCode ?? input.bucketCode,
    effectiveCode: input.bucketCode,
    rungsDropped: Math.max(0, booking.routing_trace?.rungs_dropped ?? 0),
  });
  if (alert) {
    await sendThrottledAlert(alert.key, alert.cooldownMs, alert.text).catch(() => {});
  }
```

(Plan 1's `recordRoutingDecision` already persists the row + carries the fallback flags; this only adds the Slack notice.)

- [ ] **Step 8: Typecheck, build, run all tests**

Run: `npx tsc --noEmit && pnpm test && pnpm cf:build`
Expected: all green.

- [ ] **Step 9: Live verification (user-run)**

Make a fallback booking (requested tier empty across the horizon, lower tier has slots) through the booker. Confirm: (a) the booking lands on a lower-tier agent; (b) `bookings.routing_trace` for it shows `tier_fallback: true`, the correct `requested_tier`/`booked_tier`/`rungs_dropped`; (c) a `routing_decisions` row exists with `tier_fallback = true`; (d) the booking webhook payload to Regal carries `routing.tier_fallback = true` (check the webhook log/outbox); (e) a single-rung drop produced the throttled Slack notice (not the loud alert). This needs a real booking + DB/webhook inspection, so it is the user's to run.

- [ ] **Step 10: Commit**

```bash
git add src/app/booking/route.ts src/lib/booking/service.ts src/lib/booking/orchestration.ts src/lib/routing/tier-alert.ts scripts/test-tier-alert.ts
git commit -m "Stamp, record, and alert on tier-drop fallback bookings"
```

---

## Self-Review

**Spec coverage:**
- Tier-drop cascade (UH→VH→…→Low, one rung at a time, same backend+legal) → Tasks 1, 2.
- Triggers only when the whole window is empty → Task 3 (cascade runs only when `requested.slots.length === 0` over the 4-day horizon).
- Changes what the booker SHOWS (surfaces next tier's slots) → Tasks 3, 4.
- Books against the effective tier; seamless to the customer (no tier labels) → Task 4.
- Stamp on `routing_trace` + webhook (`tier_fallback`, `requested_tier`, `booked_tier`, `rungs_dropped`) → Task 5 (+ Plan 1's `RoutingMeta` reads these through to the webhook automatically).
- Recorded in `routing_decisions` → Task 5 reuses Plan 1's `recordRoutingDecision`.
- Single-rung = throttled notice; two-plus = escalated alert → Task 5 (`tierFallbackAlert`).

**Type consistency:** `tierLadder`/`tierKeyOf` (Task 1) used in Tasks 2, 3, 5. `selectWithTierFallback` (Task 2) used in Task 3. `AvailabilityRoutingMeta` (Task 3) shape matches the Booker's `routing?` block (Task 4). `tierFallbackAlert` (Task 5) signature matches its call site.

**Trust note (call out at execution):** the Booker sends both `bucketCode` (effective) and `requestedBucketCode` (original). A client could spoof these, but the booking still runs verify-on-book against the effective bucket, so the worst case is a mis-stamped fallback flag, not a double-book or a wrong-tier booking of a real free agent. If stronger integrity is wanted later, re-run the cascade server-side at booking time instead of trusting the client's effective code. Filed as a follow-up consideration, not built here.

**Open implementer notes (verify against live code, do not assume):** exact `getCachedBucketSlots` signature + `BucketSlots` interface (Task 3); the zod `schema` field style in `src/app/booking/route.ts` (Task 5 Step 5); guard `tierLadder(...).indexOf(...)` returning -1 (Task 5 Step 6); the precise post-commit side-effects site shared with Plan 1 Task 7 (Task 5 Step 7).
