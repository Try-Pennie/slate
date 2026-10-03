/**
 * The version an edit form was drawn from (#3122).
 *
 * The event type editors and the working hours forms used to write with no
 * version check, so two people editing the same record at once silently
 * overwrote each other: the second save won and the first person was told their
 * change had saved. Each form now carries the row's `updated_at` as it was when
 * the page was drawn, and the write lands only while the row still holds it.
 *
 * Three states, kept apart because they mean different things to the person
 * reading the refusal:
 *
 *   - `missing`: the form sent no version at all. It was drawn by code from
 *     before this field existed, so nothing can say whether the record moved;
 *     the save is refused as out of date rather than allowed blind.
 *   - `loaded` with a stamp: the row's version when the page was drawn.
 *   - `loaded` with null: the page was drawn with NO row (an agent with no
 *     schedule yet), so a row that has appeared since is a change too.
 *
 * No `@/` imports, so the node suite reads it directly.
 */

/** The hidden field every guarded form carries. */
export const LOADED_VERSION_FIELD = "loaded_updated_at";

export type LoadedVersion = { kind: "missing" } | { kind: "loaded"; stamp: string | null };

/** What a form submitted. An empty value is "drawn with no row", never "missing". */
export function loadedVersionFrom(form: FormData): LoadedVersion {
  const raw = form.get(LOADED_VERSION_FIELD);
  if (typeof raw !== "string") return { kind: "missing" };
  const stamp = raw.trim();
  return { kind: "loaded", stamp: stamp === "" ? null : stamp };
}

/**
 * The stamp of a record that always exists when its form is drawn (an event type):
 * null when the form sent none, or an empty one, since either way nothing says
 * which version the person was looking at and the save must be refused.
 */
export function loadedStampOfExistingRow(form: FormData): string | null {
  const v = loadedVersionFrom(form);
  return v.kind === "loaded" ? v.stamp : null;
}

/** The value a form renders into the hidden field: the stamp, or empty for no row. */
export function loadedVersionValue(stamp: string | null | undefined): string {
  return stamp ?? "";
}

/** Somebody saved this record after the page was opened. Nothing was saved. */
export const CHANGED_SINCE_OPENED =
  "Someone saved a change here after you opened this page, so yours was not saved. Reload the page to see the current version, then make your change again.";

/** The form carried no version, so whether the record moved cannot be told. */
export const PAGE_OUT_OF_DATE =
  "This page is out of date, so your change was not saved. Reload the page and make your change again.";
