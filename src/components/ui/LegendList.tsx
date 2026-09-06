/**
 * A key: one row per treatment, in ONE column, with its parts aligned (#1925).
 *
 * Dan: "The key is also too hard to read. Let's make it a single column and try
 * for fewer words where possible."
 *
 * THE LAYOUT WAS THE PROBLEM, not the wording. Both keys were a wrapping flow
 * row (`flex flex-wrap gap-x-6`), so the two columns anybody sees are an
 * accident of where entries of different lengths happen to wrap: each entry
 * begins wherever the sentence to its left ended, so nothing lines up on any
 * line and the eye has no column to follow. Same defect as #1891 in a different
 * place, recorded as L578.
 *
 * A three track grid, so the swatches, the labels and the sentences each start
 * at one x down the whole key. `items-start` because a sentence that wraps must
 * not drag its swatch down with it.
 *
 * ONE COMPONENT for both keys, deliberately. `/admin/availability` and
 * `/admin/bucket-availability` carried this markup character for character, and
 * fixing one and leaving the other is exactly how the two drift.
 */
export interface LegendEntry {
  /** Its own id, since two entries can describe one underlying kind. */
  id: string;
  /** The letter in the swatch. Empty is legitimate: a closed cell is an absence. */
  mark: string;
  /** The bold name. */
  label: string;
  /** The sentence after it. */
  meaning: string;
  /** The cell's own classes, so a tint cannot be right in the table and wrong
   *  in the key that explains it. */
  cell: string;
  /** Extra classes a swatch needs to be visible when it has no fill. */
  swatchExtra?: string;
}

export function LegendList({
  entries,
  swatchCls = "h-4 w-4",
}: {
  entries: LegendEntry[];
  /**
   * The swatch's size, which differs between the two keys: the grid's marks are
   * single letters and the supply key's are percentages. Passed rather than
   * guessed, and the track below sizes to it, so every swatch in ONE key is the
   * same width and the labels still line up.
   */
  swatchCls?: string;
}) {
  // Nothing to explain means no key at all, rather than an empty bordered box
  // sitting under a table that is itself empty and already says so.
  if (entries.length === 0) return null;

  return (
    // ONE grid on the list, with each row taking its tracks through `subgrid`.
    // A grid per ROW sizes its own `auto` track to its own label, so every
    // sentence starts at a different x and the key is a column in name only:
    // measured that way it gave five rows five different sentence positions.
    // Shared tracks are what make the labels and the sentences each line up down
    // the page, which is the whole fix (L578).
    <ul className="mt-4 grid grid-cols-[auto_auto_1fr] gap-x-2 gap-y-1.5 text-xs text-fg-muted">
      {entries.map((e) => (
        <li key={e.id} className="col-span-3 grid grid-cols-subgrid items-start">
          <span
            aria-hidden="true"
            className={`mt-px flex ${swatchCls} shrink-0 items-center justify-center rounded text-[10px] leading-none font-semibold tabular-nums ${e.cell} ${e.swatchExtra ?? ""}`}
          >
            {e.mark}
          </span>
          {/* The label and the sentence are separate tracks, so every sentence
              starts at one x however long the labels are. Both are read: the
              label names the state and the sentence says what it means, so the
              shortening happens in the sentence rather than by folding it into
              the label. */}
          <span className="font-semibold text-fg">{e.label}</span>
          <span>{e.meaning}</span>
        </li>
      ))}
    </ul>
  );
}
