# Scalable Verify-on-Book (#167) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make booking-time agent verification fast and accurate at 100-200 live agents by replacing the serial one-Google-call-per-candidate walk with bounded, parallel-batched free/busy verification.

**Architecture:** Keep the existing cache-first model untouched (a slot is only offered if ≥1 cache-free agent; verify-on-book only ever considers those cache-free candidates). Replace the serial `selectAgent` walk with `selectFirstFree`: resolve emails for a bounded slice of round-robin candidates, hand them to an injected `verifyFree` that runs real Google free/busy checks in **parallel batches** (bounded concurrency), then pick the first candidate in round-robin order confirmed free. No "trust the stale cache" fallback — verification stays real; we just do it quickly.

**Chosen verification mechanism (Phase 0 PASSED — see below): single-identity batched `freeBusy`.** One delegated identity queries up to ~20 calendars per `freeBusy.query` call (Google caps items per request at ~20-49; `tooManyCalendarsRequested` marks the overflow), so a booking's bounded candidate set resolves in 1-2 calls instead of one-per-agent. We include each candidate's FULL calendar set (primary + any `agent_calendars` rows) as items, group the busy results back per agent, and mark an agent free iff none of their calendars overlap the slot. **Fallback for accuracy:** if any of an agent's calendars returns a permission error (`forbidden`/`notFound` — possible for a future secondary calendar not shared with the lookup identity), re-verify just that one agent by impersonating them (the always-accurate path). Today every agent is primary-only, so the fallback is dormant.

**Tech Stack:** Next 16 App Router, TypeScript, Cloudflare Workers (OpenNext), Supabase, Google Calendar `freeBusy.query` via domain-wide delegation (`src/lib/google/dwd.ts`). Node-native test scripts (`scripts/test-*.ts`, run with `node --experimental-strip-types`).

## Global Constraints

- Visual/logic scope: this is booking-logic; preserve the cal.com embed contract and Cloudflare deployability. Do NOT change the availability cache, sync, round-robin fairness, or webhooks beyond what is listed.
- Weekday convention is Luxon's (1=Mon..7=Sun). Server code uses `supabaseAdmin` (secret key, bypasses RLS).
- Every new feature ships with a test (`scripts/test-*.ts`). The pre-push gate ignores `scripts/test-*.ts`; push with `SKIP_TEST_CHECK=1` and explain why.
- New branches off `origin/main`; never reuse a merged PR branch. Small focused PRs.
- Accuracy is a hard requirement: never book an agent a live check would reveal as busy. No cache-trust fallback at confirm time.
- Google `freeBusy.query` caps at ~50 `items` (calendars, NOT agents) per request. Agents may have multiple calendars (`agent_calendars`), so a single call covers fewer than 50 agents.

---

## File Structure

