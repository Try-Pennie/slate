"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { DateTimeField } from "@/components/ui/DateTimeField";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useStalledAfter } from "@/lib/useStalledAfter";
import { resolveZone } from "@/lib/booking/timezones";
import { SelectField } from "@/components/ui/SelectField";
import type { OooFormState } from "@/app/me/actions";
import { NO_MANAGER_REVIEWER } from "@/lib/ooo/core";
import {
  CANCEL_ACT_WORDS,
  cancelActForOutcomeKind,
} from "@/lib/ooo/cancel-copy";
import { UnsavedGuard } from "@/components/ui/UnsavedGuard";
import { btnSecondaryCls } from "@/components/ui/styles";

// Sentinel <option> value that reveals the searchable full-IANA fallback (#1007,
// mirroring the booker's #219 picker); a real zone id can never collide with it.

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
  allDay: boolean;
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

// restore-optin-ok: this renders its OWN form and draws its own result through
// useActionState, so it is not inside the wrapper and there is no restore for it
// to take part in. It arrives with #1998.
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
  const formRef = useRef<HTMLFormElement>(null);
  const isEditing = !!editing;
  // Once the agent starts another submit, the prior success banner is stale.
  const [submitted, setSubmitted] = useState(false);
  // React 19 auto-resets uncontrolled fields when a form action finishes, which
  // would wipe everything typed on a validation error. Control the plain inputs
  // so their values survive the reset (the DateTimeFields keep their own state).
  const [reason, setReason] = useState(editing?.reason ?? "");
  const [notes, setNotes] = useState(editing?.notes ?? "");
  const [allDay, setAllDay] = useState(editing?.allDay ?? false);
  // #1849: the list is a fixed US set now, so a stored zone outside it resolves
  // to a named default rather than being prepended. The searchable "more zones"
  // fallback (#1007) went with it: a way out of a fixed list is not a smaller
  // version of fixing the list.
  const [timezone, setTimezone] = useState(resolveZone(defaultTz).id);
  // Watchdog: a submit should take ~1s. If it's still in flight after this, a
  // request somewhere wedged (cold server, dropped connection), so stop looking
  // successful and tell the agent how to recover instead of spinning forever.
  const stalled = useStalledAfter(isPending, 15000);

  // An inline error is easy to miss if the agent is focused lower in the form,
  // so bring it into view (reduced-motion users get an instant jump via the
  // global scroll-behavior guard). Scroll to the FORM top (block:start), not the
  // error's center — centering the error pulls the section ABOVE it (Working
  // hours / Your availability) into view, which reads as scrolling to the wrong
  // place. The error banner sits at the top of the form, so it lands in view.
  useEffect(() => {
    if (state.error) {
      formRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  }, [state]);

  // Entering edit mode (this component remounts per ?edit=<id>): snap the form
  // into view immediately. A long smooth scroll up the page reads as "nothing
  // happened"; an instant jump straight to the form (no page-top overshoot,
  // with the card's entrance animation as the cue) feels responsive.
  useEffect(() => {
    if (isEditing) {
      formRef.current?.scrollIntoView({ behavior: "instant", block: "start" });
    }
  }, [isEditing]);

  const showSuccess = !!successMessage && !submitted && !state.error;
  // #2406: withdrawing a pending request and cancelling an approved one are two
  // acts, so the banner names the one that happened. The heading is read out of
  // the same table the server action redirected with, rather than a second copy
  // of the mapping that would have to stay in step with it (L70). A null act is
  // an outcome that is not one of these two (a fresh request, an edit).
  const cancelAct = cancelActForOutcomeKind(successKind);
  const cancelled = cancelAct !== null;
  const successHeading =
    successKind === "changed"
      ? "Changes saved!"
      : cancelAct
        ? CANCEL_ACT_WORDS[cancelAct].outcomeHeading
        : "Request sent!";

  return (
    <>
      {stalled && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[var(--error)] px-5 py-4 text-sm text-error"
        >
          <span>
            This is taking longer than it should. Please refresh the page and
            try again.
          </span>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className={btnSecondaryCls}
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
        ref={formRef}
        id="ooo-form"
        action={formAction}
        autoComplete="off"
        onSubmit={() => {
          setSubmitted(true);
        }}
        className={`scroll-mt-24 rounded-md bg-surface p-6 shadow-xs dark:border dark:border-border ${
          editing
            ? "pn-confirm-enter ring-1 ring-pennie-sky dark:border-pennie-sky"
            : ""
        }`}
      >
        {/* #1966: dates and a reason somebody wrote, with no other copy. */}
        <UnsavedGuard what="changes to this request" formName="ooo-request" />
        {editing && <input type="hidden" name="request_id" value={editing.id} />}

        {state.error && (
          <div
            ref={errorRef}
            role="alert"
            className="mb-5 rounded-md border border-[var(--error)] px-5 py-4 text-sm text-error"
          >
            <p>{state.error}</p>
            {state.conflictRequestId && (
              <a
                href={`/me/time-off?edit=${state.conflictRequestId}`}
                className="mt-2 inline-flex items-center gap-1 font-semibold text-error underline underline-offset-2 hover:no-underline"
              >
                Open that request to change it
                <span aria-hidden="true">→</span>
              </a>
            )}
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
                  Saving sends it back to {managerName ?? NO_MANAGER_REVIEWER} for
                  approval.
                </p>
              )}
            </div>
          </div>
        )}

        <div className="space-y-4">
          <div>
            <label className={formLabelCls}>
              {allDay ? "Start date" : "Start date and time"}
            </label>
            <div className="mt-1">
              <DateTimeField
                nameDate="start_date"
                nameTime="start_time"
                ariaLabel={allDay ? "Start date" : "Start date and time"}
                defaultDate={editing?.startDate}
                defaultTime={editing?.startTime}
                min={bounds.minISO}
                max={bounds.maxISO}
                todayISO={bounds.todayISO}
                hideTime={allDay}
              />
            </div>
          </div>
          <div>
            <label className={formLabelCls}>
              {allDay ? "End date" : "End date and time"}
            </label>
            <div className="mt-1">
              <DateTimeField
                nameDate="end_date"
                nameTime="end_time"
                ariaLabel={allDay ? "End date" : "End date and time"}
                round="up"
                defaultDate={editing?.endDate}
                defaultTime={editing?.endTime}
                min={bounds.minISO}
                max={bounds.maxISO}
                todayISO={bounds.todayISO}
                hideTime={allDay}
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
            <SelectField
              name="timezone"
              ariaLabel="Timezone"
              value={timezone}
              onChange={setTimezone}
              className="w-56"
              options={tzOptions}
            />
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
              href="/me/time-off"
              className="rounded-md px-3 py-1.5 text-sm font-semibold text-fg-muted transition-colors hover:bg-pennie-sky-soft hover:text-fg dark:hover:bg-accent/15"
            >
              Keep it as is
            </a>
          )}
        </div>
      </form>
    </>
  );
}
