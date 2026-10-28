"use client";

import { useState } from "react";
import { cardCls } from "@/components/ui/styles";
import { UnreadableNotice } from "@/components/ui/UnreadableNotice";
import { ReminderEmailEditor, type EditorEmail } from "@/components/admin/reminder-emails/ReminderEmailEditor";
import { ReminderEmailReadOnly } from "@/components/admin/reminder-emails/ReminderEmailReadOnly";
import { ReminderEmailHistory, type HistoryVersion } from "@/components/admin/reminder-emails/ReminderEmailHistory";
import { REMINDER_COPY } from "@/lib/admin/reminder-emails-copy";

/**
 * The open email's two cards (#4299): the editor (or, for somebody who cannot edit, the
 * read only view), then its earlier versions. One client component over both, so the
 * restore question can warn about unsaved edits in the editor above it.
 */
export function ReminderEmailWorkspace({
  email,
  canEdit,
  readOnlyNote,
  testAddress,
  versions,
  versionsTotal,
}: {
  /** Null for a new email, which only an admin reaches. */
  email: EditorEmail | null;
  canEdit: boolean;
  /** Why the email is read only, when it is. */
  readOnlyNote: string;
  testAddress: string | null;
  /** Null when the versions could not be read. */
  versions: HistoryVersion[] | null;
  versionsTotal: number;
}) {
  const [dirty, setDirty] = useState(false);
  return (
    <>
      <section className={cardCls} aria-labelledby="reminder-editor-h">
        <h2 id="reminder-editor-h" className="mb-4 text-sm font-semibold">
          {email ? email.name : REMINDER_COPY.newEmailHeading}
        </h2>
        {canEdit ? (
          <ReminderEmailEditor
            // A fresh editor for each stored version, so a save that lands redraws
            // every field from what was saved.
            key={email ? `${email.id}:${email.updated_at}` : "new"}
            email={email}
            testAddress={testAddress}
            onDirtyChange={setDirty}
          />
        ) : email ? (
          <ReminderEmailReadOnly email={email} note={readOnlyNote} />
        ) : null}
      </section>

      {email && (
        <section className={cardCls} aria-labelledby="reminder-history-h">
          <h2 id="reminder-history-h" className="mb-2 text-sm font-semibold">
            {REMINDER_COPY.historyHeading}
          </h2>
          {versions === null ? (
            <UnreadableNotice>{REMINDER_COPY.historyUnreadable}</UnreadableNotice>
          ) : (
            <ReminderEmailHistory
              emailId={email.id}
              loadedUpdatedAt={email.updated_at}
              current={{
                subject: email.subject,
                body: email.body,
                card_block: email.card_block,
                placeholder_sends: email.placeholder_sends,
              }}
              versions={versions}
              total={versionsTotal}
              canRestore={canEdit}
              editorDirty={dirty}
            />
          )}
        </section>
      )}
    </>
  );
}
