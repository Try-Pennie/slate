"use client";

import { useRef, useState, type ReactNode } from "react";
import { TimeField } from "@/components/ui/TimeField";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { ConfirmAction } from "@/components/ui/ConfirmAction";
import { btnCls, btnSecondaryCls } from "@/components/ui/styles";
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
  defaultsAction,
  companyDefaultDays,
}: {
  days: WorkingHoursDay[];
  /** The timezone control, rendered by the server component that owns the zone
   *  list, so several hundred options do not have to cross into this bundle. */
  timezoneField: ReactNode;
  saveLabel?: string;
  /**
   * Replace this week with the company default (#1873). Present on the admin's
   * copy of the form, absent on the agent's own.
   *
   * It lives INSIDE this form, submitted through `formAction`, for one reason:
   * this component is the only thing that knows whether the week on screen has
   * been edited, and the control's whole hazard is that it throws those edits
   * away. As a separate form beside this one it could not see them, which is how
   * it came to be a text link that silently discarded unsaved work.
   */
  defaultsAction?: (form: FormData) => Promise<void>;
  /** The week `defaultsAction` would write, so the confirm can NAME what it
   *  replaces rather than asking a generic "are you sure". */
  companyDefaultDays?: WorkingHoursDay[];
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

  /**
   * Whether the week on screen differs from the week that is stored (#1873).
   *
   * Compared against the `days` this component was rendered with, which IS the
   * stored week, rather than tracked with a flag set by every handler: a flag has
   * to be set in each of the six places that change the week, and the one that
   * gets forgotten reads as "nothing unsaved" precisely when something is.
   */
  const edited =
    JSON.stringify(
      summaryDays.map((d) => [d.weekday, d.on, d.windows.map((w) => [w.start, w.end])]),
    ) !==
    JSON.stringify(
      WEEKDAYS.map(([weekday]) => {
        const day = days.find((d) => d.weekday === weekday);
        return [
          weekday,
          day?.on ?? false,
          (day?.windows ?? [{ start: "", end: "" }]).map((w) => [w.start, w.end]),
        ];
      }),
    );

  return (
    <div className="space-y-4">
      {/* #1997: THE WEEK SENTENCE IS GONE FROM HERE.
          Dan, 2026-09-06: "this is ugly and redundant ... we need to fix both
          sets of text to be better looking and more pleasing."

          It stated the week a third time. The green banner above recites it, this
          paragraph recited it word for word, and the rows below hold every one of
          those times in fields. At a real week, five different day patterns and a
          split shift, the two paragraphs filled most of the panel. A two row
          fixture never shows that (L606).

          What is given up, recorded so nobody rediscovers it as a regression:
          this was the only one line summary of an UNSAVED edit, and while editing
          seven rows of controls do not say at a glance what the week now reads.
          Judged acceptable. If it is missed, the answer is a summary that appears
          only while edited, not this paragraph coming back.

          `workingHoursSummary` itself STAYS: the "apply company default hours"
          confirm below names the week it is about to overwrite with it, and
          `summaryDays` still feeds the `edited` comparison (#1873) that guards an
          unsaved week. Neither is this paragraph. */}
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
                // Reinforcement, never the only signal: the unticked checkbox and the
                // sentence above both already say the day is off.
                //
                // A recessed FILL rather than opacity (#1768). `opacity-60` dimmed the
                // text along with everything else, which took the day name and its
                // times to 3.69:1 and the "to" separator to 2.42:1 on white, both under
                // the 4.5:1 body text needs. Measured with axe on the rendered page, so
                // this was a real failure on eight elements and not a theoretical one.
                day.on ? "" : "bg-[var(--bg-alt)]",
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

              {/* #1873: in the row it operates ON. It used to sit at the foot of
                  the form next to Save, so an editing aid that changes nothing
                  durable was a peer of the commit, and its subject (Monday) was
                  six rows away from it. It is the only one of the three controls
                  here that writes nothing, and it is the only one still styled
                  as text, which is why #2103 did not promote it to a button.

                  #2103 moved it OUT of the controls row and onto its own line.
                  It was the last child of a `flex-wrap` row carrying `ml-auto`,
                  so once that row wrapped (which it does at every width an agent
                  actually uses, because the day name, two time fields and the
                  add button already fill it) the link was thrown to the far
                  right edge of the card and sat directly under the `+`. Dan:
                  "this is ugly". On its own line it starts where every other
                  line in the row starts, and it can never collide with a control
                  again, whatever the width. */}
              {weekday === 1 && (
                <button
                  type="button"
                  onClick={copyMonday}
                  className="mt-2 text-xs text-pennie-blue underline dark:text-pennie-sky"
                >
                  Copy Monday to every working day
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* The single primary commit, on its own. Nothing else in this form shares
          its treatment. */}
      <div>
        <SubmitButton className={btnCls} pendingLabel="Saving your hours">
          {saveLabel}
        </SubmitButton>
      </div>

      {/* #1873: a reset, set apart from the action it undoes rather than sitting
          directly under it, and dressed as what it is. It was a text link
          identical to the copy control above, which made a control that rewrites
          somebody's stored schedule (and throws away whatever is unsaved here)
          read as the least significant thing on the screen. #1670 records this
          same control half failing and leaving an agent silently unbookable, so
          the weight is not hypothetical.

          It ASKS, and the question carries information rather than friction: it
          names the week it is about to write, and the unsaved edits only when
          there really are some. */}
      {defaultsAction && companyDefaultDays && (
        <div className="border-t border-border pt-4">
          <ConfirmAction
            label="Apply company default hours"
            confirmLabel="Apply company hours anyway"
            pendingLabel="Applying company hours"
            className={btnSecondaryCls}
            formAction={defaultsAction}
            message={
              <>
                {`This replaces this agent's stored working hours with the company default: ${workingHoursSummary(companyDefaultDays)}`}
                {edited
                  ? " The unsaved edits on this form are discarded, not saved."
                  : ""}
              </>
            }
          />
        </div>
      )}
    </div>
  );
}
