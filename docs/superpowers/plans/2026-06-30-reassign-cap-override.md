# Reassign cap-override + reschedule cap walk-back Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the daily cap from blocking a same-agent reschedule, and make the reassign action cap-aware (override switch + over-cap reporting) without changing the live automation's behavior.

**Architecture:** Phase 1 is backend-only. The shared `isBookableSlotForAgent` predicate gains a cap opt-out so the in-place reschedule guard skips the cap while the booker keeps it. `reassignBooking` computes whether the target agent is over cap (reusing the #536 helpers), throws a new `DailyCapExceededError` only when an override flag is off, and otherwise forces through while reporting `overCap`. The existing machine route passes `overrideCap: true` so automation is unchanged but now surfaces the over-cap signal.

**Tech Stack:** TypeScript, Next.js (App Router), Luxon, node-native test scripts run via `node --experimental-strip-types --import ./scripts/register-paths.mjs`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-06-30-reassign-cap-override-design.md`.
- TDD: write the failing test first, watch it fail, then implement.
- Run node test suites with: `node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/<file>.ts`.
- No customer-facing copy changes in this phase. No new dashes-as-punctuation in any output.
- Do NOT change the live automation contract: the existing `/api/bookings/reassign` route must keep forcing unconditionally (pass `overrideCap: true`).
- Branch is already `feat/reassign-cap-override` (the spec is committed there).

---

### Task 1: Cap opt-out in the shared predicate

**Files:**
- Modify: `src/lib/availability/compute.ts` (export `isUnderDailyCap`; add `enforceDailyCap` option to `isBookableSlotForAgent`)
- Test: `scripts/test-compute.ts`

**Interfaces:**
- Produces: `isUnderDailyCap(bookingStartsMs: number[], timezone: string, startMs: number, dailyCap: number | null, dayCounts?: Map<string, number>): boolean` (now exported). `isBookableSlotForAgent(m, rules, startMs, nowMs, opts?)` where `opts` now also has `enforceDailyCap?: boolean` (default `true`).

- [ ] **Step 1: Write the failing test**

Add to `scripts/test-compute.ts`, inside the `isBookableSlotForAgent` test block (after the existing daily-cap cases), reusing the `agent`, `rules`, `slot`, `earlyNow`, `ms` locals already defined there:

```ts
  // #(reassign-cap): the cap can be opted out (the in-place reschedule guard does this).
  const capAgent2 = {
    ...agent,
    bookingStartsMs: [ms("2026-06-08T13:00:00.000Z"), ms("2026-06-08T15:00:00.000Z")],
  };
  assert(
    !isBookableSlotForAgent(capAgent2, { ...rules, dailyCap: 2 }, slot, earlyNow),
    "cap enforced by default: at cap -> false",
  );
  assert(
    isBookableSlotForAgent(capAgent2, { ...rules, dailyCap: 2 }, slot, earlyNow, { enforceDailyCap: false }),
    "cap opt-out: over cap is bookable when enforceDailyCap=false (reschedule keep-same-agent)",
  );
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-compute.ts`
Expected: FAIL on "cap opt-out: ..." (currently the cap is always enforced, so it returns false).

- [ ] **Step 3: Implement the opt-out**

In `src/lib/availability/compute.ts`, export `isUnderDailyCap` (change `function isUnderDailyCap` to `export function isUnderDailyCap`).

Add `enforceDailyCap` to the `opts` type and gate the cap check. Change the `isBookableSlotForAgent` signature's `opts` to:

```ts
  opts?: {
    ignoreBusy?: { start: number; end: number };
    dayCounts?: Map<string, number>;
    enforceDailyCap?: boolean;
  },
```

and change the cap line from:

```ts
  if (!isUnderDailyCap(m.bookingStartsMs, m.timezone, startMs, rules.dailyCap, opts?.dayCounts)) {
    return false;
  }
```

to:

```ts
  if (
    (opts?.enforceDailyCap ?? true) &&
    !isUnderDailyCap(m.bookingStartsMs, m.timezone, startMs, rules.dailyCap, opts?.dayCounts)
  ) {
    return false;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-compute.ts`
Expected: ALL PASSED.

- [ ] **Step 5: Commit**

```bash
git add src/lib/availability/compute.ts scripts/test-compute.ts
git commit -m "Add daily-cap opt-out to isBookableSlotForAgent; export isUnderDailyCap"
```

---

### Task 2: Reschedule keep-same-agent skips the daily cap

**Files:**
- Modify: `src/lib/booking/orchestration.ts` (`applyReschedule` in-place guard, ~lines 2031-2052)
- Test: `scripts/test-booking-orchestration.ts`

**Interfaces:**
- Consumes: `isBookableSlotForAgent(..., { enforceDailyCap: false })` from Task 1.

- [ ] **Step 1: Write the failing test**

Add to `scripts/test-booking-orchestration.ts` after the on-shift in-place test block (search for `"reschedule(on-shift): moves in place, no reassign churn"` and insert after its closing `}`):

```ts
  // --- #(reassign-cap) reschedule keeping the SAME agent is NOT blocked by the daily
  // cap, even onto a day already full of the agent's OTHER meetings (a reschedule moves
  // an existing meeting, it's not a net-new booking). ---
  {
    const capEvent = { ...eventType, daily_cap: 1 } as unknown as EventType;
    const ctx = { booking: makeBooking({}), bucket, eventType: capEvent };
    const rescheduled = {
      booking: {
        ...ctx.booking,
        starts_at: "2026-06-08T18:00:00.000Z",
        ends_at: "2026-06-08T18:30:00.000Z",
        status: "rescheduled" as const,
      },
      bucket,
      eventType: capEvent,
    };
    const { deps, calls } = makeDeps({
      existing: ctx,
      bookingById: rescheduled,
      candidates: ["a", "b"],
      freeEmails: new Set(["a@x.com", "b@x.com"]),
      // A already has another booking that day; cap is 1 -> would be "over cap".
      agentDayBookings: new Map([["a", ["2026-06-08T13:00:00.000Z"]]]),
    });
    const res = await rescheduleBooking("tok1", "2026-06-08T18:00:00.000Z", RR, "customer", deps, NOW);
    assert(
      res.booking.assigned_user_id === "a" && res.booking.agent_email === "a@x.com",
      "reschedule(over cap, same agent): stays on the SAME agent (cap not enforced on reschedule)",
    );
    assert(
      calls.updateEventTime.length === 1 && calls.createEvent.length === 0,
      "reschedule(over cap, same agent): moves in place, no reassign churn",
    );
  }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-booking-orchestration.ts`
Expected: FAIL — today the over-cap day makes the in-place guard decline and reroute (createEvent=1, updateEventTime=0).

- [ ] **Step 3: Implement — skip the cap on the in-place path**

In `src/lib/booking/orchestration.ts`, replace the in-place guard's busy/day-bookings block (the `if (busy !== null) { ... }` that calls `deps.agentActiveBookingStartsMs` and `isBookableSlotForAgent`) with a version that skips the cap and no longer reads day bookings:

```ts
        if (busy !== null) {
          // A reschedule that keeps the same agent is NOT a net-new booking, so the
          // daily cap does not apply here (it would otherwise reroute a simple move
          // onto a day already full of the agent's OTHER meetings). Still enforce
          // working-hours (gated above), min-notice, and buffer.
          keepInPlace = isBookableSlotForAgent(
            { timezone: wh.timezone, rules: wh.rules, busy, bookingStartsMs: [] },
            slotRules,
            startMs,
            nowMs,
            { ignoreBusy: ownEvent, enforceDailyCap: false },
          );
        }
```

(This removes the `const day = ...` and `const bookingStartsMs = await deps.agentActiveBookingStartsMs(...)` lines from that block. `deps.agentActiveBookingStartsMs` is still used by Task 3, so keep the dep.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-booking-orchestration.ts`
Expected: ALL PASSED (the new case plus all existing reschedule cases, including off-shift/buffer/too-soon which still reroute).

- [ ] **Step 5: Commit**

```bash
git add src/lib/booking/orchestration.ts scripts/test-booking-orchestration.ts
git commit -m "Reschedule keep-same-agent no longer blocked by daily cap"
```

---

### Task 3: Cap-aware reassign with override + over-cap reporting

**Files:**
- Modify: `src/lib/booking/orchestration.ts` (`reassignBooking` signature, cap check, return; new `DailyCapExceededError`)
- Test: `scripts/test-booking-orchestration.ts`

**Interfaces:**
- Produces: `class DailyCapExceededError extends Error` (name `"DailyCapExceededError"`, carries `agentEmail` and `day`). `reassignBooking(bookingId: string, agentEmail: string, reason: ValidatedReason, deps: BookingDeps, overrideCap?: boolean): Promise<BookingResult & { overCap: boolean }>`.
- Consumes: `isUnderDailyCap` (Task 1), `deps.agentActiveBookingStartsMs`, `deps.agentWorkingHours`.

- [ ] **Step 1: Write the failing tests**

Add to `scripts/test-booking-orchestration.ts` after the existing reassign test block (search for `"reassign: fires booking.rescheduled"` and insert after that block's closing `}`). Reuse the `SYS` reason and `owner`-style fixture:

```ts
  // --- #(reassign-cap): reassign onto an at-cap agent ---
  {
    const capEvent = { ...eventType, daily_cap: 1 } as unknown as EventType;
    const owner = { id: "b", name: "Owner B", email: "b@x.com", bookable: true } as unknown as User;
    // B already has one booking on the booking's day (2026-06-08); cap is 1 -> over cap.
    const atCap = () =>
      makeDeps({
        bookingById: { booking: makeBooking({}), bucket, eventType: capEvent },
        agentByEmail: owner,
        agentDayBookings: new Map([["b", ["2026-06-08T15:00:00.000Z"]]]),
      });

    // Default (overrideCap omitted) -> blocked.
    {
      const { deps, calls } = atCap();
      let err: unknown;
      try {
        await reassignBooking("bk1", "b@x.com", SYS, deps);
      } catch (e) {
        err = e;
      }
      assert(
        err != null && (err as Error).name === "DailyCapExceededError",
        "reassign(at cap, no override): throws DailyCapExceededError",
      );
      assert(
        calls.createEvent.length === 0 && calls.reassignSwaps.length === 0,
        "reassign(at cap, no override): no event created, no swap (nothing mutated)",
      );
    }

    // overrideCap=true -> forces through, reports overCap.
    {
      const { deps, calls } = atCap();
      const res = await reassignBooking("bk1", "b@x.com", SYS, deps, true);
      assert(
        res.booking.assigned_user_id === "b" && res.overCap === true,
        "reassign(at cap, override): forces through and reports overCap=true",
      );
      assert(calls.createEvent.length === 1, "reassign(at cap, override): event created");
    }
  }

  // --- #(reassign-cap): reassign onto an UNDER-cap agent succeeds, overCap=false ---
  {
    const capEvent = { ...eventType, daily_cap: 3 } as unknown as EventType;
    const owner = { id: "b", name: "Owner B", email: "b@x.com", bookable: true } as unknown as User;
    const { deps } = makeDeps({
      bookingById: { booking: makeBooking({}), bucket, eventType: capEvent },
      agentByEmail: owner,
      agentDayBookings: new Map([["b", ["2026-06-08T15:00:00.000Z"]]]), // 1 < 3
    });
    const res = await reassignBooking("bk1", "b@x.com", SYS, deps);
    assert(
      res.booking.assigned_user_id === "b" && res.overCap === false,
      "reassign(under cap): succeeds, overCap=false",
    );
  }

  // --- #(reassign-cap): uncapped event never blocks, overCap=false ---
  {
    const owner = { id: "b", name: "Owner B", email: "b@x.com", bookable: true } as unknown as User;
    const { deps } = makeDeps({
      bookingById: { booking: makeBooking({}), bucket, eventType }, // daily_cap: null
      agentByEmail: owner,
      agentDayBookings: new Map([["b", ["2026-06-08T15:00:00.000Z"]]]),
    });
    const res = await reassignBooking("bk1", "b@x.com", SYS, deps);
    assert(res.overCap === false, "reassign(uncapped): never over cap");
  }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-booking-orchestration.ts`
Expected: FAIL — `reassignBooking` doesn't accept `overrideCap`, never throws `DailyCapExceededError`, and the result has no `overCap`.

- [ ] **Step 3a: Add the error class**

In `src/lib/booking/orchestration.ts`, near `NoEligibleAgentsError` (search `class NoEligibleAgentsError`), add:

```ts
export class DailyCapExceededError extends Error {
  constructor(
    readonly agentEmail: string,
    readonly day: string,
  ) {
    super(`Agent ${agentEmail} is at their daily cap on ${day}`);
    this.name = "DailyCapExceededError";
  }
}
```

- [ ] **Step 3b: Add the param, cap check, and overCap to `reassignBooking`**

Change the signature:

```ts
export async function reassignBooking(
  bookingId: string,
  agentEmail: string,
  reason: ValidatedReason,
  deps: BookingDeps,
  overrideCap = false,
): Promise<BookingResult & { overCap: boolean }> {
```

Update the same-agent early return to include `overCap: false`:

```ts
  if (agent.id === booking.assigned_user_id) {
    return { booking, manageUrl: manageUrl(deps, booking.manage_token), overCap: false };
  }
```

Immediately after that early return (and before the `// Create the event on the TARGET agent FIRST` comment), insert the cap check:

```ts
  // Daily-cap awareness (#reassign-cap): the cap counts meetings per agent per day.
  // Moving a booking onto a DIFFERENT agent is net-new load for that agent, so the
  // cap applies. We compute it ALWAYS so we can report it; we only BLOCK when the
  // caller hasn't opted to override (the machine contact-owner path passes true).
  let overCap = false;
  if (eventType.daily_cap !== null) {
    const wh = await deps.agentWorkingHours(agent.id);
    const day = DateTime.fromISO(booking.starts_at, { zone: wh.timezone }).startOf("day");
    const dayStartsMs = await deps.agentActiveBookingStartsMs(
      agent.id,
      day.toISO()!,
      day.plus({ days: 1 }).toISO()!,
      booking.id,
    );
    overCap = !isUnderDailyCap(
      dayStartsMs,
      wh.timezone,
      Date.parse(booking.starts_at),
      eventType.daily_cap,
    );
    if (overCap && !overrideCap) {
      throw new DailyCapExceededError(agent.email, day.toISODate()!);
    }
  }
```

Note: do NOT log here. `orchestration.ts` is the pure, fakes-tested logic layer and has no `console.*` calls — keep it that way. The over-cap signal is returned via `overCap`; the request handler (Task 4) does the logging, where Cloudflare actually captures it.

Update the final return to include `overCap`:

```ts
  return { booking: updated, manageUrl: manageUrl(deps, booking.manage_token), overCap };
```

Add `isUnderDailyCap` to the existing compute import at the top of the file. Find:

```ts
import {
  isBookableSlotForAgent,
  isWithinWorkingHours,
  type SlotRules,
  type WorkingRule,
} from "../availability/compute.ts";
```

and add `isUnderDailyCap,` to that list.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-booking-orchestration.ts`
Expected: ALL PASSED (new cap cases + the existing reassign test, which uses an uncapped event so `overCap` is false and it still forces).

- [ ] **Step 5: Commit**

```bash
git add src/lib/booking/orchestration.ts scripts/test-booking-orchestration.ts
git commit -m "Make reassignBooking cap-aware: override switch + over-cap reporting"
```

---

### Task 4: Thread overrideCap through the service + route; full gate

**Files:**
- Modify: `src/lib/booking/service.ts` (`reassignBooking` wrapper; re-export `DailyCapExceededError`)
- Modify: `src/app/api/bookings/reassign/route.ts` (pass `overrideCap: true`, surface `overCap`)

**Interfaces:**
- Consumes: `orchestration.reassignBooking(..., overrideCap)` returning `{ booking, manageUrl, overCap }` (Task 3).

- [ ] **Step 1: Update the service wrapper**

In `src/lib/booking/service.ts`, change the wrapper to thread the override and pass the result (including `overCap`) straight through:

```ts
export function reassignBooking(
  bookingId: string,
  agentEmail: string,
  reason: ValidatedReason,
  overrideCap = false,
) {
  return orchestration.reassignBooking(bookingId, agentEmail, reason, realDeps(), overrideCap);
}
```

Add `DailyCapExceededError` to the existing re-export block from orchestration (search `} from "@/lib/booking/orchestration";` near the other error re-exports) so routes can import it if needed:

```ts
export {
  SlotUnavailableError,
  RescheduleConflictError,
  VerifyUnavailableError,
  NoEligibleAgentsError,
  DailyCapExceededError,
  UnknownBucketError,
  BookingNotFoundError,
} from "@/lib/booking/orchestration";
```

- [ ] **Step 2: Update the machine route to force + report**

In `src/app/api/bookings/reassign/route.ts`, change the call to pass `overrideCap: true` (preserve the contact-owner force contract), log when a forced reassign landed over cap (this is the request handler — a Worker route where Cloudflare captures console output), and include `overCap` in the JSON:

```ts
    const result = await reassignBooking(
      bookingId,
      agentEmail,
      { code: reasonCode, detail: reasonDetail },
      true,
    );
    if (result.overCap) {
      console.warn(
        `reassign forced agent ${result.booking.agent_email} over their daily cap (booking ${result.booking.id})`,
      );
    }
    return NextResponse.json({
      booking: {
        id: result.booking.id,
        assignedUserId: result.booking.assigned_user_id,
        agentEmail: result.booking.agent_email,
        startsAt: result.booking.starts_at,
        status: result.booking.status,
      },
      overCap: result.overCap,
    });
```

Also update the route's doc comment line to note the `overCap` field, e.g. change the `POST { bookingId, agentEmail } -> 200 { booking } | ...` line to `-> 200 { booking, overCap } | ...`.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: `TypeScript compilation completed` (no errors). If a test file builds a `BookingDeps` or calls `reassignBooking` with the old arity, it still compiles because `overrideCap` is optional.

- [ ] **Step 4: Run the full gate**

Run:
```bash
node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-compute.ts
node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-booking-orchestration.ts
pnpm lint
pnpm test
pnpm cf:build
```
Expected: all green (`ALL PASSED`, lint 0 errors, vitest all pass, `OpenNext build complete`).

- [ ] **Step 5: Commit**

```bash
git add src/lib/booking/service.ts src/app/api/bookings/reassign/route.ts
git commit -m "Thread overrideCap through reassign service + machine route; report overCap"
```

---

## Self-Review

Spec coverage: Part A → Task 1 + Task 2. Part B → Task 3 (cap check, override, error, overCap, log) + Task 4 (service + route wiring, machine route passes `overrideCap: true` and surfaces `overCap`). Error mapping (`DailyCapExceededError`) → Task 3 + re-export in Task 4. Testing section → tests folded into Tasks 1-3, full gate in Task 4. No spec requirement left unassigned.

Placeholder scan: none — every code step shows the actual code.

Type consistency: `isUnderDailyCap` exported (Task 1) and imported/used (Task 3). `enforceDailyCap` option used in Task 2 matches Task 1's definition. `reassignBooking` arity (`overrideCap` 5th param) and return (`& { overCap: boolean }`) consistent across Tasks 3 and 4. `DailyCapExceededError` name matches between throw (Task 3) and test assertion (Task 3 Step 1) and re-export (Task 4).
