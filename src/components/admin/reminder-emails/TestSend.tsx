"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { btnSecondaryCls } from "@/components/ui/styles";
import { SubmitPending } from "@/components/ui/SubmitButton";
import { isStaleActionError, STALE_ACTION_NOTICE } from "@/lib/stale-action";
import { REMINDER_FIELDS } from "@/lib/admin/reminder-email-form";
import { REMINDER_COPY } from "@/lib/admin/reminder-emails-copy";
import type { PreviewCaseId } from "@/lib/booking/reminder-preview";
import type { ReminderTestState } from "@/app/admin/reminder-emails/actions";

/**
 * "Send me a test" (#4299): the editor's CURRENT fields, saved or not, emailed to the
 * signed in admin for the sample call the preview shows.
 *
 * A plain button, never a submit. A submit would tell the unsaved changes guard that
 * the edits had been saved, and they have not: a test saves nothing. So it reads the
 * enclosing form's fields itself and calls the action, and draws its own three states
 * (started, still going with the seconds counting, and the outcome).
 */
export function TestSend({
  action,
  address,
  caseId,
}: {
  action: (form: FormData) => Promise<ReminderTestState>;
  address: string;
  caseId: PreviewCaseId;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const [pending, start] = useTransition();
  const [state, setState] = useState<ReminderTestState | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (!pending) return;
    const startedAt = Date.now();
    const timer = setInterval(() => setElapsedMs(Date.now() - startedAt), 1_000);
    return () => {
      clearInterval(timer);
      setElapsedMs(0);
    };
  }, [pending]);

  const send = () => {
    const form = button.current?.form;
    if (!form) return;
    const fd = new FormData(form);
    fd.set(REMINDER_FIELDS.previewCase, caseId);
    setState(null);
    start(async () => {
      try {
        setState(await action(fd));
      } catch (err) {
        setState({
          error: isStaleActionError(err)
            ? STALE_ACTION_NOTICE
            : "The test did not finish, so this page cannot tell whether it was sent. Check your inbox before sending another.",
          sent: null,
        });
      }
    });
  };

  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold text-fg">{REMINDER_COPY.testHeading}</h3>
      <p className="text-xs text-fg-muted">{REMINDER_COPY.testExplain(address)}</p>
      <button ref={button} type="button" className={btnSecondaryCls} onClick={send} disabled={pending} aria-busy={pending}>
        {pending ? <SubmitPending elapsedMs={elapsedMs} pendingLabel="Sending" /> : REMINDER_COPY.testHeading}
      </button>
      {state?.error && (
        <p role="alert" className="text-xs text-error">
          {state.error}
        </p>
      )}
      {state?.sent && (
        <p role="status" className="text-xs text-fg">
          {REMINDER_COPY.testSent(state.sent.to)}
        </p>
      )}
    </section>
  );
}
