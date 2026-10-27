"use client";

import { useId } from "react";
import { ReasonSwitch } from "@/components/ui/ReasonSwitch";

/**
 * One of the editor's switches (#4299): the design system switch, a visible name, and
 * the one sentence its CURRENT state means (.impeccable.md, principle 4). The value is
 * posted through a hidden field as "true" or "false", so the save reads it whatever
 * state the box is in.
 */
export function SwitchRow({
  name,
  label,
  checked,
  onChange,
  on,
  off,
}: {
  name: string;
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  on: string;
  off: string;
}) {
  const base = useId();
  const id = `${base}-switch`;
  const helpId = `${base}-help`;
  return (
    <div className="flex items-start gap-3">
      <span className="pt-0.5">
        <ReasonSwitch id={id} label={label} checked={checked} onChange={() => onChange(!checked)} describedBy={helpId} />
      </span>
      <div className="min-w-0">
        <label htmlFor={id} className="cursor-pointer text-sm font-semibold text-fg">
          {label}
        </label>
        <p id={helpId} className="text-xs text-fg-muted">
          {checked ? on : off}
        </p>
      </div>
      <input type="hidden" name={name} value={checked ? "true" : "false"} />
    </div>
  );
}
