/**
 * What each cell of the availability grid SAYS (#1302).
 *
 * Lifted out of the page for the same reason the alert and booker copy is
 * (#1153, #1343): a string a person reads is a contract, and one living inline
 * in markup cannot be read by anything except a browser. Here it is also the
 * only thing a screen reader gets, because the grid's visible content is a
 * single letter per cell.
 *
 * The letters exist because colour is never the sole signal. Six treatments in
 * one table would otherwise be six shades somebody has to hold in their head,
 * and a colourblind reader would get four of them as the same grey.
 *
 * PURE, so `scripts/test-availability-grid.ts` and the component test drive the
 * real wording rather than a second copy of it (L41).
 */
import type { GridCell } from "./availability-grid.ts";

export interface CellTreatment {
  kind: GridCell["kind"];
  /** The letter in the cell. Empty for closed, which is an absence, not a state. */
  mark: string;
  /** The legend's name for it. */
  label: string;
  /** The legend's one-line explanation, in a reader's terms. */
  meaning: string;
  /**
   * How the counts strip above the grid names this state, which reads as part of
   * a sentence ("2 with nobody rostered") where `label` reads as a name
   * ("Nobody rostered") (#1928).
   *
   * Both forms live here because the strip and the key are derived from THIS
   * list now, and there used to be two hand maintained lists of the same seven
   * states with different words, a different order, and two kinds missing from
   * the strip entirely. One of the two it omitted was `unknown`, the
   * could-not-measure state, so a grid whose hours could not be read said
   * nothing about them in the summary somebody reads first.
   */
  strip: string;
  /**
   * Whether a non zero count of this state is worth drawing attention to in the
   * strip. On the record rather than in the strip's markup, or deriving the
   * strip would silently drop it.
   */
  urgent?: true;
  /**
   * The cell's classes. The legend swatch reuses them, so a colour can never be
   * right in the grid and wrong in the key that explains it.
   */
  cell: string;
  /** Extra classes the swatch needs to be visible when the cell has no fill. */
  swatchExtra?: string;
}

/**
 * Ordered most to least actionable, which is also the order somebody scans a key
 * in, and the order the counts strip runs in (#1928). Every fill is opaque where
 * it carries a letter, so its contrast is fixed by the two brand colours rather
 * than by whatever the theme paints behind it.
 *
 * The `meaning` sentences are deliberately short (#1925). `Could not check` is
 * the one that keeps its length: shortening it to something like "Not measured"
 * loses the distinction between "we looked and there was nothing" and "we could
 * not look", which is the whole reason that state exists.
 */
export const CELL_TREATMENTS: CellTreatment[] = [
  {
    kind: "open",
    mark: "O",
    label: "Bookable",
    meaning: "On shift, and times are available.",
    strip: "bookable hours",
    cell: "bg-pennie-sky text-pennie-graphite",
  },
  {
    kind: "booked",
    mark: "F",
    label: "Full",
    meaning: "On shift, every time taken.",
    strip: "staffed but full",
    cell: "bg-pennie-yellow text-pennie-graphite",
  },
  {
    kind: "unrostered",
    mark: "N",
    label: "Nobody rostered",
    meaning: "Open, but nobody is scheduled.",
    strip: "with nobody rostered",
    urgent: true,
    cell: "bg-error/25 text-fg",
  },
  {
    kind: "away",
    mark: "A",
    label: "Away",
    meaning: "Open, everyone scheduled is off.",
    strip: "with everyone away",
    cell: "bg-[var(--pennie-yellow-2)] text-pennie-graphite",
  },
  {
    kind: "beyond-horizon",
    mark: "H",
    label: "Past the horizon",
    meaning: "Too far ahead to offer yet.",
    strip: "past the horizon",
    cell: "bg-[var(--bg-alt)] text-fg-muted",
    swatchExtra: "border border-border",
  },
  {
    kind: "closed",
    mark: "",
    label: "Closed",
    meaning: "Not open.",
    strip: "closed",
    cell: "bg-transparent text-fg-muted/50",
    swatchExtra: "border border-border",
  },
  {
    kind: "unknown",
    mark: "?",
    label: "Could not check",
    meaning: "The roster could not be read, so this was not measured.",
    strip: "that could not be checked",
    cell: "bg-transparent text-fg-muted",
    swatchExtra: "border border-dashed border-border",
  },
];

export const treatmentFor = (kind: GridCell["kind"]): CellTreatment =>
  CELL_TREATMENTS.find((t) => t.kind === kind) ?? CELL_TREATMENTS[CELL_TREATMENTS.length - 1];

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The sentence a cell says on hover and to a screen reader.
 *
 * It states the counts where they were MEASURED, because the count is what turns
 * "full" into a decision about whether to staff more or to accept it, and it
 * states no count at all where nothing was measured, which is the whole
 * distinction the grid exists to make.
 */
export function cellTitle(cell: GridCell, dayLabel: string, hour: number): string {
  const when = `${dayLabel} at ${String(hour).padStart(2, "0")}:00`;
  switch (cell.kind) {
    case "open":
      return `${when}: bookable. ${plural(cell.agents, "agent", "agents")} on shift, ${plural(cell.buckets, "pool", "pools")} offering a time.`;
    case "booked":
      return `${when}: full. ${plural(cell.agents, "agent", "agents")} on shift and no pool has a time left.`;
    case "unrostered":
      return `${when}: nobody rostered. The org is open and no bookable agent is scheduled.`;
    case "away":
      return `${when}: everyone scheduled is away. ${plural(cell.away, "agent is", "agents are")} on approved time off.`;
    case "beyond-horizon":
      return `${when}: past the booking horizon. ${plural(cell.agents, "agent is", "agents are")} on shift, and times are not offered this far ahead yet.`;
    case "closed":
      return cell.note === null
        ? `${when}: the org is closed.`
        : `${when}: the org is closed (${cell.note}).`;
    case "unknown":
      return `${when}: could not be checked, because the roster could not be read.`;
  }
}
