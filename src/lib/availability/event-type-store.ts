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
import type { LoadedFieldValue } from "@/lib/admin/edit-version";

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

/** One editable column. */
export type EventTypeField = keyof EventTypePatch;

export interface UpdateEventTypeResult {
  /** Rows changed. Zero means the id matched nothing this org owns. */
  count: number;
  /** A real database error, for the caller to surface. Null on success. */
  error: { message: string } | null;
  /** True when the served copy was refreshed. False when the refresh itself failed. */
  invalidated: boolean;
  /** True when a field being saved no longer holds the value the editor loaded
   *  (#3122, #3798): somebody changed THAT field after the page was opened, so
   *  nothing was written. A change to any other field of the row is not this. */
  changed: boolean;
}

/**
 * How many times one save reads and writes before giving up. Each further attempt
 * means another write to this row landed in the few milliseconds between this
 * save's read and its own write, so running out is not contention a person makes.
 * It is reported as a failed save, never as a refusal that names somebody else.
 */
export const EVENT_TYPE_SAVE_ATTEMPTS = 3;

/**
 * Update one event type, scoped to its org, and refresh what the booker serves.
 *
 * Whether somebody else changed what is being saved is judged by the FIELDS being
 * saved (#3798, L776), never by the row's `updated_at`. Three editors each save one
 * field of this row (the gap, the notice, the description), and any save moves that
 * stamp, so judging by it refused every other open editor over a field nobody had
 * touched. So:
 *
 *  1. Read the row's patched fields and its `updated_at`.
 *  2. A patched field holding neither the value the editor loaded nor the value
 *     being saved was changed by somebody else: refuse as `changed`. One already
 *     holding the value being saved is no conflict (a double submit, or two people
 *     making the same change), so it is simply written again.
 *  3. Write guarded on the `updated_at` just READ. That stamp closes only the gap
 *     between this read and this write. When it matches nothing, another write
 *     landed in between, and the save goes back to step 1 and judges again, so a
 *     concurrent write to another field never becomes a refusal.
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
export async function updateEventType<K extends EventTypeField>(opts: {
  eventTypeId: string;
  orgId: string;
  patch: Required<Pick<EventTypePatch, K>>;
  /**
   * Each patched field's value as the editor's page loaded it (#3798). REQUIRED,
   * and keyed by the patch, so tsc refuses an editor that saves a field without
   * saying what it was looking at.
   */
  loaded: NoInfer<Record<K, LoadedFieldValue>>;
}): Promise<UpdateEventTypeResult> {
  const fields = Object.keys(opts.patch) as K[];
  for (const f of fields) {
    // tsc already refuses this. A caller casting around it is a defect to fix, and
    // saving blind is the very thing this function exists to stop.
    if (!(f in opts.loaded)) throw new Error(`updateEventType: no loaded value for ${f}`);
  }
  const db = supabaseAdmin();
  const nothing = { count: 0, invalidated: false, changed: false };

  for (let attempt = 1; attempt <= EVENT_TYPE_SAVE_ATTEMPTS; attempt++) {
    const { data, error: readError } = await db
      .from("event_types")
      .select(["updated_at", ...fields].join(", "))
      .eq("id", opts.eventTypeId)
      .eq("org_id", opts.orgId)
      .maybeSingle();
    // An unreadable answer is an error, never a guess at one of the outcomes below.
    if (readError) return { ...nothing, error: readError };
    // Not this org's, or not there at all.
    if (!data) return { ...nothing, error: null };
    const current = data as unknown as Record<string, unknown> & { updated_at: string };

    const movedByOthers = fields.filter(
      (f) => current[f] !== opts.loaded[f] && current[f] !== opts.patch[f],
    );
    if (movedByOthers.length > 0) return { ...nothing, error: null, changed: true };

    const { error, count } = await db
      .from("event_types")
      // Widened for supabase-js, whose typing cannot read a patch keyed by a type
      // parameter; it is the same object.
      .update(opts.patch as EventTypePatch, { count: "exact" })
      .eq("id", opts.eventTypeId)
      .eq("org_id", opts.orgId)
      .eq("updated_at", current.updated_at);
    if (error) return { ...nothing, error };
    // Another write landed between the read above and this one. Judge again.
    if (count === 0) continue;

    // A null count with no error is not a measurement of zero. Treating it as zero
    // would skip the invalidation on a write that may well have landed, so it is
    // handled as "changed something" for invalidation purposes while still being
    // reported honestly to the caller.
    const invalidated = await invalidateAfterWrite(opts.eventTypeId);
    return { count: count ?? 1, error: null, invalidated, changed: false };
  }

  log.error("event-type-store", {
    msg: "event type kept changing under the save",
    event_type_id: opts.eventTypeId,
    attempts: EVENT_TYPE_SAVE_ATTEMPTS,
  });
  return {
    ...nothing,
    error: { message: `the event type changed under the save ${EVENT_TYPE_SAVE_ATTEMPTS} times in a row` },
  };
}

/** Refresh what the booker serves after a write landed; false when the refresh failed. */
async function invalidateAfterWrite(eventTypeId: string): Promise<boolean> {
  try {
    await markAllBucketSlotsStale();
    return true;
  } catch (err) {
    log.error(
      "event-type-store",
      {
        msg: "row invalidation failed after an event type change",
        event_type_id: eventTypeId,
      },
      err,
    );
    return false;
  }
}
