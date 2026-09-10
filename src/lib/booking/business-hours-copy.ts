/**
 * What the business hours page says a save DID (#2219).
 *
 * Pure, and holding no `@/` imports beyond Luxon and the shared date formatter,
 * for the same reason `booker-copy.ts` does: copy lives in a builder a test and a
 * preview can call, never inline in the component, because a sentence nobody can
 * render is a sentence nobody reads before it ships (#1153, #1343). The admin
 * screens have no preview yet; #2223 is where that goes, and these builders are
 * what it will render.
 *
 * The defect this exists to end: one sentence, "Saved. Leads see that date
 * straight away.", was rendered over BOTH outcomes of the date form. A closed
 * date is exactly the one leads do not see, so the confirmation asserted the
 * opposite of what had just happened, on the commonest path (closed is the
 * component's default, because a holiday is the usual reason to add a date). An
 * action has to say what it did, and two outcomes cannot share one claim
 * (L11, L608).
 */
import { DateTime } from "luxon";
import { formatLongDate } from "../date/parse.ts";

/**
 * The date as the person who typed it reads it, falling back to what is stored
 * rather than to a blank: a value the formatter cannot read is shown as itself,
 * so it can be recognised and removed rather than silently disappearing from its
 * own confirmation (L67).
 */
function readableDate(onDate: string): string {
  return formatLongDate(DateTime.fromISO(onDate), { year: true }) ?? onDate;
}

/**
 * The notice after a date exception saves, derived from what was written.
 *
 * It says which date and which of the two states, and stops. The obvious fix for
 * the wrong sentence was a longer right one, explaining that a closed date is
 * offered to nobody, and that is already the second paragraph of the card this
 * form sits in, so it would have put one fact on the screen twice (L605). The
 * times are on the row below and the appointment count was on the confirm step,
 * for the same reason.
 */
export function exceptionSavedMessage(saved: { onDate: string; isOpen: boolean }): string {
  const date = readableDate(saved.onDate);
  return saved.isOpen
    ? `Saved. Pennie is open on ${date}.`
    : `Saved. Pennie is closed on ${date}.`;
}

/**
 * The notice after the weekly pattern saves.
 *
 * "Leads see the new hours straight away" was wrong the same way one rung down. A
 * lead never sees the hours; they are offered times inside them, and the
 * commonest edit NARROWS a week, where what changes is that fewer times appear.
 * Immediacy is left out because the card above already says a change applies to
 * everyone straight away.
 */
export const HOURS_SAVED_MESSAGE =
  "Saved. Leads are only offered times inside the new hours.";
