"use client";

import { useState } from "react";

import { setReasonOptions } from "@/app/admin/actions";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { labelCls, inputCls, cardCls, btnCls, btnSecondaryCls } from "@/components/ui/styles";
import { REASON_LABEL_MAX, type ReasonOptionRow } from "@/lib/booking/reason-options";
import type { ReasonAction } from "@/lib/booking/core";
import { REASON_USAGE_WINDOW_DAYS, type ReasonUsageCounts } from "@/lib/booking/reason-usage";

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

const EMPTY_USAGE: ReasonUsageCounts = { reschedule: {}, cancel: {}, reassign: {} };

function toEditRow(r: ReasonOptionRow): EditRow {
  return { code: r.code, label: r.label, active: r.active, locked: r.locked };
}

/** The per-row "used N times in the last 90 days" hint copy (#990). */
function usageHint(n: number): string {
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
  usage = EMPTY_USAGE,
}: {
  initial: Record<ReasonAction, ReasonOptionRow[]>;
  /** Recent per-reason usage from booking_events (#990); drives the hint and the
   *  confirm before retiring a still-used reason. Absent -> no counts (safe degrade). */
  usage?: ReasonUsageCounts;
}) {
  const [rows, setRows] = useState<Record<ReasonAction, EditRow[]>>({
    reschedule: initial.reschedule.map(toEditRow),
    cancel: initial.cancel.map(toEditRow),
    reassign: initial.reassign.map(toEditRow),
  });
  // The row awaiting a "retire a still-used reason" confirm, keyed `${action}:${i}`.
  const [confirming, setConfirming] = useState<string | null>(null);

  const usesFor = (action: ReasonAction, code: string) => (code ? (usage[action]?.[code] ?? 0) : 0);

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
    if (r.active && usesFor(action, r.code) > 0) {
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
    <form action={setReasonOptions} className="space-y-6">
      <input type="hidden" name="payload" value={payload} />

      {ACTION_ORDER.map((action) => (
        <section key={action} className={cardCls}>
          <h2 className="mb-3 text-sm font-semibold">{ACTION_TITLES[action]}</h2>
          <ul className="space-y-2">
            {rows[action].map((r, i) => (
              <li
                key={`${r.code}:${i}`}
                className="flex flex-wrap items-center gap-2 border-t border-border py-2 first:border-t-0"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <label className={labelCls} htmlFor={`${action}-${i}-label`}>
                    Label
                  </label>
                  <input
                    id={`${action}-${i}-label`}
                    className={inputCls}
                    value={r.label}
                    maxLength={REASON_LABEL_MAX}
                    disabled={r.locked}
                    onChange={(e) => setLabel(action, i, e.target.value)}
                  />
                  {r.code && (
                    <span className="text-xs text-fg-muted tabular-nums">
                      Code: {r.code}
                      {r.locked && " (system)"}
                    </span>
                  )}
                  {r.code && (
                    <span className="text-xs text-fg-muted tabular-nums">
                      {usageHint(usesFor(action, r.code))}
                    </span>
                  )}
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

                {r.locked ? (
                  <span className="rounded-full border border-border px-2 py-0.5 text-xs text-fg-muted">
                    Always on
                  </span>
                ) : r.code ? (
                  <label className="flex items-center gap-1 text-xs text-fg-muted">
                    <input
                      type="checkbox"
                      checked={r.active}
                      onChange={() => toggleActive(action, i)}
                    />
                    Active
                  </label>
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
    </form>
  );
}
