import {
  DEBT_TEAM_RUNGS,
  debtTeamCoverage,
  debtTeamLabel,
  debtTeamRungLabel,
  debtTeamRungLetter,
} from "@/lib/admin/debt-team";

/**
 * An agent's debt team coverage as five ledger letters (#1812).
 *
 * Dan, on the glyph this replaces: "I hate the change made to the teams." Three
 * things were wrong with it, and the first came from the spec rather than the
 * build.
 *
 * THE MARKS REPEATED THE WORDS BESIDE THEM. #1796 specced a drawn scale AND its
 * own caption in the same cell, so every row said the same thing twice; the eye
 * reads the words and the bars become noise. A mark next to its own caption
 * cannot earn its place, so the sentence is gone from the column and lives only
 * in the accessible name.
 *
 * THE ASCENDING HEIGHTS MADE THE COMMONEST CASE THE FAINTEST. Rungs rose left to
 * right and most of the roster covers Low only, so the majority of rows drew the
 * smallest possible mark. Letters are all the same size.
 *
 * PER ROW BARS SHARE NO AXIS, so nothing could be compared down the column, which
 * was the entire argument for drawing it rather than writing it. Five letters in
 * fixed, equal width positions align exactly down every row, which is the
 * comparison the bars could not do.
 *
 * The letters are their own legend, so the column needs no key: L M H V U reads
 * as the ladder it is. They are DERIVED from the tier names rather than written
 * out beside the table, which is what keeps them from drifting, and
 * `scripts/test-ledger-letters.ts` is what keeps that safe rather than lucky: two
 * tiers sharing an initial would draw two identical positions with nothing
 * failing (#1817). V and U are the two that are not obvious, and their
 * expansion lives ONCE on the column header rather than on every row.
 *
 * TWO SIGNALS SEPARATE COVERED FROM UNCOVERED: weight and tone, both measured
 * rather than eyeballed (`--ledger-on` / `--ledger-off`, asserted surface by
 * surface in scripts/test-contrast.ts). Case USED to be a third, and it is gone
 * (#1832): weight already satisfies the rule that colour may never be the only
 * signal, so case was doing nothing the second signal was not, and it cost real
 * legibility, because changing case changes the GLYPH and a letter then reads as
 * a different letter rather than as the same one turned down. Lowercase "l" was
 * the worst of them, being nearly a vertical bar beside four letters that are
 * not.
 *
 * THE FAINT LETTERS ARE NOT LABELS, and an earlier version of this docstring said
 * they were (#1830). The covered letters label themselves: three dark letters
 * reading M H V say Medium, High, Very High directly, and a lone dark L says Low,
 * so nothing is ever counted. What the faint ones carry is the five slot rhythm,
 * so rows align and the cell width never varies, plus a sense of the scale's
 * extent. That needs them PERCEPTIBLE rather than legible, which is a far lower
 * bar and carries no 3:1 obligation; claiming otherwise is what put a floor on
 * them that the design could not meet.
 *
 * Sky is deliberately absent: it is the only colour that may mean "do this", and
 * a data mark is not an action.
 *
 * NO MOTION, and nothing per row that varies in size, so 136 of these stay calm.
 */

/**
 * What L M H V U stand for, for the column header. Built from `DEBT_TIER` so it
 * cannot drift from the letters, and stated ONCE rather than per row.
 */
export const LEDGER_LEGEND = DEBT_TEAM_RUNGS.map(
  (rank) => `${debtTeamRungLetter(rank)} ${debtTeamRungLabel(rank)}`,
).join(", ");

export function DebtTeamLedger({ teams }: { teams: string[] }) {
  const coverage = debtTeamCoverage(teams);

  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      {/* `role="img"` with a label is the pattern for a graphic made of text: it
          names the whole thing and hides its parts. The label CANNOT go on an
          aria-hidden element, or it goes away with it, so the letters carry the
          hiding and this carries the name. */}
      <span
        data-ledger
        role="img"
        aria-label={debtTeamLabel(coverage)}
        className="inline-flex shrink-0 text-xs"
      >
        {DEBT_TEAM_RUNGS.map((rank) => {
          const on = coverage.ranks.includes(rank);
          const letter = debtTeamRungLetter(rank);
          return (
            <span
              key={rank}
              aria-hidden="true"
              data-rung={rank}
              data-covered={on ? "true" : "false"}
              // Equal width boxes, because letters are not equal width in a
              // proportional face and the vertical alignment is the point.
              className={`inline-block w-3 text-center ${
                on
                  ? "font-semibold text-[var(--ledger-on)]"
                  : "font-normal text-[var(--ledger-off)]"
              }`}
            >
              {letter}
            </span>
          );
        })}
      </span>
      {/* A value that is not one of the five rungs has no position, and dropping
          it would under report that agent on the screen that exists to show it
          (L113). Shown as stored, so it reads as a data question. */}
      {coverage.offLadder.map((value) => (
        <span
          key={value}
          className="rounded-[4px] border border-border px-1.5 py-px text-[11px] text-fg-muted"
        >
          {value}
        </span>
      ))}
    </span>
  );
}
