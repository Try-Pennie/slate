"use client";

import { useCallback, useId, useMemo, useRef, useState } from "react";
import { useRestoredValue } from "@/components/ui/SaveForm";
import { AnchoredPanel } from "@/components/ui/AnchoredPanel";
import {
  nextIndex,
  typeAheadIndex,
  TYPE_AHEAD_RESET_MS,
} from "@/lib/ui/listbox-navigation";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/**
 * A select that belongs to this app rather than to the operating system (#1849).
 *
 * Dan, opening the agent's home timezone control: it is a bare native `<select>`,
 * so it drops the OS's own grey menu on top of a Pennie branded page, and with
 * several hundred zones in it that menu filled the whole browser window top to
 * bottom. Nothing in our CSS can reach either of those: a native select's popup
 * is drawn by the platform, so it cannot be styled and its height cannot be
 * bounded.
 *
 * WHAT A NATIVE SELECT WAS DOING FOR FREE, and what this therefore has to do
 * deliberately, because a replacement that skips any of it trades a plain
 * looking control for an inaccessible one:
 *
 * IT POSTS. Every one of these sits in a form, several of them server action
 * forms and the roster's filter form, so a hidden input carries `name` and the
 * current value. Without it the form silently posts nothing, which is the worst
 * kind of failure here: the screen looks right and the data does not arrive.
 *
 * IT IS OPERABLE FROM THE KEYBOARD. Arrows with wrapping, Home, End, Enter and
 * Space to commit, Escape to dismiss without committing, and type ahead. Those
 * rules are pure and live in `@/lib/ui/listbox-navigation`, tested as rules.
 *
 * IT IS ANNOUNCED. The trigger is a `combobox` owning a `listbox`, and it points
 * at the highlighted row with `aria-activedescendant` rather than moving DOM
 * focus into the list, so the trigger keeps focus and the reading order stays
 * put. Each row carries `aria-selected`.
 *
 * IT IS NOT CLIPPED. The panel goes through `AnchoredPanel` (#1843), so no
 * scrolling ancestor can cut it off, which matters immediately: the roster's
 * four filters sit directly above a table with `overflow-x-auto`. The panel
 * bounds its OWN height and scrolls inside, which is the half a native select
 * could never do and the reason the timezone menu covered the screen.
 */
