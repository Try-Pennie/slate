"use client";

import { useId } from "react";
import { ReasonSwitch } from "@/components/ui/ReasonSwitch";

/**
 * One of the editor's switches (#4299): the design system switch and a visible name,
 * plus, where the name alone leaves a domain fact unsaid, the one sentence its CURRENT
 * state means (.impeccable.md, principle 4). A switch whose position says everything
 * (on or off) carries no sentence. The value is posted through a hidden field as "true"
 * or "false", so the save reads it whatever state the box is in.
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
  /** What on means, when the label does not already say it. Given with `off` or not at all. */
  on?: string;
  off?: string;
}) {
  const base = useId();
  const id = `${base}-switch`;
  const helpId = `${base}-help`;
  const help = checked ? on : off;
  return (
    <div className={`flex gap-3 ${help ? "items-start" : "items-center"}`}>
      <span className={help ? "pt-0.5" : undefined}>
        <ReasonSwitch
          id={id}
          label={label}
          checked={checked}
          onChange={() => onChange(!checked)}
          describedBy={help ? helpId : undefined}
        />
      </span>
      <div className="min-w-0">
        <label htmlFor={id} className="cursor-pointer text-sm font-semibold text-fg">
          {label}
        </label>
        {help && (
          <p id={helpId} className="text-xs text-fg-muted">
            {help}
          </p>
        )}
      </div>
      <input type="hidden" name={name} value={checked ? "true" : "false"} />
    </div>
  );
}
