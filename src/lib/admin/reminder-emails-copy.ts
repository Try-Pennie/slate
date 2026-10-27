import type { EmailSendOutcome } from "../notify/email-errors.ts";

/**
 * The words on /admin/reminder-emails (#4299), in one place so the page, the editor and
 * the actions say each thing the same way. Pure, so the editor imports it client side.
 */

export const REMINDER_EMAILS_PATH = "/admin/reminder-emails";

/** The page with one email open in the editor, or the editor for a new one. */
export function reminderEmailPath(id: string | "new"): string {
  return `${REMINDER_EMAILS_PATH}?email=${encodeURIComponent(id)}`;
}

export const REMINDER_COPY = {
  pageIntro: "The emails a lead gets from their advisor's mailbox before the call.",
  listHeading: "Emails",
  addEmail: "Add a reminder email",
  newEmailHeading: "New reminder email",
  newEmailStartsOff: "A new email starts off, so no lead gets it until you switch it on.",
  noEmails: "No reminder emails yet, so leads get no email before their call.",
  unreadable:
    "The reminder emails could not be read just now, so this page cannot show them. Reload in a minute. Leads still get whatever is saved.",
  readOnly: "Only an admin can change these emails.",
  viewingAs:
    "You are viewing as someone else, so saving and test sends are off. Stop viewing as them to make changes in your own name.",
  viewingAsRefused:
    "Nothing was saved, because you are viewing as someone else. Stop viewing as them, then make the change in your own name.",
  saveFailed: "The reminder email could not be saved.",
  stale:
    "Someone saved this email after you opened it, so your changes were not saved. Copy anything you need, then reload to see their version.",
  missing: "This reminder email is no longer there, so nothing was saved. Reload the page.",
  noVersion: "That version could not be found, so nothing was restored. Reload the page.",
  versionUnusable: (v: number) => `Version ${v} cannot be restored as it is:`,
  versionIsCurrent: (v: number) => `Version ${v} is the copy this email already has, so there is nothing to restore.`,

  // The fields. Each explains the domain fact a reader cannot know, never the control.
  timingHelp: "How long before the call the email goes out.",
  lateBookingHelp: "What happens when a call is booked after this email's time has already passed.",
  enabledOn: "On. Leads get this email.",
  enabledOff: "Off. No lead gets this email.",
  cardOn: "When we know the number the call comes from, the email names it and attaches the advisor's contact card.",
  cardOff: "The email never names the number the call comes from, and no card is attached.",
  placeholderOn: "Calls on the placeholder advisor get this email, with Pennie's fixed placeholder wording.",
  placeholderOff: "Calls on the placeholder advisor do not get this email.",
  fillInHelp: "Fill-ins become the call's own details when the email is sent.",

  previewHeading: "What the lead receives",
  previewNote: "For a sample call on Thursday 5 November at 2:30pm in New York, with invented names and numbers.",
  previewNotSent: "This call does not get this email.",
  cardAttached: "Contact card attached",
  noCard: "No contact card",

  testHeading: "Send me a test",
  testExplain: (address: string) =>
    `Sends this text, saved or not, for the call picked above, from and to your own mailbox (${address}), not the advisor's.`,
  testNeedsOwnMailbox: (domain: string) => `A test goes only to your own @${domain} mailbox, and you are not signed in with one.`,
  testNeedsCase: "Pick which sample call the test is for.",
  testNotSentForPlaceholder:
    "A call on the placeholder advisor does not get this email, so there is nothing to send. Pick another call, or switch placeholder calls on.",
  testTooMany: "That is a lot of test sends in a short time. Wait a minute and press it again.",
  testSent: (to: string) => `Test sent to ${to}. It can take a minute to arrive.`,
  testFailed: (outcome: EmailSendOutcome, reason: string) =>
    outcome === "unknown"
      ? `Gmail did not answer, so the test may or may not arrive (${reason}). Check your inbox before sending another.`
      : `The test was not sent (${reason}).`,

  historyHeading: "Earlier versions",
  historyIntro: "Restore brings back the subject, the body and the two switches. The timing and whether it is on stay as they are.",
  historyShowing: (shown: number, total: number) => `Showing the latest ${shown} of ${total} versions.`,
  historyUnreadable: "The earlier versions could not be read just now. Reload in a minute.",
  restore: "Restore",
  restoreConfirm: "Restore this version",
  restoreMessage: (version: number, changes: string, dirty: boolean) =>
    `Restoring version ${version} changes ${changes}. The timing and whether it is on stay as they are.${
      dirty ? " Your unsaved changes in the editor above are replaced." : ""
    }`,
  restoreNothing: "Same copy as now",
} as const;
