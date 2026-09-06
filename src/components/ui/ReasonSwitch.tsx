/**
 * An on/off switch (#1947).
 *
 * Dan: "active should just be a toggle, not a check box. and other can be the
 * same but unclickable so it's forced to be always on instead of spelling it
 * out."
 *
 * A NATIVE CHECKBOX with `role="switch"`, not a div that looks like one. The
 * role is what makes a screen reader say "switch, on" rather than "checkbox,
 * checked"; everything else (the keyboard, the label association, the focus
 * ring, the form) is the platform's and is kept rather than reimplemented
 * (L568). The input is visually hidden rather than `display: none`, because a
 * hidden input is not focusable and the keyboard would stop reaching it.
 *
 * The LOCKED case is the interesting one and it has two failure modes to avoid.
 * A disabled control announces as unavailable and never says why, which leaves a
 * dead control and no explanation (L109), so it carries a note that is both a
 * `title` and its `aria-describedby` target. And a greyed out switch reads as
 * OFF, which is the opposite of what a locked-on reason means, so it keeps its
 * filled track and is only slightly dimmed.
 */
export function ReasonSwitch({
  id,
  label,
  checked,
  disabled,
  onChange,
  note,
  noteId,
  describedBy,
}: {
  id: string;
  /** The accessible name. There is no visible text beside it, so this is it. */
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange?: () => void;
  /** Why it cannot be changed, for the locked case. */
  note?: string;
  noteId?: string;
  describedBy?: string;
}) {
  return (
    <span className="inline-flex items-center">
      <input
        id={id}
        type="checkbox"
        role="switch"
        className="peer sr-only"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        aria-describedby={describedBy}
        onChange={() => onChange?.()}
      />
      <label
        htmlFor={id}
        title={note}
        className={[
          "relative block h-5 w-9 rounded-full border transition-colors",
          disabled ? "cursor-default opacity-80" : "cursor-pointer",
          // The ON track is the action colour whether or not it can be moved, so
          // a locked switch never reads as off.
          checked ? "border-transparent bg-pennie-sky" : "border-border bg-[var(--bg-alt)]",
          // The focus ring rides on the input's own focus, since that is what
          // the keyboard actually lands on.
          "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--focus-ring-line)]",
        ].join(" ")}
      >
        <span
          aria-hidden="true"
          className={`absolute top-0.5 block h-4 w-4 rounded-full bg-white shadow-xs transition-all ${
            checked ? "left-4.5" : "left-0.5"
          }`}
        />
      </label>
      {note && noteId && (
        <span id={noteId} className="sr-only">
          {note}
        </span>
      )}
    </span>
  );
}
