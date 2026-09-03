"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  filterTimeOptions,
  formatTimeOfDay,
  quarterHourOptions,
  resolveTypedTime,
  roundDownToQuarterHour,
  roundUpToQuarterHour,
} from "@/lib/date/parse";

/**
 * One typeable time field: an editable box with a filtered list of every quarter
 * hour in the day (#1764).
 *
 * It replaces three dropdowns per time (hour, minute, AM or PM). That split was
 * deliberate, for two reasons: fewer options per control, and an off grid time was
 * impossible to enter. The first is better served by FILTERING than by splitting,
 * so `5:15p` reaches 5:15pm in five keystrokes rather than three menus. The second
 * genuinely changes, and the consequence is handled rather than ignored:
 *
 * **A typed value can be wrong, and a wrong one is REFUSED, never snapped.** An off
 * grid time (5:07pm) or something that is not a time at all leaves the field marked
 * invalid, announced, and, where the caller passes `enforce`, blocking the save
 * through the browser's own constraint validation. Snapping to a neighbour would
 * move hours the person had just typed without saying so, and the difference
 * between "not saved" and "saved as something else" is the whole reason this is not
 * a convenience decision.
 *
 * It covers the WHOLE day (12:00am to 11:45pm), so no storable window is
 * unenterable and no stored value can fail to display. An existing off grid stored
 * value still snaps on the way IN (`round="down"` for a start, `round="up"` for an
 * end, so a window never displays shorter than it is); that is about a value the
 * database already holds, not about one somebody typed.
 *
 * Submits 24 hour "HH:MM" through a hidden input, so every server reader is
 * unchanged. Unresolved submits "".
 *
 * It needs JavaScript, and always did: the hidden input was React controlled in the
 * three dropdown version too, so with JavaScript off these times have always
 * submitted their initial values.
 *
 * The conversion, the snapping, the spelling and the option list all come from
 * `@/lib/date/parse`. This component owns NONE of them, which is what keeps a
 * second copy of the rounding rule from growing back (#1765).
 */
