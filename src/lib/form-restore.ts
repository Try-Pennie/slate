/**
 * What was typed, kept across the reload a stale save forces (#1994).
 *
 * ## Why this exists at all
 *
 * When a deploy lands under an open page the save dies and the only way back is
 * a reload, because the page's server actions no longer exist by name. Next's
 * own self-hosting guide says plainly that a reload loses component state, and
 * #1966 was Dan losing a week of hours to exactly that. Shipping the reload
 * without this would trade a crash for silent data loss, which is worse: a crash
 * is at least visible.
 *
 * ## The shape, and why it is not a DOM restore
 *
 * The obvious implementation writes the saved values back onto the inputs after
 * reload. That works for a plain text box and fails for every field whose value
 * lives in React state, which on these forms is most of them: `TimeField` holds
 * the typed text and renders a hidden input from it, so a value written onto
 * that hidden input is overwritten by the next render and the form submits the
 * old one. Fighting React here would fail intermittently, which is worse than
 * failing.
 *
 * So the stash is read at MOUNT, by the field itself, as its initial value. The
 * field keeps ownership of its own state and there is nothing to fight.
 *
 * Pure, and storage is injected, so `scripts/test-form-restore.ts` drives every
 * branch with no browser.
 */

/** One field's submitted value or values. Multi-value fields are real here:
 *  bucket members and criteria post several entries under one name. */
export type RestoredForm = Record<string, string[]>;

/** Where a stash lives. `sessionStorage` in a browser, a fake in a test. */
export interface RestoreStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const PREFIX = "slate.restore.";

/**
 * The key a stash is filed under.
 *
 * The PATH is in it because two pages can hold forms with the same field names,
 * and restoring one page's hours onto another's would be worse than restoring
 * nothing. The form's own name separates two forms on one page.
 */
export function restoreKey(path: string, formName: string): string {
  return `${PREFIX}${path}::${formName}`;
}

/** Everything a form would have submitted, as a stashable object. */
export function entriesToRestored(entries: Iterable<[string, FormDataEntryValue]>): RestoredForm {
  const out: RestoredForm = {};
  for (const [key, value] of entries) {
    // A File has no text form worth keeping, and none of these forms carry one.
    // Dropping it silently would be a lie about what was kept, so it is skipped
    // by TYPE rather than coerced into "[object File]".
    if (typeof value !== "string") continue;
    (out[key] ??= []).push(value);
  }
  return out;
}

/** Write a stash. A failure to store is swallowed deliberately: a full or
 *  disabled `sessionStorage` must not turn a recoverable save into a thrown
 *  error on top of the one that already happened. */
export function stashForm(
  store: RestoreStore,
  path: string,
  formName: string,
  form: RestoredForm,
): boolean {
  try {
    store.setItem(restoreKey(path, formName), JSON.stringify(form));
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a stash, or `null`.
 *
 * Anything unreadable is `null` rather than a partial object: a half restored
 * form is a form quietly holding somebody else's values, and the person has no
 * way to tell which fields came back.
 */
export function readStash(
  store: RestoreStore,
  path: string,
  formName: string,
): RestoredForm | null {
  let raw: string | null;
  try {
    raw = store.getItem(restoreKey(path, formName));
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const out: RestoredForm = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) return null;
    out[key] = value as string[];
  }
  return out;
}

/** Remove a stash. Called once the values are back on screen, so a second
 *  reload does not silently re-apply values the person has since changed. */
export function clearStash(store: RestoreStore, path: string, formName: string): void {
  try {
    store.removeItem(restoreKey(path, formName));
  } catch {
    // Nothing to do and nothing worth saying: the values are already restored.
  }
}

/** One field's restored value, or `null` when the stash has nothing for it. */
export function restoredValue(form: RestoredForm | null, name: string): string | null {
  const values = form?.[name];
  return values && values.length > 0 ? values[0]! : null;
}
