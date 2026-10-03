/**
 * Per-isolate caching for the org's opening hours (#1296).
 *
 * Gate 1 (#1295) is enforced at COMPUTE time, which leaves one hole: a slot
 * computed under a wider window and then served from the slot cache after someone
 * narrows the day. Closing it means filtering at READ time, and that means every
 * served response needs the current hours. A PostgREST round trip per request is
 * not affordable on that path, and a long-lived cache would leave a narrowing
 * unenforced for as long as the cache lasted.
 *
 * So: a TTL aligned to `SLOT_TTL_SECONDS`, the same 5 seconds the slot cache
 * already tolerates. One read per isolate per 5 seconds, and an edit takes effect
 * on the next request rather than the next recompute.
 *
 * ## The failure direction, which is a decision and not a default
 *
 * A refresh that FAILS serves the LAST KNOWN hours rather than taking the booker
 * down (Dan, 2026-08-06). Leads keep booking through a blip.
 *
 * That is only safe to do quietly because a sustained failure is loud elsewhere:
 * `loadBusinessHours` throws, so `getBucketSlots` throws, so `recomputeBucketSlots`
 * writes no row, rows go stale, and `bucket_slots_stale` pages after six minutes.
 * The fallback buys time; it does not hide the fault. Every stale serve is also
 * logged with its age by the caller's `onStale`, so the window is visible in the
 * logs rather than inferred.
 *
 * The one case with nothing to fall back on, a cold isolate whose very first read
 * fails, still THROWS. Inventing a week there is the single outcome nobody would
 * notice: it would silently re-open hours an admin had narrowed, and the booker
 * would look perfectly healthy while doing it.
 *
 * No `@/` imports, so the node suite drives it directly with a fake clock.
 */

import { makeSharedInFlight } from "../concurrency.ts";

/** The org's hours as the loader returns them. Structural, so this module does not
 *  depend on the DB layer that produces it. */
export interface BusinessHours {
  zone: string;
  rules: { weekday: number; start_minute: number; end_minute: number }[];
  /** Date exceptions (#1363). Cached with the week, and for the same reason: the
   *  read-time filter has to see the SAME answer the gate saw about a given day. */
  exceptions: {
    on_date: string;
    is_open: boolean;
    start_minute: number | null;
    end_minute: number | null;
    note: string | null;
  }[];
  source: "stored" | "seeded";
}

export interface CachedHoursDeps {
  /** The real read. Throws on an unreadable week; never returns a fallback. */
  load(): Promise<BusinessHours>;
  /** How long a successful read stays fresh. Aligned to `SLOT_TTL_SECONDS`. */
  ttlMs: number;
  /** Injected clock, so the TTL is testable without waiting. */
  now(): number;
  /** Called on EVERY serve of a stale entry, with how old it is. Never silent. */
  onStale(ageMs: number, err: unknown): void;
}

export function makeCachedHoursReader(deps: CachedHoursDeps): () => Promise<BusinessHours> {
  let entry: { value: BusinessHours; readAt: number } | null = null;
  // One load at a time (#3123): a burst arriving on a cold or expired entry awaits
  // the leader's read rather than each starting its own round trip.
  const shared = makeSharedInFlight<"hours", BusinessHours>();

  return async function readHours(): Promise<BusinessHours> {
    const now = deps.now();
    if (entry && now - entry.readAt < deps.ttlMs) return entry.value;

    try {
      return await shared("hours", async () => {
        const fresh = await deps.load();
        entry = { value: fresh, readAt: now };
        return fresh;
      });
    } catch (err) {
      // Deliberately do NOT cache the failure: the next request retries straight
      // away, so recovery is immediate rather than one TTL away.
      if (entry) {
        deps.onStale(now - entry.readAt, err);
        return entry.value;
      }
      throw err;
    }
  };
}
