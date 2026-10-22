"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AnchoredPanel } from "@/components/ui/AnchoredPanel";
import { useRestoredValue } from "@/components/ui/SaveForm";
import { inputCls, proseCls } from "@/components/ui/styles";
import { nextIndex } from "@/lib/ui/listbox-navigation";
import {
  channelInputMessage,
  channelLabel,
  channelText,
  filterChannels,
  notInChannelNote,
  resolveChannelInput,
  type SlackChannelListing,
  type SlackChannelOption,
} from "@/lib/notify/slack-channel-input";

/**
 * One Slack channel field: an editable box with Slack's channel list under it,
 * filtered as you type (#2438).
 *
 * It replaces a text box with a native datalist element, which failed in two ways Dan
 * reported. Chrome drew its own black popup over the page, which no Slate style
 * can reach (L607). And a datalist option's VALUE is what the browser writes into
 * the box, so picking `#statuspage` filled the field with `C08A3BYMB29`: the name
 * lived only in a label the box never shows.
 *
 * WHAT IT KEEPS FROM THE DATALIST, deliberately: it suggests without restricting.
 * A private channel is never in the list Slate reads (that needs a Slack scope
 * the app may not have), so a pasted ID is kept as it is and the save asks Slack
 * about it directly. A select would have refused it outright (L568).
 *
 * WHAT A NATIVE CONTROL DID FOR FREE, and so what this does on purpose, the same
 * contract `SelectField` and `TimeField` carry:
 *
 * IT POSTS. A hidden input carries `name` and the channel ID, so the save action
 * reads exactly what it read before. Unresolved text posts as typed, so the save
 * refuses it with the sentence the field already showed.
 *
 * IT IS OPERABLE FROM THE KEYBOARD. Arrows walk the list with the wrapping rule in
 * `@/lib/ui/listbox-navigation`; Enter takes the highlighted channel, or settles
 * the typed text, and NEVER submits the form (#1968: Save is the only thing that
 * saves); Escape puts back what was there. Home and End stay with the text, as
 * they do in any text box.
 *
 * IT IS ANNOUNCED. The box is a `combobox` owning a `listbox`, pointing at the
 * highlighted row with `aria-activedescendant`, so focus stays in the box.
 *
 * IT IS NOT CLIPPED. The list goes through `AnchoredPanel` (#1843) and bounds its
 * own height.
 *
 * IT SURVIVES A STALE SAVE. The restored value is the field's initial state
 * (`useRestoredValue`, #1994), because one written onto the hidden input from
 * outside would be overwritten by the next render.
 *
 * WHAT A TYPED VALUE MEANS is decided by `resolveChannelInput`, which the save
 * action also runs, so the field never accepts what the save refuses (L99). This
 * component owns none of that rule.
 *
 * The list arrives as a PROMISE from the page, so the form draws at once and the
 * field shows the stored ID until Slack answers, then its name. A stored ID the
 * list does not hold (a private channel) takes the name Slack gave when the page
 * asked about it directly (`names`). It never guesses: an ID nothing has named
 * shows bare.
 */
