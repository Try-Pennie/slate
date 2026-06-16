"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { DateTimeField } from "@/components/ui/DateTimeField";
import { SubmitButton } from "@/components/ui/SubmitButton";
import type { OooFormState } from "@/app/me/actions";

/**
 * The agent's request/edit time-off form. Client-side so it can use
 * useActionState: a validation error comes back as state (no navigation), which
 * keeps the typed values, renders the error inline as a styled banner, and
 * never bounces the page down to the request list as if it had succeeded.
 * Success still redirects from the server action (clearing the form), and the
 * post-redirect success banner lives here too so a fresh submit can dismiss it
 * the instant it starts (otherwise a stale "sent!" could sit above an error).
 */

type Editing = {
  id: string;
  whenLine: string;
  approved: boolean;
  startDate?: string;
  startTime?: string;
  endDate?: string;
  endTime?: string;
  reason: string;
  notes: string;
};

const formLabelCls = "block text-xs font-semibold text-fg";
const fieldBaseCls =
  "h-[44px] rounded-sm border border-border bg-[var(--field)] px-3 text-fg placeholder:text-fg-muted";
const tzInputCls = `${fieldBaseCls} text-sm`;

export function OooForm({
  action,
  editing,
  managerName,
  defaultTz,
  tzOptions,
  bounds,
  successMessage,
  successKind,
}: {
  action: (prev: OooFormState, form: FormData) => Promise<OooFormState>;
  editing: Editing | null;
  managerName: string | null;
  defaultTz: string;
  tzOptions: { value: string; label: string }[];
  bounds: { minISO: string; maxISO: string; todayISO: string };
  successMessage: string | null;
  successKind: string | null;
}) {
  const [state, formAction, isPending] = useActionState<OooFormState, FormData>(
    action,
    { error: null },
  );
  const errorRef = useRef<HTMLDivElement>(null);
  // Once the agent starts another submit, the prior success banner is stale.
  const [submitted, setSubmitted] = useState(false);
  // React 19 auto-resets uncontrolled fields when a form action finishes, which
  // would wipe everything typed on a validation error. Control the plain inputs
  // so their values survive the reset (the DateTimeFields keep their own state).
  const [reason, setReason] = useState(editing?.reason ?? "");
  const [notes, setNotes] = useState(editing?.notes ?? "");
  const [allDay, setAllDay] = useState(false);
  const [timezone, setTimezone] = useState(defaultTz);
  // Watchdog: a submit should take ~1s. If it's still in flight after this, a
  // request somewhere wedged (cold server, dropped connection), so stop looking
  // successful and tell the agent how to recover instead of spinning forever.
  const [stalled, setStalled] = useState(false);

  // An inline error is easy to miss if the agent is focused lower in the form,
  // so bring it into view (reduced-motion users get an instant jump via the
  // global scroll-behavior guard).
  useEffect(() => {
    if (state.error) {
      errorRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [state]);

  useEffect(() => {
    if (!isPending) return;
    const t = setTimeout(() => setStalled(true), 15000);
    return () => clearTimeout(t);
  }, [isPending]);

  const showSuccess = !!successMessage && !submitted && !state.error;
  const cancelled = successKind === "cancelled";
  const successHeading =
    successKind === "changed"
      ? "Changes saved!"
      : cancelled
        ? "Time off cancelled"
        : "Request sent!";

  return (
    <>
      {stalled && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[var(--error)] bg-error/5 px-5 py-4 text-sm text-error"
        >
          <span>
            This is taking longer than it should. Please refresh the page and
            try again.
          </span>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-md px-3 py-1.5 text-sm font-semibold text-error transition-colors hover:bg-error/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pennie-sky"
          >
            Refresh
          </button>
        </div>
      )}

      {showSuccess && (
        <div
          role="status"
          className={`pn-confirm-enter flex items-start gap-3 rounded-md px-5 py-4 ${
            cancelled
              ? "bg-bg-alt dark:bg-surface"
              : "bg-pennie-sky-soft dark:bg-accent/15"
          }`}
        >
          <span
            aria-hidden="true"
            className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
              cancelled
                ? "bg-fg-muted/20 text-fg-muted"
                : "bg-pennie-sky text-pennie-graphite"
            }`}
          >
            {cancelled ? (
              <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M4 8h8" strokeLinecap="round" />
              </svg>
            ) : (
              <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M3.5 8.5l3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </span>
          <div>
            <p className="font-semibold text-fg">{successHeading}</p>
            <p className="mt-0.5 text-sm text-fg">{successMessage}</p>
          </div>
        </div>
      )}

      <form
        action={formAction}
        onSubmit={() => {
          setSubmitted(true);
          setStalled(false);
        }}
        className={`rounded-md bg-surface p-6 shadow-xs dark:border dark:border-border ${
          editing
            ? "pn-confirm-enter ring-1 ring-pennie-sky dark:border-pennie-sky"
            : ""
        }`}
      >
        {editing && <input type="hidden" name="request_id" value={editing.id} />}

        {state.error && (
          <div
            ref={errorRef}
            role="alert"
            className="mb-5 rounded-md border border-[var(--error)] bg-error/5 px-5 py-4 text-sm text-error"
          >
            {state.error}
          </div>
        )}

        {editing && (
          <div className="mb-5 flex items-start gap-3 border-b border-border pb-5">
            <span
              aria-hidden="true"
              className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-pennie-sky-soft text-pennie-blue dark:bg-accent/15 dark:text-pennie-sky"
            >
              <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M11.5 2.5l2 2-7.5 7.5-2.7.7.7-2.7 7.5-7.5z" strokeLinejoin="round" strokeLinecap="round" />
              </svg>
            </span>
            <div className="min-w-0">
              <p className="font-semibold text-fg">Editing your request</p>
              <p className="mt-0.5 text-sm tabular-nums text-fg-muted">
                {editing.whenLine}
              </p>
              {editing.approved && (
                <p className="mt-1 text-sm text-fg-muted">
                  Saving sends it back to {managerName ?? "your manager"} for
                  approval.
                </p>
              )}
            </div>
          </div>
        )}

        <div className="space-y-4">
          <div>
            <label className={formLabelCls}>Start date and time</label>
            <div className="mt-1">
              <DateTimeField
                nameDate="start_date"
                nameTime="start_time"
                ariaLabel="Start date and time"
                defaultDate={editing?.startDate}
                defaultTime={editing?.startTime}
                min={bounds.minISO}
                max={bounds.maxISO}
                todayISO={bounds.todayISO}
              />
            </div>
          </div>
          <div>
            <label className={formLabelCls}>End date and time</label>
            <div className="mt-1">
              <DateTimeField
                nameDate="end_date"
                nameTime="end_time"
                ariaLabel="End date and time"
                round="up"
                defaultDate={editing?.endDate}
                defaultTime={editing?.endTime}
                min={bounds.minISO}
                max={bounds.maxISO}
                todayISO={bounds.todayISO}
              />
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3">
          <label className="flex min-h-11 items-center gap-2 text-sm text-fg">
            <input
              type="checkbox"
              name="all_day"
              checked={allDay}
              onChange={(e) => setAllDay(e.target.checked)}
              className="accent-pennie-sky"
            />
            All day
          </label>
          <label className="flex items-center gap-2">
            <span className="pn-eyebrow text-fg-muted">Timezone</span>
            <select
              name="timezone"
              aria-label="Timezone"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className={tzInputCls}
            >
              {tzOptions.map((tz) => (
                <option key={tz.value} value={tz.value}>
                  {tz.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="mt-4">
          <label className={formLabelCls}>Reason</label>
          <input
            name="reason"
            aria-label="Reason"
            placeholder="Vacation, appointment, family"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className={`${fieldBaseCls} mt-1 w-full`}
          />
        </div>
        <div className="mt-4">
          <label className={formLabelCls}>
            Anything your manager should know? (optional)
          </label>
          <input
            name="notes"
            aria-label="Notes for your manager (optional)"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className={`${fieldBaseCls} mt-1 w-full`}
          />
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-4">
          <SubmitButton
            className="pn-btn pn-btn--big pn-btn--primary"
            pendingLabel={editing ? "Sending…" : "Submitting…"}
          >
            {editing ? "Send my changes" : "Request time off"}
          </SubmitButton>
          {editing && (
            <a
              href="/me#time-off"
              className="rounded-md px-3 py-1.5 text-sm font-semibold text-fg-muted transition-colors hover:bg-pennie-sky-soft hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pennie-sky dark:hover:bg-accent/15"
            >
              Keep it as is
            </a>
          )}
        </div>
      </form>
    </>
  );
}
