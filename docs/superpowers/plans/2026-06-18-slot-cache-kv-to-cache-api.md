# Switch the Slot Cache from KV to the Cache API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the slot cache's storage (Cloudflare KV, measured ~264ms hits) with the Cloudflare Cache API (measured ~31ms hits in this project), so the booking widget's slot list is blazing-fast at any traffic level — without a "hot key" warm-up.

**Architecture:** Keep the existing read-through + fail-open + invalidate-on-booking shape from #231; swap only the storage layer inside `slot-cache.ts`. The Cache API is colo-local and has **no prefix/list operation**, so the cache key changes from one-per-hour to **one stable key per bucket per UTC day**, making invalidation an exact single `delete`. Freshness still leans on the 60s TTL + verify-on-book (cross-datacenter and cross-day-boundary staleness is TTL-bounded), which we already accept.

**Tech Stack:** Next 16 App Router on OpenNext/Cloudflare Workers; Cloudflare Cache API (`caches.default`); the `appUrl()` helper (`src/lib/env.ts:38`) for an on-zone cache-key URL.

## Global Constraints

- **Correctness unchanged from #231:** cache affects only displayed slots, never the booking write path. Verify-on-book + the active-slot unique index remain the only double-book guards. Fail-open: any cache error falls back to a direct DB compute.
- **Embed contract:** `/api/availability` response shape stays byte-for-byte identical.
- Cache-key URL must be on the app's own zone (use `appUrl()`); a synthetic path is fine (it's only a lookup key, not a real route) — the #232 probe confirmed `caches.default` works this way on `slate.trypennie.app`.
- `caches.default` is a Cloudflare runtime extension not in standard TS lib types — access via a narrow typed cast (as the probe did), never `any`/`@ts-ignore`.
- New branch off `origin/main`; verify with `pnpm test` + `pnpm build` + `pnpm lint`; push needs `SKIP_TEST_CHECK=1` (gate ignores `scripts/test-*.ts`).

