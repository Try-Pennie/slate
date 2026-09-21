# Edge-Cache the Computed Availability Slots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the booking embed's slot list load in ~10-50ms by serving the computed per-bucket slot list from a global edge cache (Workers KV), instead of recomputing it from ~7 cross-region Supabase queries (~400-800ms) on every load.

**Architecture:** Wrap `getBucketSlots` with a read-through KV cache keyed by `(bucketCode, normalized window)`. On a hit, return the cached slot list (filtered to the caller's `now + min-notice` at read time, so one cached payload serves all callers within the window). On a miss, compute as today and store with a short TTL. Invalidate best-effort on the booking write-through (the user-visible "a slot just got taken" case); Google-sync and OOO changes ride the short TTL, matching Slate's existing eventual-consistency tolerance. Verify-on-book stays the hard correctness guarantee against double-booking, exactly as today — the cache only affects what slots are *shown*, never what gets *booked*.

**Tech Stack:** Next 16 (App Router) on OpenNext/Cloudflare Workers, Workers KV (new binding), Supabase, Luxon. KV binding accessed via `getCloudflareContext().env` from `@opennextjs/cloudflare`. Node-native tests (`scripts/test-*.ts`).

## Global Constraints

- **Correctness invariant:** the cache changes only which slots are *displayed*. Booking still goes through `createBooking` → verify-on-book → the active-slot unique index. A briefly-stale shown slot resolves to a "that time just filled up" message, never a real double-book. Do NOT add any cache read/write to the booking write path.
- Staleness budget: a booked slot may remain visible for up to the TTL (target 60s) plus KV propagation. This matches the existing model (the 1-min sync cron already means external changes are up to ~60s stale).
- Cloudflare-deployable; keep the cal.com embed contract (`/api/availability` response shape) **unchanged**.
- Every new feature ships with a test (`scripts/test-*.ts`). Pre-push gate ignores `scripts/test-*.ts` → push with `SKIP_TEST_CHECK=1` + reason.
- New branch off `origin/main`; small focused PRs.
- Weekday convention Luxon (1=Mon..7=Sun). Server code uses `supabaseAdmin` (secret key).

## File Structure

- `wrangler.jsonc` (modify) — add a `kv_namespaces` binding (`SLOT_CACHE`).
- `src/lib/availability/cache-key.ts` (create) — pure: normalize a request window + build the cache key. Unit-tested.
- `src/lib/availability/slot-cache.ts` (create) — KV read-through wrapper + invalidation helper (the only IO; binding access lives here).
- `src/app/api/availability/route.ts` (modify) — call the cached path; apply read-time `now + minNotice` filter.
- `src/lib/availability/compute.ts` (modify, maybe) — expose/keep a pure `filterSlotsFromNow(slots, nowMs, minNoticeMin)` helper for the read-time filter. Unit-tested.
- `src/lib/booking/service.ts` (modify) — after the booking write-through to `busy_blocks` (insert at ~116 / delete at ~134), best-effort invalidate the bucket's cached slots.
- `scripts/test-slot-cache-key.ts` (create) — tests for key normalization + the read-time filter.

Out of scope (separate plans): Hyperdrive / the Worker→Supabase connection fix (the app-wide layer under this); the at-scale flip benchmark.

---

## Task 1: KV namespace + binding

**Files:** `wrangler.jsonc` (modify)

- [ ] **Step 1: Create the namespace** (user runs — needs Cloudflare auth):

Run: `npx wrangler kv namespace create SLOT_CACHE`
Expected: prints an `id`. Copy it.

- [ ] **Step 2: Add the binding to `wrangler.jsonc`** (after `"assets"`):

```jsonc
  "kv_namespaces": [
    { "binding": "SLOT_CACHE", "id": "<the id from step 1>" }
  ],
```

- [ ] **Step 3: Type the binding** — extend the Cloudflare env type (wherever `CloudflareEnv` is declared, e.g. `env.d.ts` / `worker-configuration.d.ts`; create a `cloudflare-env.d.ts` if none) so `getCloudflareContext().env.SLOT_CACHE` is `KVNamespace`.

- [ ] **Step 4: Commit.**
```bash
git add wrangler.jsonc *.d.ts
git commit -m "Add SLOT_CACHE KV namespace binding for availability caching"
```

---

## Task 2: Pure cache-key + read-time filter

**Files:** `src/lib/availability/cache-key.ts` (create), `src/lib/availability/compute.ts` (modify), `scripts/test-slot-cache-key.ts` (create)

**Interfaces:**
- Produces: `slotCacheKey(bucketCode: string, fromIso: string, horizonDays: number): { key: string; fromIso: string; toIso: string }` — rounds `fromIso` DOWN to the start of its UTC hour and sets `toIso = roundedFrom + horizonDays`, so all requests within the same hour share one key. Key format: `slots:v1:{bucketCode}:{roundedFromIso}:{horizonDays}`.
- Produces: `filterSlotsFromNow(slots: string[], nowMs: number, minNoticeMin: number): string[]` — drops slot instants earlier than `nowMs + minNoticeMin*60000`. Lets one hour-granular cached payload serve exact-`now` callers.

- [ ] **Step 1: Write failing tests**
```ts
// scripts/test-slot-cache-key.ts
import { slotCacheKey } from "../src/lib/availability/cache-key.ts";
import { filterSlotsFromNow } from "../src/lib/availability/compute.ts";
let failures = 0;
const assert = (c: boolean, m: string) => { if (!c) { console.error("FAIL:", m); failures++; } else console.log("ok:", m); };

const k = slotCacheKey("411", "2026-06-18T16:42:07.123Z", 14);
assert(k.key === "slots:v1:411:2026-06-18T16:00:00.000Z:14", "key rounds from down to the UTC hour");
assert(k.fromIso === "2026-06-18T16:00:00.000Z", "fromIso is the rounded hour");
assert(k.toIso === "2026-07-02T16:00:00.000Z", "toIso is rounded-from + 14d");
// two timestamps in the same hour -> same key
assert(slotCacheKey("411", "2026-06-18T16:05:00.000Z", 14).key === k.key, "same hour shares a key");

const slots = ["2026-06-18T16:30:00.000Z", "2026-06-18T17:00:00.000Z", "2026-06-18T18:00:00.000Z"];
const now = Date.parse("2026-06-18T16:50:00.000Z");
assert(JSON.stringify(filterSlotsFromNow(slots, now, 30)) === JSON.stringify(["2026-06-18T18:00:00.000Z"]),
  "filters slots earlier than now + 30m min-notice");

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run → FAIL** (`node --experimental-strip-types scripts/test-slot-cache-key.ts`): modules/exports missing.

- [ ] **Step 3: Implement**
```ts
// src/lib/availability/cache-key.ts
/** Cache key + the normalized window to compute, so all requests within one
 *  UTC hour share a cache entry. Bump the `v1` prefix to invalidate all keys
 *  after a compute-logic change. */
export function slotCacheKey(
  bucketCode: string,
  fromIso: string,
  horizonDays: number,
): { key: string; fromIso: string; toIso: string } {
  const d = new Date(fromIso);
  d.setUTCMinutes(0, 0, 0);
  const roundedFrom = d.toISOString();
  const toIso = new Date(d.getTime() + horizonDays * 86_400_000).toISOString();
  return { key: `slots:v1:${bucketCode}:${roundedFrom}:${horizonDays}`, fromIso: roundedFrom, toIso };
}
```
```ts
// src/lib/availability/compute.ts (add)
/** Drops slot instants earlier than now + min-notice (applied after a cache read). */
export function filterSlotsFromNow(slots: string[], nowMs: number, minNoticeMin: number): string[] {
  const cutoff = nowMs + minNoticeMin * 60_000;
  return slots.filter((s) => Date.parse(s) >= cutoff);
}
```

- [ ] **Step 4: Run → PASS. Commit.**
```bash
git add src/lib/availability/cache-key.ts src/lib/availability/compute.ts scripts/test-slot-cache-key.ts
git commit -m "Add pure slot cache-key normalization + read-time min-notice filter"
```

---

## Task 3: KV read-through wrapper + invalidation helper

**Files:** `src/lib/availability/slot-cache.ts` (create)

**Interfaces:**
- Consumes: `getCloudflareContext` from `@opennextjs/cloudflare`; `getBucketSlots` from `./service`; `slotCacheKey` from `./cache-key`.
- Produces:
  - `getCachedBucketSlots(code, fromIso, horizonDays): Promise<BucketSlots | null>` — KV get on the normalized key; on miss, `getBucketSlots(code, normFrom, normTo)`, store JSON with TTL, return it. On any KV error, fall through to a direct compute (cache is never load-bearing for correctness).
  - `invalidateBucketSlots(code): Promise<void>` — best-effort delete of the bucket's cached keys (list by `slots:v1:{code}:` prefix, delete each). Swallows errors.

**Config:** `const SLOT_TTL_SECONDS = 60;` `const HORIZON_DAYS = 14;` (match `DEFAULT_RANGE_DAYS`).

- [ ] **Step 1: Implement** (IO; verified by integration + the live latency re-measure, not a unit test — KV isn't available under `node`):
```ts
// src/lib/availability/slot-cache.ts
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getBucketSlots, type BucketSlots } from "./service";
import { slotCacheKey } from "./cache-key";

