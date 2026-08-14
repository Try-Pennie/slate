/**
 * Slot separation for EVERY booking canary scenario (#1491).
 *
 * #1489 fixed the cross-bucket scenario, whose two slots were chosen with zero
 * margin and collided three times in ten days. The same design was still present
 * everywhere else: each scenario indexed into `slotsA`, a single availability read
 * taken at the top of the run, with hardcoded offsets (0, 1, 2, 3, 4) whose gaps
 * are one or two slots wide while the seeded event is 20 minutes. Scenarios 2 and 7
 * both started from index 2.
 *
 * Two reasons that is a defect rather than a tidiness point:
 *
 *  1. The list is already STALE by the time the later scenarios run, so the offsets
 *     do not describe the availability the run is actually booking against.
 *  2. A scenario whose instant lands inside another's still-present event does not
 *     fail as "the fixture overlapped". It fails as a dedupe (`decidePersonBooking`
 *     compares start instants) or as NO_ELIGIBLE_AGENTS (the sole test agent reads
 *     its own event as a conflict), which reads as a booking regression. That is
 *     the exact shape of the three false pages in #1489.
 *
 * So a scenario asks for a slot and is REFUSED if none clears the stated margin,
 * rather than being handed a colliding one. A thin window then fails as itself.
 *
 * The margin is anchored on what each booking ACTUALLY landed on, not on the slot
 * requested: the retry helper (`bookFirstFreeSlot`) deliberately advances past a
 * taken slot, so recording the request would leave the plan believing a window is
 * free when it is not.
 *
 * `chooseCrossBucketSlot` stays as it is: it answers a different question (a slot
 * in the OTHER bucket, relative to one known booked instant, where earlier is
 * equally fine), and both live here under the same principle.
 */

/**
 * Minimum separation between any two scenarios' bookings.
 *
 * One hour, matching `laterSlot` and `CROSS_BUCKET_MIN_GAP_MS` for the same reason:
 * comfortably wider than the 20 minute seeded event, so no scenario's window can
 * overlap another's even after the list has gone stale. Slots are published every
 * 10 minutes, so this is six slots.
 */
export const SCENARIO_MIN_GAP_MS = 60 * 60 * 1000;

/**
 * How many scenarios reserve a booking slot: 1 (create/dedupe/reschedule),
 * 2 (cross bucket), 3 (confirm), 4 (lookup), 6 (reassign), 7 (stickiness). The dry
 * run reserves nothing, because it creates nothing.
 */
export const SCENARIOS_RESERVING_SLOTS = 6;

/** The cadence the smoke buckets publish at, measured live on 2026-08-14. */
export const SLOT_STEP_MS = 10 * 60 * 1000;

/**
 * The floor the availability gate should use, derived rather than guessed.
 *
 * Six reservations an hour apart span five hours, which is 30 slots at a 10 minute
 * cadence, plus 6 slots of headroom for the retry helper's own hourly advances.
 *
 * The gate's previous floor was 5 slots, chosen when scenarios indexed into the list
 * at offsets 0 to 4. With a stated separation the run genuinely needs an order of
 * magnitude more, and a floor left at 5 would let the run start and then refuse
 * mid-way, which is honest but pages with a per-scenario message rather than one
 * clear "this window is too thin". Production offers 175 slots over 122 hours, so
 * this floor is nowhere near the real supply.
 */
export const MIN_SLOTS_FOR_RUN =
  ((SCENARIOS_RESERVING_SLOTS - 1) * SCENARIO_MIN_GAP_MS) / SLOT_STEP_MS + 6;

export type SlotReservation =
  | { ok: true; start: string }
  | { ok: false; reason: string };

export interface SlotPlan {
  /**
   * Reserve a start at least `minGapMs` from every start already reserved or
   * recorded. `label` names the scenario, so a refusal says which one could not be
   * placed instead of just "no slot".
   */
  reserve(label: string): SlotReservation;
  /**
   * Record the instant a booking ACTUALLY landed on (the response's `startsAt`),
   * which may differ from the slot reserved.
   *
   * An unreadable stamp is recorded as unreadable rather than dropped, and makes
   * every later reservation refuse: continuing would mean placing slots around a
   * booking whose position is unknown, which is the collision this exists to stop.
   */
  record(startIso: string): void;
  /** Every readable instant the plan is currently avoiding, for a log line. */
  taken(): string[];
}

/** Minutes, for a reason string a human reads mid-incident. */
function mins(ms: number): string {
  return `${Math.round(ms / 60_000)} min`;
}

export function createSlotPlan(
  slots: string[],
  minGapMs: number = SCENARIO_MIN_GAP_MS,
): SlotPlan {
  const takenMs: number[] = [];
  let unreadable: string | null = null;

  const clears = (ms: number): boolean =>
    takenMs.every((t) => Math.abs(ms - t) >= minGapMs);

  return {
    reserve(label: string): SlotReservation {
      if (unreadable !== null) {
        return {
          ok: false,
          reason:
            `cannot place ${label}: a previous booking reported an unreadable start ` +
            `(${JSON.stringify(unreadable)}), so the plan does not know which window to avoid`,
        };
      }
      if (slots.length === 0) {
        return { ok: false, reason: `cannot place ${label}: the bucket returned no open slots` };
      }

      let widest: number | null = null;
      let readable = 0;
      for (const slot of slots) {
        const ms = Date.parse(slot);
        if (!Number.isFinite(ms)) continue; // unreadable candidate, never a pick
        readable++;
        if (clears(ms)) {
          takenMs.push(ms);
          return { ok: true, start: slot };
        }
        const nearest = Math.min(...takenMs.map((t) => Math.abs(ms - t)));
        if (widest === null || nearest > widest) widest = nearest;
      }

      if (readable === 0) {
        return {
          ok: false,
          reason: `cannot place ${label}: none of the ${slots.length} slot(s) has a readable start`,
        };
      }
      return {
        ok: false,
        reason:
          `cannot place ${label}: no slot is ${mins(minGapMs)} clear of the ` +
          `${takenMs.length} already in use (widest gap on offer: ${mins(widest ?? 0)} ` +
          `across ${readable} readable slot(s))`,
      };
    },

    record(startIso: string): void {
      const ms = Date.parse(startIso);
      if (!Number.isFinite(ms)) {
        unreadable = startIso;
        return;
      }
      takenMs.push(ms);
    },

    taken(): string[] {
      return takenMs.map((ms) => new Date(ms).toISOString()).sort();
    },
  };
}
