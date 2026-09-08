import { Pill } from "@/components/ui/Pill";

/**
 * Whether an agent is bookable, as one pill (#1823).
 *
 * Dan, on the roster's Bookable column: "The word is redundant. the unbookable
 * ones just get a line so we should have a symbol there two with the green."
 *
 * Three things were wrong. The column is headed "Bookable" and every bookable row
 * said "Bookable", which is one fact stated twice. The negative state got a
 * hyphen, so the two states were not comparable treatments: one a pill, the other
 * a placeholder, which reads as an absence rather than as a value. And the agent
 * detail page already had a treatment for the same fact, so the roster was a
 * third one nobody had reconciled.
 *
 * ONE COMPONENT, TWO WORDINGS. The variant and the mark are decided here, so the
 * two screens cannot drift; what differs is only the words, and it differs for a
 * reason. In a table the column header already asks the question, so the value is
 * Yes or No. On the agent detail page nothing else names the fact, so the pill
 * carries the noun.
 *
 * THREE SIGNALS, NOT ONE. Colour may never be the only difference, so the states
 * differ by word, by fill (a wash against a plain outline) and by mark shape (a
 * filled disc against a ring).
 *
 * THE FILLED MARK USES `--pennie-green-mark`, the one green legible with no word
 * beside it. The palette green is 1.82:1 on the wash it would sit on and the
 * deepest is 2.45:1, so neither can be a mark; this one measures 3.32:1 there
 * (#1822). The wash is theme independent, which is what makes the dot safe in
 * both themes.
 *
 * NO IS NEUTRAL, NOT AN ERROR. Most of the roster is not bookable today, so a
 * rose treatment would put thirty four rows of alarm on a screen where nothing is
 * wrong. A plain outline pill, which is what the detail page already used.
 *
 * In `components/ui` rather than `components/admin` because the agent's own
 * availability page uses it too, and the whole point is that there is one of it.
 */
/**
 * The three wordings. Only the WORDS vary between surfaces; the variant and the
 * mark below are one decision, which is what stops three screens describing the
 * same fact three ways.
 *
 * "self" says "yet" because the reader is the agent looking at their own page and
 * the state is one they are working towards, not a verdict on them.
 */
const LABELS: Record<"short" | "full" | "self", { yes: string; no: string }> = {
  short: { yes: "Yes", no: "No" },
  full: { yes: "Bookable", no: "Not bookable" },
  self: { yes: "Bookable", no: "Not bookable yet" },
};

export function BookablePill({
  bookable,
  wording,
  alignToColumn,
}: {
  bookable: boolean;
  /**
   * "short" where a column header already asks the question, "full" where
   * nothing else names the fact, "self" where the reader IS the agent.
   */
  wording: "short" | "full" | "self";
  /** Set when this starts a table cell, so the word lines up with the header. */
  alignToColumn?: boolean;
}) {
  const label = LABELS[wording][bookable ? "yes" : "no"];

  return (
    <Pill
      variant={bookable ? "status-ok" : "outline"}
      alignToColumn={alignToColumn}
      // #2081: through `mark` rather than as a child, because the pill centres
      // the two differently. The mark belongs on the pill's own centre; the word
      // has to be centred on its letters, which sit above the centre of their
      // line box. Passed as a child it would ride along with the label's nudge
      // and the pair would still disagree.
      mark={
        <span
          aria-hidden="true"
          data-bookable-mark={bookable ? "filled" : "hollow"}
          // A filled disc against a ring, so the shapes differ and the distinction
          // does not rest on the tone. The ring is drawn with a border rather than
          // a fill, which is what makes it hollow at 8px.
          className={
            bookable
              ? "h-2 w-2 shrink-0 rounded-full bg-[var(--pennie-green-mark)]"
              : "h-2 w-2 shrink-0 rounded-full border-[1.5px] border-[var(--fg-muted)]"
          }
        />
      }
    >
      {label}
    </Pill>
  );
}
