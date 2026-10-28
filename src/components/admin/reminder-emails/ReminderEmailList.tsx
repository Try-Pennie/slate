import { InPlaceLink } from "@/components/ui/InPlaceLink";
import { Pill } from "@/components/ui/Pill";
import { btnSecondaryCls } from "@/components/ui/styles";
import { lateBookingLabel } from "@/lib/admin/reminder-email-form";
import { REMINDER_COPY, reminderEmailPath } from "@/lib/admin/reminder-emails-copy";
import { timingWords } from "@/lib/booking/reminder-preview";
import type { ReminderLateBooking } from "@/lib/db/types";

export interface ListedEmail {
  id: string;
  name: string;
  minutesBefore: number;
  enabled: boolean;
  lateBooking: ReminderLateBooking;
}

/**
 * Every reminder email, earliest sent first (#4299): its name, timing, on or off, and
 * what it does for a call booked late. The name opens it in the editor below.
 *
 * Each row keeps a slot for the email's status (phase 5: what it sent, skipped and
 * failed). Nothing is drawn in it until that phase measures something to put there.
 */
export function ReminderEmailList({
  emails,
  openId,
  canAdd,
}: {
  emails: ListedEmail[];
  openId: string | null;
  canAdd: boolean;
}) {
  return (
    <div className="space-y-4">
      {emails.length === 0 ? (
        <p className="text-sm text-fg-muted">{REMINDER_COPY.noEmails}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-fg-muted">
                <th scope="col" className="py-1 pr-4 font-semibold">
                  Email
                </th>
                <th scope="col" className="py-1 pr-4 font-semibold">
                  Sent before the call
                </th>
                <th scope="col" className="py-1 pr-4 font-semibold">
                  Sending
                </th>
                <th scope="col" className="py-1 font-semibold">
                  A call booked after this time
                </th>
              </tr>
            </thead>
            <tbody>
              {emails.map((e) => {
                const isOpen = e.id === openId;
                return (
                  <tr key={e.id} className="border-t border-border align-top" data-email={e.id}>
                    <td className="py-2 pr-4">
                      <InPlaceLink
                        href={reminderEmailPath(e.id)}
                        className={isOpen ? "font-semibold text-fg" : "text-pennie-blue underline dark:text-pennie-sky"}
                      >
                        {e.name}
                      </InPlaceLink>
                      {isOpen && <span className="sr-only"> (open below)</span>}
                      {/* Phase 5 of "Editable reminder emails" draws this email's status here. */}
                      <div data-slot="reminder-email-status" />
                    </td>
                    <td className="py-2 pr-4 tabular-nums">{timingWords(e.minutesBefore)}</td>
                    <td className="py-2 pr-4">
                      {/* Off is the exception worth seeing, so it carries the mark. */}
                      {e.enabled ? <span className="text-fg-muted">On</span> : <Pill variant="outline" alignToColumn>Off</Pill>}
                    </td>
                    <td className="py-2 text-fg-muted">{lateBookingLabel(e.lateBooking)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {canAdd && openId !== "new" && (
        <InPlaceLink href={reminderEmailPath("new")} className={btnSecondaryCls}>
          {REMINDER_COPY.addEmail}
        </InPlaceLink>
      )}
    </div>
  );
}
