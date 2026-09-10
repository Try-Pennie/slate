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

/**
 * WHY a draft was kept, which decides what the page says when it hands it back
 * (#2077).
 *
 * The two are not the same event and one message answering for both is how a
 * person stops reading it (L11). A save that died under a deploy is something
 * that happened TO them and the page reloaded itself; leaving a page with edits
 * on it is something they chose, and the sentence has to say so or it reads as a
 * fault report about an action they took on purpose.
 */
export type RestoreReason = "stale-save" | "navigation";

/**
 * How long a kept draft is still worth handing back (#2077).
 *
 * A stale draft silently overwriting a value somebody has since changed
 * elsewhere is the failure mode, and it gets likelier the older the draft is. Two
 * hours covers the case this was built for many times over, since a stale save
 * hands the draft back on the reload seconds later, and it is short enough that a
 * draft from this morning is not put in front of somebody this afternoon as
 * though they had just typed it.
 *
 * `sessionStorage` already bounds this to one tab, so nothing here survives the
 * browser closing; this is the bound WITHIN a long lived tab.
 */
export const RESTORE_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** A stash as it comes back: the values, why they were kept, and when. */
export interface Stash {
  form: RestoredForm;
  why: RestoreReason;
  atMs: number;
}

/**
 * Whether a restored stash actually holds something a person TYPED (#2075).
 *
 * A form of one button restores an empty set of values, and announcing "what you
 * had typed has been put back" over one is telling the reader about a state that
 * cannot exist for that form: nothing was typed, so nothing came back. Worse, on
 * the agents header that notice is a paragraph inside a one line row, so it pushed
 * the Sync button off the line beside the heading every time it fired.
 *
 * A value that is present but EMPTY counts as nothing, because a cleared field and
 * an untouched one are the same thing to somebody reading the sentence.
 */
export function restoredAnything(restored: RestoredForm | null | undefined): boolean {
  if (!restored) return false;
  return Object.values(restored).some((values) => values.some((v) => v.trim() !== ""));
}

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
  why: RestoreReason = "stale-save",
  nowMs: number = Date.now(),
): boolean {
  try {
    // An ENVELOPE since #2077, so the page can say which of the two things
    // happened and can refuse a draft too old to mean anything. The clock is a
    // parameter so a test asserts the age rule rather than waiting out a real
    // two hours (L524).
    store.setItem(restoreKey(path, formName), JSON.stringify({ v: 2, at: nowMs, why, form }));
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
  nowMs: number = Date.now(),
): Stash | null {
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

  const envelope = parsed as Record<string, unknown>;
  // A stash written before the envelope existed is a bare values object, and it
  // is READ rather than dropped: it can only be one written seconds ago by a
  // stale save in this same tab, which is exactly the person this feature was
  // built for, and dropping it would lose their work to a version bump.
  const isEnvelope = envelope.v === 2 && typeof envelope.form === "object" && envelope.form !== null;
  const body = isEnvelope ? (envelope.form as Record<string, unknown>) : envelope;
  const why: RestoreReason = isEnvelope && envelope.why === "navigation" ? "navigation" : "stale-save";
  const atMs = isEnvelope && typeof envelope.at === "number" ? envelope.at : nowMs;

  // Too old to mean anything. Refused rather than handed back, because a draft
  // that overwrites a value somebody has since changed elsewhere is worse than
  // one that was quietly dropped.
  if (nowMs - atMs > RESTORE_MAX_AGE_MS) return null;

  const form: RestoredForm = {};
  for (const [key, value] of Object.entries(body)) {
    if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) return null;
    form[key] = value as string[];
  }
  return { form, why, atMs };
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