- `src/lib/concurrency.ts` (create) — `mapWithConcurrency` + `chunk`, the shared bounded-parallelism primitives (extracted from `orchestration.ts`; closes #224).
- `src/lib/booking/core.ts` (modify) — add pure `selectFirstFree` (decides which candidates to verify and picks the first free in order). Remove the now-unused `selectAgent` after callers migrate.
- `src/lib/google/calendar.ts` (modify) — add `freeBusyMany` (single-identity, many-calendar free/busy). Phase 0 PASSED, so this is the chosen path.
- `src/lib/booking/service.ts` (modify) — implement the injected `verifyFree` dep using `chunk` + `mapWithConcurrency`; rewire `isFree`→batch.
- `src/lib/booking/orchestration.ts` (modify) — `assignAgent` calls `selectFirstFree`; `mapWithConcurrency` import moves to `@/lib/concurrency`; record verified-candidate count in `routing_trace`.
- `scripts/test-concurrency.ts` (create) — tests for the helpers.
- `scripts/test-booking.ts` (modify) — tests for `selectFirstFree`.
- `scripts/test-booking-orchestration.ts` (modify) — orchestration fakes updated to `verifyFree`.
- `scripts/spike-freebusy-batch.ts` (create, throwaway) — Phase 0 feasibility script the user runs against production Google.

Out of scope (separate plans/issues): availability-load at scale (#225), sync-cron at 200 agents, the completion sweep (#163/#164, done).

---

## Phase 0 — Feasibility spike (DECISION GATE) — ✅ DONE, PASSED (2026-06-18)

**Result:** One delegated identity (impersonating `dwright@trypennie.com`) batch-read the WHOLE roster — **112/112 agents readable in 6 `freeBusy` calls** at chunk size 20. Google's per-call calendar cap is ~20-49 (`tooManyCalendarsRequested` marks the overflow — a QUANTITY limit, not a permission error). **All 112 agents are primary-only today** (`agent_calendars` has no secondaries), so single-identity batching is fully accurate now. **Decision: build single-identity batched `freeBusyMany` (Phase 3 below), with a per-agent-impersonation fallback for any calendar that returns a real permission error.** Spike (`scripts/spike-freebusy-batch.ts`) to be deleted once Phase 3 lands.

This was a spike, not TDD. It decided Phase 3's mechanism. **Only the user could run it** (needs production Google service-account env: `GOOGLE_SA_CLIENT_EMAIL`, `GOOGLE_SA_PRIVATE_KEY`); the agent cannot, having no prod creds.

### Task 0: Confirm one identity can batch-read many agents' free/busy

**Files:**
- Create (throwaway): `scripts/spike-freebusy-batch.ts`

**What it must answer:**
1. Can a SINGLE delegated identity (impersonate one Pennie mailbox, e.g. an admin/service account) query `freeBusy` with `items=[several real agent emails]` and get back each agent's busy intervals (not 403 / empty)?
2. Does it also see each agent's **secondary** calendars (the `agent_calendars` rows), or only `primary`? (Determines accuracy of the single-call path.)

- [ ] **Step 1: Write the spike script**

```ts
// scripts/spike-freebusy-batch.ts — THROWAWAY. Run: node --experimental-strip-types scripts/spike-freebusy-batch.ts a@trypennie.com b@trypennie.com
import { getDelegatedToken } from "../src/lib/google/dwd.ts";

const IMPERSONATE = process.env.SPIKE_IMPERSONATE ?? "admin@trypennie.com"; // a Pennie identity
const agents = process.argv.slice(2);
if (agents.length === 0) throw new Error("pass agent emails as args");

const token = await getDelegatedToken(IMPERSONATE);
const now = new Date();
const timeMin = now.toISOString();
const timeMax = new Date(now.getTime() + 60 * 60_000).toISOString();

const res = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ timeMin, timeMax, items: agents.map((id) => ({ id })) }),
});
const data = await res.json();
console.log("status", res.status);
console.log(JSON.stringify(data, null, 2));
// Inspect: does data.calendars[<each agent>] exist with `busy` (PASS) or `errors` (FAIL)?
```

- [ ] **Step 2: User runs it against production**

Run (user, with prod env loaded): `node --experimental-strip-types scripts/spike-freebusy-batch.ts agent1@trypennie.com agent2@trypennie.com`
Expected PASS: `status 200`, and `calendars` has an entry per agent with a `busy` array (possibly empty) and NO `errors`.
Expected FAIL: per-agent `errors` like `{ domain: "global", reason: "notFound"|"forbidden" }`, or a 403.

- [ ] **Step 3: Record the decision**

Comment the result on issue #167:
- PASS → Phase 3 uses `freeBusyMany` (one call per ~50-calendar batch). Note whether secondary calendars appeared.
- FAIL (or secondary calendars invisible) → Phase 3 uses per-agent `freeBusy` fired in parallel batches (impersonating each agent, so all their calendars are seen). Orchestration is unchanged.

- [ ] **Step 4: Delete the spike**

```bash
git rm -f scripts/spike-freebusy-batch.ts 2>/dev/null || rm -f scripts/spike-freebusy-batch.ts
```

---

## Phase 1 — Extract the bounded-concurrency primitives (closes #224)

### Task 1: Move `mapWithConcurrency` to a shared util and add `chunk`

**Files:**
- Create: `src/lib/concurrency.ts`
- Create: `scripts/test-concurrency.ts`
- Modify: `src/lib/booking/orchestration.ts` (remove the local `mapWithConcurrency`, import from `@/lib/concurrency`)

**Interfaces:**
- Produces: `mapWithConcurrency<T,R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]>` (order-preserving); `chunk<T>(items: T[], size: number): T[][]`.

- [ ] **Step 1: Write the failing test**

```ts
// scripts/test-concurrency.ts
// Run: node --experimental-strip-types scripts/test-concurrency.ts
import { mapWithConcurrency, chunk } from "../src/lib/concurrency.ts";

let failures = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("FAIL:", m); failures++; } else console.log("ok:", m); }

// chunk
assert(JSON.stringify(chunk([1,2,3,4,5], 2)) === JSON.stringify([[1,2],[3,4],[5]]), "chunk: splits into size-2 groups with remainder");
assert(JSON.stringify(chunk([], 3)) === JSON.stringify([]), "chunk: empty input -> empty");

// mapWithConcurrency: preserves order
const r = await mapWithConcurrency([1,2,3,4], 2, async (n) => n * 10);
assert(JSON.stringify(r) === JSON.stringify([10,20,30,40]), "map: results in input order");

// mapWithConcurrency: never exceeds the limit in flight
let inFlight = 0, maxSeen = 0;
await mapWithConcurrency([1,2,3,4,5,6], 2, async () => {
  inFlight++; maxSeen = Math.max(maxSeen, inFlight);
  await new Promise((res) => setTimeout(res, 5));
  inFlight--;
});
assert(maxSeen <= 2, "map: at most `limit` tasks run at once");

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run it; verify it fails**

Run: `node --experimental-strip-types scripts/test-concurrency.ts`
Expected: FAIL — module `@/lib/concurrency` / `../src/lib/concurrency.ts` does not exist.

- [ ] **Step 3: Create the util**

```ts
// src/lib/concurrency.ts

/** Splits `items` into consecutive groups of at most `size`. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Runs `task` over `items` with at most `limit` in flight at once. Bounds the
 * simultaneous-connection pressure on Cloudflare Workers while beating a serial
 * loop. Preserves input order in the returned results.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await task(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}
```

- [ ] **Step 4: Update `orchestration.ts` to import from the util**

Remove the local `mapWithConcurrency` function (added in #164) from `src/lib/booking/orchestration.ts` and add near the other imports:
```ts
import { mapWithConcurrency } from "@/lib/concurrency";
```
Keep `COMPLETION_WEBHOOK_CONCURRENCY` where it is.

- [ ] **Step 5: Run tests to verify green**

Run: `node --experimental-strip-types scripts/test-concurrency.ts && node --experimental-strip-types scripts/test-booking-orchestration.ts`
Expected: both `ALL PASSED`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/concurrency.ts scripts/test-concurrency.ts src/lib/booking/orchestration.ts
git commit -m "Extract bounded-concurrency map + chunk into a shared util (#224)"
```

---

## Phase 2 — Pure selection core

### Task 2: `selectFirstFree` — bounded, order-preserving pick

**Files:**
- Modify: `src/lib/booking/core.ts`
- Modify: `scripts/test-booking.ts`

**Interfaces:**
- Consumes: `AssignResult` (`{ userId: string; email: string }`, already in core.ts).
- Produces:
  ```ts
  selectFirstFree(
    candidates: string[],                                            // userIds, round-robin order
    loadEmail: (userId: string) => Promise<string | null>,
    verifyFree: (entries: { userId: string; email: string }[]) => Promise<string[]>, // returns userIds confirmed free
    maxCandidates: number,                                           // cap how many we verify per attempt
  ): Promise<AssignResult | null>
  ```
  Resolves emails for the first `maxCandidates` candidates (skipping null/empty emails), calls `verifyFree` ONCE with all resolved entries, and returns the FIRST candidate in round-robin order whose userId is in the returned free set. Returns null if none are free. `verifyFree`'s parallel-batch mechanics live in the IO layer; this core is deterministic and IO-free.

- [ ] **Step 1: Write the failing test**

```ts
// add to scripts/test-booking.ts — import selectFirstFree alongside the others
// import { ..., selectFirstFree } from "../src/lib/booking/core.ts";
{
  const emailOf: Record<string, string | null> = { a: "a@x", b: "b@x", c: "", d: "d@x", e: "e@x" };
  const loadEmail = async (id: string) => emailOf[id] ?? null;

  // First free in round-robin order wins, even if a later one is also free.
  let verified: { userId: string; email: string }[] = [];
  const verifyFree = async (entries: { userId: string; email: string }[]) => {
    verified = entries;
    return entries.filter((e) => e.userId === "b" || e.userId === "d").map((e) => e.userId);
  };
  let r = await selectFirstFree(["a", "b", "d"], loadEmail, verifyFree, 10);
  assert(r?.userId === "b" && r?.email === "b@x", "selectFirstFree: first free in round-robin order wins");

  // Emailless candidate (c) is excluded from verification.
  await selectFirstFree(["c", "a", "b"], loadEmail, verifyFree, 10);
  assert(!verified.some((e) => e.userId === "c"), "selectFirstFree: emailless candidate not verified");

  // maxCandidates caps how many are verified.
  await selectFirstFree(["a", "b", "d", "e"], loadEmail, verifyFree, 2);
  assert(verified.length === 2 && verified[0].userId === "a" && verified[1].userId === "b", "selectFirstFree: respects maxCandidates cap");

  // None free -> null (caller turns into SlotUnavailableError).
  r = await selectFirstFree(["a", "e"], loadEmail, async () => [], 10);
  assert(r === null, "selectFirstFree: none free yields null");
}
```

- [ ] **Step 2: Run it; verify it fails**

Run: `node --experimental-strip-types scripts/test-booking.ts`
Expected: FAIL — `selectFirstFree` is not exported.

- [ ] **Step 3: Implement `selectFirstFree`**

```ts
// src/lib/booking/core.ts (add below selectAgent)
/**
 * Verify-on-book selection at scale: resolve emails for up to `maxCandidates`
 * round-robin candidates, verify them in ONE `verifyFree` call (the IO layer
 * runs that as bounded parallel batches), and return the first candidate in
 * round-robin order confirmed free. Returns null when none are free. Pure and
 * IO-free so it is deterministic under test.
 */
export async function selectFirstFree(
  candidates: string[],
  loadEmail: (userId: string) => Promise<string | null>,
  verifyFree: (entries: { userId: string; email: string }[]) => Promise<string[]>,
  maxCandidates: number,
): Promise<AssignResult | null> {
  const slice = candidates.slice(0, maxCandidates);
  const entries: { userId: string; email: string }[] = [];
  for (const userId of slice) {
    const email = await loadEmail(userId);
    if (email) entries.push({ userId, email });
  }
  if (entries.length === 0) return null;

  const freeIds = new Set(await verifyFree(entries));
  // Walk candidates (not entries) to honor round-robin order exactly.
  for (const userId of slice) {
    if (freeIds.has(userId)) {
      const email = entries.find((e) => e.userId === userId)!.email;
      return { userId, email };
    }
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify green**

Run: `node --experimental-strip-types scripts/test-booking.ts`
Expected: `ALL PASSED`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/booking/core.ts scripts/test-booking.ts
git commit -m "Add pure selectFirstFree: bounded, order-preserving verify-on-book pick (#167)"
```

---

## Phase 3 — The `verifyFree` IO implementation (single-identity batched, Phase 0 PASSED)

### Task 3a: Pure `overlaps` helper + per-agent free roll-up

**Files:**
- Modify: `src/lib/booking/core.ts`
- Modify: `scripts/test-booking.ts`

**Interfaces:**
- Produces: `overlaps(busy: { start: string; end: string }[], startIso: string, endIso: string): boolean` — true if any interval overlaps [start,end). Mirrors the existing `isFree` overlap math (calendar.ts:147-149) so the per-agent roll-up is unit-testable without Google.

- [ ] **Step 1: Write the failing test**

```ts
// scripts/test-booking.ts
{
  const s = "2026-06-08T13:00:00.000Z", e = "2026-06-08T13:30:00.000Z";
  assert(overlaps([{ start: "2026-06-08T13:15:00.000Z", end: "2026-06-08T13:45:00.000Z" }], s, e), "overlaps: partial overlap is busy");
  assert(!overlaps([{ start: "2026-06-08T13:30:00.000Z", end: "2026-06-08T14:00:00.000Z" }], s, e), "overlaps: touching at end is free (half-open)");
  assert(!overlaps([], s, e), "overlaps: no busy intervals -> free");
}
```

- [ ] **Step 2: Run it; verify it fails** — `node --experimental-strip-types scripts/test-booking.ts` → FAIL (`overlaps` not exported).

- [ ] **Step 3: Implement**

```ts
// src/lib/booking/core.ts
/** True if any busy interval overlaps the half-open [startIso, endIso) window. */
export function overlaps(
  busy: { start: string; end: string }[],
  startIso: string,
  endIso: string,
): boolean {
  const s = Date.parse(startIso), e = Date.parse(endIso);
  return busy.some((b) => Date.parse(b.start) < e && Date.parse(b.end) > s);
}
```

- [ ] **Step 4: Run tests → PASS. Commit.**

```bash
git add src/lib/booking/core.ts scripts/test-booking.ts
git commit -m "Add pure overlaps() helper for free/busy roll-up (#167)"
```

### Task 3b: `freeBusyMany` (single identity, many calendars, split on overflow)

**Files:**
- Modify: `src/lib/google/calendar.ts`

**Interfaces:**
- Produces: `freeBusyMany(impersonate: string, timeMin: string, timeMax: string, calendarIds: string[]): Promise<{ busyByCalendar: Record<string, Interval[]>; unreadable: string[] }>` — one delegated identity reads many calendars; auto-splits on `tooManyCalendarsRequested`; `unreadable` lists calendar ids that returned a real permission error (`forbidden`/`notFound`) so the caller can fall back.

- [ ] **Step 1: Implement (live-verified, not unit-tested — calls Google)**

```ts
// src/lib/google/calendar.ts
const FREEBUSY_ITEMS_PER_CALL = 20; // Phase 0: ~20 is safe; Google caps at ~20-49.

/**
 * Free/busy for MANY calendars via a SINGLE impersonated identity (Phase 0
 * confirmed one identity can read the whole roster). Splits any chunk that
 * overflows Google's per-request cap (`tooManyCalendarsRequested`) and reports
 * calendars that returned a real permission error so the caller can fall back
 * to impersonating that agent directly.
 */
export async function freeBusyMany(
  impersonate: string,
  timeMin: string,
  timeMax: string,
  calendarIds: string[],
): Promise<{ busyByCalendar: Record<string, Interval[]>; unreadable: string[] }> {
  const busyByCalendar: Record<string, Interval[]> = {};
  const unreadable: string[] = [];

  async function query(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const res = await ok(
      await gfetch(impersonate, `${BASE}/freeBusy`, {
        method: "POST",
        body: JSON.stringify({ timeMin, timeMax, items: ids.map((id) => ({ id })) }),
      }),
      "freeBusyMany",
    );
    const cals = ((await res.json()) as {
      calendars?: Record<string, { busy?: { start?: string; end?: string }[]; errors?: { reason?: string }[] }>;
    }).calendars ?? {};
    const overflow: string[] = [];
    for (const id of ids) {
      const c = cals[id];
      if (c?.errors?.some((e) => e.reason === "tooManyCalendarsRequested")) overflow.push(id);
      else if (c?.errors?.length) unreadable.push(id);
      else busyByCalendar[id] = (c?.busy ?? []).flatMap((b) => (b.start && b.end ? [{ start: b.start, end: b.end }] : []));
    }
    if (overflow.length === ids.length && ids.length > 1) {
      const mid = Math.floor(ids.length / 2);
      await query(ids.slice(0, mid));
      await query(ids.slice(mid));
    } else if (overflow.length) {
      await query(overflow);
    }
  }

  for (const c of chunk(calendarIds, FREEBUSY_ITEMS_PER_CALL)) await query(c);
  return { busyByCalendar, unreadable };
}
```
(Import `chunk` from `@/lib/concurrency` in calendar.ts.)

- [ ] **Step 2: Live verification** — book a known conflict for one agent in dev/staging; confirm `freeBusyMany` reports that agent's calendar as busy and a free peer as free. Document in the PR (no automated Google test).

- [ ] **Step 3: Commit.**

```bash
git add src/lib/google/calendar.ts
git commit -m "Add freeBusyMany: single-identity batched free/busy with overflow split (#167)"
```

### Task 3c: Wire `verifyFree` in service.ts (batched + per-agent fallback)

**Files:**
- Modify: `src/lib/booking/service.ts`

**Config constants (top of service.ts):**
```ts
const VERIFY_IDENTITY = () => requireEnv("GOOGLE_FREEBUSY_IDENTITY"); // a Pennie mailbox to impersonate for batch reads
```
(Add `GOOGLE_FREEBUSY_IDENTITY` to env.ts + `.env.example`; set it to a stable admin/service mailbox. Falls back to any one candidate's email if unset — document the choice.)

- [ ] **Step 1: Implement `verifyFree`**

```ts
// src/lib/booking/service.ts — replace the isFree dep with verifyFree
verifyFree: async (entries, startIso, endIso) => {
  // Map every candidate's full calendar set (primary + secondaries) to its agent.
  const calToAgent = new Map<string, string>();   // calendarId -> userId
  const calIds: string[] = [];
  for (const e of entries) {
    const ids = await calendarIdsForEmail(e.email);
    for (const id of (ids.length ? ids : [e.email])) {
      if (!calToAgent.has(id)) { calToAgent.set(id, e.userId); calIds.push(id); }
    }
  }

  const { busyByCalendar, unreadable } = await freeBusyMany(VERIFY_IDENTITY(), startIso, endIso, calIds);

  // Per-agent fallback: any calendar the batch identity couldn't read gets a
  // direct, impersonated check (always-accurate path) — dormant while everyone
  // is primary-only, but keeps secondary calendars correct if they appear.
  const fallbackAgents = new Set(unreadable.map((id) => calToAgent.get(id)!));
  for (const id of unreadable) {
    const e = entries.find((x) => x.userId === calToAgent.get(id));
    if (e) busyByCalendar[id] = await freeBusy(e.email, startIso, endIso, [id]);
  }

  // An agent is free iff NONE of their calendars overlap the slot.
  const freeIds: string[] = [];
  for (const e of entries) {
    const myCals = calIds.filter((id) => calToAgent.get(id) === e.userId);
    const busyAny = myCals.some((id) => overlaps(busyByCalendar[id] ?? [], startIso, endIso));
    if (!busyAny) freeIds.push(e.userId);
  }
  void fallbackAgents;
  return freeIds;
},
```
Imports: `freeBusyMany`, `freeBusy` from `@/lib/google/calendar`; `overlaps` from `@/lib/booking/core`.

- [ ] **Step 2: Live verification + commit** — same dev/staging conflict check end-to-end through a real booking; confirm the busy agent is excluded.

```bash
git add src/lib/booking/service.ts src/lib/env.ts .env.example
git commit -m "Wire verifyFree to single-identity batched free/busy with per-agent fallback (#167)"
```

---

## Phase 4 — Wire into the booking flow

### Task 4: `assignAgent` uses `selectFirstFree`; record verified count

**Files:**
- Modify: `src/lib/booking/orchestration.ts` (`assignAgent` ~163; `BookingDeps` ~116; `routing_trace` ~341)
- Modify: `src/lib/booking/service.ts` (dep wiring)
- Modify: `scripts/test-booking-orchestration.ts` (fakes)

**Interfaces:**
- `BookingDeps`: replace `isFree(email, startIso, endIso)` with `verifyFree(entries: { userId: string; email: string }[], startIso: string, endIso: string): Promise<string[]>`.
- `assignAgent` calls `selectFirstFree(candidates, loadEmail, (entries) => deps.verifyFree(entries, startIso, endIso), VERIFY_MAX_CANDIDATES)`.
- Add `const VERIFY_MAX_CANDIDATES = 32;` (in core.ts or a shared const) — the max candidates verified per booking attempt. At the ~20-per-call freeBusy cap this is ≤2 Google calls per booking.

- [ ] **Step 1: Update the orchestration fakes to the new dep, write failing test**

In `scripts/test-booking-orchestration.ts`, replace the fake `isFree` with `verifyFree`:
```ts
// calls.verifyFree records entries; `free` is the set of free emails as before
verifyFree: async (entries) => {
  calls.verifyFree.push(entries.map((e) => e.email));
  return entries.filter((e) => free.has(e.email)).map((e) => e.userId);
},
```
Update the existing create/reschedule assertions that referenced `calls.isFree` to `calls.verifyFree`. Add an assertion that a happy-path create still books the first free candidate and fires `booking.created`.

- [ ] **Step 2: Run it; verify it fails**

Run: `node --experimental-strip-types scripts/test-booking-orchestration.ts`
Expected: FAIL — `deps.isFree is not a function` / `verifyFree` not used by `assignAgent` yet.

- [ ] **Step 3: Rewire `assignAgent` and `BookingDeps`**

```ts
// orchestration.ts assignAgent
const candidates = await deps.roundRobinCandidates(bucket, eventType, Date.parse(startIso));
const result = await selectFirstFree(
  candidates,
  async (userId) => (await deps.getUser(userId)).email,
  (entries) => deps.verifyFree(entries, startIso, endIso),
  VERIFY_MAX_CANDIDATES,
);
if (!result) throw new SlotUnavailableError();
return { ...result, candidates };
```
Update `BookingDeps` (remove `isFree`, add `verifyFree`), import `selectFirstFree` from `./core`, and add `verified_count: <entries length>` (or similar) to `routing_trace` so contended picks are observable.

- [ ] **Step 4: Wire the real dep in service.ts**

Replace the `isFree` dep block with the `verifyFree` implementation from Task 3 (now taking `(entries, startIso, endIso)`).

- [ ] **Step 5: Run the full suite**

Run: `pnpm test`
Expected: all node suites + components green.

- [ ] **Step 6: Build + lint**

Run: `pnpm build && pnpm lint`
Expected: compiles; 0 lint errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/booking/orchestration.ts src/lib/booking/service.ts scripts/test-booking-orchestration.ts
git commit -m "Route verify-on-book through bounded parallel-batch verification (#167)"
```

---

## Phase 5 — Scale verification & cleanup

### Task 5: Simulate a large pool and remove dead code

**Files:**
- Modify: `scripts/test-booking-orchestration.ts` (add a scale test)
- Modify: `src/lib/booking/core.ts` (remove unused `selectAgent` once nothing imports it)

- [ ] **Step 1: Add a scale test (fake verifyFree, 200 candidates)**

```ts
// Builds 200 candidates, only #137 is free; assert it is chosen, the cap is honored,
// and verifyFree is invoked with at most VERIFY_MAX_CANDIDATES entries.
```
Drive `selectFirstFree` directly with 200 userIds and a fake `verifyFree`; assert the cap bounds how many are verified and that a free agent within the cap is picked in order. (If the only free agent is beyond the cap, the slot returns null — document this as the deliberate trade-off; the cap is sized so this is vanishingly unlikely given upstream cache gating.)

- [ ] **Step 2: Remove `selectAgent` if unused**

Run: `grep -rn "selectAgent\b" src scripts`
If only its definition/tests remain, delete `selectAgent` and its tests. Keep if anything still imports it.

- [ ] **Step 3: Full suite + build**

Run: `pnpm test && pnpm build && pnpm lint`
Expected: green.

- [ ] **Step 4: Commit + open PR**

```bash
git add -A && git commit -m "Add scale test for verify-on-book; drop the serial selectAgent (#167)"
SKIP_TEST_CHECK=1 git push -u origin <branch>
gh pr create --title "Scalable verify-on-book: bounded parallel-batch free/busy (#167)" --body "..."
```

---

## Self-Review notes

- **Spec coverage:** Phase 0 answers the auth unknown; Phases 1-2 are unblocked and shippable regardless; Phase 3 branches on Phase 0; Phase 4 wires it in; Phase 5 proves scale. #224 (helper extraction) is folded into Phase 1. #225 (availability load) is explicitly out of scope.
- **Accuracy invariant:** no cache-trust fallback anywhere — `selectFirstFree` returns null (→ "slot just filled up") when no verified-free agent is found within the cap, preserving honest availability.
- **Type consistency:** `verifyFree(entries, startIso, endIso) => Promise<string[]>` is used identically in `BookingDeps`, the fake, the real dep, and the `selectFirstFree` adapter. `AssignResult` is unchanged.
- **Open risk to confirm during execution:** the `VERIFY_MAX_CANDIDATES` cap (default 32) means a free agent beyond the first 32 cache-free candidates in round-robin order would be missed on that attempt. Given upstream gating already guarantees the slot had ≥1 cache-free agent and the cache is kept fresh, 32 is generous; revisit if production telemetry (`routing_trace.verified_count`) shows frequent saturation.
```
