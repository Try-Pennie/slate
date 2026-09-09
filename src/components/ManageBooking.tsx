"use client";

import { useMemo, useState } from "react";
import { DateTime } from "luxon";

import {
  deviceTimeZone,
  timezoneOptions,
  resolveZone,
} from "@/lib/booking/timezones";
import { SelectField } from "@/components/ui/SelectField";
import { validateReason, type ReasonOption } from "@/lib/booking/core";
import ReasonPicker from "@/components/ReasonPicker";
import { AlertIcon } from "@/components/icons";
import { BookerStrip } from "@/components/BookerStrip";
import { SlotTimes, SLOT_TIMES_CLASSES } from "@/components/SlotTimes";
import { useSlotPicker } from "@/components/use-slot-picker";
import { NearestTimesPanel } from "@/components/NearestTimes";
import { rescheduleOffersAlternatives } from "@/lib/booking/nearest-slots";
import { postJson, REQUEST_TIMEOUT_MS } from "@/lib/http";
import { useStalledAfter } from "@/lib/useStalledAfter";
import { formatSlotTime } from "@/lib/booking/slot-label";
import { usePhoneCaret } from "@/lib/usePhoneCaret";
import { countdownPhrase, advisorFirstName } from "@/lib/booking/countdown";
import {
  BEFORE_COPY,
  CANCEL_COPY,
  DONE_COPY,
  LIVE_COPY,
  RESCHEDULE_COPY,
  PHONE_COPY,
  advisorWillCall,
  doneBody,
  doneHeading,
  liveHeading,
  phoneSaved as phoneSaved_,
} from "@/lib/booking/manage-copy";


interface ManageBookingProps {
  token: string;
  bucketCode: string;
  startsAt: string;
  status: string;
  eventName: string;
  /** Length of the call in minutes, from the event type. */
  durationMin: number;
  /** The number the advisor will call, as the lead gave it. Null when absent, in
   *  which case the copy says "the number you gave us" rather than a blank. */
  attendeePhone: string | null;
  /** Where the fresh invite goes after a reschedule. Null drops that clause. */
  attendeeEmail: string | null;
  /** The advisor the call is CURRENTLY with, resolved live server-side (#1338).
   *  Null when unresolvable, and then no name is rendered anywhere: coverage
   *  reassignment and bulk reassign both move a booking, so a stale or borrowed
   *  name would promise a lead one person and send another (L75). */
  advisorName: string | null;
  /** The advisor's lead-facing title, shown under the name. Null hides the line. */
  advisorRole: string | null;
  /** Active reschedule/cancel reason options, resolved from the store server-side
   *  (#346). Used for both the pickers and the client-side validate gate, so the
   *  UI and server share the same live set. */
  rescheduleReasons: ReasonOption[];
  cancelReasons: ReasonOption[];
  /** Presentational only; scopes the Pennie tokens via data-theme. */
  theme?: "light" | "dark";
}

function XIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
    </svg>
  );
}

/** US order everywhere (#1336): "Monday, August 17", never "17 August". */
function longDay(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date(iso));
}

/** Time alone, e.g. "10:00am". Lowercase meridiem to match the booker. */
function timeOnly(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" })
    .format(new Date(iso))
    .replace(/\s?([AP]M)$/, (_m, p: string) => p.toLowerCase());
}

/** Initials for the advisor avatar: "Aisha Bello" -> "AB". */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function ClockIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" strokeLinecap="round" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18" />
    </svg>
  );
}

