"use client";

import { useState } from "react";

/**
 * One alert switch on /admin/alerts with the one sentence its current state means
 * (Dan, 2026-10-26, settled in docs/design/admin-alerts-help-text.html).
 *
 * The sentence follows the box as it is ticked, not the saved value: it says what the
 * switch will do once the form is saved, and the form's unsaved changes guard already
 * marks that it has not been. Showing the saved state under a box that disagrees with
 * it would be the one place on the card where the words and the control contradict.
 *
 * The box stays an ordinary form field (`name`, `value="on"`, uncontrolled default), so
 * the save reads it exactly as before; the state here only picks the sentence.
 */
export function AlertSwitch({
  name,
  label,
  on,
  off,
  defaultChecked,
}: {
  name: string;
  label: string;
  on: string;
  off: string;
  defaultChecked: boolean;
}) {
  const [checked, setChecked] = useState(defaultChecked);
  const helpId = `${name}_help`;
  return (
    <>
      <label className="mt-4 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name={name}
          value="on"
          defaultChecked={defaultChecked}
          onChange={(e) => setChecked(e.currentTarget.checked)}
          aria-describedby={helpId}
          className="h-4 w-4"
        />
        {label}
      </label>
      <p id={helpId} className="mt-1 text-xs text-fg-muted">
        {checked ? on : off}
      </p>
    </>
  );
}