export function SelectField({
  name,
  value: controlled,
  defaultValue,
  options,
  onChange,
  ariaLabel,
  className,
  placeholder = "Select",
  id,
  disabled = false,
  compact = false,
  ariaDescribedBy,
}: {
  /** Submitted with the form. Omit for a control that only calls `onChange`. */
  name?: string;
  /**
   * The current value, for a caller that holds it. Leave undefined and pass
   * `defaultValue` for the uncontrolled form: several of these live in plain
   * server rendered forms that post on submit and have no state to drive them,
   * which is exactly what a native select supported and is why this has both.
   */
  value?: string;
  defaultValue?: string;
  options: SelectOption[];
  onChange?: (value: string) => void;
  /** Required when no visible label points at this control. */
  ariaLabel?: string;
  className?: string;
  /** Shown when `value` matches no option. */
  placeholder?: string;
  id?: string;
  disabled?: boolean;
  /**
   * For a list of bare one digit numbers (#3922, D4 in docs/design/days-offered.html):
   * the value is centred in tabular figures in the trigger and in every option, and
   * the list drops the wide minimum a word list needs, so two of these side by side
   * line their numbers up. Its height bound is raised just enough to show seven 44px
   * rows whole, since a short list of numbers should never scroll. The caller sizes
   * the trigger with `className`. An opt in for that card, not a standing rule.
   */
  compact?: boolean;
  /** The id of a hint explaining what the value means, announced with the control. */
  ariaDescribedBy?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  // #2008: the restored value wins over the stored one as the INITIAL state.
  // This control renders its hidden input from state, so the blanket restore in
  // SaveForm cannot reach it: an assignment there is overwritten by the next
  // render and the form posts the stored value. Outside a SaveForm this is null
  // and nothing changes.
  const restored = useRestoredValue(name);
  const [uncontrolled, setUncontrolled] = useState(restored ?? defaultValue ?? "");
  const value = controlled ?? uncontrolled;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const buffer = useRef({ text: "", at: 0 });
  const base = useId();
  const listId = `${base}-list`;

  const labels = useMemo(() => options.map((o) => o.label), [options]);
  const selected = options.findIndex((o) => o.value === value);
  const current = selected === -1 ? null : selected;
  const label = current === null ? placeholder : options[current]!.label;

  const optionId = (i: number) => `${base}-opt-${i}`;

  /** Open with the highlight on the current value, so the list starts where the person is. */
  const openList = useCallback(() => {
    setActive(current);
    setOpen(true);
  }, [current]);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    setActive(null);
    if (refocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  const commit = useCallback(
    (i: number) => {
      const opt = options[i];
      if (!opt || opt.disabled) return;
      if (controlled === undefined) setUncontrolled(opt.value);
      onChange?.(opt.value);
      close(true);
    },
    [options, onChange, close, controlled],
  );

  /** Keep the highlighted row inside the panel's own scroll, without moving the page. */
  const reveal = useCallback((i: number) => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${i}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, []);

  const move = useCallback(
    (to: number | null) => {
      if (to === null) return;
      setActive(to);
      reveal(to);
    },
    [reveal],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    const key = e.key;

    if (!open) {
      // A closed select opens on the same keys that walk an open one, which is
      // what a native select does, so the list is never a mouse-only step.
      if (key === "ArrowDown" || key === "ArrowUp" || key === "Enter" || key === " ") {
        e.preventDefault();
        openList();
        return;
      }
    }

    if (key === "Escape") {
      e.preventDefault();
      close(true);
      return;
    }
    if (open && (key === "Enter" || key === " ")) {
      e.preventDefault();
      if (active !== null) commit(active);
      return;
    }
    if (key === "Tab") {
      // The browser is already moving focus; dismiss without dragging it back.
      close(false);
      return;
    }

    const to = nextIndex(active, key, options.length);
    if (to !== null) {
      e.preventDefault();
      if (!open) setOpen(true);
      move(to);
      return;
    }

    // Type ahead. One printable character at a time, with the buffer clearing
    // after a pause so a later word does not continue an earlier one.
    if (key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const now = Date.now();
      buffer.current.text =
        now - buffer.current.at > TYPE_AHEAD_RESET_MS ? key : buffer.current.text + key;
      buffer.current.at = now;
      const to2 = typeAheadIndex(labels, buffer.current.text, active ?? current);
      if (to2 !== null) {
        e.preventDefault();
        if (!open) setOpen(true);
        move(to2);
      }
    }
  };

  return (
    <span className={`relative inline-flex ${className ?? ""}`}>
      {/* What the form actually posts. A native select carried this for free. */}
      {/* `data-restore-own` keeps SaveForm's blanket restore off this input: the
          value comes from the state above, which took the restored one as its
          initial value (#2008). */}
      {name !== undefined && (
        <input type="hidden" name={name} data-restore-own="true" value={value} />
      )}
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && active !== null ? optionId(active) : undefined}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        disabled={disabled}
        onClick={() => (open ? close(true) : openList())}
        onKeyDown={onKeyDown}
        className="pn-select-trigger flex h-11 w-full items-center justify-between gap-2 rounded-sm border border-border bg-[var(--field)] pl-3 pr-3 text-left text-sm text-fg disabled:opacity-60"
      >
        {/* #4205 (D5): a placeholder is drawn muted, as an empty text field's is, so
            "Choose a reason" never reads as a value somebody chose. */}
        <span
          className={`${compact ? "flex-1 truncate text-center tabular-nums" : "truncate"}${current === null ? " text-fg-muted" : ""}`}
        >
          {label}
        </span>
        <svg
          aria-hidden="true"
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="shrink-0 text-fg-muted"
        >
          <path d="M3 4.5 6 7.5 9 4.5" />
        </svg>
      </button>

      <AnchoredPanel
        open={open}
        onDismiss={() => close(false)}
        triggerRef={triggerRef}
        panelRef={listRef}
        align="start"
        id={listId}
        role="listbox"
        aria-label={ariaLabel}
        // The height it bounds is the whole point: a native menu of several
        // hundred zones took the entire window, and nothing could stop it.
        className={`${compact ? "max-h-80 min-w-21" : "max-h-72 min-w-44"} overflow-y-auto rounded-md border border-border bg-surface py-1 shadow-pop`}
      >
        {options.map((o, i) => (
          <div
            key={o.value}
            id={optionId(i)}
            data-idx={i}
            role="option"
            aria-selected={o.value === value}
            aria-disabled={o.disabled || undefined}
            onMouseEnter={() => setActive(i)}
            // The press must not blur the trigger first, or the panel closes
            // before the click lands.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => commit(i)}
            className={`flex min-h-11 cursor-pointer items-center px-3 text-sm ${compact ? "justify-center tabular-nums" : ""} ${
              i === active ? "bg-[var(--bg-alt)] text-fg" : "text-fg"
            } ${o.disabled ? "pointer-events-none opacity-50" : ""}`}
          >
            {o.label}
          </div>
        ))}
      </AnchoredPanel>
    </span>
  );
}
