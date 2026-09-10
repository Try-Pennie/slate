"use client";

import { useActionState, useState } from "react";
import { DateTime } from "luxon";
import { TimeField } from "@/components/ui/TimeField";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { btnCls, btnSecondaryCls, inputCls, labelCls } from "@/components/ui/styles";
import { Pill } from "@/components/ui/Pill";
import type { BusinessHoursFormState } from "@/app/admin/actions";
import type { BusinessHoursException } from "@/lib/booking/business-hours";
import { SelectField } from "@/components/ui/SelectField";
import { UnsavedGuard } from "@/components/ui/UnsavedGuard";

/** "HH:MM" for a minute count, for the list. */
function hhmm(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

/** The date as a person writes it, never as it is stored. */
function readableDate(iso: string): string {
  const d = DateTime.fromISO(iso);
  return d.isValid ? d.toFormat("cccc d LLLL yyyy") : iso;
}

/**
 * Specific dates the org is shut, or open, whatever the weekly pattern says (#1363).
 *
 * A client component for the same reason its weekly sibling is one: a refusal
 * comes back as STATE rather than a navigation, so the entered date and note stay
 * on screen. The confirm step is likewise not an error: closing a date that
 * already holds appointments is allowed, and the person is shown the consequence
 * once before it happens.
 */
// restore-optin-ok: this component renders its own form, which is not the wrapper
// and draws its own result through useActionState. It arrives with #1998.
export function BusinessHoursExceptions({
  action,
  removeAction,
  exceptions,
  zoneLabel,
}: {
  action: (prev: BusinessHoursFormState, form: FormData) => Promise<BusinessHoursFormState>;
  removeAction: (form: FormData) => Promise<void>;
  exceptions: BusinessHoursException[];
  zoneLabel: string;
}) {
  const [state, formAction] = useActionState<BusinessHoursFormState, FormData>(action, {
    error: null,
  });
  // Closed is the overwhelmingly common case (a holiday), so it is the default and
  // the times only appear when they are actually needed.
  const [open, setOpen] = useState(false);

  return (
    <div className="space-y-5">
      {exceptions.length === 0 ? (
        <p className="text-sm text-fg-muted">
          No dates are set. Every day follows the weekly pattern above.
        </p>
      ) : (
        <ul className="space-y-2">
          {exceptions.map((e) => (
            <li
              key={e.on_date}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[var(--radius-md)] border border-border px-4 py-3"
            >
              {/* The pill carries the meaning in words: colour is never the sole
                  signal, and open and closed are the whole point of the row. */}
              <Pill variant={e.is_open ? "status-ok" : "status-error"}>
                {e.is_open ? "Open" : "Closed"}
              </Pill>
              <span className="text-sm font-semibold tabular-nums">{readableDate(e.on_date)}</span>
              {e.is_open && e.start_minute !== null && e.end_minute !== null && (
                <span className="text-sm tabular-nums text-fg-muted">
                  {hhmm(e.start_minute)} to {hhmm(e.end_minute)}
                </span>
              )}
              {e.note && <span className="text-sm text-fg-muted">{e.note}</span>}
              <form action={removeAction} className="ml-auto">
                <input type="hidden" name="on_date" value={e.on_date} />
                <SubmitButton className={btnSecondaryCls} pendingLabel="Removing...">
                  Remove
                </SubmitButton>
              </form>
            </li>
          ))}
        </ul>
      )}

      <form action={formAction} className="space-y-4">
        {/* #1966: the ADD form. The per row remove forms below hold nothing
            typed, so they carry no guard. */}
        <UnsavedGuard what="changes to this date" formName="business-hours-exception" />
        {state.error && (
          <p
            role="alert"
            className="rounded-[var(--radius-md)] border border-[rgba(196,61,61,0.35)] bg-[rgba(196,61,61,0.12)] px-4 py-3 text-sm text-[#C43D3D]"
          >
            {state.error}
          </p>
        )}

        {state.confirm && (
          <div
            role="alert"
            className="rounded-[var(--radius-md)] border border-border bg-[var(--bg-alt)] px-4 py-3 text-sm text-fg"
          >
            <p>{state.confirm.message}</p>
            {/* Carried on the NEXT submit, so confirming is a deliberate second
                action rather than something already ticked on the person's behalf. */}
            <input type="hidden" name="confirm_close" value="1" />
          </div>
        )}

        {state.ok && (
          <p
            role="status"
            className="rounded-[var(--radius-md)] border border-border bg-[var(--bg-alt)] px-4 py-3 text-sm text-fg"
          >
            Saved. Leads see that date straight away.
          </p>
        )}

        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className={labelCls} htmlFor="exception_date">
              Date
            </label>
            <input
              id="exception_date"
              name="on_date"
              type="date"
              required
              className={`${inputCls} w-44`}
            />
          </div>

          <div>
            <label className={labelCls} htmlFor="exception_state">
              Pennie is
            </label>
            <SelectField
              id="exception_state"
              name="state"
              className="w-44"
              value={open ? "open" : "closed"}
              onChange={(v) => setOpen(v === "open")}
              options={[
                { value: "closed", label: "Closed all day" },
                { value: "open", label: "Open, these hours" },
              ]}
            />
          </div>

          {open && (
            <div className="flex flex-wrap items-center gap-3">
              <TimeField name="start" ariaLabel="Opening time on this date" defaultValue="08:00" enforce />
              <span aria-hidden="true" className="text-sm text-fg-muted">
                to
              </span>
              <TimeField
                name="end"
                ariaLabel="Closing time on this date"
                defaultValue="20:00"
                round="up"
                enforce
              />
              <span className="text-xs text-fg-muted">{zoneLabel}</span>
            </div>
          )}

          <div className="min-w-[12rem] flex-1">
            <label className={labelCls} htmlFor="exception_note">
              Why (optional)
            </label>
            <input
              id="exception_note"
              name="note"
              placeholder="Christmas Day"
              className={`${inputCls} w-full`}
            />
          </div>

          <SubmitButton className={btnCls} pendingLabel="Saving...">
            Add date
          </SubmitButton>
        </div>
      </form>
    </div>
  );
}
