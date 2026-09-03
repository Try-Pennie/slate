import {
  DEBT_TEAM_RUNGS,
  debtTeamBandLabel,
  debtTeamCoverage,
  debtTeamLabel,
} from "@/lib/admin/debt-team";

/**
 * An agent's debt team coverage, as the ladder it actually is (#1796).
 *
 * Dan asked for these to look nicer with some delight in them. The column was
 * printing raw database keys as a comma list, "ultra_high, very_high, high,
 * medium", which wrapped to three lines on the widest agent so row heights varied
 * down the table, and which threw away the one thing the values mean.
 *
 * WHY A SHAPE RATHER THAN TIDIER TEXT. Debt team is rungs 1 to 5 and an agent
 * covers a band of them, so scanning 136 rows for "who covers the top end" was
 * four words of decoding per row. As five ascending rungs it is one glance. That
 * is the delight and it is functional: this is a dense admin table, so the column
 * earns its place by being faster to scan, not by being decorated.
 *
 * FIXED WIDTH, so the cell is the same size for an agent with one tier and an
 * agent with five, which is the row height Dan reported.
 *
 * HEIGHT CARRIES THE RANK, not colour. Colour may never be the only signal, and
 * an ordered scale expressed as five different tints breaks the first time one
 * member is changed for an unrelated reason (L545). So there are exactly two
 * colours, covered and not.
 *
 * THE COVERED COLOUR IS `--cue-line`, NOT THE SKY ACCENT, and that is measured
 * rather than preferred. Sky against an unfilled rung is 1.18:1, so the filled
 * versus unfilled distinction, which is the entire content of the glyph, would be
 * invisible on a light page; rendered at 136 rows it reads as texture. Sky is a
 * light colour, so it cannot carry a fill distinction on a light ground. The
 * `--cue-line` token already answers exactly this question per surface (brand
 * blue on light at 3.41:1, sky on dark at 3.13:1) and is asserted in
 * scripts/test-contrast.ts.
 *
 * NO MOTION. A hundred and thirty six rows of animating rungs is noise, not
 * delight; the restraint is the craft.
 *
 * EVERY ROW CARRIES THE WORDS. The glyph is `aria-hidden` and the band is printed
 * beside it, so the shape is never the only way to learn what it means, and this
 * is an Operate surface so the words stay on screen rather than hiding in a
 * tooltip as a puzzle. The title carries the whole sentence including anything
 * off the ladder.
 */
export function DebtTeamLadder({ teams }: { teams: string[] }) {
  const coverage = debtTeamCoverage(teams);
  const band = debtTeamBandLabel(coverage);
  const whole = debtTeamLabel(coverage);

  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <span
        aria-hidden="true"
        data-ladder
        title={whole}
        className="inline-flex h-3.5 w-9 shrink-0 items-end gap-px"
      >
        {DEBT_TEAM_RUNGS.map((rank) => {
          const on = coverage.ranks.includes(rank);
          return (
            <span
              key={rank}
              data-rung={rank}
              data-covered={on ? "true" : "false"}
              // Height in an inline style rather than a utility: it is a
              // proportion of the rung count, so it belongs to the data.
              style={{ height: `${rank * 20}%` }}
              className={`flex-1 rounded-[1px] ${
                on ? "bg-[var(--cue-line)]" : "bg-[var(--border)]"
              }`}
            />
          );
        })}
      </span>
      {band ? <span className="text-xs text-fg-muted">{band}</span> : null}
      {/* A value that is not one of the five rungs is still data. Shown as
          stored, in its own chip, so it reads as a data question rather than a
          formatting bug, and never silently dropped (L113). */}
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
