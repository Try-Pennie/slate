import { UnreadableNotice } from "@/components/ui/UnreadableNotice";
import { reminderStatusSummary, type ReminderStatusReading } from "@/lib/booking/reminder-status";

/**
 * One reminder email's last 24 hours, drawn in its row's "Last 24 hours" cell on
 * /admin/reminder-emails (#4300; settled design docs/design/reminder-email-status.html):
 * sent, failed, skipped by reason, the earlier job's untimed sends, and the last send,
 * in `reminderStatusSummary`'s words (D3).
 *
 * The page reads every listed email's status once (`loadReminderEmailStatus`) and hands
 * the same reading to each row. A read that failed is the could not read notice, never
 * zeros, and an email the reading does not answer is treated the same way (D4). A
 * failing email's first line is bold in the error colour, and every other line muted,
 * so a failure stands out while a healthy email stays quiet (D2).
 */
export function ReminderEmailStatus({ reading, emailId }: { reading: ReminderStatusReading; emailId: string }) {
  const counts = reading.status === "read" ? reading.byEmail[emailId] : undefined;
  const summary = reminderStatusSummary(counts ?? "unreadable");
  if (summary.tone === "unreadable") {
    return <UnreadableNotice className="px-2 py-1 text-xs">{summary.lines[0]}</UnreadableNotice>;
  }
  const [first, ...rest] = summary.lines;
  return (
    <div className="space-y-0.5 text-xs" data-tone={summary.tone}>
      <p className={summary.tone === "failing" ? "font-semibold text-error" : "text-fg-muted"}>{first}</p>
      {rest.map((line) => (
        <p key={line} className="text-fg-muted">
          {line}
        </p>
      ))}
    </div>
  );
}