export default function ManageBooking({
  token,
  bucketCode,
  startsAt,
  status: initialStatus,
  eventName,
  durationMin,
  attendeePhone,
  attendeeEmail,
  advisorName,
  advisorRole,
  rescheduleReasons,
  cancelReasons,
  theme = "light",
}: ManageBookingProps) {
  const detectedZone = useMemo(() => deviceTimeZone(), []);
  // #1849: a fixed US list. A lead whose browser reports a non US zone is shown
  // Eastern rather than their own, which is the trade Dan took: the booked
  // instant is always UTC so nothing is mis-booked, but what they READ is a US
  // clock. The "more zones" search went with it, since a way out of a fixed list
  // is not a smaller version of fixing the list.
  const [timeZone, setTimeZone] = useState(resolveZone(detectedZone).id);
  const selectOptions = useMemo(() => timezoneOptions(), []);
  const [start, setStart] = useState(startsAt);
  // Pinned at mount, refreshed when a reschedule lands, so the countdown below is
  // a pure function of (start, nowMs) rather than of the wall clock mid-render.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [status, setStatus] = useState(initialStatus);
  const [rescheduling, setRescheduling] = useState(false);
  const today = useMemo(
    () => DateTime.now().setZone(timeZone).startOf("day"),
    [timeZone],
  );
  // Null while the panel is shut: nothing is fetched, and the picker settles as
  // "no days" rather than sitting in a load that never runs.
  const picker = useSlotPicker({
    url: rescheduling ? `/api/availability?bucket=${encodeURIComponent(bucketCode)}` : null,
    zone: timeZone,
  });
  const [busy, setBusy] = useState(false);
  // Still-alive cue if a cancel/reschedule POST hasn't returned by ~10s; the
  // REQUEST_TIMEOUT_MS abort then converts a true hang into the error below (#626).
  const stalled = useStalledAfter(busy);
  const [error, setError] = useState<string | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [pendingIso, setPendingIso] = useState<string | null>(null);
  // #1549: the time a move was just refused for, or null. Set only when the refusal
  // means that time is not available, so the alternatives can leave it out.
  const [refusedSlot, setRefusedSlot] = useState<string | null>(null);

  // #1341: the number the advisor rings, corrected in place. Held in state (not
  // read from the prop) so a successful save is reflected without a reload.
  const [phone, setPhone] = useState(attendeePhone);
  const [editingPhone, setEditingPhone] = useState(false);
  const [phoneDraft, setPhoneDraft] = useState(attendeePhone ?? "");
  const [phoneError, setPhoneError] = useState<string | null>(null);
  // The booker's own as-you-type formatter AND its caret handling, through one
  // hook (#2162), so an impossible number cannot be typed in either place and
  // neither surface can lose the lead's cursor while the other keeps it.
  const { attach: attachPhoneInput, onChange: onPhoneChange } = usePhoneCaret((formatted) => {
    setPhoneDraft(formatted);
    setPhoneError(null);
  });
  const [savingPhone, setSavingPhone] = useState(false);
  const [phoneSaved, setPhoneSaved] = useState(false);
  const phoneStalled = useStalledAfter(savingPhone);

  // Mandatory reschedule/cancel reason (#326).
  const [reschedReason, setReschedReason] = useState("");
  const [reschedDetail, setReschedDetail] = useState("");
  const [cancelReason, setCancelReason] = useState("");
  const [cancelDetail, setCancelDetail] = useState("");
  const reschedReasonValid = validateReason(
    { code: reschedReason, detail: reschedDetail },
    rescheduleReasons,
  ).ok;
  const cancelReasonValid = validateReason(
    { code: cancelReason, detail: cancelDetail },
    cancelReasons,
  ).ok;

  // A cancelled OR completed booking is terminal: neither may be rescheduled or
  // cancelled, so both drop the live actions. Only `cancelled` gets the struck
  // time and the rebook offer; a completed call simply has nothing to act on.
  const done = status === "cancelled" || status === "completed";
  const longDayOf = (iso: string) => longDay(iso, timeZone);
  const timeOf = (iso: string) => timeOnly(iso, timeZone);
  // Derived from the booking's CURRENT time, so a reschedule moves it. The clock
  // is read once per mount (and again when a reschedule lands) rather than during
  // render, which would be an impure read React can re-run unpredictably.
  const countdown = countdownPhrase(start, nowMs, timeZone);

  /** Leave the reschedule panel without moving anything, clearing the reason and
   *  the chosen day so reopening it starts clean. */
  function closeReschedule() {
    setRescheduling(false);
    setReschedReason("");
    setReschedDetail("");
    picker.selectDay(null);
    setError(null);
  }

  async function reschedule(newStart: string) {
    setBusy(true);
    setError(null);
    setRefusedSlot(null);
    setPendingIso(newStart);
    try {
      const { ok, status, data } = await postJson<{
        startsAt?: string;
        error?: string;
        reason?: string;
      }>(
        `/api/bookings/${token}/reschedule`,
        {
          start: newStart,
          reason: reschedReason,
          reasonDetail: reschedDetail || undefined,
        },
        { timeoutMs: REQUEST_TIMEOUT_MS },
      );
      if (ok) {
        setStart(data.startsAt ?? newStart);
        setNowMs(Date.now());
        setStatus("rescheduled");
        setRescheduling(false);
      } else {
        setError(data.error ?? RESCHEDULE_COPY.failed);
        // #1549: the honest error stays and the soonest times still open go beneath it,
        // but only when the refusal actually means that time is not available. A booking
        // that moved under this page needs "refresh" to stand alone, and a failure that
        // never measured the time must not imply one went (L11).
        if (rescheduleOffersAlternatives(status, data.reason)) {
          setRefusedSlot(newStart);
          // Re-run the load so the stale list is swapped for the loading state rather
          // than left tappable with a time that has gone.
          picker.retry();
        }
      }
    } finally {
      setPendingIso(null);
      setBusy(false);
    }
  }

  function closePhoneEdit() {
    setEditingPhone(false);
    setPhoneError(null);
  }

  /**
   * Save the corrected number.
   *
   * The panel stays OPEN and the old number stays on screen until the server
   * confirms: a failed save that closed the field and showed the new digits
   * would tell the lead their advisor has a number we never stored, which is the
   * exact defect this control exists to prevent (L12).
   */
  async function savePhone() {
    setSavingPhone(true);
    setPhoneError(null);
    try {
      const { ok, data } = await postJson<{ phone?: string; error?: string }>(
        `/api/bookings/${token}/phone`,
        { phone: phoneDraft },
        { timeoutMs: REQUEST_TIMEOUT_MS },
      );
      if (ok && data.phone) {
        setPhone(data.phone);
        setPhoneSaved(true);
        setEditingPhone(false);
      } else {
        // The server's own sentence when it gave one: it distinguishes a number
        // we cannot call from an incomplete one, and a generic fallback here
        // would flatten that back into "invalid".
        setPhoneError(data.error ?? PHONE_COPY.failed);
      }
    } finally {
      setSavingPhone(false);
    }
  }

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      const { ok, data } = await postJson<{ error?: string }>(
        `/api/bookings/${token}/cancel`,
        {
          reason: cancelReason,
          reasonDetail: cancelDetail || undefined,
        },
        { timeoutMs: REQUEST_TIMEOUT_MS },
      );
      if (ok) {
        setStatus("cancelled");
        setConfirmingCancel(false);
      } else {
        // Previously a native confirm() with no visible failure path: a failed
        // POST left the page looking unchanged. Surface it instead.
        setError(data.error ?? CANCEL_COPY.failed);
      }
    } finally {
      setBusy(false);
    }
  }

  // The card is sized to its content (about 740px), not to the booker's width:
  // at the booker's width this column carried ~415px of content and 300px of
  // nothing. `min-h-dvh bg-bg` keeps the beige gutter behind it.
  return (
    <div data-theme={theme} className="min-h-dvh bg-bg p-6 text-fg">
      <div className="mx-auto max-w-[740px]">
        {/* #1336: a completed reschedule states its outcome. The panel used to
            simply re-render, so a lead had no confirmation the move landed, that
            a fresh invite was coming, or that the old time had been released. */}
        {status === "rescheduled" && !rescheduling && (
          <div
            role="status"
            className="mb-4 rounded-2xl bg-pennie-sky-soft px-6 py-5 dark:bg-accent/15"
          >
            <p className="text-sm font-semibold text-fg">Your call is moved</p>
            <p className="mt-1 text-sm text-fg-muted">
              It is now{" "}
              <span className="tabular-nums text-fg">
                {longDayOf(start)} at {timeOf(start)}
              </span>
              .{attendeeEmail ? ` A new invite is on its way to ${attendeeEmail}, and` : " A new invite is on its way, and"}{" "}
              the time you were holding has been released.
            </p>
          </div>
        )}

        <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-xs">
          {/* One grid, five blocks. Narrow width has its OWN order (#1338): most
              people open this from a calendar reminder on a phone, so the time
              comes first, then the advisor and the actions, then the event
              detail. Stacking the desktop columns would put the event
              description between the time and the actions. */}
          <div className="flex flex-col md:grid md:grid-cols-[300px_1fr]">
            {/* --- Event identity --- */}
            <div className="order-4 border-t border-border px-6 py-5 md:order-none md:col-start-1 md:row-start-1 md:border-t-0 md:border-r md:pb-0">
              <div
                className="mb-4 flex h-9 w-9 items-center justify-center rounded-full bg-pennie-sky-soft text-xs font-semibold text-fg dark:bg-accent/20"
                aria-hidden="true"
              >
                PE
              </div>
              <h1 className="text-base font-semibold leading-snug text-fg">{eventName}</h1>
            </div>

            {/* --- When --- */}
            <div className="order-1 px-6 pt-5 md:order-none md:col-start-1 md:row-start-2 md:border-r md:border-border md:pt-4">
              <p className="text-sm text-fg-muted">{longDayOf(start)}</p>
              <p
                data-hero-time
                className={`mt-0.5 text-[26px] font-semibold leading-tight tabular-nums text-fg ${
                  status === "cancelled" ? "line-through decoration-2" : ""
                }`}
              >
                {timeOf(start)}
              </p>
              {status === "cancelled" && (
                <p className="mt-1 text-sm font-semibold text-[var(--error)]">Cancelled</p>
              )}
              <div className="mt-4 space-y-2 text-sm text-fg">
                <div className="flex items-center gap-2">
                  <span className="text-fg-muted">
                    <ClockIcon />
                  </span>
                  {durationMin} minutes
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-fg-muted">
                    <GlobeIcon />
                  </span>
                  <label htmlFor="manage-tz" className="sr-only">
                    Timezone
                  </label>
                  <SelectField
                    id="manage-tz"
                    ariaLabel="Timezone"
                    value={timeZone}
                    onChange={setTimeZone}
                    className="max-w-full"
                    options={selectOptions.map((o) => ({ value: o.id, label: o.label }))}
                  />
                </div>
              </div>
            </div>

            {/* --- The advisor. Dropped entirely when unresolvable (L75): a
                    booking can be reassigned, so no name is better than the
                    wrong one. --- */}
            <div className="order-2 px-6 pb-5 pt-5 md:order-none md:col-start-1 md:row-start-3 md:border-r md:border-border">
              {advisorName && (
                <div className="flex items-center gap-3 border-t border-border pt-5">
                  <span
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--bg-alt)] text-[11px] font-semibold text-fg"
                    aria-hidden="true"
                  >
                    {initialsOf(advisorName)}
                  </span>
                  <span>
                    <span className="block text-sm font-semibold text-fg">{advisorName}</span>
                    {advisorRole && (
                      <span className="block text-xs text-fg-muted">{advisorRole}</span>
                    )}
                  </span>
                </div>
              )}
            </div>

            {/* --- What you are doing --- */}
            <div className="order-3 px-6 py-5 md:order-none md:col-start-2 md:row-start-1 md:row-span-2">
              {done ? (
                <>
                  <h2 className="text-base font-semibold text-fg">
                    {doneHeading(status)}
                  </h2>
                  <p className="mt-2 text-sm text-fg-muted">
                    {doneBody(status)}
                  </p>
                  <a
                    href={`/book?xbc=${encodeURIComponent(bucketCode)}`}
                    className="pn-btn pn-btn--primary mt-4 inline-flex min-h-[44px] rounded-lg px-5 text-sm"
                  >
                    {DONE_COPY.bookAgain}
                  </a>
                </>
              ) : confirmingCancel ? (
                <div className="rounded-lg border border-[var(--error)] bg-[rgba(196,61,61,0.04)] p-4">
                  <p className="text-sm font-semibold text-fg">{CANCEL_COPY.heading}</p>
                  <p className="mt-1 text-sm text-fg-muted">
                    {CANCEL_COPY.consequence}
                  </p>
                  <div className="mt-4">
                    <ReasonPicker
                      legend={CANCEL_COPY.reasonLegend}
                      options={cancelReasons}
                      code={cancelReason}
                      detail={cancelDetail}
                      onCode={setCancelReason}
                      onDetail={setCancelDetail}
                      idPrefix="cancel-reason"
                    />
                  </div>
                  <div className="mt-4 flex flex-wrap gap-3">
                    <button
                      onClick={cancel}
                      disabled={busy || !cancelReasonValid}
                      className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-[var(--error)] px-5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
                    >
                      <XIcon />
                      {busy ? CANCEL_COPY.confirming : CANCEL_COPY.confirm}
                    </button>
                    <button
                      onClick={() => {
                        setConfirmingCancel(false);
                        setCancelReason("");
                        setCancelDetail("");
                      }}
                      disabled={busy}
                      className="pn-btn pn-btn--additional min-h-[44px] rounded-lg px-5 text-sm"
                    >
                      {CANCEL_COPY.keep}
                    </button>
                  </div>
                </div>
              ) : rescheduling ? (
                <div>
                  <div className="mb-4">
                    <ReasonPicker
                      legend={RESCHEDULE_COPY.reasonLegend}
                      options={rescheduleReasons}
                      code={reschedReason}
                      detail={reschedDetail}
                      onCode={setReschedReason}
                      onDetail={setReschedDetail}
                      idPrefix="reschedule-reason"
                    />
                  </div>
                  <p className="mb-3 text-sm font-semibold text-fg">
                    {reschedReasonValid
                      ? RESCHEDULE_COPY.pickReady
                      : RESCHEDULE_COPY.pickBlocked}
                  </p>
                  {/* The same day strip and times panel the booker runs on
                      (#1336), so a lead moving a call meets the surface they
                      booked on. No time renders until a day is chosen. */}
                  <div className="mb-4">
                    <BookerStrip
                      today={today}
                      days={picker.days}
                      activeDay={picker.selectedDay}
                      zone={timeZone}
                      onSelect={picker.selectDay}
                    />
                  </div>
                  <SlotTimes
                    view={picker.view}
                    timeZone={timeZone}
                    onRetry={picker.retry}
                    classes={SLOT_TIMES_CLASSES.panel}
                    noDaysNode={
                      <p className="text-sm text-fg-muted">{RESCHEDULE_COPY.noTimes}</p>
                    }
                    renderSlot={(iso) => (
                      <button
                        key={iso}
                        disabled={busy || !reschedReasonValid}
                        aria-busy={pendingIso === iso}
                        onClick={() => reschedule(iso)}
                        className={`min-h-11 rounded-md border px-2 py-2 text-sm tabular-nums transition-colors disabled:opacity-60 ${
                          pendingIso === iso
                            ? "border-fg/45 bg-[var(--bg-alt)] text-fg-muted"
                            : "border-border bg-surface text-fg hover:border-fg/45"
                        }`}
                      >
                        {pendingIso === iso ? RESCHEDULE_COPY.moving : formatSlotTime(iso, timeZone)}
                      </button>
                    )}
                  />
                  {/* The only way back out while the panel is open (#1336).
                      Cancel booking is hidden, so an irreversible action is not
                      sitting beside the times a lead is reading. */}
                  <button
                    onClick={closeReschedule}
                    className="mt-5 inline-flex min-h-11 items-center text-sm text-fg-muted underline underline-offset-2 hover:text-fg"
                  >
                    {RESCHEDULE_COPY.keepCurrent}
                  </button>
                </div>
              ) : (
                <>
                  {/* Computed at render, so it tracks a reschedule. The advisor's
                      first name is dropped when unresolvable rather than
                      replaced. */}
                  <h2 className="text-base font-semibold text-fg">
                    {liveHeading(advisorFirstName(advisorName), countdown)}
                  </h2>
                  <p className="mt-2 text-sm text-fg-muted">
                    {/* No pronoun for the advisor anywhere on this page: nothing
                        on the agent record says how a person wants to be referred
                        to, and a guess misgenders a colleague in front of a
                        customer. */}
                    {advisorWillCall(phone)}
                  </p>
                  {/* #1341: the number is the one fact on this page the call
                      actually depends on, and it was the only one a lead could
                      not change. Behind a plain-language trigger rather than an
                      always-open field, because most leads never need it, and a
                      real button at rest rather than a hover affordance (L49). */}
                  {editingPhone ? (
                    <form
                      className="mt-4 max-w-sm"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void savePhone();
                      }}
                    >
                      <label htmlFor="manage-phone" className="block text-sm font-semibold text-fg">
                        {PHONE_COPY.heading}
                      </label>
                      <input
                        id="manage-phone"
                        name="phone"
                        type="tel"
                        inputMode="tel"
                        autoComplete="tel"
                        autoFocus
                        value={phoneDraft}
                        aria-describedby="manage-phone-hint"
                        aria-invalid={phoneError ? true : undefined}
                        ref={attachPhoneInput}
                        onChange={onPhoneChange}
                        className="mt-2 h-[44px] w-full rounded-lg border border-border bg-[var(--field)] px-3 text-fg placeholder:text-fg-muted"
                      />
                      <p id="manage-phone-hint" className="mt-1.5 text-sm text-fg-muted">
                        {PHONE_COPY.hint}
                      </p>
                      {phoneError && (
                        <p role="alert" className="mt-2 text-sm text-error">
                          {phoneError}
                        </p>
                      )}
                      {/* Three visibly distinct states: started, still alive,
                          failed. A bare spinner that looks the same whether the
                          save is progressing, hung or dead is a defect. */}
                      {phoneStalled && (
                        <p role="status" className="mt-2 text-sm text-fg-muted">
                          {PHONE_COPY.stillWorking}
                        </p>
                      )}
                      <div className="mt-4 flex flex-wrap items-center gap-5">
                        <button
                          type="submit"
                          disabled={savingPhone}
                          className="pn-btn pn-btn--additional min-h-[44px] rounded-lg px-5 text-sm disabled:opacity-60"
                        >
                          {savingPhone ? PHONE_COPY.saving : PHONE_COPY.save}
                        </button>
                        <button
                          type="button"
                          onClick={closePhoneEdit}
                          disabled={savingPhone}
                          className="inline-flex min-h-[44px] items-center text-sm font-semibold text-fg underline underline-offset-2 hover:no-underline disabled:opacity-60"
                        >
                          {PHONE_COPY.cancel}
                        </button>
                      </div>
                    </form>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingPhone(true);
                          setPhoneDraft(phone ?? "");
                          setPhoneError(null);
                          setPhoneSaved(false);
                        }}
                        className="mt-1 inline-flex min-h-[44px] items-center text-sm font-semibold text-fg underline underline-offset-2 hover:no-underline"
                      >
                        {PHONE_COPY.trigger}
                      </button>
                      {/* Said only after the save COMMITTED, and it names the
                          number that is now stored rather than the one typed. */}
                      {phoneSaved && phone && (
                        <p role="status" className="mt-1 text-sm text-fg">
                          {phoneSaved_(phone)}
                        </p>
                      )}
                    </>
                  )}
                  <p className="mt-1 text-sm text-fg-muted">
                    {LIVE_COPY.changeYourPlans}
                  </p>
                  {/* Cancel is NOT a peer of Reschedule (#1338): an accidental
                      cancel costs far more than an accidental reschedule click.
                      It stays a real control at rest and a 44px target (L49),
                      just not equal weight. */}
                  <div className="mt-5 flex flex-wrap items-center gap-5">
                    <button
                      onClick={() => {
                        setRescheduling(true);
                        setReschedReason("");
                        setReschedDetail("");
                      }}
                      className="pn-btn pn-btn--additional min-h-[44px] rounded-lg px-5 text-sm"
                    >
                      {LIVE_COPY.reschedule}
                    </button>
                    <button
                      onClick={() => {
                        setError(null);
                        setConfirmingCancel(true);
                      }}
                      disabled={busy}
                      className="inline-flex min-h-[44px] items-center text-sm font-semibold text-[var(--error)] underline underline-offset-2 hover:no-underline disabled:opacity-60"
                    >
                      {LIVE_COPY.cancel}
                    </button>
                  </div>
                </>
              )}

              {busy && stalled && !error && (
                <p role="status" className="mt-4 text-sm text-fg-muted">
                  {LIVE_COPY.stillWorking}
                </p>
              )}
              {error && (
                <div className="mt-4">
                  <p
                    role="alert"
                    className="flex items-start gap-2 text-sm text-[var(--error)]"
                  >
                    <span className="mt-0.5 shrink-0">
                      <AlertIcon width={15} height={15} />
                    </span>
                    {error}
                  </p>
                  {/* #1549: the same panel the booker shows under a refused confirm.
                      A lead who came from their confirmation email to move a call and
                      lost the time was left with a message and nowhere to go, which
                      risks them not rescheduling at all. The tap puts the picker on
                      that time's own day; moving the call is still their choice. */}
                  <NearestTimesPanel
                    refused={refusedSlot}
                    slots={picker.slots}
                    view={picker.view}
                    zone={timeZone}
                    variant="move"
                    onSelect={(iso) => {
                      picker.selectDay(DateTime.fromISO(iso, { zone: timeZone }).toISODate());
                      setRefusedSlot(null);
                      setError(null);
                    }}
                  />
                </div>
              )}
            </div>

            {/* --- Before the call --- */}
            {!done && !rescheduling && !confirmingCancel && (
              <div className="order-5 border-t border-border px-6 py-5 md:order-none md:col-start-2 md:row-start-3">
                <p className="text-sm font-semibold text-fg">{BEFORE_COPY.heading}</p>
                <p className="mt-1 text-sm text-fg-muted">
                  {BEFORE_COPY.body}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
