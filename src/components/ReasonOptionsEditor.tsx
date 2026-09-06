"use client";

import { useState } from "react";
import { useRestoredValue } from "@/components/ui/SaveForm";
import { SaveForm } from "@/components/ui/SaveForm";

import { setReasonOptions } from "@/app/admin/actions";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { inputCls, cardCls, btnCls, btnSecondaryCls } from "@/components/ui/styles";
import { ReasonSwitch } from "@/components/ui/ReasonSwitch";
import { REASON_LABEL_MAX, slugifyCode, type ReasonOptionRow } from "@/lib/booking/reason-options";
import type { ReasonAction } from "@/lib/booking/core";
import { REASON_USAGE_WINDOW_DAYS, type ReasonUsageCounts } from "@/lib/booking/reason-usage";
import { UnsavedGuard } from "@/components/ui/UnsavedGuard";

/** The editor's per-row working state (a superset of what it submits). */
interface EditRow {
  code: string; // "" for a not-yet-saved row
  label: string;
  active: boolean;
  locked: boolean;
}

const ACTION_TITLES: Record<ReasonAction, string> = {
  reschedule: "Reschedule reasons",
  cancel: "Cancel reasons",
  reassign: "Reassign reasons",
};
const ACTION_ORDER: ReasonAction[] = ["reschedule", "cancel", "reassign"];

function toEditRow(r: ReasonOptionRow): EditRow {
  return { code: r.code, label: r.label, active: r.active, locked: r.locked };
}

/**
 * The per-row usage hint copy (#990), with a third state (#1657).
 *
 * `null` is "could not measure" and must never borrow the wording for zero:
 * zero is the real and useful answer "nobody has picked this in 90 days", and a
 * failed read saying that is a false all clear on the very screen where a reason
 * gets retired.
 */
function usageHint(n: number | null): string {
  if (n === null) return "Recent use could not be read";
  if (n <= 0) return `Not used in the last ${REASON_USAGE_WINDOW_DAYS} days`;
  return `Used ${n} time${n === 1 ? "" : "s"} in the last ${REASON_USAGE_WINDOW_DAYS} days`;
}

/**
 * Admin editor for the reschedule/cancel/reassign reason options (#346). Holds the
 * full ordered set per action in state (add / relabel / reorder / retire), and
 * submits the WHOLE set as one JSON payload so the server action does a pure keyed
 * upsert (never retire-by-absence). Locked rows ('other', 'owner_reassignment') show
 * read-only and cannot be retired or removed. Reorder uses keyboard-accessible
 * up/down buttons (no drag), so it works without pointer precision or motion.
 */
