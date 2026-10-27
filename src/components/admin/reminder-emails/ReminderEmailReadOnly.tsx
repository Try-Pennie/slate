"use client";

import { useState } from "react";
import { ReminderPreview } from "@/components/admin/reminder-emails/ReminderPreview";
import { REMINDER_COPY } from "@/lib/admin/reminder-emails-copy";
import type { PreviewCaseId } from "@/lib/booking/reminder-preview";
import type { EditorEmail } from "@/components/admin/reminder-emails/ReminderEmailEditor";

/**
 * One reminder email for somebody who may read it but not change it (#4299): a manager,
 * or an admin while viewing as someone. The stored text and settings, and the same live
 * preview the editor shows, with no control that saves or sends.
 */
export function ReminderEmailReadOnly({ email, note }: { email: EditorEmail; note: string }) {
  const [caseId, setCaseId] = useState<PreviewCaseId>("calling_known");
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
      <div className="space-y-4">
        <p className="text-sm text-fg-muted">{note}</p>
        <dl className="space-y-3 text-sm">
          {/* The timing, on or off and the late booking choice are on this email's row
              in the list above, so they are not said a second time here. */}
          <Row term="Subject">{email.subject}</Row>
          <Row term="Body">
            <span className="block whitespace-pre-wrap break-words">{email.body}</span>
          </Row>
          <Row term="Contact card">{email.card_block ? REMINDER_COPY.cardOn : REMINDER_COPY.cardOff}</Row>
          <Row term="Placeholder calls">{email.placeholder_sends ? REMINDER_COPY.placeholderOn : REMINDER_COPY.placeholderOff}</Row>
        </dl>
      </div>
      <div className="lg:sticky lg:top-4 lg:self-start">
        <ReminderPreview
          draft={{
            minutesBefore: email.minutes_before,
            subject: email.subject,
            body: email.body,
            cardBlock: email.card_block,
            placeholderSends: email.placeholder_sends,
          }}
          caseId={caseId}
          onCaseChange={setCaseId}
        />
      </div>
    </div>
  );
}

function Row({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-semibold text-fg-muted">{term}</dt>
      <dd className="mt-0.5 text-fg">{children}</dd>
    </div>
  );
}
