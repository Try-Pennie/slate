"use client";

import { useId } from "react";
import { SelectField } from "@/components/ui/SelectField";
import { labelCls } from "@/components/ui/styles";
import { Pill } from "@/components/ui/Pill";
import { describeTemplateProblem } from "@/lib/booking/reminder-template";
import { PREVIEW_CASES, previewCase, previewReminder, type PreviewCaseId, type ReminderDraft } from "@/lib/booking/reminder-preview";
import { REMINDER_COPY } from "@/lib/admin/reminder-emails-copy";

/**
 * What the lead in one sample call receives from the draft as it stands (#4299),
 * rendered by the same `renderReminder` the send lane uses, so the preview is the email.
 *
 * Client side and live: it follows every keystroke. Five sample calls, one shown at a
 * time behind a picker, so each case is a read rather than a scroll; the picked one is
 * also the call "Send me a test" uses.
 */
export function ReminderPreview({
  draft,
  caseId,
  onCaseChange,
}: {
  draft: ReminderDraft;
  caseId: PreviewCaseId;
  onCaseChange: (id: PreviewCaseId) => void;
}) {
  const base = useId();
  const c = previewCase(caseId) ?? PREVIEW_CASES[0]!;
  const preview = previewReminder(draft, c);

  return (
    <section aria-labelledby={`${base}-h`} className="space-y-3">
      <h3 id={`${base}-h`} className="text-sm font-semibold text-fg">
        {REMINDER_COPY.previewHeading}
      </h3>
      <div>
        <label className={labelCls} id={`${base}-case-label`} htmlFor={`${base}-case`}>
          Sample call
        </label>
        {/* No name: which call is previewed is a view, not part of the email, so it is
            never posted with the save and never counts as an unsaved change. */}
        <SelectField
          id={`${base}-case`}
          value={c.id}
          options={PREVIEW_CASES.map((p) => ({ value: p.id, label: p.label }))}
          onChange={(v) => onCaseChange(v as PreviewCaseId)}
          ariaDescribedBy={`${base}-note`}
        />
        <p id={`${base}-note`} className="mt-1 text-xs text-fg-muted">
          {REMINDER_COPY.previewNote}
        </p>
      </div>

      <div
        data-preview-case={c.id}
        className="rounded-[var(--radius-lg)] border border-border bg-[var(--field)] px-4 py-3 text-sm"
        aria-live="polite"
      >
        {preview.kind === "not_sent" && <p className="text-fg-muted">{REMINDER_COPY.previewNotSent}</p>}
        {preview.kind === "refused" && (
          <ul role="list" className="space-y-1 text-error">
            {preview.problems.map((p) => (
              <li key={describeTemplateProblem(p)}>{describeTemplateProblem(p)}</li>
            ))}
          </ul>
        )}
        {preview.kind === "rendered" && (
          <dl className="space-y-2">
            <div className="flex flex-wrap gap-x-2">
              <dt className="font-semibold text-fg-muted">From</dt>
              <dd className="min-w-0 break-words text-fg">
                {preview.fromName} &lt;{preview.fromAddress}&gt;
              </dd>
            </div>
            <div className="flex flex-wrap gap-x-2">
              <dt className="font-semibold text-fg-muted">Subject</dt>
              <dd className="min-w-0 break-words text-fg">{preview.subject}</dd>
            </div>
            <div>
              <dt className="sr-only">Body</dt>
              <dd className="whitespace-pre-wrap break-words border-t border-border pt-2 text-fg">{preview.body}</dd>
            </div>
            <div>
              <dt className="sr-only">Attachment</dt>
              <dd>
                {/* Words carry it, never the pill's colour alone. */}
                <Pill variant={preview.cardAttached ? "status-pending" : "outline"}>
                  {preview.cardAttached ? REMINDER_COPY.cardAttached : REMINDER_COPY.noCard}
                </Pill>
              </dd>
            </div>
          </dl>
        )}
      </div>
    </section>
  );
}
