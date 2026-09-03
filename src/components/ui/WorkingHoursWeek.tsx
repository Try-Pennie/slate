"use client";

import { useRef, useState, type ReactNode } from "react";
import { TimeField } from "@/components/ui/TimeField";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { btnCls } from "@/components/ui/styles";
import {
  WEEKDAYS,
  workingHoursSummary,
  type WorkingHoursDay,
} from "@/lib/schedule-week";

/** How a row is named in a control's label, so "Remove" says which one. */
const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh"];

interface EditWindow {
  /** Stable across edits, so typing in a field never remounts it and loses focus.
   *  A window written from OUTSIDE the field (the copy control) gets a NEW id on
   *  purpose, which remounts it with the new value.
   *
   *  The rows a day arrives with are keyed by POSITION and minted rows by a
   *  counter, so the two can never collide, and building the initial week needs no
   *  counter at all. That matters because the initial week is built during render,
   *  where reading a ref is not allowed. */
  id: string;
  start: string;
  end: string;
}

interface EditDay {
  weekday: number;
  on: boolean;
  windows: EditWindow[];
}

/**
 * The editable week: a row per weekday, each holding one or more windows (#1764).
 *
 * A client component because three things here cannot be answered by the server:
 * the sentence above the rows describes what is ON SCREEN rather than what is
 * stored, `+` and `x` change how many fields exist, and a typed time that does not
 * resolve has to block the save at the field rather than after a round trip.
 *
 * The window fields are REPEATED names (`start_1` twice for a split Monday) read
 * back with `FormData.getAll`, rather than indexed names. A single `start_1` can no
 * longer identify a window, and repeated names pair by position with no index
 * bookkeeping to get wrong when a middle row is removed.
 */
