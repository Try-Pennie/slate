"use client";

import { useEffect, useId, useRef, useState } from "react";
import { SaveForm, useRestoredValue } from "@/components/ui/SaveForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { ConfirmAction } from "@/components/ui/ConfirmAction";
import { SelectField } from "@/components/ui/SelectField";
import { btnCls, inputCls, labelCls, textareaCls } from "@/components/ui/styles";
import { FillInPicker, type FillInTarget } from "@/components/admin/reminder-emails/FillInPicker";
import { ReminderPreview } from "@/components/admin/reminder-emails/ReminderPreview";
import { SwitchRow } from "@/components/admin/reminder-emails/SwitchRow";
import { TestSend } from "@/components/admin/reminder-emails/TestSend";
import { saveReminderEmail, sendReminderEmailTest } from "@/app/admin/reminder-emails/actions";
import {
  CONFIRM_WINDOW_YES,
  LATE_BOOKING_CHOICES,
  REMINDER_FIELDS,
  REMINDER_NAME_MAX,
  freshWindowMessage,
  opensFreshWindow,
} from "@/lib/admin/reminder-email-form";
import { REMINDER_COPY } from "@/lib/admin/reminder-emails-copy";
import { joinMinutes, splitMinutes, type PreviewCaseId } from "@/lib/booking/reminder-preview";
import type { ReminderEmailRow, ReminderLateBooking } from "@/lib/db/types";

/** What the editor is drawn from: one stored email. */
export type EditorEmail = Pick<
  ReminderEmailRow,
  "id" | "name" | "minutes_before" | "late_booking" | "enabled" | "subject" | "body" | "card_block" | "placeholder_sends" | "updated_at"
>;

/** What a brand new email starts with: the 1 hour shape, off. */
const NEW_EMAIL = {
  name: "",
  minutes_before: 120,
  late_booking: "skip" as ReminderLateBooking,
  enabled: false,
  subject: "Your Pennie call is {when}",
  body: "Hi, this is a reminder that {call with} is {when}.\n\n{how we call}\n\nIf that time no longer works, you can pick another or cancel here: {manage link}\n\n{signature}",
  card_block: true,
  placeholder_sends: true,
};

type SaveAction = (form: FormData) => Promise<{ refused: string[] }>;

/**
 * Edit one reminder email (#4299): its name, timing, late booking choice, on or off,
 * subject and body with the fill-in picker, the two switches, a live preview of what the
 * lead receives, and "Send me a test".
 *
 * Built on `SaveForm`, as the booker copy editor is, so it carries the unsaved changes
 * guard (a refresh and an in app link both ask), the restore of a draft kept on leaving,
 * and the notice for a save a deploy landed under. The save's refusals come back from
 * the action and are drawn here, above the fields, with everything typed kept; a save
 * that lands redirects, and the page draws its outcome.
 *
 * Every field is controlled, because the preview has to follow each keystroke, and
 * each takes a kept draft as its first value (`useRestoredValue`).
 */
