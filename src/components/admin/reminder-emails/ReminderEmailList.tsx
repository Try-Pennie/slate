import { InPlaceLink } from "@/components/ui/InPlaceLink";
import { ReminderEmailStatus } from "@/components/admin/reminder-emails/ReminderEmailStatus";
import { Pill } from "@/components/ui/Pill";
import { btnSecondaryCls } from "@/components/ui/styles";
import { lateBookingLabel } from "@/lib/admin/reminder-email-form";
import { REMINDER_COPY, reminderEmailPath } from "@/lib/admin/reminder-emails-copy";
import { timingWords } from "@/lib/booking/reminder-preview";
import type { ReminderLateBooking } from "@/lib/db/types";
import type { ReminderStatusReading } from "@/lib/booking/reminder-status";

export interface ListedEmail {
  id: string;
  name: string;
  minutesBefore: number;
  enabled: boolean;
  lateBooking: ReminderLateBooking;
}

/**
 * Every reminder email, earliest sent first (#4299): its name, timing, on or off, what
 * it does for a call booked late, and, in its own last column, what it did in the last
 * 24 hours (#4300, settled design docs/design/reminder-email-status.html). The name
 * opens it in the editor below. Every row is handed the page's one status reading, so a
 * failed read shows the could not read notice in each cell rather than zeros.
 */
export function ReminderEmailList({
  emails,
  openId,
  canAdd,
  status,
}: {
  emails: ListedEmail[];
  openId: string | null;
  canAdd: boolean;
  status: ReminderStatusReading;
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
                <th scope="col" className="py-1 pr-4 font-semibold">
                  A call booked after this time
                </th>
                <th scope="col" className="py-1 font-semibold">
                  Last 24 hours
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
                    </td>
                    <td className="py-2 pr-4 tabular-nums">{timingWords(e.minutesBefore)}</td>
                    <td className="py-2 pr-4">
                      {/* Off is the exception worth seeing, so it carries the mark. */}
                      {e.enabled ? <span className="text-fg-muted">On</span> : <Pill variant="outline" alignToColumn>Off</Pill>}
                    </td>
                    <td className="py-2 pr-4 text-fg-muted">{lateBookingLabel(e.lateBooking)}</td>
                    <td className="py-2">
                      <ReminderEmailStatus reading={status} emailId={e.id} />
                    </td>
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