export function WorkingHoursWeek({
  days,
  timezoneField,
  saveLabel = "Save",
}: {
  days: WorkingHoursDay[];
  /** The timezone control, rendered by the server component that owns the zone
   *  list, so several hundred options do not have to cross into this bundle. */
  timezoneField: ReactNode;
  saveLabel?: string;
}) {
  const [week, setWeek] = useState<EditDay[]>(() =>
    WEEKDAYS.map(([weekday]) => {
      const day = days.find((d) => d.weekday === weekday);
      return {
        weekday,
        on: day?.on ?? false,
        windows: (day?.windows ?? [{ start: "", end: "" }]).map((w, i) => ({
          id: `stored-${weekday}-${i}`,
          start: w.start,
          end: w.end,
        })),
      };
    }),
  );

  /** Ids for windows created after the first render. Read only from a handler. */
  const minted = useRef(0);
  const mint = (start: string, end: string): EditWindow => ({
    id: `added-${minted.current++}`,
    start,
    end,
  });

  const addRefs = useRef(new Map<number, HTMLButtonElement | null>());

  const update = (weekday: number, change: (day: EditDay) => EditDay) =>
    setWeek((w) => w.map((d) => (d.weekday === weekday ? change(d) : d)));

  function addWindow(weekday: number) {
    update(weekday, (d) => ({ ...d, windows: [...d.windows, mint("", "")] }));
  }

  function removeWindow(weekday: number, id: string) {
    update(weekday, (d) => ({ ...d, windows: d.windows.filter((w) => w.id !== id) }));
    // Focus would otherwise land on the body, sending a keyboard user back to the
    // top of the page to get to the row they were working on.
    addRefs.current.get(weekday)?.focus();
  }

  function setBound(weekday: number, id: string, which: "start" | "end", value: string) {
    update(weekday, (d) => ({
      ...d,
      windows: d.windows.map((w) => (w.id === id ? { ...w, [which]: value } : w)),
    }));
  }

  /** Monday's whole window list onto every other WORKING day, so copying a split
   *  Monday gives each of them the same split, and a day that is off stays off. */
  function copyMonday() {
    setWeek((w) => {
      const monday = w.find((d) => d.weekday === 1);
      if (!monday) return w;
      return w.map((d) =>
        d.weekday === 1 || !d.on
          ? d
          : { ...d, windows: monday.windows.map((m) => mint(m.start, m.end)) },
      );
    });
  }

  const summaryDays: WorkingHoursDay[] = week.map((d) => ({
    weekday: d.weekday,
    on: d.on,
    windows: d.windows.map((w) => ({ start: w.start, end: w.end })),
  }));

  return (
    <div className="space-y-4">
      <p
        data-testid="hours-summary"
        // Announced when it changes, without claiming `role="status"`: that role is
        // for the outcome of an action, and this panel already has one for what a
        // save came back with. Two status regions on one form is noise.
        aria-live="polite"
        className="text-sm font-semibold text-fg"
      >
        {workingHoursSummary(summaryDays)}
      </p>

      {timezoneField}

      <div className="space-y-2">
        {WEEKDAYS.map(([weekday, name]) => {
          const day = week.find((d) => d.weekday === weekday);
          if (!day) return null;
          const several = day.windows.length > 1;
          return (
            <div
              key={weekday}
              data-weekday={weekday}
              data-day-off={day.on ? "false" : "true"}
              className={[
                "rounded-[var(--radius-md)] border border-border px-4 py-3",
                // Reinforcement, never the only signal: the unticked checkbox and
                // the sentence above both already say the day is off.
                day.on ? "" : "opacity-60",
              ].join(" ")}
            >
              <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
                <label className="flex min-h-11 min-w-[9.5rem] cursor-pointer items-center gap-3">
                  <input
                    type="checkbox"
                    name={`day_${weekday}`}
                    checked={day.on}
                    onChange={(e) => update(weekday, (d) => ({ ...d, on: e.target.checked }))}
                    className="h-5 w-5 shrink-0 rounded-[var(--radius-xs)] border-border accent-[var(--accent)]"
                  />
                  <span className="text-sm font-semibold">{name}</span>
                </label>

                <div className="flex flex-col gap-2">
                  {day.windows.map((w, i) => {
                    const bothBlank = w.start === "" && w.end === "";
                    // A ticked day's only window MUST resolve, and so must a window
                    // somebody has half filled in. A blank ADDED row is left alone:
                    // clicking + and saving without filling it is ordinary.
                    const enforce = day.on && (!bothBlank || day.windows.length === 1);
                    return (
                      <div key={w.id} className="flex flex-wrap items-start gap-2">
                        <TimeField
                          name={`start_${weekday}`}
                          ariaLabel={`${name} start time`}
                          defaultValue={w.start}
                          enforce={enforce}
                          onValueChange={(v) => setBound(weekday, w.id, "start", v)}
                        />
                        <span aria-hidden="true" className="mt-3 text-sm text-fg-muted">
                          to
                        </span>
                        <TimeField
                          name={`end_${weekday}`}
                          ariaLabel={`${name} end time`}
                          defaultValue={w.end}
                          round="up"
                          enforce={enforce}
                          onValueChange={(v) => setBound(weekday, w.id, "end", v)}
                        />
                        {several && (
                          <button
                            type="button"
                            onClick={() => removeWindow(weekday, w.id)}
                            aria-label={`Remove ${name}'s ${ORDINALS[i] ?? `${i + 1}th`} window`}
                            title={`Remove ${name}'s ${ORDINALS[i] ?? `${i + 1}th`} window`}
                            className="flex h-11 w-11 items-center justify-center rounded-[var(--radius-xs)] border border-border bg-surface text-base text-fg-muted hover:border-fg/45 hover:text-fg"
                          >
                            <span aria-hidden="true">{"\u00d7"}</span>
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>

                <button
                  type="button"
                  ref={(el) => {
                    addRefs.current.set(weekday, el);
                  }}
                  onClick={() => addWindow(weekday)}
                  aria-label={`Add a window to ${name}`}
                  title={`Add a window to ${name}`}
                  className="flex h-11 w-11 items-center justify-center rounded-[var(--radius-xs)] border border-border bg-surface text-base text-fg-muted hover:border-fg/45 hover:text-fg"
                >
                  <span aria-hidden="true">+</span>
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={copyMonday}
        className="text-xs text-pennie-blue underline dark:text-pennie-sky"
      >
        Copy Monday to every working day
      </button>

      <div>
        <SubmitButton className={btnCls} pendingLabel="Saving your hours">
          {saveLabel}
        </SubmitButton>
      </div>
    </div>
  );
}
