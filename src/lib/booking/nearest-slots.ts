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
