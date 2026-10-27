"use client";

import { useId } from "react";
import { FILL_INS } from "@/lib/booking/reminder-template";
import { btnSecondaryCls, labelCls } from "@/components/ui/styles";

export type FillInTarget = "subject" | "body";

/**
 * The fill-ins an admin can place, as buttons (#4299). The only way to write one other
 * than typing it, and the list comes from `FILL_INS`, the same vocabulary the save and
 * the send lane accept (L611). Each one says what it becomes, on the term itself.
 *
 * It inserts into whichever of the subject and the body was last in focus. A fill-in
 * that cannot go in a subject is unavailable while the subject is the target, and
 * says why.
 */
export function FillInPicker({
  target,
  onInsert,
}: {
  target: FillInTarget;
  onInsert: (token: string) => void;
}) {
  const base = useId();
  return (
    <div role="group" aria-labelledby={`${base}-h`}>
      <p id={`${base}-h`} className={labelCls}>
        Add a fill-in to the {target}
      </p>
      <ul role="list" className="mt-2 space-y-2">
        {FILL_INS.map((f, i) => {
          const blocked = target === "subject" && !f.subject;
          const descId = `${base}-d${i}`;
          return (
            <li key={f.token} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <button
                type="button"
                className={btnSecondaryCls}
                // Keeps focus (and the caret) in the field the fill-in is going into.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onInsert(f.token)}
                disabled={blocked}
                aria-describedby={descId}
              >
                {f.token}
              </button>
              <span id={descId} className="min-w-0 flex-1 text-xs text-fg-muted">
                {blocked ? "Only in the body. " : ""}
                {f.description}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
