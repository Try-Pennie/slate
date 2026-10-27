"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { removeCoordinator } from "@/app/admin/actions";
import { ConfirmQuestion } from "@/components/ui/ConfirmAction";
import { SaveForm, holdsAView } from "@/components/ui/SaveForm";
import { btnDangerCls } from "@/components/ui/styles";
import { COORDINATOR_BOOKING_COPY, removeLabel, removeQuestion } from "@/lib/admin/coordinator-booking-copy";
import type { CoordinatorsRead } from "@/lib/admin/coordinators";

const COPY = COORDINATOR_BOOKING_COPY.list;

/**
 * Every scheduling coordinator, with a Remove that asks first (#4264, D10 to D14 in
 * docs/design/coordinator-admin.html).
 *
 * The table is the Team access panel's own, so the two lists of people read alike (D10).
 * Each Remove is the red danger button, named for its person, because a removal cannot be
 * undone: Team access turns away anyone who has left, and a coordinator has no page of their
 * own to be brought back from (D11). The question opens across the row beneath its person, since a cell is too narrow to
 * hold it (D12), and it is ConfirmQuestion, the question ConfirmAction draws, with the opener
 * and the focus move owned here because the two sit in different rows.
 *
 * A failed read is its own state, never an empty table or the empty sentence (D14): either
 * would tell a super admin that nobody can book.
 */
export function CoordinatorList({
  read,
  initiallyRemoving = null,
}: {
  read: CoordinatorsRead;
  /** A row's Remove question drawn open, for the design's preview frame only. */
  initiallyRemoving?: string | null;
}) {
  const [removing, setRemoving] = useState<string | null>(initiallyRemoving);
  // Which row's opener focus goes back to after a cancel, and whether a press (rather than
  // the first render) opened the question, so the page never takes focus on load.
  const [returnTo, setReturnTo] = useState<string | null>(null);
  const [pressed, setPressed] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const openers = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    if (removing && pressed) confirmRef.current?.focus();
    else if (!removing && returnTo) openers.current.get(returnTo)?.focus();
  }, [removing, pressed, returnTo]);

  if (!read.ok) {
    return (
      <div role="alert" className="rounded-sm border border-border bg-[var(--field)] p-4">
        <p className="text-sm text-fg">{COPY.failed}</p>
        <p className="mt-2 text-sm text-fg-muted">{COPY.failedMeanwhile}</p>
      </div>
    );
  }
  if (read.rows.length === 0) return <p className="text-sm text-fg-muted">{COPY.empty}</p>;

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full min-w-[560px] text-sm">
        <thead>
          <tr className="border-b border-border bg-[var(--bg-alt)] text-left text-xs text-fg-muted">
            <th className="px-4 py-2.5 font-semibold">{COPY.person}</th>
            <th className="px-3 py-2.5 text-right font-semibold">{COPY.lastSignedIn}</th>
            <th className="px-3 py-2.5">
              <span className="sr-only">Remove</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {read.rows.map((row, i) => {
            const asking = removing === row.id;
            return (
              <Fragment key={row.id}>
                <tr className={i > 0 ? "border-t border-border" : undefined}>
                  <td className="px-4 py-3">
                    <p className="font-semibold text-fg">{row.name}</p>
                    <p className="text-xs text-fg-muted">{row.email}</p>
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums text-fg-muted">{row.lastSignedIn}</td>
                  <td className="px-3 py-3 text-right">
                    {!asking && (
                      <button
                        ref={(el) => {
                          if (el) openers.current.set(row.id, el);
                          else openers.current.delete(row.id);
                        }}
                        type="button"
                        className={btnDangerCls}
                        aria-label={removeLabel(row.name)}
                        onClick={() => {
                          setPressed(true);
                          setReturnTo(null);
                          setRemoving(row.id);
                        }}
                      >
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
                {asking && (
                  <tr>
                    <td colSpan={3} className="px-4 pb-3">
                      <SaveForm
                        action={removeCoordinator}
                        name={`coordinator-remove-${row.id}`}
                        unsaved={holdsAView("the question holds nothing typed: it is one button carrying a fixed value")}
                      >
                        {/* Who to remove travels on the confirm itself, the pressed
                            button's own name and value (#2124's mechanism), so the
                            form holds no field to restore after a deploy. */}
                        <ConfirmQuestion
                          message={removeQuestion(row.name)}
                          confirmLabel={removeLabel(row.name)}
                          pendingLabel="Removing"
                          className={btnDangerCls}
                          confirmName="user_id"
                          confirmValue={row.id}
                          confirmRef={confirmRef}
                          onCancel={() => {
                            setReturnTo(row.id);
                            setRemoving(null);
                          }}
                        />
                      </SaveForm>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
