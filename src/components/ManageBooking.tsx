"use client";

import { useMemo, useState } from "react";
import { DateTime } from "luxon";

import {
  deviceTimeZone,
  timezoneOptions,
  allTimeZones,
  ensureZonePresent,
  isKnownTimeZone,
  humanizeZone,
} from "@/lib/booking/timezones";
import { validateReason, type ReasonOption } from "@/lib/booking/core";
import ReasonPicker from "@/components/ReasonPicker";
import { AlertIcon } from "@/components/icons";
import { BookerStrip } from "@/components/BookerStrip";
import { SlotTimes, SLOT_TIMES_CLASSES } from "@/components/SlotTimes";
import { useSlotPicker } from "@/components/use-slot-picker";
import { postJson, REQUEST_TIMEOUT_MS } from "@/lib/http";
import { useStalledAfter } from "@/lib/useStalledAfter";
import { formatSlotTime } from "@/lib/booking/slot-label";
import { countdownPhrase, advisorFirstName } from "@/lib/booking/countdown";

// Sentinel <option> value that reveals the searchable full-IANA fallback (#1000,
// mirroring the Booker's #219 picker); a real zone id can never collide with it.
const MORE_ZONES = "__more_zones__";

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
  const [timeZone, setTimeZone] = useState(detectedZone);
  const zoneOptions = useMemo(() => timezoneOptions(detectedZone), [detectedZone]);
  // Curated list plus, if the lead picked a zone from the full-list fallback that
  // isn't curated, that zone too (so the <select value> never blanks). #219/#1000.
  const selectOptions = useMemo(
    () => ensureZonePresent(zoneOptions, timeZone),
    [zoneOptions, timeZone],
  );
  // The searchable "more zones" fallback: the full IANA set, revealed only when
  // the lead's correct zone is neither detected nor curated. Empty on a runtime
  // without Intl.supportedValuesOf, in which case the fallback is simply hidden.
  const [showAllZones, setShowAllZones] = useState(false);
  const allZones = useMemo(() => allTimeZones(), []);
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
    setPendingIso(newStart);
    try {
      const { ok, data } = await postJson<{ startsAt?: string; error?: string }>(
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
        setError(data.error ?? "Could not reschedule. Please try again.");
      }
    } finally {
      setPendingIso(null);
      setBusy(false);
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
        setError(data.error ?? "Could not cancel. Please try again.");
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
                  <select
                    id="manage-tz"
                    value={timeZone}
                    onChange={(e) => {
                      if (e.target.value === MORE_ZONES) {
                        setShowAllZones(true);
                        return;
                      }
                      setTimeZone(e.target.value);
                      setShowAllZones(false);
                    }}
                    className="-ml-1 min-h-11 max-w-full truncate rounded-md border border-transparent bg-transparent px-1 text-sm text-fg hover:border-border"
                  >
                    {selectOptions.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                    {allZones.length > 0 && <option value={MORE_ZONES}>More zones...</option>}
                  </select>
                </div>
              </div>
              {showAllZones && allZones.length > 0 && (
                <div className="mt-2 text-sm">
                  <label htmlFor="manage-tz-search" className="sr-only">
                    Search all timezones
                  </label>
                  {/* Native datalist: free keyboard + screen-reader support, no
                      custom ARIA. isKnownTimeZone gates the free text so a typo
                      can't apply a bad zone; a valid pick applies it and
                      collapses the search (#1000). */}
                  <input
                    id="manage-tz-search"
                    list="manage-all-tz"
                    autoFocus
                    placeholder="Type a city or region"
                    defaultValue=""
                    onChange={(e) => {
                      const picked = e.target.value;
                      if (isKnownTimeZone(picked)) {
                        setTimeZone(picked);
                        setShowAllZones(false);
                      }
                    }}
                    className="min-h-11 w-full rounded-md border border-border bg-transparent px-2 text-sm text-fg"
                  />
                  <datalist id="manage-all-tz">
                    {allZones.map((z) => (
                      <option key={z} value={z}>
                        {humanizeZone(z)}
                      </option>
                    ))}
                  </datalist>
                </div>
              )}
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
                    {status === "cancelled"
                      ? "This booking is cancelled"
                      : "This call has happened"}
                  </h2>
                  <p className="mt-2 text-sm text-fg-muted">
                    {status === "cancelled"
                      ? "Changed your mind? You can grab a new time with the same team whenever you are ready."
                      : "Need to talk again? You can book another time with the same team whenever you are ready."}
                  </p>
                  <a
                    href={`/book?xbc=${encodeURIComponent(bucketCode)}`}
                    className="pn-btn pn-btn--primary mt-4 inline-flex min-h-[44px] rounded-lg px-5 text-sm"
                  >
                    Book a new time
                  </a>
                </>
              ) : confirmingCancel ? (
                <div className="rounded-lg border border-[var(--error)] bg-[rgba(196,61,61,0.04)] p-4">
                  <p className="text-sm font-semibold text-fg">Cancel this booking?</p>
                  <p className="mt-1 text-sm text-fg-muted">
                    This releases your time and cannot be undone.
                  </p>
                  <div className="mt-4">
                    <ReasonPicker
                      legend="Why are you cancelling?"
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
                      {busy ? "Cancelling…" : "Yes, cancel it"}
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
                      Keep my booking
                    </button>
                  </div>
                </div>
              ) : rescheduling ? (
                <div>
                  <div className="mb-4">
                    <ReasonPicker
                      legend="Why are you rescheduling?"
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
                      ? "Pick a new time"
                      : "Choose a reason above, then pick a new time"}
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
                      <p className="text-sm text-fg-muted">
                        All times are taken right now. Check back soon.
                      </p>
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
                        {pendingIso === iso ? "Moving…" : formatSlotTime(iso, timeZone)}
                      </button>
                    )}
                  />
                  {/* The only way back out while the panel is open (#1336).
                      Cancel booking is hidden, so an irreversible action is not
                      sitting beside the times a lead is reading. */}
                  <button
                    onClick={closeReschedule}
                    className="mt-5 inline-flex min-h-11 items-center text-sm text-fg-muted underline underline-offset-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pennie-sky"
                  >
                    Keep my current time
                  </button>
                </div>
              ) : (
                <>
                  {/* Computed at render, so it tracks a reschedule. The advisor's
                      first name is dropped when unresolvable rather than
                      replaced. */}
                  <h2 className="text-base font-semibold text-fg">
                    {[advisorFirstName(advisorName), countdown].filter(Boolean).join(", ") ||
                      "Your call"}
                  </h2>
                  <p className="mt-2 text-sm text-fg-muted">
                    {/* No pronoun for the advisor anywhere on this page: nothing
                        on the agent record says how a person wants to be referred
                        to, and a guess misgenders a colleague in front of a
                        customer. */}
                    Your advisor will call you at{" "}
                    <span className="tabular-nums">{attendeePhone ?? "the number you gave us"}</span>
                    .
                  </p>
                  <p className="mt-1 text-sm text-fg-muted">
                    If your plans change, you can move it or cancel it.
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
                      Reschedule
                    </button>
                    <button
                      onClick={() => {
                        setError(null);
                        setConfirmingCancel(true);
                      }}
                      disabled={busy}
                      className="inline-flex min-h-[44px] items-center text-sm font-semibold text-[var(--error)] underline underline-offset-2 hover:no-underline disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pennie-sky"
                    >
                      Cancel booking
                    </button>
                  </div>
                </>
              )}

              {busy && stalled && !error && (
                <p role="status" className="mt-4 text-sm text-fg-muted">
                  Still working… this is taking longer than usual.
                </p>
              )}
              {error && (
                <p
                  role="alert"
                  className="mt-4 flex items-start gap-2 text-sm text-[var(--error)]"
                >
                  <span className="mt-0.5 shrink-0">
                    <AlertIcon width={15} height={15} />
                  </span>
                  {error}
                </p>
              )}
            </div>

            {/* --- Before the call --- */}
            {!done && !rescheduling && !confirmingCancel && (
              <div className="order-5 border-t border-border px-6 py-5 md:order-none md:col-start-2 md:row-start-3">
                <p className="text-sm font-semibold text-fg">Before the call</p>
                <p className="mt-1 text-sm text-fg-muted">
                  Join from somewhere quiet, not while driving, with access to a screen (phone,
                  tablet, laptop, etc.). Some of what we will cover is easier to follow along
                  visually.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
