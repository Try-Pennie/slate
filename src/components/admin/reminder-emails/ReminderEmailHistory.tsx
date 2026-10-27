"use client";

import { useState } from "react";
import { RestoreVersionForm } from "@/components/admin/reminder-emails/RestoreVersionForm";
import { restoreReminderEmailVersion } from "@/app/admin/reminder-emails/actions";
import { listWords, restoreChanges } from "@/lib/admin/reminder-email-form";
import { REMINDER_COPY } from "@/lib/admin/reminder-emails-copy";
import type { ReminderEmailCopy } from "@/lib/db/types";

export interface HistoryVersion {
  version: number;
  snapshot: ReminderEmailCopy;
  /** Who saved it, by name, or a sentence saying nobody is on record. */
  who: string;
  /** When, already written out for the reader. */
  when: string;
}

type RestoreAction = (form: FormData) => Promise<{ refused: string[] }>;

/**
 * Every saved version of one email's copy, newest first, with who saved it and when
 * (#4299). Restore brings back that version's subject, body and two switches, and its
 * question names exactly which of those change, and warns when the editor above holds
 * unsaved changes, since the restore replaces them.
 */
export function ReminderEmailHistory({
  emailId,
  loadedUpdatedAt,
  current,
  versions,
  total,
  canRestore,
  editorDirty,
  restore = restoreReminderEmailVersion,
}: {
  emailId: string;
  loadedUpdatedAt: string;
  current: ReminderEmailCopy;
  versions: HistoryVersion[];
  total: number;
  canRestore: boolean;
  editorDirty: boolean;
  restore?: RestoreAction;
}) {
  const [refused, setRefused] = useState<string[] | null>(null);
  return (
    <div className="space-y-3">
      {refused && refused.length > 0 && (
        <div role="alert" className="rounded-md border border-[var(--error)] px-4 py-3 text-sm text-error">
          <p className="font-semibold">Nothing was restored.</p>
          <ul role="list" className="mt-1 space-y-1">
            {refused.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      )}
      <ol role="list" className="divide-y divide-border">
        {versions.map((v) => {
          const changes = restoreChanges(current, v.snapshot);
          return (
            <li key={v.version} className="flex flex-wrap items-start gap-x-4 gap-y-2 py-3" data-version={v.version}>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-fg">Version {v.version}</p>
                <p className="text-xs text-fg-muted">
                  {v.who}, {v.when}
                </p>
                <p className="mt-1 truncate text-xs text-fg-muted" title={v.snapshot.subject}>
                  {v.snapshot.subject}
                </p>
              </div>
              {changes.length === 0 ? (
                <p className="text-xs text-fg-muted">{REMINDER_COPY.restoreNothing}</p>
              ) : canRestore ? (
                <RestoreVersionForm
                  emailId={emailId}
                  loadedUpdatedAt={loadedUpdatedAt}
                  version={v.version}
                  message={REMINDER_COPY.restoreMessage(v.version, listWords(changes), editorDirty)}
                  restore={restore}
                  onRefused={setRefused}
                />
              ) : null}
            </li>
          );
        })}
      </ol>
      {total > versions.length && (
        <p className="text-xs text-fg-muted">{REMINDER_COPY.historyShowing(versions.length, total)}</p>
      )}
    </div>
  );
}
