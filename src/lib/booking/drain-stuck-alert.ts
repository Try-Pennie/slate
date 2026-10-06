/**
 * The page and the all-clear for a stuck durable drain (#3359), shared by the
 * booking-outbox drain and the create-reservation drain.
 *
 * A row that keeps failing is put on an exponential backoff (#445), so on most
 * ticks the drain does not load it at all. That makes "this tick found nothing
 * stuck in its batch" a statement about the batch, not about the table. Both
 * drains used to send their all-clear on exactly that, so on 2026-10-06 one
 * reservation pending at five and more attempts produced page and all-clear pairs
 * at 2:49, 3:01, 3:38 and 9:41 AM ET while it never moved: an all-clear off a tick
 * that measured nothing (#1152, L98).
 *
 * So the condition is judged on the STORED rows: it is over only when the store
 * holds no pending row at `DRAIN_ALERT_AFTER` attempts or more. A store that
 * cannot be read clears nothing, and the next tick asks again.
 *
 * The page is unchanged: it is still raised by a tick that bumped a row past the
 * threshold, under the alert's own cooldown. Pure, with every effect injected, so
 * `scripts/test-drain-stuck-alert.ts` drives it with no database.
 */

export interface RecoveryNotice {
  key: string;
  text: string;
}

export interface DrainStuckSeams {
  /** Pending rows with attempts at or past the alert threshold, as the store
   *  holds them now. THROWS when the store cannot be read; never answers 0 for it. */
  countStoredStuck: () => Promise<number>;
  /** Raise the stuck page for the rows this tick found past the threshold. */
  page: (count: number, ids: string) => Promise<void>;
  /** Clear the conditions that were measured healthy, in one batch. */
  resolve: (entries: RecoveryNotice[]) => Promise<void>;
}

export type DrainStuckOutcome =
  /** This tick bumped rows past the threshold and paged them. */
  | "paged"
  /** The store still holds a row past the threshold, so the condition stands. */
  | "still-stuck"
  /** The store could not be read, so nothing is known and nothing was cleared. */
  | "unmeasured"
  /** The store holds no row past the threshold: the condition is over. */
  | "cleared";

/** How many stuck row ids a page names, as it always has. */
const PAGED_IDS = 10;

export async function settleDrainStuckAlert(
  tickStuck: readonly { id: string }[],
  recovery: RecoveryNotice,
  seams: DrainStuckSeams,
  /** Other conditions the caller MEASURED healthy this tick, settled in the same
   *  batch so the lane spends one alert_state read. Never anything unmeasured. */
  alsoRecovered: readonly RecoveryNotice[] = [],
): Promise<DrainStuckOutcome> {
  let outcome: DrainStuckOutcome;
  if (tickStuck.length > 0) {
    const ids = tickStuck.slice(0, PAGED_IDS).map((r) => r.id).join(", ");
    await seams.page(tickStuck.length, ids);
    outcome = "paged";
  } else {
    let stored: number | null;
    try {
      stored = await seams.countStoredStuck();
    } catch {
      // The caller's read logs its own failure; here it only means "unknown".
      stored = null;
    }
    outcome = stored === null ? "unmeasured" : stored > 0 ? "still-stuck" : "cleared";
  }
  const entries = [...(outcome === "cleared" ? [recovery] : []), ...alsoRecovered];
  if (entries.length > 0) await seams.resolve(entries);
  return outcome;
}