export const SLOT_TTL_SECONDS = 60;
export const HORIZON_DAYS = 14;

function kv(): KVNamespace | null {
  try { return getCloudflareContext().env.SLOT_CACHE ?? null; } catch { return null; }
}

export async function getCachedBucketSlots(
  code: string,
  fromIso: string,
  horizonDays = HORIZON_DAYS,
): Promise<BucketSlots | null> {
  const { key, fromIso: nf, toIso: nt } = slotCacheKey(code, fromIso, horizonDays);
  const store = kv();
  if (store) {
    try {
      const hit = await store.get(key, "json");
      if (hit) return hit as BucketSlots;
    } catch { /* fall through to compute */ }
  }
  const fresh = await getBucketSlots(code, nf, nt);
  if (store && fresh) {
    try { await store.put(key, JSON.stringify(fresh), { expirationTtl: SLOT_TTL_SECONDS }); } catch { /* ignore */ }
  }
  return fresh;
}

/** Best-effort: clear a bucket's cached slot lists after its availability changes. */
export async function invalidateBucketSlots(code: string): Promise<void> {
  const store = kv();
  if (!store) return;
  try {
    const { keys } = await store.list({ prefix: `slots:v1:${code}:` });
    await Promise.all(keys.map((k) => store.delete(k.name)));
  } catch { /* ignore */ }
}
```

- [ ] **Step 2: Commit.**
```bash
git add src/lib/availability/slot-cache.ts
git commit -m "Add KV read-through cache + invalidation for availability slots"
```

---

## Task 4: Wire the route to the cache + read-time filter

**Files:** `src/app/api/availability/route.ts` (modify)

**Interface change:** the route computes over the normalized window (via the cache) and filters to `now + minNotice` before responding, so the cached payload is reused while each response still respects the exact current time.

- [ ] **Step 1: Update the route**
```ts
// replace `const result = await getBucketSlots(code, from, to);`
import { getCachedBucketSlots } from "@/lib/availability/slot-cache";
import { filterSlotsFromNow } from "@/lib/availability/compute";
// ...
const result = await getCachedBucketSlots(code, from); // normalized window + horizon inside
if (!result) return NextResponse.json({ error: "Unknown bucket" }, { status: 404 });
const slots = filterSlotsFromNow(result.slots, Date.now(), result.eventType.min_notice_min);
// return { ...result fields..., slots } — same response shape as today
```
Keep the `from`/`to` query-param parsing for backwards compatibility, but pass `from` into the cache (the horizon is fixed at `HORIZON_DAYS`); if a caller passes an explicit `to`, clamp the returned `slots` to `<= to` after the filter so the response still honors a narrower requested window.

- [ ] **Step 2: Verify response shape unchanged** — diff a live response before/after for a known bucket; `slots`, `bucket`, `eventType`, `orgName` identical (embed contract). Document in the PR.

- [ ] **Step 3: Build + lint.** `pnpm build && pnpm lint` green.

- [ ] **Step 4: Commit.**
```bash
git add src/app/api/availability/route.ts
git commit -m "Serve availability from the KV slot cache with a read-time min-notice filter"
```

---

## Task 5: Invalidate on the booking write-through

**Files:** `src/lib/booking/service.ts` (modify)

The booking write-through to `busy_blocks` is the user-visible freshness case (a just-booked slot should disappear). Hook invalidation there. Sync/OOO changes intentionally ride the 60s TTL.

- [ ] **Step 1: Invalidate after the write-through** — in the `insertBusyBlock` dep (service.ts ~116) and the `deleteBusyBlocksForBooking` dep (~134), after the DB write, call `invalidateBucketSlots(bucketCode)` for the affected booking's bucket. The bucket code is reachable from the booking context; if only `bucket_id` is on hand, resolve its `code` once. Best-effort (never block or fail the booking on a cache error).

- [ ] **Step 2: Add a test** — extend `scripts/test-booking-orchestration.ts` (or a new `scripts/test-slot-cache-invalidation.ts`) with a fake that asserts a successful booking triggers exactly one invalidation for the booked bucket, and a failed/rolled-back booking triggers none. (Drive through the existing `BookingDeps` fake; add an `invalidateSlots` spy dep so it stays unit-testable without KV.)

- [ ] **Step 3: Run the suite + build.** `pnpm test && pnpm build && pnpm lint` green.

- [ ] **Step 4: Commit + PR.**
```bash
git add -A && git commit -m "Invalidate cached slots on booking write-through"
SKIP_TEST_CHECK=1 git push -u origin <branch>
gh pr create --title "Edge-cache availability slots for blazing-fast booker loads" --body "..."
```

---

## Verification (post-merge, deployed)

- Re-run the slot-load timing (`scripts/spike-slotload-bench.ts`) for several xbc codes: expect a cold miss (~current latency) then warm hits ~10-50ms.
- Book a slot in one session, confirm it disappears from a fresh availability load within ~1s (same colo) / ~60s (cross-colo TTL).
- Confirm the embed still renders and books end-to-end (contract intact).
- Confirm `cf-cache`/timing improvement vs the pre-cache baseline; record numbers in the PR.

## Self-Review notes

- **Correctness:** cache is never on the booking write path; verify-on-book + the active-slot unique index remain the only double-book guards. A stale shown slot degrades to "just filled up", which already exists.
- **Hit-ability:** hour-normalized key + read-time `now`-filter means all requests in an hour share one entry while each response still respects the exact current time and min-notice.
- **Fail-open:** every KV call is wrapped; on any KV error the path computes directly, so the cache can never break availability.
- **Type consistency:** `getCachedBucketSlots` returns the same `BucketSlots` shape as `getBucketSlots`; the route's response is byte-for-byte the same fields.
- **Scope note:** this plan covers only the availability read hot path. Hyperdrive was named here as a separate plan for the cache-miss compute and every other DB page; the precompute work that came next (#256, plan `2026-06-19-precompute-availability-implementation.md`) measured the path as compute bound rather than connection bound and judged Hyperdrive unnecessary, so no plan or issue for it exists.
