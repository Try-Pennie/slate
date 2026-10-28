// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// #4299: the reminder email editor, its preview, its confirmations and its history.
//
// The server actions are mocked: they pull the write path in, and what is judged here
// is what a person sees and what the form would post.
vi.mock("@/app/admin/reminder-emails/actions", () => ({
  saveReminderEmail: vi.fn(async () => ({ refused: [] })),
  restoreReminderEmailVersion: vi.fn(async () => ({ refused: [] })),
  sendReminderEmailTest: vi.fn(async () => ({ error: null, sent: null })),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

import { ReminderEmailEditor, type EditorEmail } from "./ReminderEmailEditor";
import { ReminderEmailWorkspace } from "./ReminderEmailWorkspace";
import { ReminderEmailHistory } from "./ReminderEmailHistory";
import { REMINDER_COPY } from "@/lib/admin/reminder-emails-copy";
import { REMINDER_FIELDS } from "@/lib/admin/reminder-email-form";
import { stashForm } from "@/lib/form-restore";

const HOUR: EditorEmail = {
  id: "e1",
  name: "1 hour reminder",
  minutes_before: 60,
  late_booking: "skip",
  enabled: true,
  subject: "Your Pennie call is {when}",
  body: "Hi, this is a reminder that {call with} is {when}.\n\n{how we call}\n\n{signature}",
  card_block: true,
  placeholder_sends: true,
  updated_at: "2026-10-27T10:00:00Z",
};

beforeEach(() => {
  window.sessionStorage.clear();
});

const subjectBox = () => screen.getByLabelText("Subject") as HTMLInputElement;

describe("ReminderEmailEditor", () => {
  it("previews the email as it is typed, from the advisor's mailbox", () => {
    render(<ReminderEmailEditor email={HOUR} testAddress="dana@trypennie.com" />);
    expect(screen.getByText("Your Pennie call is in about an hour, at 2:30pm EST")).toBeTruthy();
    expect(screen.getByText("Sam Rivera <sam.rivera@trypennie.com>")).toBeTruthy();
    expect(screen.getByText(REMINDER_COPY.cardAttached)).toBeTruthy();

    fireEvent.change(subjectBox(), { target: { value: "Talk soon, {when}" } });
    expect(screen.getByText("Talk soon, in about an hour, at 2:30pm EST")).toBeTruthy();

    // A typo is named in the preview, rather than previewed as literal braces.
    fireEvent.change(subjectBox(), { target: { value: "Hi {advisor}" } });
    expect(screen.getByText(/uses \{advisor\}, which is not a fill-in/)).toBeTruthy();
  });

  it("names the timing as the list does, and ties a bad timing's reason to the boxes", () => {
    render(<ReminderEmailEditor email={HOUR} testAddress={null} />);
    const group = screen.getByRole("group", { name: "Sent before the call" });
    expect(group.getAttribute("aria-describedby")).toBeNull();
    fireEvent.change(screen.getByLabelText("Minutes"), { target: { value: "75" } });
    const describedBy = group.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toMatch(/minutes must be under 60/);
  });

  it("follows the timing: a 24 hour email names the day", () => {
    render(<ReminderEmailEditor email={HOUR} testAddress={null} />);
    fireEvent.change(screen.getByLabelText("Hours"), { target: { value: "24" } });
    expect(screen.getByText("Your Pennie call is tomorrow at 2:30pm EST")).toBeTruthy();
  });

  it("inserts a fill-in from the picker where the caret is", () => {
    render(<ReminderEmailEditor email={HOUR} testAddress={null} />);
    const box = subjectBox();
    fireEvent.focus(box);
    box.setSelectionRange(0, 0);
    fireEvent.click(screen.getByRole("button", { name: "{call time}" }));
    expect(box.value).toBe("{call time}Your Pennie call is {when}");
    // The subject cannot take the block, so it is unavailable while the subject is the target.
    expect((screen.getByRole("button", { name: "{how we call}" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("asks before switching an email on, saying which calls miss it, and posts the confirmation", () => {
    render(<ReminderEmailEditor email={{ ...HOUR, enabled: false }} testAddress={null} />);
    fireEvent.click(screen.getByRole("switch", { name: "Send this email" }));
    fireEvent.click(screen.getByRole("button", { name: "Save email" }));
    const question = screen.getByRole("alert");
    expect(question.textContent).toContain('Switching "1 hour reminder" on starts it from now.');
    expect(question.textContent).toContain("A call that is already less than 1 hour away will not get it.");
    const confirm = within(question).getByRole("button", { name: "Save and switch on" }) as HTMLButtonElement;
    expect(confirm.name).toBe(REMINDER_FIELDS.confirmWindow);
    expect(confirm.value).toBe("yes");
  });

  it("asks before retiming an email that is on, naming the new timing", () => {
    render(<ReminderEmailEditor email={HOUR} testAddress={null} />);
    fireEvent.change(screen.getByLabelText("Hours"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save email" }));
    const question = screen.getByRole("alert");
    expect(question.textContent).toContain('Moving "1 hour reminder" to 2 hours before the call starts it from now.');
    expect(within(question).getByRole("button", { name: "Save the new timing" })).toBeTruthy();
  });

  it("saves a copy edit in one press, with no question", () => {
    render(<ReminderEmailEditor email={HOUR} testAddress={null} />);
    fireEvent.change(subjectBox(), { target: { value: "Soon: {when}" } });
    const save = screen.getByRole("button", { name: "Save email" });
    expect(save.getAttribute("type")).toBe("submit");
  });

  it("draws a refused save above the fields and keeps what was typed", async () => {
    const save = vi.fn(async () => ({ refused: [REMINDER_COPY.stale] }));
    render(<ReminderEmailEditor email={HOUR} testAddress={null} save={save} />);
    fireEvent.change(subjectBox(), { target: { value: "Kept {when}" } });
    await userEvent.click(screen.getByRole("button", { name: "Save email" }));
    expect(await screen.findByText(REMINDER_COPY.stale)).toBeTruthy();
    expect(save).toHaveBeenCalledTimes(1);
    expect(subjectBox().value).toBe("Kept {when}");
  });

  it("starts a new email off, with no switch to move", () => {
    const { container } = render(<ReminderEmailEditor email={null} testAddress={null} />);
    expect(screen.queryByRole("switch", { name: "Send this email" })).toBeNull();
    expect(screen.getByText(REMINDER_COPY.newEmailStartsOff)).toBeTruthy();
    const enabled = container.querySelector(`input[name="${REMINDER_FIELDS.enabled}"]`) as HTMLInputElement;
    expect(enabled.value).toBe("false");
  });

  it("sends a test as a plain button, never a submit, with the current text", async () => {
    const sendTest = vi.fn(async () => ({ error: null, sent: { to: "dana@trypennie.com", subject: "x", cardAttached: true } }));
    render(<ReminderEmailEditor email={HOUR} testAddress="dana@trypennie.com" sendTest={sendTest} />);
    expect(screen.getByText(/from and to your own mailbox \(dana@trypennie\.com\), not the advisor's/)).toBeTruthy();
    fireEvent.change(subjectBox(), { target: { value: "Unsaved {when}" } });
    const button = screen.getByRole("button", { name: "Send me a test" });
    expect(button.getAttribute("type")).toBe("button");
    await userEvent.click(button);
    expect(await screen.findByText(/Test sent to dana@trypennie\.com/)).toBeTruthy();
    const posted = (sendTest.mock.calls[0] as unknown as [FormData])[0];
    expect(posted.get(REMINDER_FIELDS.subject)).toBe("Unsaved {when}");
    expect(posted.get(REMINDER_FIELDS.previewCase)).toBe("calling_known");
  });

  // Coordinator review, 2026-10-27: the labels, the options and the switch already say
  // these, so a sentence restating them is the interface explained (L604, L605).
  it("carries no sentence that restates a label, an option or a switch's position", () => {
    const { container } = render(<ReminderEmailEditor email={HOUR} testAddress="dana@trypennie.com" />);
    const text = container.textContent ?? "";
    for (const gone of [
      "How long before the call the email goes out",
      "What happens when a call is booked after",
      "Leads get this email",
      "No lead gets this email",
      "Fill-ins become the call's own details",
      "Sends this text, saved or not",
    ]) {
      expect(text, gone).not.toContain(gone);
    }
    expect(screen.getByRole("switch", { name: "Send this email" }).getAttribute("aria-describedby")).toBeNull();
    // The domain explanations stay.
    expect(text).toContain(REMINDER_COPY.cardOn);
    expect(text).toContain(REMINDER_COPY.placeholderOn);
    expect(screen.getByText("Goes from and to your own mailbox (dana@trypennie.com), not the advisor's.")).toBeTruthy();
  });

  it("warns before an in app link takes away unsaved edits", async () => {
    const user = userEvent.setup();
    render(
      <>
        <a href="/admin/buckets">Buckets</a>
        <ReminderEmailEditor email={HOUR} testAddress={null} />
      </>,
    );
    await user.type(subjectBox(), " now");
    await user.click(screen.getByRole("link", { name: "Buckets" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("You have unsaved changes to this reminder email");
  });

  it("puts back a draft kept on leaving, the body and the switches included", () => {
    stashForm(
      window.sessionStorage,
      window.location.pathname,
      "reminder-email-e1",
      {
        [REMINDER_FIELDS.subject]: ["Kept subject {when}"],
        [REMINDER_FIELDS.body]: ["Kept body {signature}"],
        [REMINDER_FIELDS.cardBlock]: ["false"],
      },
      "navigation",
    );
    render(<ReminderEmailEditor email={HOUR} testAddress={null} />);
    expect(subjectBox().value).toBe("Kept subject {when}");
    expect((screen.getByLabelText("Body") as HTMLTextAreaElement).value).toBe("Kept body {signature}");
    expect((screen.getByRole("switch", { name: "Contact card" }) as HTMLInputElement).checked).toBe(false);
    // The body is restored from the draft by the editor itself, so it opts out of the
    // form's blanket restore rather than having it fight the field's own state.
    expect(screen.getByLabelText("Body").getAttribute("data-restore-own")).toBe("true");
  });

  it("lets an in app link go when nothing was changed", async () => {
    const user = userEvent.setup();
    render(
      <>
        <a href="/admin/buckets">Buckets</a>
        <ReminderEmailEditor email={HOUR} testAddress={null} />
      </>,
    );
    await user.click(screen.getByRole("link", { name: "Buckets" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

describe("ReminderEmailWorkspace for a manager", () => {
  it("shows the email and its preview, with nothing that saves, sends or restores", () => {
    render(
      <ReminderEmailWorkspace
        email={HOUR}
        canEdit={false}
        readOnlyNote={REMINDER_COPY.readOnly}
        testAddress="manager@trypennie.com"
        versions={[
          {
            version: 1,
            snapshot: { subject: "Old {when}", body: "Old {manage link}", card_block: false, placeholder_sends: true },
            who: "Dana",
            when: "Oct 1, 2026, 9:00 AM ET",
          },
        ]}
        versionsTotal={1}
      />,
    );
    expect(screen.getByText(REMINDER_COPY.readOnly)).toBeTruthy();
    expect(screen.getByText("Your Pennie call is in about an hour, at 2:30pm EST")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send me a test" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
    // The history is still readable.
    expect(screen.getByText("Version 1")).toBeTruthy();
    // Timing, on or off and the late booking choice are on the email's list row, so
    // the read only view does not say them a second time.
    for (const term of ["Timing", "Send this email", "A call booked after this time"]) {
      expect(screen.queryByText(term), term).toBeNull();
    }
    expect(screen.getByText("Contact card")).toBeTruthy();
  });

  it("says the history could not be read, rather than showing none", () => {
    render(
      <ReminderEmailWorkspace email={HOUR} canEdit={false} readOnlyNote={REMINDER_COPY.readOnly} testAddress={null} versions={null} versionsTotal={0} />,
    );
    expect(screen.getByRole("alert").textContent).toBe(REMINDER_COPY.historyUnreadable);
  });
});

describe("ReminderEmailHistory", () => {
  const current = { subject: HOUR.subject, body: HOUR.body, card_block: true, placeholder_sends: true };
  const versions = [
    { version: 2, snapshot: current, who: "Dana", when: "Oct 27, 2026, 9:00 AM ET" },
    {
      version: 1,
      snapshot: { ...current, body: "Older body {signature}", card_block: false },
      who: "Set up with Slate",
      when: "Oct 20, 2026, 9:00 AM ET",
    },
  ];

  it("lists who saved each version and when, and says which one is the copy now", () => {
    render(
      <ReminderEmailHistory emailId="e1" loadedUpdatedAt={HOUR.updated_at} current={current} versions={versions} total={2} canRestore editorDirty={false} />,
    );
    expect(screen.getByText("Dana, Oct 27, 2026, 9:00 AM ET")).toBeTruthy();
    expect(screen.getByText(REMINDER_COPY.restoreNothing)).toBeTruthy();
    // Only the version that differs offers a restore.
    expect(screen.getAllByRole("button", { name: "Restore" })).toHaveLength(1);
  });

  it("asks before restoring, listing exactly what changes and that timing and on or off stay", () => {
    render(
      <ReminderEmailHistory emailId="e1" loadedUpdatedAt={HOUR.updated_at} current={current} versions={versions} total={2} canRestore editorDirty={false} />,
    );
    // The card says nothing about restore until it is pressed: the question does.
    expect(screen.queryByText(/stay as they are/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    const question = screen.getByRole("alert").textContent ?? "";
    expect(question).toContain("Restoring version 1 changes the body and the contact card switch.");
    expect(question).toContain("The timing and whether it is on stay as they are.");
    expect(question).not.toContain("unsaved");
    expect(screen.getByRole("button", { name: REMINDER_COPY.restoreConfirm })).toBeTruthy();
  });

  it("warns that a restore replaces unsaved edits in the editor", () => {
    render(
      <ReminderEmailHistory emailId="e1" loadedUpdatedAt={HOUR.updated_at} current={current} versions={versions} total={2} canRestore editorDirty />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(screen.getByRole("alert").textContent).toContain("Your unsaved changes in the editor above are replaced.");
  });

  it("says how many older versions are not shown", () => {
    render(
      <ReminderEmailHistory emailId="e1" loadedUpdatedAt={HOUR.updated_at} current={current} versions={versions} total={40} canRestore editorDirty={false} />,
    );
    expect(screen.getByText(REMINDER_COPY.historyShowing(2, 40))).toBeTruthy();
  });
});
