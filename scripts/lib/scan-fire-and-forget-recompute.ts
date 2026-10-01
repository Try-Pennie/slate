// Scan logic for the #503 fire-and-forget recompute guard, kept beside the guard
// so it is unit-testable (the guard's positive control exercises it).
//
// #503 routed the post-response `recomputeBucketsForAgent(...)` calls in the
// calendar-sync and OOO paths through an awaited call or `afterResponse(...)`,
// so Cloudflare/OpenNext keeps the isolate alive until they settle instead of
// dropping the floated promise. This detector fails the build if one of those
// sites regresses back to a bare `void recomputeBucketsForAgent(...)` float.
//
// It deliberately targets ONLY `recomputeBucketsForAgent`. The every-booking
// `invalidateSlots` → `recomputeBucketSlotsForToday(...)` (a DIFFERENT function)
// floats only on the outbox cron drain, where after() would be a shared-lane
// budget regression and the recompute lane is the backstop. On the user-facing
// paths it goes through afterResponse since #2345, pinned by
// src/lib/booking/confirm-slot-refresh.test.ts. So this guard must not flag the
// cron float.

export interface FireAndForgetHit {
  line: number;
  text: string;
}

/** Lines that float `recomputeBucketsForAgent` via `void` (the banned shape). */
export function scanFireAndForgetRecompute(src: string): FireAndForgetHit[] {
  const hits: FireAndForgetHit[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    // `void recomputeBucketsForAgent(`: the fire-and-forget shape #503 removed.
    if (/\bvoid\s+recomputeBucketsForAgent\s*\(/.test(text)) {
      hits.push({ line: i + 1, text: text.trim() });
    }
  }
  return hits;
}
