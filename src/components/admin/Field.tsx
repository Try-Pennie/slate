import { inputCls, labelCls } from "@/components/ui/styles";

/**
 * A labelled text input, used by the event type editor (#1748). It was a local
 * helper on the old single-page /admin; its caller is its own route now, so it
 * moved out rather than being written twice.
 *
 * Three things it now gets right that it did not (#1950):
 *
 * THE LABEL IS ASSOCIATED WITH THE INPUT. It used to render a bare `<label>`
 * with no `htmlFor` and put `aria-label={label}` on the input separately, so the
 * visible text and the accessible name were two facts about one field with
 * nothing holding them together, and clicking the label did not focus the
 * field. An `id` plus `htmlFor` gives both at once, and the duplicate
 * `aria-label` is gone: with the label wired up it would override the very text
 * on screen if the two ever drifted.
 *
 * A `defaultValue` IS OPTIONAL, and a `placeholder` is the way to show a
 * number without submitting it. A `defaultValue` submits when untouched, so a
 * suggested value in one is a value nobody typed reaching the database.
 *
 * A `hint` SAYS WHAT THE FIELD DOES, visibly, and is announced with the field
 * through `aria-describedby` rather than only being nearby.
 */
export function Field({
  name,
  id: idOverride,
  label,
  defaultValue,
  placeholder,
  hint,
  required,
  small,
}: {
  name: string;
  /** Needed when one name appears more than once on a page, so each label
   *  still points at its own input. Defaults to one derived from the name. */
  id?: string;
  label: string;
  defaultValue?: string;
  placeholder?: string;
  hint?: string;
  required?: boolean;
  small?: boolean;
}) {
  const id = idOverride ?? `field-${name}`;
  const hintId = `${id}-hint`;
  return (
    <div>
      <label className={labelCls} htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        name={name}
        defaultValue={defaultValue}
        placeholder={placeholder}
        required={required}
        aria-describedby={hint ? hintId : undefined}
        className={`${inputCls} ${small ? "w-24" : "w-full max-w-80"}`}
      />
      {hint && (
        <p id={hintId} className="mt-1 max-w-40 text-xs leading-snug text-fg-muted">
          {hint}
        </p>
      )}
    </div>
  );
}