## File Structure
- `src/lib/availability/cache-key.ts` (modify) — normalize `from` to start-of-UTC-**day** (was hour); bump key prefix to `slots:v2:`.
- `scripts/test-slot-cache-key.ts` (modify) — update assertions hour→day.
- `src/lib/availability/slot-cache.ts` (rewrite) — Cache API instead of KV/`getCloudflareContext`.
- `wrangler.jsonc` (modify) — remove the `kv_namespaces` block (binding no longer used).
- `cloudflare-env.d.ts` (modify/delete) — remove the `SLOT_CACHE` declaration (delete the file if that's all it held).
- `src/app/api/cache-probe/route.ts` (delete) — the throwaway probe.

Out of scope: deleting the KV namespace itself (harmless to leave; note for the user to delete in the dashboard later). Hyperdrive / connection-cost (separate).

---

## Task 1: Day-anchor the cache key

**Files:** `src/lib/availability/cache-key.ts`, `scripts/test-slot-cache-key.ts`

- [ ] **Step 1: Update the failing test** — change the hour assertions to day:
```ts
const k = slotCacheKey("411", "2026-06-18T16:42:07.123Z", 14);
assert(k.key === "slots:v2:411:2026-06-18T00:00:00.000Z:14", "key anchors from to the start of the UTC day");
assert(k.fromIso === "2026-06-18T00:00:00.000Z", "fromIso is the day anchor");
assert(k.toIso === "2026-07-02T00:00:00.000Z", "toIso is day-anchor + 14d");
assert(slotCacheKey("411", "2026-06-18T23:59:00.000Z", 14).key === k.key, "same day shares a key");
```
- [ ] **Step 2: Run → FAIL** (`node --experimental-strip-types scripts/test-slot-cache-key.ts`).
- [ ] **Step 3: Implement** — in `slotCacheKey`, replace `d.setUTCMinutes(0,0,0)` with `d.setUTCHours(0,0,0,0)` and change the prefix to `slots:v2:`. (Comment: day-anchoring gives one key per bucket per day so the Cache API can invalidate it exactly.)
- [ ] **Step 4: Run → PASS.** Also run `node --experimental-strip-types scripts/test-booking.ts` (it imports the same module) — green.
- [ ] **Step 5: Commit** `cache-key.ts` + the test: "Day-anchor the slot cache key for exact Cache API invalidation".

---

## Task 2: Rewrite slot-cache.ts on the Cache API

**Files:** `src/lib/availability/slot-cache.ts` (full rewrite)

**Interfaces (unchanged signatures):** `getCachedBucketSlots(code, fromIso, horizonDays?)`, `invalidateBucketSlots(code)`, `SLOT_TTL_SECONDS`, `HORIZON_DAYS`.

- [ ] **Step 1: Rewrite** (IO; verified by build + live, not unit-tested):
```ts
import { getBucketSlots, type BucketSlots } from "./service";
import { slotCacheKey } from "./cache-key";
import { appUrl } from "@/lib/env";

export const SLOT_TTL_SECONDS = 60;
export const HORIZON_DAYS = 14;

// `caches.default` is a Cloudflare runtime extension not in the standard lib types.
type CfCache = {
  match(req: Request): Promise<Response | undefined>;
  put(req: Request, res: Response): Promise<void>;
  delete(req: Request): Promise<boolean>;
};
function slotCache(): CfCache | null {
  return (globalThis as unknown as { caches?: { default?: CfCache } }).caches?.default ?? null;
}
// Lookup-only key Request on the app's own zone (not a real route).
function keyRequest(key: string): Request {
  return new Request(`${appUrl()}/__slot-cache/${encodeURIComponent(key)}`);
}

export async function getCachedBucketSlots(
  code: string,
  fromIso: string,
  horizonDays = HORIZON_DAYS,
): Promise<BucketSlots | null> {
  const { key, fromIso: nf, toIso: nt } = slotCacheKey(code, fromIso, horizonDays);
  const cache = slotCache();
  const req = keyRequest(key);
  if (cache) {
    try {
      const hit = await cache.match(req);
      if (hit) return JSON.parse(await hit.text()) as BucketSlots;
    } catch { /* fall through to compute */ }
  }
  const fresh = await getBucketSlots(code, nf, nt);
  if (cache && fresh) {
    try {
      await cache.put(
        req,
        new Response(JSON.stringify(fresh), {
          headers: { "content-type": "application/json", "cache-control": `public, max-age=${SLOT_TTL_SECONDS}` },
        }),
      );
    } catch { /* ignore */ }
  }
  return fresh;
}

/**
 * Best-effort clear of a bucket's cached slots after a booking changes it.
 * Cache API is per-datacenter with no prefix-list, so we delete the exact
 * current-day key (the only realistically-cached one, since reads use from≈now).
 * Other datacenters / a crossed day boundary ride the 60s TTL; verify-on-book is
 * the hard double-book guard regardless.
 */
export async function invalidateBucketSlots(code: string): Promise<void> {
  const cache = slotCache();
  if (!cache) return;
  try {
    const { key } = slotCacheKey(code, new Date().toISOString(), HORIZON_DAYS);
    await cache.delete(keyRequest(key));
  } catch { /* ignore */ }
}
```
- [ ] **Step 2:** `pnpm build` + `pnpm lint` clean (0 errors). Commit just `slot-cache.ts`: "Back the slot cache with the Cloudflare Cache API instead of KV".

---

## Task 3: Remove the now-unused KV binding + the probe

**Files:** `wrangler.jsonc`, `cloudflare-env.d.ts`, `src/app/api/cache-probe/route.ts`

- [ ] **Step 1:** Delete the `kv_namespaces` block from `wrangler.jsonc` (the `SLOT_CACHE` entry).
- [ ] **Step 2:** Remove the `SLOT_CACHE: KVNamespace` line from `cloudflare-env.d.ts`; if that leaves the interface empty, delete the file.
- [ ] **Step 3:** `git rm src/app/api/cache-probe/route.ts`.
- [ ] **Step 4:** Confirm nothing else references `SLOT_CACHE` or `getCloudflareContext`: `grep -rn "SLOT_CACHE\|getCloudflareContext" src wrangler.jsonc` returns nothing.
- [ ] **Step 5:** `pnpm build` + `pnpm lint` + `pnpm test` all green. Commit: "Drop the unused SLOT_CACHE KV binding and the Cache API probe".

---

## Task 4: Verify + ship

- [ ] **Step 1:** Full suite green: `pnpm test` (node suites incl. the updated key test + the booking invalidation test) + `pnpm build` + `pnpm lint`.
- [ ] **Step 2:** Open the PR (`SKIP_TEST_CHECK=1` on push). Body notes: KV→Cache API (~264ms→~31ms measured via probe #232), day-anchored key for exact invalidation, per-datacenter + 60s TTL freshness tradeoff (unchanged guarantees), removed KV binding + probe.
- [ ] **Step 3 (post-merge, deployed):** Re-measure `/api/availability?bucket=411`: expect the first hit cold (~hundreds of ms) then warm hits in the tens of ms (matching the probe's ~31ms). Record numbers on the PR. If warm hits are NOT fast, the cache isn't engaging — investigate before claiming the win (don't repeat the KV over-claim).
- [ ] **Step 4 (user, later):** Delete the unused `SLOT_CACHE` KV namespace in the Cloudflare dashboard (optional cleanup; harmless to leave).

## Self-Review notes
- **Invalidation completeness:** day-anchored key means at most ~1 active key per bucket (today; briefly yesterday around 00:00 UTC). `invalidateBucketSlots` deletes today's key exactly. The booking flows that call it (create/reschedule/reassign/cancel) are unchanged from #231.
- **Per-datacenter caveat is acceptable:** smart placement currently runs the Worker in one colo, so reads + bookings share it and invalidation is effective; at multi-colo scale, staleness is ≤60s, and verify-on-book prevents any double-book.
- **Fail-open preserved:** every Cache API call is wrapped; a missing/erroring cache computes directly.
- **Type safety:** `CfCache` cast avoids `any`; no `@ts-ignore`.
- **Embed contract:** response shape untouched (Task 2 only changes where the BucketSlots comes from).
