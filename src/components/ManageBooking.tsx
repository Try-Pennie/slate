"use client";

import { AdvisorAvatar } from "@/components/ui/AdvisorAvatar";
import { TestModeBand } from "@/components/TestModeBand";
import { useMemo, useState } from "react";
import { DateTime } from "luxon";
import { formatLongDate } from "@/lib/date/parse";

import {
  deviceTimeZone,
  timezoneOptions,
  resolveZone,
} from "@/lib/booking/timezones";
import { SelectField } from "@/components/ui/SelectField";
import { validateReason, type ReasonOption } from "@/lib/booking/core";
import ReasonPicker from "@/components/ReasonPicker";
import { AlertIcon, CheckIcon, GlobeIcon, XIcon } from "@/components/icons";
import { BookerStrip } from "@/components/BookerStrip";
import { DANGER_FILL_CLASSES } from "@/components/booker-button";
import { SlotTimes, SLOT_TIMES_CLASSES } from "@/components/SlotTimes";
import { useSlotPicker } from "@/components/use-slot-picker";
import { NearestTimesPanel } from "@/components/NearestTimes";
import { rescheduleOffersAlternatives } from "@/lib/booking/nearest-slots";
import { PLACEHOLDER_DAY_FULL_CODE } from "@/lib/booking/placeholder-day-full";
import { postJson, REQUEST_TIMEOUT_MS } from "@/lib/http";
import { useStalledAfter } from "@/lib/useStalledAfter";
import { formatSlotTime } from "@/lib/booking/slot-label";
// The booker's own sentence for this button, not a second copy of it: both
// surfaces move a call to a named time and must say it the same way (L41).
import { moveToTime } from "@/lib/booking/booker-copy";
import { BusyLabel } from "@/components/BusyLabel";
import AddToCalendar from "@/components/AddToCalendar";
import type { CalendarLinks } from "@/lib/booking/calendar-links";
import { usePhoneCaret } from "@/lib/usePhoneCaret";
import { formatPhoneForDisplay } from "@/lib/phone-format";
import { UnsavedGuard } from "@/components/ui/UnsavedGuard";
import {
  BEFORE_COPY,
  CANCEL_COPY,
  DONE_COPY,
  LIVE_COPY,
  RESCHEDULE_COPY,
  PHONE_COPY,
  advisorWillCall,
  callComesFrom,
  callWhen,
  doneBody,
  doneHeading,
  movedNote,
  phoneSaved as phoneSaved_,
  rescheduleNoTimes,
} from "@/lib/booking/manage-copy";
import {
  leadRescheduleTimesUrl,
  type RescheduleTimesFrom,
} from "@/lib/booking/reschedule-times-url";


