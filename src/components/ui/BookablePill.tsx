import { Pill } from "@/components/ui/Pill";
import {
  BOOKABLE_STATE_TEXT,
  bookableStateOf,
  type BookableState,
} from "@/lib/bookable/bookable-state";

/**
 * Whether an agent is bookable, as one pill (#1823), in one of three states
 * (#3030): bookable, not bookable, and held back on Redistribute.
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
 * ONE COMPONENT, THREE WORDINGS. The variant and the mark are decided here, so
 * the screens cannot drift; what differs is only the words, and it differs for a
 * reason. In a table the column header already asks the question, so the value is
 * Yes or No. On the agent detail page nothing else names the fact, so the pill
 * carries the noun. On the agent's own page the reader is the agent. The words
 * live in `BOOKABLE_STATE_TEXT`, beside the list of states the roster's filter
 * enumerates too, so a picker and a cell cannot name a state two ways.
 *
 * THREE SIGNALS, NOT ONE. Colour may never be the only difference, so the states
 * differ by word, by fill (a wash against a plain outline) and by mark shape: a
 * filled disc for bookable, a solid ring for not bookable, and a DASHED ring for
 * somebody the hourly Twilio sync holds back because their worker carries the
 * Redistribute tag.
 *
 * REDISTRIBUTE IS A KIND OF NO, SO IT LOOKS LIKE ONE (#3030, settled in a design
 * round with Dan, 2026-10-02). A Redistribute advisor is deliberately off booked
 * calls and comes back when the tag comes off in Twilio, while a genuinely
 * unbookable one needs setting up, calendar access or a decision, so a manager
 * has to be able to tell them apart. The pill keeps the same outline and the same
 * muted 1.5px ring, and differs by its WORD and by the ring being DASHED, so word
 * and shape both differ and colour is not the signal. Rejected in that round: a
 * No pill with a muted Redistribute word beside it, and a dashed ring alone. It
 * is asked only of somebody out of the pool, so a bookable advisor never shows it,
 * and the caller decides it with the same predicate the console's refusal uses.
 *
 * THE FILLED MARK USES `--pennie-green-mark`, the one green legible with no word
 * beside it. The palette green is 1.82:1 on the wash it would sit on and the
 * deepest is 2.45:1, so neither can be a mark; this one measures 3.32:1 there
 * (#1822). The wash is theme independent, which is what makes the dot safe in
 * both themes.
 *
 * NO IS NEUTRAL, NOT AN ERROR, and neither is Redistribute. Most of the roster is
 * not bookable today, so a rose treatment would put thirty four rows of alarm on
 * a screen where nothing is wrong. A plain outline pill, which is what the detail
 * page already used.
 *
 * In `components/ui` rather than `components/admin` because the agent's own
 * availability page uses it too, and the whole point is that there is one of it.
 */

/**
 * One mark per state. A filled disc against a ring, so the shapes differ and the
 * distinction does not rest on the tone. The ring is drawn with a border rather
 * than a fill, which is what makes it hollow at 8px; the Redistribute ring is the
 * same border dashed, in the same tone and weight.
 */
const RING = "h-2 w-2 shrink-0 rounded-full border-[1.5px] border-[var(--fg-muted)]";
const MARK: Record<BookableState, { name: string; className: string }> = {
  yes: { name: "filled", className: "h-2 w-2 shrink-0 rounded-full bg-[var(--pennie-green-mark)]" },
  no: { name: "hollow", className: RING },
  redistribute: { name: "dashed", className: `${RING} border-dashed` },
};

export function BookablePill({
  bookable,
  heldByTwilio = false,
  wording,
  alignToColumn,
}: {
  bookable: boolean;
  /**
   * True when the hourly Twilio sync holds this person out of the pool. Compute
   * it with `heldByTwilio` from `@/lib/bookable/bookable-state`, the predicate
   * the console's refusal uses. Ignored when `bookable` is true.
   */
  heldByTwilio?: boolean;
  /**
   * "short" where a column header already asks the question, "full" where
   * nothing else names the fact, "self" where the reader IS the agent.
   */
  wording: "short" | "full" | "self";
  /** Set when this starts a table cell, so the word lines up with the header. */
  alignToColumn?: boolean;
}) {
  const state = bookableStateOf(bookable, heldByTwilio);

  return (
    <Pill
      variant={state === "yes" ? "status-ok" : "outline"}
      alignToColumn={alignToColumn}
      // #2081: through `mark` rather than as a child, because the pill centres
      // the two differently. The mark belongs on the pill's own centre; the word
      // has to be centred on its letters, which sit above the centre of their
      // line box. Passed as a child it would ride along with the label's nudge
      // and the pair would still disagree.
      mark={<span aria-hidden="true" data-bookable-mark={MARK[state].name} className={MARK[state].className} />}
    >
      {BOOKABLE_STATE_TEXT[wording][state]}
    </Pill>
  );
}