export function TimeField({
  name,
  defaultValue,
  ariaLabel,
  className = "",
  round = "down",
  enforce = false,
  onValueChange,
}: {
  name: string;
  defaultValue?: string;
  ariaLabel: string;
  className?: string;
  round?: "down" | "up";
  /**
   * Whether this field MUST hold a real time. The caller decides, because only it
   * knows whether the row matters: a ticked day's window has to resolve, while a
   * blank window on an unticked day, or a row somebody added and left empty, is an
   * ordinary state that must not refuse the whole save.
   */
  enforce?: boolean;
  /** The 24 hour value each time it settles, so a live summary can be written. */
  onValueChange?: (value: string) => void;
}) {
  const snap = round === "up" ? roundUpToQuarterHour : roundDownToQuarterHour;
  const initial = defaultValue ? snap(defaultValue) : "";
  const initialText = formatTimeOfDay(initial) ?? "";

  const [text, setText] = useState(initialText);
  const [committed, setCommitted] = useState(initial && formatTimeOfDay(initial) ? initial : "");
  const [open, setOpen] = useState(false);
  /**
   * The row the keyboard is on, or null for none. Null matters: with a highlight
   * fixed at 0 the FIRST arrow press would skip past the first option, so typing
   * "8a" and pressing down would land on 8:15am rather than the 8:00am somebody
   * was aiming at.
   */
  const [highlight, setHighlight] = useState<number | null>(null);
  const [touched, setTouched] = useState(false);
  /**
   * Whether the text in the box is something the person TYPED rather than the
   * committed value spelled out. Only a typed query filters: opening the list on a
   * field that already reads 9:00am must offer the whole day (scrolled to it), not
   * the one option matching its own label.
   */
  const [dirty, setDirty] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const baseId = useId();
  const listId = `${baseId}-list`;
  const messageId = `${baseId}-message`;

  const options = useMemo(
    () => (dirty ? filterTimeOptions(text) : quarterHourOptions()),
    [dirty, text],
  );
  const resolved = resolveTypedTime(text);

  /**
   * What is wrong with the field right now, in the reader's words, or null.
   *
   * Three causes, three sentences (L11). "Not one of the times we offer" and "not a
   * time" send somebody to different places, and a single message covering both
   * would describe the wrong one half the time.
   */
  const problem: string | null = resolved.ok
    ? null
    : resolved.reason === "off-grid"
      ? "Times run in fifteen minute steps. Pick one from the list."
      : resolved.reason === "unreadable"
        ? "That is not a time. Pick one from the list."
        : enforce && touched
          ? "Pick a time from the list."
          : null;

  // The browser's own constraint validation is what BLOCKS the save, so a refused
  // field stops a submit the same way a required field does, including one fired by
  // a server action's form. Coloured red without this would be a warning nobody has
  // to act on.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.setCustomValidity(enforce && !resolved.ok ? (problem ?? "Pick a time from the list.") : "");
  }, [enforce, resolved.ok, problem]);

  useEffect(() => {
    if (!open || highlight === null) return;
    const el = listRef.current?.children[highlight] as HTMLElement | undefined;
    el?.scrollIntoView?.({ block: "nearest" });
  }, [open, highlight]);

  // A freshly typed query starts at the TOP. The list is opened scrolled to the
  // committed row (9:00am sits 36 rows down), and filtering to eight rows leaves
  // that scroll position behind, which hides the first matches above the visible
  // area and makes the field look like it is offering the wrong times.
  useEffect(() => {
    if (dirty && listRef.current) listRef.current.scrollTop = 0;
  }, [dirty, text]);

  /** Open on the committed row, so the list arrives where the value already is. */
  function openList() {
    setOpen(true);
    if (!dirty) {
      const at = options.findIndex((o) => o.value === committed);
      setHighlight(at >= 0 ? at : null);
    }
  }

  function commit(value: string) {
    setText(formatTimeOfDay(value) ?? "");
    setCommitted(value);
    setOpen(false);
    setTouched(true);
    setDirty(false);
    onValueChange?.(value);
  }

  /** Settle whatever is typed: a real time commits, anything else stands refused. */
  function settle() {
    setTouched(true);
    const r = resolveTypedTime(text);
    if (r.ok) {
      if (r.value !== committed) {
        setCommitted(r.value);
        onValueChange?.(r.value);
      }
      setText(formatTimeOfDay(r.value) ?? text);
      setDirty(false);
    } else if (committed !== "") {
      setCommitted("");
      onValueChange?.("");
    }
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        openList();
        return;
      }
      if (options.length === 0) return;
      setHighlight((h) =>
        e.key === "ArrowDown"
          ? h === null
            ? 0
            : Math.min(options.length - 1, h + 1)
          : h === null
            ? options.length - 1
            : Math.max(0, h - 1),
      );
      return;
    }
    if (e.key === "Enter") {
      if (open && highlight !== null && options[highlight]) {
        e.preventDefault();
        commit(options[highlight].value);
      }
      return;
    }
    if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setOpen(false);
        setDirty(false);
        setText(committed ? (formatTimeOfDay(committed) ?? "") : "");
      }
      return;
    }
    if (e.key === "Tab") settle();
  }

  const invalid = problem !== null;
  const fieldCls = [
    "h-11 w-28 rounded-sm border bg-surface px-2 text-sm tabular-nums text-fg",
    invalid ? "border-error text-error" : "border-border",
  ].join(" ");

  return (
    <div className={`relative ${className}`}>
      <input type="hidden" name={name} value={resolved.ok ? resolved.value : ""} />
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          open && highlight !== null && options[highlight]
            ? `${baseId}-opt-${options[highlight].value}`
            : undefined
        }
        aria-invalid={invalid || undefined}
        aria-describedby={problem ? messageId : undefined}
        autoComplete="off"
        inputMode="text"
        value={text}
        className={fieldCls}
        onChange={(e) => {
          setText(e.target.value);
          setDirty(true);
          setOpen(true);
          setHighlight(null);
        }}
        onFocus={openList}
        onBlur={settle}
        onKeyDown={onKeyDown}
      />

      {/* Always present, so `aria-controls` names a real element even while closed,
          which is what the combobox pattern expects. */}
      <ul
        ref={listRef}
        id={listId}
        role="listbox"
        // Not the field's own name: two elements with the identical accessible name
        // ("Monday start time") is ambiguous to a screen reader and to anything
        // looking a control up by its label.
        aria-label={`${ariaLabel} options`}
        hidden={!open}
        className="absolute z-20 mt-1 max-h-64 w-32 overflow-y-auto rounded-[var(--radius-md)] border border-border bg-surface py-1 shadow-[var(--shadow-md)]"
      >
        {options.map((o, i) => (
          <li
            key={o.value}
            id={`${baseId}-opt-${o.value}`}
            role="option"
            aria-selected={o.value === committed}
            className={[
              "flex min-h-11 cursor-pointer items-center px-3 text-sm tabular-nums",
              i === highlight ? "bg-[var(--bg-alt)] font-semibold text-fg" : "text-fg",
            ].join(" ")}
            onMouseEnter={() => setHighlight(i)}
            // The press must not blur the box first, or `settle` would run against
            // the half typed text and close the list before the click landed.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => commit(o.value)}
          >
            {o.label}
          </li>
        ))}
        {options.length === 0 && (
          <li role="presentation" className="px-3 py-2 text-sm text-fg-muted">
            No times match
          </li>
        )}
      </ul>

      {problem && (
        <p id={messageId} role="alert" className="mt-1 text-xs text-error">
          {problem}
        </p>
      )}
    </div>
  );
}
