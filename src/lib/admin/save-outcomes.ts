/**
 * What a settings form on an admin page says when it saves (#1990).
 *
 * ## The defect this exists to remove
 *
 * The confirmation travels as `?ok=` on a redirect and is drawn by
 * `SettingsSaveNotice`. That worked while a page held ONE form. Several of them
 * hold three or four, and the flag carried no name, so whichever form redirected
 * lit whatever sentence the page had hardcoded:
 *
 *   /admin/business-hours   saving the booking HORIZON printed "Hours saved.",
 *                           naming the hours week, which it had not touched
 *   /admin/buckets          changing the direct booking fallback confirmed,
 *                           creating or editing an actual pool did not
 *
 * The horizon one was wrong in the worse direction: not silence, but a sentence
 * naming a thing it had not done. And silence on such a page is worse than on a
 * page with no notice at all, because the page has already shown somebody that
 * it confirms saves, so the next silence reads as a failure rather than as a
 * feature nobody built.
 *
 * Not every form here uses this mechanism, and that is deliberate rather than an
 * omission. The business hours week and its date exceptions return their result
 * through `useActionState` and draw it inside their own form, which is a better
 * answer where the form is already a client component: the confirmation appears
 * where the person is looking. #1990 reported those two as silent; they are not,
 * and they are left alone.
 *
 * ## The shape
 *
 * The outcome carries the NAME of the form that saved. One vocabulary, here, so
 * an action and the page that renders its result cannot disagree about the
 * spelling: `tsc` names a key that does not exist, and the guard
 * (`scripts/test-save-outcomes.ts`) names a key nothing renders.
 *
 * A page still chooses its own WORDS, because it always did and because one of
 * them is built per render rather than fixed.
 */

/**
 * Every outcome a form can report.
 *
 * Named for the FORM rather than the page, because two forms on one page is the
 * whole reason this is a name and not a flag.
 */
export const SAVE_OUTCOMES = [
  "agent-attributes",
  "agent-ooo-calendar",
  "alerts",
  "booker-copy",
  "booking-horizon",
  "booking-reasons",
  "bucket-created",
  "bucket-routing",
  "bucket-updated",
  "org-default-hours",
  "working-hours",
] as const;

export type SaveOutcome = (typeof SAVE_OUTCOMES)[number];

/**
 * The sentence for each outcome whose wording is fixed.
 *
 * Every sentence names what was saved, never just that something was. A word
 * that appears whatever you pressed barely improves on silence, and on a page
 * with four forms it is actively misleading.
 */
export const SAVE_OUTCOME_COPY: Record<Exclude<SaveOutcome, DynamicOutcome>, string> = {
  "agent-attributes": "Routing attributes saved.",
  "agent-ooo-calendar": "Time off calendar saved.",
  alerts: "Alert settings saved.",
  "booker-copy": "Booker copy saved.",
  "booking-horizon": "Booking horizon saved.",
  "booking-reasons": "Booking reasons saved.",
  "bucket-created": "Bucket created.",
  "bucket-routing": "Bucket routing saved.",
  "bucket-updated": "Bucket saved.",
  "org-default-hours": "Default hours for a new agent saved.",
};

/**
 * The outcomes whose sentence is built by the PAGE, per render, and why.
 *
 * Declared rather than left as an absence from the copy map, so a key that
 * simply has no sentence anywhere fails the build instead of confirming a save
 * in silence, which is the defect this module exists to remove.
 */
export const DYNAMIC_OUTCOME_REASONS = {
  // #1988: it names the week that is now stored, read back from the database on
  // the render that draws it, so it reports the finished state rather than what
  // the action meant to write (L78).
  "working-hours": "names the week that was written, which is only known at render",
} as const;

export type DynamicOutcome = keyof typeof DYNAMIC_OUTCOME_REASONS;

/**
 * The outcome a `?ok=` value names, or `null`.
 *
 * A value it does not recognise is `null` rather than a default, and that is the
 * point rather than tidiness: the flag used to be `ok=1`, so a bookmarked or
 * pasted link from before this change still carries it. Resolving that to any
 * sentence would print a confirmation for a save nobody performed, on a page
 * that had just been opened. Showing nothing is the honest answer (L11).
 */
export function savedOutcome(raw: string | undefined | null): SaveOutcome | null {
  if (!raw) return null;
  return (SAVE_OUTCOMES as readonly string[]).includes(raw) ? (raw as SaveOutcome) : null;
}

/** The sentence for an outcome whose wording is fixed, or `null` when the page
 *  builds its own. Never a default: a missing sentence is a build failure, not a
 *  quiet fallback. */
export function savedSentence(outcome: SaveOutcome | null): string | null {
  if (!outcome) return null;
  if (outcome in DYNAMIC_OUTCOME_REASONS) return null;
  return SAVE_OUTCOME_COPY[outcome as Exclude<SaveOutcome, DynamicOutcome>];
}

/** The query string a saving action redirects with. One builder, so no call site
 *  hand writes the parameter name. */
export function savedQuery(outcome: SaveOutcome): string {
  return `?ok=${outcome}`;
}