export function SlackChannelField({
  id,
  name,
  defaultValue = "",
  listing,
  names,
  placeholder,
  ariaLabel,
  className = "",
}: {
  /** The box's id, which the page's own `<label htmlFor>` points at. */
  id: string;
  /** The field the channel ID is submitted under. */
  name: string;
  /** The stored ID, or "" for none. */
  defaultValue?: string;
  /** Slack's channel list, read once by the page and shared by every field. */
  listing: Promise<SlackChannelListing>;
  /**
   * The names Slack gave for the stored ids, asked of Slack directly by the
   * page's destination checks. A PRIVATE channel is never in `listing`, and the
   * stored Info and Handoff channel was one, so without these it showed bare.
   */
  names?: Promise<Record<string, string>>;
  placeholder?: string;
  /** Only when no visible label points at `id`. */
  ariaLabel?: string;
  /** Width and the like, on the box itself. */
  className?: string;
}) {
  const restored = useRestoredValue(name);
  /** The list once it has arrived, or null while it is on its way. */
  const [list, setList] = useState<SlackChannelListing | null>(null);
  /** What the field stands on: an ID, blank, or text that resolved to nothing. */
  const [committed, setCommitted] = useState((restored ?? defaultValue).trim());
  /** The text being typed, which is what the box shows while `dirty`. */
  const [text, setText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [open, setOpen] = useState(false);
  /** The row the keyboard is on, or null for none, so the first arrow lands on row one. */
  const [highlight, setHighlight] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    listing.then(
      (l) => {
        if (live) setList(l);
      },
      // The page's read never rejects, but a promise that did must not leave the
      // field reading "Reading Slack's channels" for ever.
      (err: unknown) => {
        if (live) setList({ readable: false, why: err instanceof Error ? err.message : String(err) });
      },
    );
    return () => {
      live = false;
    };
  }, [listing]);

  /** Names for ids the list does not hold, once Slack has given them. */
  const [known, setKnown] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!names) return;
    let live = true;
    // A failed read leaves the ids bare, which is the honest fallback: no name
    // was given, so none is shown.
    names.then(
      (n) => {
        if (live) setKnown(n);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [names]);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const baseId = useId();
  const listId = `${baseId}-list`;
  const messageId = `${baseId}-message`;
  const optionId = (c: SlackChannelOption) => `${baseId}-opt-${c.id}`;

  const channels = useMemo(() => (list?.readable ? list.channels : []), [list]);
  const options = useMemo(
    () => (dirty ? filterChannels(channels, text) : channels),
    [dirty, text, channels],
  );

  /** What the settled value resolves to against the list (null list while loading). */
  // `known` too: the name of a stored private channel, which the box displays, has
  // to be typeable back (#2438 review). The save resolves with the same names.
  const settled = resolveChannelInput(committed, list, known);
  const settledId = settled.ok ? (settled.value ?? "") : "";
  const settledChannel = channels.find((c) => c.id === settledId) ?? null;
  const shown = dirty ? text : settledId ? channelText(settledId, channels, known) : committed;

  // What the form posts. Derived from what is in the box NOW, so a Save pressed
  // straight after typing posts the ID for a typed name, not the name.
  const live = dirty ? resolveChannelInput(text, list, known) : settled;
  const posted = live.ok ? (live.value ?? "") : (dirty ? text : committed).trim();

  /**
   * What is wrong with the settled value, or null. Not while typing: a half typed
   * name is not a mistake yet. Not while the list is on its way either, because a
   * name cannot be judged before it arrives.
   */
  const problem =
    dirty || list === null || settled.ok ? null : channelInputMessage(settled);
  /** Only a name the list was READ and does not hold blocks the save; an unreadable
   *  list is the save's to judge, since it reads the list again. */
  const blocks = !dirty && !settled.ok && settled.reason === "no-match";

  useEffect(() => {
    inputRef.current?.setCustomValidity(blocks && problem ? problem : "");
  }, [blocks, problem]);

  useEffect(() => {
    if (!open || highlight === null) return;
    const el = listRef.current?.children[highlight] as HTMLElement | undefined;
    el?.scrollIntoView?.({ block: "nearest" });
  }, [open, highlight]);

  // A fresh query starts at the top, or the first matches sit above a scroll
  // position left over from the whole list.
  useEffect(() => {
    if (dirty && listRef.current) listRef.current.scrollTop = 0;
  }, [dirty, text]);

  /** Open on the settled row, so the list arrives where the value already is. */
  function openList() {
    setOpen(true);
    if (!dirty) {
      const at = options.findIndex((c) => c.id === settledId);
      setHighlight(at >= 0 ? at : null);
    }
  }

  function commit(c: SlackChannelOption) {
    setCommitted(c.id);
    setDirty(false);
    setOpen(false);
    setHighlight(null);
  }

  /** Settle what is typed: a name or an ID resolves, anything else stands as typed. */
  function settle() {
    if (dirty) {
      const r = resolveChannelInput(text, list, known);
      setCommitted(r.ok ? (r.value ?? "") : text.trim());
      setDirty(false);
    }
    setOpen(false);
    setHighlight(null);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        openList();
        return;
      }
      const to = nextIndex(highlight, e.key, options.length);
      if (to !== null) setHighlight(to);
      return;
    }
    if (e.key === "Enter") {
      // Unconditional, as in TimeField (#1968): the same key must never mean
      // "take this row" or "save the whole page" depending on a faint highlight.
      e.preventDefault();
      if (open && highlight !== null && options[highlight]) commit(options[highlight]);
      else settle();
      return;
    }
    if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setOpen(false);
        setDirty(false);
        setHighlight(null);
      }
      return;
    }
    if (e.key === "Tab") settle();
  }

  const status: string | null =
    list === null
      ? "Reading Slack's channels..."
      : !list.readable
        ? "Slate could not read Slack's channel list. Paste a channel ID instead."
        : options.length === 0
          ? "No channel matches. For a private channel, paste its ID."
          : null;

  return (
    <div>
      {/* `data-restore-own` keeps SaveForm's blanket restore off this input: the
          value comes from the field's own state, above (#1994). */}
      <input type="hidden" name={name} data-restore-own="true" value={posted} />
      <input
        ref={inputRef}
        id={id}
        type="text"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          open && highlight !== null && options[highlight] ? optionId(options[highlight]) : undefined
        }
        aria-invalid={problem ? true : undefined}
        aria-describedby={problem ? messageId : undefined}
        autoComplete="off"
        spellCheck={false}
        value={shown}
        placeholder={placeholder}
        className={`${inputCls} ${problem ? "border-error" : ""} ${className}`}
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

      <AnchoredPanel
        open={open}
        keepMounted
        onDismiss={() => setOpen(false)}
        triggerRef={inputRef}
        align="start"
      >
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={`${ariaLabel ?? "Slack channel"} options`}
          // A press anywhere in the list, its scrollbar included, must not blur the
          // box first, or `settle` would close the list under the pointer.
          onMouseDown={(e) => e.preventDefault()}
          className="max-h-72 w-80 overflow-y-auto rounded-[var(--radius-md)] border border-border bg-surface py-1 shadow-[var(--shadow-md)]"
        >
          {options.map((c, i) => (
            <li
              key={c.id}
              id={optionId(c)}
              role="option"
              aria-selected={c.id === settledId}
              className={[
                "flex min-h-11 cursor-pointer items-center justify-between gap-3 px-3 text-sm text-fg",
                i === highlight ? "bg-[var(--bg-alt)]" : "",
                c.id === settledId ? "font-semibold" : "",
              ].join(" ")}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => commit(c)}
            >
              <span className="truncate">{channelLabel(c)}</span>
              {!c.isMember && (
                <span className="shrink-0 rounded-[var(--radius-xs)] border border-border px-1.5 py-0.5 text-xs font-normal text-fg-muted">
                  Slate is not in it
                </span>
              )}
            </li>
          ))}
          {status && (
            <li role="presentation" className="px-3 py-2 text-sm text-fg-muted">
              {status}
            </li>
          )}
        </ul>
      </AnchoredPanel>

      {problem ? (
        <p id={messageId} role="alert" className={`mt-1 text-xs text-error ${proseCls}`}>
          {problem}
        </p>
      ) : settledChannel && !settledChannel.isMember ? (
        <p className={`mt-1 text-xs text-fg-muted ${proseCls}`}>
          {notInChannelNote(settledChannel)}
        </p>
      ) : null}
    </div>
  );
}
