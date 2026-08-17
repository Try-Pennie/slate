import { parseStampMs } from "@/lib/date/stamp";

/**
 * The soonest times to offer a lead whose confirm was refused (#1319).
 *
 * A refusal at confirm is not rare by design: the booker reads a cached availability index and
 * the only live check happens at confirm, so the gap between what was shown and what is true is
 * closed at exactly that step. The lead has already filled in every field and pressed the final
 * button, and answering with a refusal and nothing else is where an otherwise willing customer
 * gives up.
 *
 * The honest error stays and these go BENEATH it (L10: an error state and an empty state are
 * different screens, and the explanation must not be replaced by the alternatives).
 */

/**
 * How many alternatives to show. A handful: enough to be a real choice, few enough to scan
 * under an error message on a phone without becoming a second picker.
 */
export const NEAREST_SLOT_COUNT = 3;

/**
 * The soonest `count` free times, ascending, excluding the one that was just refused.
 *
 * Sorted here rather than trusted from the caller. The availability API returns times in
 * order today, but a caller merging lists or reading them back out of a day grouping would
 * not, and the failure mode is offering the LATEST times at the exact moment the lead wants
 * the soonest, which looks like the product working.
 *
 * `refused` is excluded because it is the one time we KNOW is gone. Offering it back is the
 * dead end this exists to remove, wearing a helpful face.
 *
 * An unreadable value is dropped rather than kept: `Date.parse` yields NaN, every comparison
 * with NaN is false, and a NaN would sort unpredictably and could be offered first (L50).
 */
export function nearestSlots(
  slots: string[],
  count: number = NEAREST_SLOT_COUNT,
  refused?: string | null,
): string[] {
  if (count <= 0) return [];
  const seen = new Set<string>();
  const readable: { iso: string; ms: number }[] = [];
  for (const iso of slots) {
    if (iso === refused) continue;
    if (seen.has(iso)) continue;
    const ms = parseStampMs(iso);
    if (ms === null) continue;
    seen.add(iso);
    readable.push({ iso, ms });
  }
  readable.sort((a, b) => a.ms - b.ms);
  return readable.slice(0, count).map((s) => s.iso);
}

/**
 * The refusal reasons the reschedule endpoint answers with that mean "that time is not
 * available", and so are the ones the alternatives above belong under (#1549).
 *
 * Held as a set rather than tested inline because both lead-facing surfaces that move an
 * existing call (the manage page, and the booker's offer to move the call a lead already
 * has) go through the same endpoint and must answer a refusal the same way.
 */
const RESCHEDULE_TIME_GONE_REASONS: ReadonlySet<string> = new Set([
  "reschedule_slot_taken",
  "reschedule_no_eligible_agents",
]);

/**
 * Whether a refused reschedule should offer the soonest times still open (#1549).
 *
 * The endpoint answers 409 for two different things and they need opposite responses. A time
 * that went while the lead was deciding is exactly what the alternatives are for. A booking
 * that MOVED under them (`reschedule_conflict`, #439) is not: the page is still showing a time
 * that is no longer the booking's, so offering to move it from that stale view walks them into
 * the same refusal again, wearing a helpful face. The honest answer there is to refresh, and it
 * has to stand alone.
 *
 * The status cannot tell those apart, and branching on the message text would make the copy
 * load-bearing (L35). So the route names its reason and this is the only judge of it.
 *
 * An unnamed or unrecognised reason offers nothing. The route and this client ship in one
 * Worker, so a missing reason is a shape we do not recognise rather than an older deploy;
 * withholding leaves the honest error, which is today's behaviour, where guessing could show
 * the misleading panel above.
 */
export function rescheduleOffersAlternatives(
  status: number,
  reason?: string | null,
): boolean {
  if (status !== 409) return false;
  return reason != null && RESCHEDULE_TIME_GONE_REASONS.has(reason);
}
