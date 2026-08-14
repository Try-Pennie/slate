// Slot-reuse resilience for the booking smoke canary.
//
// The full smoke pass books, cancels, and re-books against the isolated SMOKE
// test agents. A cancel deletes the Google event on the happy path, but per
// #166/#524 it can orphan it, and the orphan sweep that cleans that up is OFF in
// CI (no Google service-account creds on the runner: SMOKE_SKIP_EVENT_CLEANUP=1).
// Because verify-on-book reads Google LIVE at book time, a slot that just held a
// cancelled event can still read busy for a few seconds (worse under elevated
// Google latency), so re-booking it comes back 409 SLOT_TAKEN / NO_ELIGIBLE_AGENTS.
// That flaked run 30010672602 (2026-07-23) and paged.
//
// bookFirstFreeSlot books the first slot the API actually accepts, advancing past
// a transient conflict onto a fresh slot, so residue on a reused slot is skipped
// instead of failing the run.

export interface BookOutcome {
  status: number;
  body: { code?: string; outcome?: string };
}

/**
 * A 409 SLOT_TAKEN / NO_ELIGIBLE_AGENTS is a TRANSIENT slot conflict: the slot's
 * just-cancelled event may not have propagated out of Google's live freeBusy yet.
 * Retrying on a fresh slot self-heals it. A 409 `confirm_required` is the functional
 * weak-match path (and any non-409 is a real failure): neither is transient, so
 * neither is retried away.
 */
export function isTransientSlotConflict(res: BookOutcome): boolean {
  return res.status === 409 && (res.body.code === "SLOT_TAKEN" || res.body.code === "NO_ELIGIBLE_AGENTS");
}

/**
 * Separation between one attempt and the next (#1491).
 *
 * The retry used to advance to the ADJACENT slot (`startIndex + i`). Slots are
 * published every 10 minutes and the seeded event is 20, so the next slot sits
 * INSIDE the window just attempted. When the reason for the conflict is residue
 * from a just-cancelled event, retrying 10 minutes along re-reads the same busy
 * period and conflicts again, which spends the attempt budget without moving.
 *
 * One hour, matching SCENARIO_MIN_GAP_MS and CROSS_BUCKET_MIN_GAP_MS: every margin
 * in this canary is the same stated number for the same reason.
 */
export const RETRY_MIN_GAP_MS = 60 * 60 * 1000;

/**
 * Book the first slot (from `slots`, starting at `startIndex`) that `attempt`
 * accepts, advancing past a transient slot conflict onto the next slot at least
 * `minGapMs` LATER than the one just tried. Returns as soon as `attempt` yields
 * anything that is not a transient conflict (a created booking, a functional
 * `confirm_required`, or a real error) so the caller's checks still see the true
 * result. On a persistent conflict, or when the slot list runs out first, it returns
 * the LAST result so the caller fails loudly rather than looping or hanging.
 *
 * A slot whose stamp cannot be read is skipped rather than attempted: Date.parse
 * yields NaN, every comparison with NaN is false, and accepting it would silently
 * put the retry back on the adjacent slot this margin exists to avoid.
 */
export async function bookFirstFreeSlot<T extends BookOutcome>(
  slots: string[],
  startIndex: number,
  attempt: (slot: string) => Promise<T>,
  maxAttempts = 4,
  minGapMs = RETRY_MIN_GAP_MS,
): Promise<T> {
  let last: T | undefined;
  let index = startIndex;
  for (let i = 0; i < maxAttempts; i++) {
    const slot = slots[index];
    if (slot === undefined) break; // ran out of fresh slots
    last = await attempt(slot);
    if (!isTransientSlotConflict(last)) return last;

    // Advance to the next slot a full margin clear of the one just attempted.
    const triedMs = Date.parse(slot);
    let next = -1;
    for (let j = index + 1; j < slots.length; j++) {
      const ms = Date.parse(slots[j]!);
      if (!Number.isFinite(ms) || !Number.isFinite(triedMs)) continue;
      if (ms - triedMs >= minGapMs) {
        next = j;
        break;
      }
    }
    if (next === -1) break; // nothing far enough left to try
    index = next;
  }
  return last as T;
}
