/**
 * The only way to CHANGE an event type (#1435).
 *
 * Hit live on 2026-08-12 while applying #1335's copy: the description was updated
 * in `event_types`, the database was correct, the admin screen showed the new text,
 * and the booker went on serving the old one. The event type rides INSIDE the cached
 * `bucket_slots` payload the read path serves, so **editing the row is not the same
 * as serving it**, and the gap is invisible from every angle anyone checks. Only a
 * lead sees the old value.
 *
 * Two admin actions happened to remember to invalidate. Nothing enforced it, and a
 * future editor for the name, duration, buffers, notice or cap would have shipped
 * the same defect. A duration change is worse than cosmetic: the org business-hours
 * gate judges whether a slot FITS the window, so a stale duration can offer a time
 * that no longer fits.
 *
 * So the invalidation is not a step a call site remembers, it is part of writing.
 * `scripts/test-event-type-writes.ts` enforces the other direction: nothing else in
 * `src/` may write the table.
 *
 * What this deliberately does NOT cover: an INSERT (a brand new event type has no
 * cached payload serving an older version of itself), and a direct SQL edit, which
 * no code guard can reach. The runbook carries that case.
 */
import { supabaseAdmin } from "@/lib/supabase/admin";
import { markAllBucketSlotsStale } from "@/lib/availability/precompute";
import { log } from "@/lib/log";
import type { EventType } from "@/lib/db/types";

/**
 * The columns an editor may change. Deliberately a named list rather than
 * `Partial<EventType>`: `id`, `org_id` and the timestamps are not editable, and
 * spreading a whole row into an update is how an org_id gets rewritten by accident.
 */
export type EventTypePatch = Partial<
  Pick<
    EventType,
    | "name"
    | "description"
    | "regal_type"
    | "duration_min"
    | "buffer_before_min"
    | "buffer_after_min"
    | "min_notice_min"
    | "daily_cap"
    | "slot_interval_min"
  >
>;

export interface UpdateEventTypeResult {
  /** Rows changed. Zero means the id matched nothing this org owns. */
  count: number;
  /** A real database error, for the caller to surface. Null on success. */
  error: { message: string } | null;
  /** True when the served copy was refreshed. False when the refresh itself failed. */
  invalidated: boolean;
}

/**
 * Update one event type, scoped to its org, and refresh what the booker serves.
 *
 * Ordering and failure directions, each chosen rather than inherited:
 *
 *  - The write happens first. Invalidating before writing would re-serve the OLD
 *    value into a fresh cache row, which is the defect with extra steps.
 *  - Zero rows changed does NOT invalidate. Nothing was edited, so nothing is
 *    stale, and a mass invalidation costs a full recompute cycle across every
 *    bucket.
 *  - A failed invalidation does NOT fail the save. The row is committed and
 *    correct, and the served copy still converges as rows age past the freshness
 *    window; failing the admin's save would leave them re-submitting a change that
 *    already landed. It is logged and reported in `invalidated` so the caller can
 *    tell the difference rather than assuming.
 */
export async function updateEventType(opts: {
  eventTypeId: string;
  orgId: string;
  patch: EventTypePatch;
}): Promise<UpdateEventTypeResult> {
  const { error, count } = await supabaseAdmin()
    .from("event_types")
    .update(opts.patch, { count: "exact" })
    .eq("id", opts.eventTypeId)
    .eq("org_id", opts.orgId);

  if (error) return { count: 0, error, invalidated: false };
  // A null count with no error is not a measurement of zero. Treating it as zero
  // would skip the invalidation on a write that may well have landed, so it is
  // handled as "changed something" for invalidation purposes while still being
  // reported honestly to the caller.
  const changed = count ?? null;
  if (changed === 0) return { count: 0, error: null, invalidated: false };

  try {
    await markAllBucketSlotsStale();
    return { count: changed ?? 1, error: null, invalidated: true };
  } catch (err) {
    log.error(
      "event-type-store",
      {
        msg: "row invalidation failed after an event type change",
        event_type_id: opts.eventTypeId,
      },
      err,
    );
    return { count: changed ?? 1, error: null, invalidated: false };
  }
}
