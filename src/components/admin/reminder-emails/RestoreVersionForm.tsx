"use client";

import { SaveForm, holdsAView } from "@/components/ui/SaveForm";
import { ConfirmAction } from "@/components/ui/ConfirmAction";
import { btnSecondaryCls } from "@/components/ui/styles";
import { REMINDER_FIELDS } from "@/lib/admin/reminder-email-form";
import { REMINDER_COPY } from "@/lib/admin/reminder-emails-copy";

/**
 * One version's Restore (#4299): a button that asks first, naming what changes, then
 * posts which version to bring back. It holds no state of its own; the history above it
 * draws a refusal.
 */
export function RestoreVersionForm({
  emailId,
  loadedUpdatedAt,
  version,
  message,
  restore,
  onRefused,
}: {
  emailId: string;
  loadedUpdatedAt: string;
  version: number;
  message: string;
  restore: (form: FormData) => Promise<{ refused: string[] }>;
  onRefused: (refused: string[] | null) => void;
}) {
  return (
    <SaveForm
      action={async (form) => {
        onRefused(null);
        onRefused((await restore(form)).refused);
      }}
      name={`reminder-restore-${emailId}-${version}`}
      unsaved={holdsAView("a restore holds nothing typed: it posts which version to bring back")}
    >
      <input type="hidden" name={REMINDER_FIELDS.id} value={emailId} />
      <input type="hidden" name={REMINDER_FIELDS.loadedUpdatedAt} value={loadedUpdatedAt} />
      <input type="hidden" name={REMINDER_FIELDS.version} value={version} />
      <ConfirmAction
        className={btnSecondaryCls}
        label={REMINDER_COPY.restore}
        confirmLabel={REMINDER_COPY.restoreConfirm}
        pendingLabel="Restoring"
        message={message}
      />
    </SaveForm>
  );
}
