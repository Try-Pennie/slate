/**
 * The version an edit form was drawn from (#3122).
 *
 * The event type editors and the working hours forms used to write with no
 * version check, so two people editing the same record at once silently
 * overwrote each other: the second save won and the first person was told their
 * change had saved. Each form now carries the row's `updated_at` as it was when
 * the page was drawn, and the write lands only while the row still holds it.
 *
 * That record stamp is right only where one form saves the record's whole
 * subject, as the working hours form does with the week. The event type editors
 * each save one field of a shared row, so they carry their fields' loaded values
 * instead (`loadedFieldsFrom` below, #3798).
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

/** The hidden field a form guarded on the record's version carries. */
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
 * The value one field held when its form was drawn (#3798, L776).
 *
 * A record whose fields are edited by SEPARATE forms (an event type: the gap and
 * the notice on one page, the description on another) must not judge a conflict
 * by the record's `updated_at`: any save of any field moves it, so every other open
 * form was refused over a field nobody touched. Each such form carries the loaded
 * value of each field it saves instead, and the save is refused only when one of
 * THOSE fields moved.
 *
 * JSON, so the value comes back exactly as it was drawn: a number stays a number,
 * a null stays a null rather than turning into "", and a description's line breaks
 * are not rewritten by the browser's form encoding, which would turn every
 * multi paragraph description into a false conflict.
 */
export type LoadedFieldValue = string | number | null;

/** The hidden field carrying one field's loaded value. */
export function loadedFieldName(field: string): string {
  return `loaded_${field}`;
}

/** What a form renders into that hidden field. */
export function loadedFieldValue(value: LoadedFieldValue): string {
  return JSON.stringify(value);
}

/**
 * The loaded value of every named field, or null when any is missing or cannot be
 * read: a form drawn by code from before these fields existed, so nothing says
 * which values the person was looking at and the save must be refused.
 */
export function loadedFieldsFrom<K extends string>(
  form: FormData,
  fields: readonly K[],
): Record<K, LoadedFieldValue> | null {
  const out = {} as Record<K, LoadedFieldValue>;
  for (const field of fields) {
    const raw = form.get(loadedFieldName(field));
    if (typeof raw !== "string" || raw === "") return null;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
    if (value !== null && typeof value !== "string" && typeof value !== "number") return null;
    out[field] = value;
  }
  return out;
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