export function ReminderEmailEditor({
  email,
  testAddress,
  onDirtyChange,
  save = saveReminderEmail,
  sendTest = sendReminderEmailTest,
}: {
  /** Null for a new email. */
  email: EditorEmail | null;
  /** The admin's own mailbox for "Send me a test", or null when they cannot send one. */
  testAddress: string | null;
  onDirtyChange?: (dirty: boolean) => void;
  save?: SaveAction;
  sendTest?: typeof sendReminderEmailTest;
}) {
  const [refused, setRefused] = useState<string[] | null>(null);
  const action = async (form: FormData) => {
    setRefused(null);
    const result = await save(form);
    setRefused(result.refused);
  };
  return (
    <SaveForm
      action={action}
      name={`reminder-email-${email?.id ?? "new"}`}
      unsaved="changes to this reminder email"
      className="space-y-6"
    >
      {refused && refused.length > 0 && (
        <div role="alert" className="rounded-md border border-[var(--error)] px-4 py-3 text-sm text-error">
          <p className="font-semibold">Nothing was saved.</p>
          <ul role="list" className="mt-1 space-y-1">
            {refused.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      )}
      <EditorFields email={email} testAddress={testAddress} onDirtyChange={onDirtyChange} sendTest={sendTest} />
    </SaveForm>
  );
}

/** A field's first value: the kept draft, else the stored one. */
function useInitial(field: string, stored: string): string {
  const restored = useRestoredValue(field);
  return restored ?? stored;
}

function EditorFields({
  email,
  testAddress,
  onDirtyChange,
  sendTest,
}: {
  email: EditorEmail | null;
  testAddress: string | null;
  onDirtyChange?: (dirty: boolean) => void;
  sendTest: typeof sendReminderEmailTest;
}) {
  const base = useId();
  const stored = email ?? NEW_EMAIL;
  const storedTiming = splitMinutes(stored.minutes_before);
  const initial = {
    name: useInitial(REMINDER_FIELDS.name, stored.name),
    hours: useInitial(REMINDER_FIELDS.hours, String(storedTiming.hours)),
    minutes: useInitial(REMINDER_FIELDS.minutes, String(storedTiming.minutes)),
    late: useInitial(REMINDER_FIELDS.lateBooking, stored.late_booking),
    enabled: useInitial(REMINDER_FIELDS.enabled, String(stored.enabled)) === "true",
    subject: useInitial(REMINDER_FIELDS.subject, stored.subject),
    body: useInitial(REMINDER_FIELDS.body, stored.body),
    cardBlock: useInitial(REMINDER_FIELDS.cardBlock, String(stored.card_block)) === "true",
    placeholderSends: useInitial(REMINDER_FIELDS.placeholderSends, String(stored.placeholder_sends)) === "true",
  };
  const [name, setName] = useState(initial.name);
  const [hours, setHours] = useState(initial.hours);
  const [minutes, setMinutes] = useState(initial.minutes);
  const [late, setLate] = useState(initial.late);
  // A new email is always created off, so it has no switch to move.
  const [enabled, setEnabled] = useState(email ? initial.enabled : false);
  const [subject, setSubject] = useState(initial.subject);
  const [body, setBody] = useState(initial.body);
  const [cardBlock, setCardBlock] = useState(initial.cardBlock);
  const [placeholderSends, setPlaceholderSends] = useState(initial.placeholderSends);
  const [caseId, setCaseId] = useState<PreviewCaseId>("calling_known");
  const [target, setTarget] = useState<FillInTarget>("body");
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const caretAfter = useRef<{ field: FillInTarget; at: number } | null>(null);

  const timing = joinMinutes(hours, minutes);
  const minutesBefore = timing.ok ? timing.total : Number.NaN;

  const dirty =
    name !== stored.name ||
    !timing.ok ||
    timing.total !== stored.minutes_before ||
    late !== stored.late_booking ||
    enabled !== stored.enabled ||
    subject !== stored.subject ||
    body !== stored.body ||
    cardBlock !== stored.card_block ||
    placeholderSends !== stored.placeholder_sends;
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  // After a fill-in goes in, the caret goes after it, so the next word follows on.
  useEffect(() => {
    const c = caretAfter.current;
    if (!c) return;
    caretAfter.current = null;
    const el = c.field === "subject" ? subjectRef.current : bodyRef.current;
    el?.focus();
    el?.setSelectionRange(c.at, c.at);
  });

  const insert = (token: string) => {
    const el = target === "subject" ? subjectRef.current : bodyRef.current;
    const value = target === "subject" ? subject : body;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const next = value.slice(0, start) + token + value.slice(end);
    caretAfter.current = { field: target, at: start + token.length };
    if (target === "subject") setSubject(next);
    else setBody(next);
  };

  const loadedWindow = email ? { enabled: email.enabled, minutesBefore: email.minutes_before } : null;
  const nextWindow = { enabled, minutesBefore };
  const asks = email !== null && timing.ok && opensFreshWindow(loadedWindow, nextWindow);
  const draft = { minutesBefore, subject, body, cardBlock, placeholderSends };

  const ids = {
    name: `${base}-name`,
    hours: `${base}-hours`,
    minutes: `${base}-minutes`,
    timingHelp: `${base}-timing-help`,
    timingError: `${base}-timing-error`,
    late: `${base}-late`,
    subject: `${base}-subject`,
    body: `${base}-body`,
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
      <div className="space-y-5">
        {email && <input type="hidden" name={REMINDER_FIELDS.id} value={email.id} />}
        {/* The version this editor was drawn from, so a save over somebody else's
            newer one is refused rather than silently replacing it. */}
        {email && <input type="hidden" name={REMINDER_FIELDS.loadedUpdatedAt} value={email.updated_at} />}

        <div>
          <label className={labelCls} htmlFor={ids.name}>
            Name
          </label>
          <input
            id={ids.name}
            name={REMINDER_FIELDS.name}
            data-restore-own="true"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={REMINDER_NAME_MAX}
            className={`${inputCls} max-w-125`}
          />
        </div>

        <fieldset aria-describedby={timing.ok ? ids.timingHelp : `${ids.timingHelp} ${ids.timingError}`}>
          <legend className={labelCls}>Timing</legend>
          <p id={ids.timingHelp} className="mt-0.5 text-xs text-fg-muted">
            {REMINDER_COPY.timingHelp}
          </p>
          <div className="mt-1 flex flex-wrap items-end gap-3">
            <div>
              <label className={labelCls} htmlFor={ids.hours}>
                Hours
              </label>
              <input
                id={ids.hours}
                name={REMINDER_FIELDS.hours}
                data-restore-own="true"
                inputMode="numeric"
                value={hours}
                onChange={(e) => setHours(e.target.value)}
                aria-invalid={!timing.ok}
                className={`${inputCls} w-24 tabular-nums`}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor={ids.minutes}>
                Minutes
              </label>
              <input
                id={ids.minutes}
                name={REMINDER_FIELDS.minutes}
                data-restore-own="true"
                inputMode="numeric"
                value={minutes}
                onChange={(e) => setMinutes(e.target.value)}
                aria-invalid={!timing.ok}
                className={`${inputCls} w-24 tabular-nums`}
              />
            </div>
          </div>
          {!timing.ok && (
            <p id={ids.timingError} className="mt-1 text-xs text-error">
              {timing.reason}
            </p>
          )}
        </fieldset>

        <div className="max-w-125">
          <label className={labelCls} htmlFor={ids.late}>
            A call booked after this time
          </label>
          <SelectField
            id={ids.late}
            name={REMINDER_FIELDS.lateBooking}
            value={late}
            options={LATE_BOOKING_CHOICES.map((c) => ({ value: c.value, label: c.label }))}
            onChange={setLate}
            ariaDescribedBy={`${ids.late}-help`}
          />
          <p id={`${ids.late}-help`} className="mt-1 text-xs text-fg-muted">
            {REMINDER_COPY.lateBookingHelp}
          </p>
        </div>

        {email ? (
          <SwitchRow
            name={REMINDER_FIELDS.enabled}
            label="Send this email"
            checked={enabled}
            onChange={setEnabled}
            on={REMINDER_COPY.enabledOn}
            off={REMINDER_COPY.enabledOff}
          />
        ) : (
          <>
            <input type="hidden" name={REMINDER_FIELDS.enabled} value="false" />
            <p className="text-sm text-fg-muted">{REMINDER_COPY.newEmailStartsOff}</p>
          </>
        )}

        <div>
          <label className={labelCls} htmlFor={ids.subject}>
            Subject
          </label>
          <input
            ref={subjectRef}
            id={ids.subject}
            name={REMINDER_FIELDS.subject}
            data-restore-own="true"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            onFocus={() => setTarget("subject")}
            className={inputCls}
          />
        </div>

        <div>
          <label className={labelCls} htmlFor={ids.body}>
            Body
          </label>
          <textarea
            ref={bodyRef}
            id={ids.body}
            name={REMINDER_FIELDS.body}
            rows={12}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onFocus={() => setTarget("body")}
            className={textareaCls}
          />
        </div>

        <FillInPicker target={target} onInsert={insert} />

        <div className="space-y-4">
          <SwitchRow
            name={REMINDER_FIELDS.cardBlock}
            label="Contact card"
            checked={cardBlock}
            onChange={setCardBlock}
            on={REMINDER_COPY.cardOn}
            off={REMINDER_COPY.cardOff}
          />
          <SwitchRow
            name={REMINDER_FIELDS.placeholderSends}
            label="Placeholder calls"
            checked={placeholderSends}
            onChange={setPlaceholderSends}
            on={REMINDER_COPY.placeholderOn}
            off={REMINDER_COPY.placeholderOff}
          />
        </div>

        <div>
          {!email ? (
            <SubmitButton className={btnCls} pendingLabel="Adding">
              {REMINDER_COPY.addEmail}
            </SubmitButton>
          ) : asks ? (
            <ConfirmAction
              className={btnCls}
              label="Save email"
              confirmLabel={email.enabled ? "Save the new timing" : "Save and switch on"}
              pendingLabel="Saving"
              message={freshWindowMessage(name.trim() || email.name, loadedWindow, nextWindow)}
              confirmName={REMINDER_FIELDS.confirmWindow}
              confirmValue={CONFIRM_WINDOW_YES}
            />
          ) : (
            <SubmitButton className={btnCls} pendingLabel="Saving">
              Save email
            </SubmitButton>
          )}
        </div>
      </div>

      <div className="space-y-6 lg:sticky lg:top-4 lg:self-start">
        <ReminderPreview draft={draft} caseId={caseId} onCaseChange={setCaseId} />
        {testAddress && <TestSend action={sendTest} address={testAddress} caseId={caseId} />}
      </div>
    </div>
  );
}