interface ManageBookingProps {
  token: string;
  bucketCode: string;
  /**
   * The public test bucket's pass (#2666), minted server side for a TEST booking,
   * whose bucket is the public test bucket and whose reschedule panel reads its
   * times. Null for every real booking, whose read needs none.
   */
  testPass?: string | null;
  /**
   * Where the move times come from (#2827), decided server side off the
   * booking's kind by `rescheduleTimesFrom`. A call booked through an advisor's
   * own link can only move to a time that advisor can take, so it reads that
   * advisor's times by this page's token; a routed call reads its bucket's pool.
   * Required, so no surface can forget to decide it.
   */
  rescheduleTimesFrom: RescheduleTimesFrom;
  /**
   * "Book a new time" on a call that is over (#2982), built server side by
   * `rebookHref`: a link to `/booking/manage/<token>/rebook`, under this page's
   * own path, which reads the Lead id, the lead's details and the source page
   * server side by the same token, so the rebooked call is tied to their Lead and
   * they retype nothing. The public `/book` page never sees the token. Required,
   * so no surface can fall back to a bare bucket link.
   */
  rebookHref: string;
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
  /**
   * The number the call will come FROM (#1334), read server side from the lead's
   * Salesforce record. Null when it is not known, and then nothing is said about
   * it: a wrong number is worse than none (L75). Required, so every surface that
   * renders this page has to decide.
   */
  callingNumber: string | null;
  /** The advisor the call is CURRENTLY with, resolved live server-side (#1338).
   *  Null when unresolvable, and then no name is rendered anywhere: coverage
   *  reassignment and bulk reassign both move a booking, so a stale or borrowed
   *  name would promise a lead one person and send another (L75). */
  advisorName: string | null;
  /**
   * The advisor's Workspace photo (#2600), resolved live server side beside the
   * name. Null for every way it can be unavailable, and there are several that a
   * lead has no reason to tell apart: no assignee, no address on file, a refused
   * directory, and an agent who simply has no photo. All of them draw the
   * initials circle, which is a correct picture rather than an empty frame.
   */
  advisorPhotoUrl?: string | null;
  /** The advisor's lead-facing title, shown under the name. Null hides the line. */
  advisorRole: string | null;
  /** Active reschedule/cancel reason options, resolved from the store server-side
   *  (#346). Used for both the pickers and the client-side validate gate, so the
   *  UI and server share the same live set. */
  rescheduleReasons: ReasonOption[];
  cancelReasons: ReasonOption[];
  /** Presentational only; scopes the Pennie tokens via data-theme. */
  theme?: "light" | "dark";
  /**
   * The booking is on a TEST bucket (#2660). This is the one screen a tester
   * keeps a link to and the one a stray lead comes back to from the invite, so
   * it carries the same test line the booker does, in the reserved treatment.
   */
  isTest?: boolean;
  /**
   * The add to calendar links for this booking (#2165), from the one builder
   * (`bookingDetailExtras`, #2643). Null when there is nothing to add: a
   * cancelled call, or a stored time the builder could not read.
   */
  calendarLinks?: CalendarLinks | null;
  /**
   * #4389: a signed token saying this booking is a program lead's, so its move may use
   * the placeholder's extra times. Minted on the server from `bookings.program_lead`;
   * read by the reschedule times (#4390) and the move (#4391). Null for every other call.
   */
  programLeadMoveToken?: string | null;
}


/**
 * US order everywhere: "Monday, August 17", never "17 August" (#1336).
 *
 * The rule now lives in `formatLongDate` rather than in this comment beside a
 * hand rolled copy of it, which is what let three admin surfaces spell the same
 * fact the other way round (#2221).
 */
