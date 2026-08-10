/**
 * Finding the first bookable days on the far side of a closure (#1329, #1339).
 *
 * The ordinary availability search is bounded for cost: recompute is roughly
 * super-linear in the window and every bucket pays it on every pass, which is why
 * `MAX_CLOSED_RUN_DAYS` buys a closed weekend and no more (#1326). So during a
 * genuinely long closure the honest answer is "nothing", and a lead is left with
 * no idea when to come back.
 *
 * This is the way through, and it is deliberately NOT part of the cached path: it
 * runs only for a lead who asks, so the cost is paid by the few who arrive during
 * a shutdown rather than by every bucket on every recompute pass.
 *
 * ## Why it walks in chunks rather than computing one long window
 *
 * A single 60 day compute for one bucket is the kind of request that meets the
 * Worker CPU ceiling, and it would pay for the whole lookahead even when the answer
 * sits three days in. Walking forward in short windows stops at the first chunk
 * that yields enough days, so a two week shutdown costs a few cheap computes and
 * the common case costs one. The cap is what keeps an indefinitely dark roster
 * (today's state, #1272) from turning one lead's click into an unbounded bill.
 *
 * Pure (luxon only, no `@/` imports) so the node suite drives the walk directly.
 */
import { DateTime } from "luxon";

/** Days per probe. A week at a time: long enough to clear a weekend plus a
 *  holiday in one go, short enough that a single compute stays cheap. */
export const PROBE_WINDOW_DAYS = 7;

/**
 * How far ahead we are willing to look at all.
 *
 * Eight weeks. A Christmas shutdown is under two, so this clears every real
 * closure with room to spare, and beyond it the honest answer is that we cannot
 * say rather than a bigger bill on a request a lead is waiting on. It also bounds
 * the walk when NOTHING is bookable for reasons other than a closure, which is the
 * live state while the routing pool is off.
 */
export const MAX_LOOKAHEAD_DAYS = 56;

/** One window to compute, as ISO instants. */
export interface Probe {
  fromIso: string;
  toIso: string;
}

/**
 * The windows to try, in order, starting the day after the ordinary search gave
 * up. Bounded by `MAX_LOOKAHEAD_DAYS`; the caller stops as soon as a probe yields
 * enough bookable days, so the later entries are usually never computed.
 *
 * `searchedThroughDay` is the last day the ordinary search already covered, so the
 * walk never re-computes ground that came back empty.
 */
export function probeWindows(input: {
  searchedThroughDay: string;
  zone: string;
}): Probe[] {
  const start = DateTime.fromISO(input.searchedThroughDay, { zone: input.zone });
  if (!start.isValid) return [];
  const probes: Probe[] = [];
  for (let offset = 1; offset <= MAX_LOOKAHEAD_DAYS; offset += PROBE_WINDOW_DAYS) {
    const from = start.plus({ days: offset }).startOf("day");
    const spanEnd = Math.min(offset + PROBE_WINDOW_DAYS - 1, MAX_LOOKAHEAD_DAYS);
    const to = start.plus({ days: spanEnd }).endOf("day");
    const fromIso = from.toUTC().toISO();
    const toIso = to.toUTC().toISO();
    if (fromIso && toIso) probes.push({ fromIso, toIso });
  }
  return probes;
}

/**
 * Walk the probes until `wantDays` distinct bookable days have been found, and
 * return every slot on those days.
 *
 * Returns what it HAS when the lookahead runs out, including nothing. Fewer days
 * than asked for is the honest answer during an open ended closure, and inventing
 * or padding would be a promise about times nobody can book.
 *
 * `compute` is injected so the walk is tested without any IO, and so the caller
 * owns the uncached compute (this must never write the slot cache: the days it
 * finds lie outside the horizon every other reader is keyed on).
 */
export async function findNextAvailableSlots(input: {
  probes: Probe[];
  wantDays: number;
  zone: string;
  compute: (probe: Probe) => Promise<string[]>;
}): Promise<string[]> {
  if (input.wantDays <= 0) return [];
  const byDay = new Map<string, string[]>();

  for (const probe of input.probes) {
    const slots = await input.compute(probe);
    for (const iso of slots) {
      const day = DateTime.fromISO(iso).setZone(input.zone).toISODate();
      if (!day) continue;
      const existing = byDay.get(day);
      if (existing) existing.push(iso);
      else byDay.set(day, [iso]);
    }
    // Stop at the first probe that has taken us to enough days. Checked AFTER the
    // whole probe is folded in, so a day split across a probe boundary is complete.
    if (byDay.size >= input.wantDays) break;
  }

  const days = [...byDay.keys()].sort().slice(0, input.wantDays);
  return days
    .flatMap((day) => byDay.get(day) ?? [])
    .sort((a, b) => Date.parse(a) - Date.parse(b));
}