export default function ReasonOptionsEditor({
  initial,
  usage = null,
}: {
  initial: Record<ReasonAction, ReasonOptionRow[]>;
  /**
   * Recent per-reason usage from booking_events (#990); drives the hint and the
   * confirm before retiring a still-used reason.
   *
   * `null` means the counts could not be MEASURED, which is not the same as a
   * measured zero and is deliberately the default: a component handed nothing
   * knows nothing (#1657).
   */
  usage?: ReasonUsageCounts | null;
}) {
  // #2008: the list this form posts lives ENTIRELY in the state below and is
  // sent as one hidden field, so a save killed by a deploy loses every edit and
  // the blanket restore cannot help: it assigns to inputs, and the next render
  // would overwrite this one from state. The restore has to reach the STATE, as
  // its initial value, which is what `useRestoredValue` is for.
  //
  // Anything unreadable falls back to what is stored. A half parsed list would
  // be a form quietly holding some of the person's rows and some of the saved
  // ones, with nothing on screen saying which came from where (L11).
  const restored = useRestoredValue("payload");
  const [rows, setRows] = useState<Record<ReasonAction, EditRow[]>>(() => {
    const stored = {
      reschedule: initial.reschedule.map(toEditRow),
      cancel: initial.cancel.map(toEditRow),
      reassign: initial.reassign.map(toEditRow),
    };
    if (!restored) return stored;
    try {
      // The stash holds exactly what the hidden input posted, which is already
      // the edit row shape, so it needs no conversion. Every action must be
      // present and an array, or the whole thing is refused.
      const parsed = JSON.parse(restored) as Record<ReasonAction, EditRow[]>;
      const ok = ACTION_ORDER.every(
        (a) =>
          Array.isArray(parsed?.[a]) &&
          parsed[a].every((r) => typeof r?.code === "string" && typeof r?.label === "string"),
      );
      return ok
        ? { reschedule: parsed.reschedule, cancel: parsed.cancel, reassign: parsed.reassign }
        : stored;
    } catch {
      return stored;
    }
  });
  // The row awaiting a "retire a still-used reason" confirm, keyed `${action}:${i}`.
  const [confirming, setConfirming] = useState<string | null>(null);

  /** Recent uses of `code`, or null when the counts could not be measured. */
  const usesFor = (action: ReasonAction, code: string): number | null => {
    if (!code) return 0;
    if (usage === null) return null;
    return usage[action]?.[code] ?? 0;
  };

  const update = (action: ReasonAction, next: EditRow[]) =>
    setRows((prev) => ({ ...prev, [action]: next }));

  const setLabel = (action: ReasonAction, i: number, label: string) => {
    const next = rows[action].slice();
    next[i] = { ...next[i], label };
    update(action, next);
  };
  const applyToggle = (action: ReasonAction, i: number) => {
    const next = rows[action].slice();
    next[i] = { ...next[i], active: !next[i].active };
    update(action, next);
    setConfirming(null);
  };
  const toggleActive = (action: ReasonAction, i: number) => {
    const r = rows[action][i];
    // Retiring (active -> inactive) a reason still in recent use holds the toggle
    // behind an inline confirm (#990); everything else applies immediately.
    //
    // An UNMEASURED count asks too (#1657). An unreadable count must fail toward
    // asking, never toward waving the destructive edit through: the alternative
    // is that the one guard against retiring a reason people actively use is
    // silently off exactly when nothing can tell whether they do.
    const uses = usesFor(action, r.code);
    if (r.active && (uses === null || uses > 0)) {
      setConfirming(`${action}:${i}`);
      return;
    }
    applyToggle(action, i);
  };
  const move = (action: ReasonAction, i: number, delta: -1 | 1) => {
    const next = rows[action].slice();
    const j = i + delta;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    update(action, next);
  };
  const addRow = (action: ReasonAction) =>
    update(action, [...rows[action], { code: "", label: "", active: true, locked: false }]);
  const removeNew = (action: ReasonAction, i: number) =>
    update(action, rows[action].filter((_, k) => k !== i));

  // The submitted payload: display order preserved, only the fields the server needs.
  const payload = JSON.stringify(
    Object.fromEntries(
      ACTION_ORDER.map((a) => [a, rows[a].map((r) => ({ code: r.code, label: r.label, active: r.active }))]),
    ),
  );

  return (
    <SaveForm action={setReasonOptions} name="booking-reasons" className="space-y-6">
      {/* #1966: typed lists, with no other copy of them. */}
      <UnsavedGuard what="changes to these reasons" />
      {/* `data-restore-own` keeps SaveForm's blanket restore off this input: the
          value comes from the state above, which took the restored list as its
          initial value (#2008). */}
      <input type="hidden" name="payload" data-restore-own="true" value={payload} />

      {ACTION_ORDER.map((action) => (
        <section key={action} className={cardCls}>
          <h2 className="mb-3 text-sm font-semibold">{ACTION_TITLES[action]}</h2>
          <ul className="space-y-2">
            {rows[action].map((r, i) => (
              <li
                key={`${r.code}:${i}`}
                /* #1947: a GRID with fixed control tracks, not a flow row. As a
                   flow row the first column was `flex-1`, so it absorbed any
                   difference in the controls' widths: the locked row's wider
                   pill made that row's column shrink and pushed its up and down
                   buttons left, on that row only, which is the misalignment Dan
                   saw. Fixed tracks mean no row's content can move another
                   row's columns, whatever any control's width becomes later
                   (L578). */
                className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-1 border-t border-border py-1.5 first:border-t-0"
              >
                <div className="flex min-w-0 flex-col">
                  {/* #1947: "we don't need the word Label on every row". It goes
                      from the SCREEN, not from the markup: this is the input's
                      accessible name, and deleting it outright would leave the
                      field announced as an unnamed edit box (WCAG 4.1.2). Same
                      trap as #1889 on the Team access field, recorded as L577. */}
                  <label className="sr-only" htmlFor={`${action}-${i}-label`}>
                    Label
                  </label>
                  <input
                    id={`${action}-${i}-label`}
                    className={inputCls}
                    value={r.label}
                    maxLength={REASON_LABEL_MAX}
                    disabled={r.locked}
                    aria-describedby={`${action}-${i}-note`}
                    onChange={(e) => setLabel(action, i, e.target.value)}
                  />
                  {/* One line under the field rather than two, and it says the
                      thing that decides whether a reason is worth keeping.

                      THE CODE MOVED RATHER THAN VANISHING, and its placement was
                      backwards. `setReasonOptions` upserts on (action, code) and
                      a code is minted from the label only for a NEW row, so
                      renaming an existing reason never changes its code: the two
                      diverge permanently, by design, and the code is what shows
                      up in booking history, in the Regal payload and in any
                      report keyed on reasons. It used to be printed on every row
                      where it can never change and hidden on the one row where
                      the typing is choosing it. Now it is previewed while it is
                      being chosen, and reachable elsewhere. */}
                  <span
                    id={`${action}-${i}-note`}
                    className="mt-0.5 truncate text-xs text-fg-muted tabular-nums"
                    title={r.code ? `Stored code: ${r.code}${r.locked ? " (system)" : ""}` : undefined}
                  >
                    {r.code
                      ? usageHint(usesFor(action, r.code))
                      : r.label.trim()
                        ? `Will be stored as ${slugifyCode(r.label) || "an unusable code"}`
                        : "New reason"}
                  </span>
                </div>

                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    className={btnSecondaryCls}
                    aria-label={`Move ${r.label || "reason"} up`}
                    disabled={i === 0}
                    onClick={() => move(action, i, -1)}
                  >
                    &uarr;
                  </button>
                  <button
                    type="button"
                    className={btnSecondaryCls}
                    aria-label={`Move ${r.label || "reason"} down`}
                    disabled={i === rows[action].length - 1}
                    onClick={() => move(action, i, 1)}
                  >
                    &darr;
                  </button>
                </div>

                {/* #1947: a switch, and the locked row shows the SAME switch,
                    on and unmovable, rather than the words "Always on".

                    Three things that had to survive it. It is a native checkbox
                    with `role="switch"`, not a div that looks like one, so the
                    keyboard, the form and the screen reader all still work
                    (L568). The locked row still says WHY it cannot change, since
                    a disabled control announces as unavailable and never says
                    why, which would leave a dead control and no explanation
                    (L109). And it must not read as OFF: a greyed switch usually
                    means off, so the locked one keeps its filled ON track and is
                    dimmed only slightly. */}
                {r.locked ? (
                  <ReasonSwitch
                    id={`${action}-${i}-active`}
                    label={`${r.label || "This reason"} is always on`}
                    checked
                    disabled
                    describedBy={`${action}-${i}-locked`}
                    note="Always on: this reason is part of the system and cannot be retired."
                    noteId={`${action}-${i}-locked`}
                  />
                ) : r.code ? (
                  <ReasonSwitch
                    id={`${action}-${i}-active`}
                    label={`${r.label || "This reason"} is active`}
                    checked={r.active}
                    onChange={() => toggleActive(action, i)}
                  />
                ) : (
                  <button
                    type="button"
                    className={btnSecondaryCls}
                    onClick={() => removeNew(action, i)}
                  >
                    Remove
                  </button>
                )}

                {confirming === `${action}:${i}` && (
                  <div
                    role="group"
                    aria-label={`Confirm retiring ${r.label || "reason"}`}
                    className="mt-1 basis-full rounded-lg border border-border bg-fg/5 p-3"
                  >
                    <p className="text-sm text-fg">
                      {usageHint(usesFor(action, r.code))}. Retire it anyway? Retiring hides it from
                      new bookings but keeps it readable in history.
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        type="button"
                        className={btnSecondaryCls}
                        onClick={() => applyToggle(action, i)}
                      >
                        Retire it anyway
                      </button>
                      <button
                        type="button"
                        className={btnCls}
                        onClick={() => setConfirming(null)}
                      >
                        Keep it active
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>

          <button
            type="button"
            className={`${btnSecondaryCls} mt-3`}
            onClick={() => addRow(action)}
          >
            + Add reason
          </button>
        </section>
      ))}

      <SubmitButton className={btnCls} pendingLabel="Saving…">
        Save reasons
      </SubmitButton>
    </SaveForm>
  );
}