function longDay(iso: string, timeZone: string) {
  // WITH the year (#2579): every other readback of a committed time on this
  // product spells it that way, and this page was the one surface leaving it
  // off, so the same call read two different ways depending which screen you
  // were on (L118).
  return formatLongDate(DateTime.fromISO(iso, { zone: timeZone }), { year: true }) ?? "";
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



export default function ManageBooking({
  token,
  bucketCode,
  rebookHref,
  testPass = null,
  rescheduleTimesFrom,
  startsAt,
  status: initialStatus,
  eventName,
  durationMin,
  attendeePhone,
  attendeeEmail,
  callingNumber,
  advisorName,
  advisorPhotoUrl,
  advisorRole,
  rescheduleReasons,
  cancelReasons,
  theme = "light",
  isTest = false,
  calendarLinks: initialCalendarLinks = null,
  programLeadMoveToken = null,
}: ManageBookingProps) {
  const detectedZone = useMemo(() => deviceTimeZone(), []);
  // #1849: a fixed US list. A lead whose browser reports a non US zone is shown
  // Eastern rather than their own, which is the trade Dan took: the booked
  // instant is always UTC so nothing is mis-booked, but what they READ is a US
  // clock. The "more zones" search went with it, since a way out of a fixed list
  // is not a smaller version of fixing the list.
  const [timeZone, setTimeZone] = useState(resolveZone(detectedZone));
  const selectOptions = useMemo(() => timezoneOptions(), []);
  const [start, setStart] = useState(startsAt);
  // #2165: held in state because a move made on this page changes the time the
  // links carry. The reschedule answer brings the new ones; links still at the
  // old time would put the wrong meeting on the lead's calendar.
  const [calendarLinks, setCalendarLinks] = useState<CalendarLinks | null>(initialCalendarLinks);
  const [status, setStatus] = useState(initialStatus);
  const [rescheduling, setRescheduling] = useState(false);
  // #2215: set ONLY by a move made on this page, and never derived from the
  // stored status, which records that the booking was moved at some point rather
  // than that it was moved just now. That is what makes the confirmation below
  // reachable from the action alone.
  const [moved, setMoved] = useState(false);
  const today = useMemo(
    () => DateTime.now().setZone(timeZone).startOf("day"),
    [timeZone],
  );
  // Null while the panel is shut: nothing is fetched, and the picker settles as
  // "no days" rather than sitting in a load that never runs.
  const picker = useSlotPicker({
    // #2827: an advisor link booking reads its own advisor's times, never the pool.
    url: rescheduling
      ? leadRescheduleTimesUrl(rescheduleTimesFrom, { bucketCode, manageToken: token })
      : null,
    zone: timeZone,
    leadZone: timeZone,
    testPass,
    // #4390: a program lead's booking reads the pool's times plus the placeholder's. An
    // advisor's own times have no placeholder to add, so their read carries no token.
    programLeadToken: rescheduleTimesFrom === "pool" ? programLeadMoveToken : null,
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
  const [phoneDraft, setPhoneDraft] = useState(formatPhoneForDisplay(attendeePhone) ?? "");
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
  /**
   * The time the lead has TAPPED, which is not the time they have committed to
   * (Dan, 2026-09-22). A tap on this panel used to move the call outright, which
   * is why the reason had to be enforced before the tap: there was no later
   * moment to enforce it at. A tap selects now, so there is one, and the panel
   * matches the booker's own move flow rather than differing from it for no
   * reason anybody chose.
   */
  const [selectedIso, setSelectedIso] = useState<string | null>(null);
  /** What `validateReason` refused on the last attempt at each action. */
  const [reschedReasonError, setReschedReasonError] = useState<string | null>(null);
  const [cancelReasonError, setCancelReasonError] = useState<string | null>(null);
  const reschedReasonCheck = validateReason(
    { code: reschedReason, detail: reschedDetail },
    rescheduleReasons,
  );
  const cancelReasonCheck = validateReason(
    { code: cancelReason, detail: cancelDetail },
    cancelReasons,
  );

  // A cancelled OR completed booking is terminal: neither may be rescheduled or
  // cancelled, so both drop the live actions. Only `cancelled` gets the struck
  // time and the rebook offer; a completed call simply has nothing to act on.
  const done = status === "cancelled" || status === "completed";
  const longDayOf = (iso: string) => longDay(iso, timeZone);
  const timeOf = (iso: string) => timeOnly(iso, timeZone);

  /** Leave the reschedule panel without moving anything, clearing the reason and
   *  the chosen day so reopening it starts clean. */
  function closeReschedule() {
    setRescheduling(false);
    setReschedReason("");
    setReschedDetail("");
    setSelectedIso(null);
    setReschedReasonError(null);
    picker.selectDay(null);
    setError(null);
  }

  /**
   * Commit the move. The reason is checked HERE rather than by switching the
   * control off, so the one thing that can explain the refusal is the thing the
   * lead just pressed (L109). Focus goes to the group, because a message alone
   * can be off screen on a phone and a screen reader would never reach it.
   */
  function commitReschedule() {
    if (!selectedIso) return;
    if (!reschedReasonCheck.ok) {
      setReschedReasonError(reschedReasonCheck.error);
      document.getElementById(`reschedule-reason-${reschedReason || rescheduleReasons[0]?.code}`)?.focus();
      return;
    }
    setReschedReasonError(null);
    void reschedule(selectedIso);
  }

  /** The same rule on the cancel confirm, for the same reason. */
  function commitCancel() {
    if (!cancelReasonCheck.ok) {
      setCancelReasonError(cancelReasonCheck.error);
      document.getElementById(`cancel-reason-${cancelReason || cancelReasons[0]?.code}`)?.focus();
      return;
    }
    setCancelReasonError(null);
    void cancel();
  }

  async function reschedule(newStart: string) {
    setBusy(true);
    setError(null);
    setRefusedSlot(null);
    setPendingIso(newStart);
    try {
      const { ok, status, data } = await postJson<{
        startsAt?: string;
        calendarLinks?: CalendarLinks | null;
        error?: string;
        reason?: string;
        code?: string;
      }>(
        `/api/bookings/${token}/reschedule`,
        {
          start: newStart,
          reason: reschedReason,
          reasonDetail: reschedDetail || undefined,
          // #2310: the zone this page is showing times in, which is the lead's
          // clock the server judges the calling window in.
          timezone: timeZone,
          // #4391: a program lead's call may move onto the placeholder's extra times. In
          // the body, which is never logged.
          ...(programLeadMoveToken ? { programLeadMoveToken } : {}),
        },
        { timeoutMs: REQUEST_TIMEOUT_MS },
      );
      if (ok) {
        setStart(data.startsAt ?? newStart);
        // No links in the answer means none at the new time, never the old ones.
        setCalendarLinks(data.calendarLinks ?? null);
        // Kept in step with the row the server just wrote. Nothing on this page
        // is shown because of it any more (#2215): what the move says for itself
        // hangs off `moved` below, which only this line can set.
        setStatus("rescheduled");
        setMoved(true);
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
        } else if (data.code === PLACEHOLDER_DAY_FULL_CODE) {
          // #4391: the day's extra times filled up. The server's own sentence is shown
          // above; the reload swaps them for the day's real times. No alternatives
          // panel: nothing was taken from this lead.
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

  // One column, about 560px (#2601). It was a 740px two column grid whose left
  // rail carried the event, the time and the advisor while the right carried
  // everything a lead could DO. Chosen from a rendered comparison of four whole
  // page options rather than described: Dan picked the booking detail shape
  // cal.com uses. `min-h-dvh bg-bg` keeps the beige gutter behind it.
  return (
    <div data-theme={theme} className="min-h-dvh bg-bg p-6 text-fg">
      <div className="mx-auto max-w-[560px]">
        {/* #2215 removed the banner that used to sit here. It was gated on
            `status === "rescheduled"`, which a reschedule writes onto the row
            permanently, so it was a moment rendered from a persistent state:
            every later visit to the manage link was told the call had just
            moved, and told that the invite the reader had clicked through to get
            here was still on its way. What #1336 put it there for now lives
            beside the actions, driven by the move itself. */}
        <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-xs">
          {/* #2660: the test line, first, on a test booking's page. */}
          {isTest && <TestModeBand bucketCode={bucketCode} />}
          {/* One column, in reading order: who and what state it is in, then the
              detail, then what a lead can do about it. There is no narrow layout
              to order separately any more, which is what the two column grid
              needed five `order-*` rules for. */}
          <div>
            {/* --- Who it is with, and what state it is in --- */}
            <div className="px-6 pb-6 pt-8 text-center">
              {/* The advisor's face leads, and is dropped entirely when the
                  advisor cannot be resolved (L75): a booking can be reassigned,
                  so no face is better than the wrong one. */}
              {advisorName && (
                <div className="relative mx-auto mb-4 inline-flex">
                  {/* The one avatar component (#3027): the initials take over
                      when there is no photo or the browser cannot draw it. */}
                  <AdvisorAvatar
                    src={advisorPhotoUrl ?? null}
                    initials={initialsOf(advisorName)}
                    imgClassName="h-18 w-18 rounded-full object-cover"
                    fallbackClassName="flex items-center justify-center rounded-full bg-[var(--bg-alt)] text-xl font-semibold text-fg"
                    style={{ width: 72, height: 72 }}
                  />
                  {/* The booked mark, and ONLY while it is booked: a tick over a
                      cancelled call would contradict the heading under it. Green
                      rather than sky, because sky is the action colour and this
                      is not an action; it is also the one mark sky cannot carry
                      at this size and still pass contrast. */}
                  {!done && (
                    <span
                      className="absolute -bottom-0.5 -right-0.5 flex h-[22px] w-[22px] items-center justify-center rounded-full border-2 border-surface bg-[var(--pennie-green-mark)]"
                      aria-hidden="true"
                    >
                      <CheckIcon width={12} height={12} className="text-white" />
                    </span>
                  )}
                </div>
              )}
              <h1 className="text-[22px] font-semibold leading-tight text-fg">
                {done ? doneHeading(status) : LIVE_COPY.heading}
              </h1>
              {advisorName && (
                <p className="mt-1.5 text-sm">
                  <span className="block font-semibold text-fg">{advisorName}</span>
                  {advisorRole && <span className="block text-fg-muted">{advisorRole}</span>}
                </p>
              )}
            </div>
            <hr className="border-0 border-t border-border" />

            {/* --- What the booking IS. Shown in every state that is not a
                    panel, because a cancelled call still has a what and a when,
                    and a page that says only "this is cancelled" has dropped the
                    thing the reader came to check. --- */}
            {!rescheduling && !confirmingCancel && (
              <>
                <div className="px-6 py-5">
                {/* The detail, as labelled rows. Each fact appears ONCE
                    across the whole page (L605), which is what the heading this
                    replaced did not manage: it was the advisor and the date,
                    both already here. So the advisor is named in the header and
                    not again below, and the number lives with the control that
                    changes it and nowhere else. */}
                {/* #2957: the value column is `minmax(0, 1fr)`, not `1fr`. A bare
                    `1fr` has a min-content floor, so one unbreakable value (an
                    email address, the zone picker's natural width) widened the
                    column past the card on a phone and the card clipped it. Each
                    value may now shrink, and a long address wraps anywhere. */}
                <dl className="grid grid-cols-[64px_minmax(0,1fr)] gap-x-5 gap-y-4 text-sm">
                  <dt className="text-fg-muted">{LIVE_COPY.whatLabel}</dt>
                  <dd className="min-w-0 text-fg">{eventName}</dd>

                  <dt className="text-fg-muted">{LIVE_COPY.whenLabel}</dt>
                  <dd className="min-w-0 text-fg">
                    <span className="tabular-nums">
                      {callWhen(longDayOf(start), timeOf(start), durationMin)}
                    </span>
                    {status === "cancelled" && (
                      <span className="ml-2 font-semibold text-[var(--error)]">Cancelled</span>
                    )}
                    {/* The zone stays a control rather than a label: a lead
                        reading this on a phone in another state needs to move
                        the whole page into their own time, not just read ours. */}
                    <span className="mt-2 flex min-w-0 items-center gap-2">
                      <span className="shrink-0 text-fg-muted">
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
                        // Fills what the globe leaves rather than keeping its
                        // natural width, which overran the card at 390px (#2957).
                        className="min-w-0 flex-1"
                        options={selectOptions.map((o) => ({ value: o.id, label: o.label }))}
                      />
                    </span>
                  </dd>

                  {attendeeEmail && (
                    <>
                      <dt className="text-fg-muted">{LIVE_COPY.youLabel}</dt>
                      <dd className="min-w-0 text-fg [overflow-wrap:anywhere]">{attendeeEmail}</dd>
                    </>
                  )}
                </dl>
                </div>
                <hr className="border-0 border-t border-border" />
              </>
            )}

            {/* --- What you can do about it --- */}
            <div className="px-6 py-5">
              {done ? (
                <>
                  {/* No heading here: the header above already says which of the
                      two states this is, and saying it twice is exactly the
                      duplication this page was rebuilt to remove (L605). */}
                  <p className="text-sm text-fg-muted">
                    {doneBody(status)}
                  </p>
                  <a
                    href={rebookHref}
                    className="pn-btn pn-btn--primary mt-4 inline-flex min-h-[44px] rounded-lg px-5 text-sm"
                  >
                    {DONE_COPY.bookAgain}
                  </a>
                </>
              ) : confirmingCancel ? (
                <div className="rounded-lg border border-[var(--error)] bg-[color-mix(in_srgb,var(--error)_4%,transparent)] p-4">
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
                      onCode={(c) => { setCancelReason(c); setCancelReasonError(null); }}
                      onDetail={(d) => { setCancelDetail(d); setCancelReasonError(null); }}
                      idPrefix="cancel-reason"
                      error={cancelReasonError}
                    />
                  </div>
                  <div className="mt-4 flex flex-wrap gap-3">
                    <button
                      onClick={commitCancel}
                      disabled={busy}
                      className={`inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg px-5 text-sm font-semibold disabled:opacity-60 ${DANGER_FILL_CLASSES}`}
                    >
                      <XIcon width={15} height={15} />
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
                      onCode={(c) => { setReschedReason(c); setReschedReasonError(null); }}
                      onDetail={(d) => { setReschedDetail(d); setReschedReasonError(null); }}
                      idPrefix="reschedule-reason"
                      error={reschedReasonError}
                    />
                  </div>
                  <p className="mb-3 text-sm font-semibold text-fg">{RESCHEDULE_COPY.pickReady}</p>
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
                    reader={{ kind: "lead" }}
                    onRetry={picker.retry}
                    failedMessage={picker.failedMessage}
                    classes={SLOT_TIMES_CLASSES.panel}
                    noDaysNode={
                      <p className="text-sm text-fg-muted">
                        {rescheduleNoTimes({ from: rescheduleTimesFrom, advisorName })}
                      </p>
                    }
                    renderSlot={(iso) => (
                      <button
                        key={iso}
                        disabled={busy}
                        aria-busy={pendingIso === iso}
                        // Selected, not activated: the commit below is what moves
                        // the call. `aria-pressed` is what tells a screen reader
                        // which of these the lead is holding, since the chosen one
                        // is otherwise only a colour (L20).
                        aria-pressed={selectedIso === iso}
                        onClick={() => setSelectedIso(iso)}
                        className={`min-h-11 rounded-md border px-2 py-2 text-sm tabular-nums transition-colors disabled:opacity-60 ${
                          pendingIso === iso
                            ? "border-fg/45 bg-[var(--bg-alt)] text-fg-muted"
                            : selectedIso === iso
                              ? "border-fg/45 bg-pennie-sky-soft text-fg dark:bg-accent/20"
                              : "border-border bg-surface text-fg hover:border-fg/45"
                        }`}
                      >
                        {pendingIso === iso ? RESCHEDULE_COPY.moving : formatSlotTime(iso, timeZone)}
                      </button>
                    )}
                  />
                  {/* Only once there is a time to name. A commit that asks for
                      nothing is a control with no job (L187 is the opposite case,
                      and this is the same reasoning): until a time is tapped the
                      only thing to do here is tap one. */}
                  {selectedIso && (
                    <button
                      onClick={commitReschedule}
                      disabled={busy}
                      className="pn-btn pn-btn--primary mt-4 inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg px-5 text-sm disabled:opacity-60"
                    >
                      {busy
                        ? <BusyLabel>{RESCHEDULE_COPY.moving}</BusyLabel>
                        : /* The booker's own short form for this button, built the
                             same way, so the one sentence both surfaces put on a
                             move control reads identically on each (L118). */
                          moveToTime(
                            `${DateTime.fromISO(selectedIso).setZone(timeZone).toFormat("ccc, LLL d")} at ${formatSlotTime(selectedIso, timeZone)}`,
                          )}
                    </button>
                  )}
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
                  {/* #1336 as #2215 rebuilt it: the move states its own outcome,
                      beside the actions the lead just used, and only ever because
                      the move happened here. The new time is the hero in the panel
                      to the left, so this says the two things that panel cannot:
                      a fresh invite is coming, and the time they were holding is
                      gone. Quiet type rather than a band, because it follows an
                      action the lead took on purpose. */}
                  {moved && (
                    <div role="status" className="mb-4">
                      <p className="text-sm font-semibold text-fg">{RESCHEDULE_COPY.moved}</p>
                      <p className="mt-1 text-sm text-fg-muted">{movedNote(attendeeEmail)}</p>
                    </div>
                  )}
                  {/* Computed at render, so it tracks a reschedule. The advisor's
                      first name is dropped when unresolvable rather than
                      replaced. */}
                  <p className="mt-5 text-sm text-fg">
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
                    // form-restore-ok: this form exists only after the lead presses
                    // the change button, so it is never in the page a reload parses
                    // and nothing of it can be restored (#2718).
                    <form
                      className="mt-4 max-w-sm"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void savePhone();
                      }}
                    >
                      {/* #2076: a corrected number is typed work, and this is a
                          page a lead reaches from an email and leaves by a link.
                          The number is the whole reason they opened it. */}
                      <UnsavedGuard what="changes to your phone number" formName="manage-phone" />
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
                          // Seeded in the form a lead types, not the stored
                          // `+1XXXXXXXXXX` (#2616), so a small correction starts
                          // from the number they recognise.
                          setPhoneDraft(formatPhoneForDisplay(phone) ?? "");
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
                  {/* #1334: the number the call comes FROM, after the lead's own
                      number and its control rather than between them, so "Not the
                      right number?" can only be read as about the lead's number.
                      Nothing at all when it is not known. */}
                  {callComesFrom(callingNumber) && (
                    <p className="mt-3 text-sm text-fg">{callComesFrom(callingNumber)}</p>
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
                        // Reopening the panel is the lead saying this time is not
                        // right either, so the last move's confirmation goes.
                        setMoved(false);
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

            {/* --- Add it to your calendar (#2165) --- the one thing cal.com's
                manage screen offered that this one did not, and where a lead
                coming back to the booking most wants it. After the actions, which
                are what a lead returns to do most often, and before the advice,
                which is read once. A cancelled or completed call has nothing to
                add. */}
            {!done && !rescheduling && !confirmingCancel && calendarLinks && (
              <div className="border-t border-border px-6 py-5">
                <AddToCalendar links={calendarLinks} />
              </div>
            )}

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
