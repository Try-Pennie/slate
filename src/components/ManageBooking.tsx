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

// Sentinel <option> value that reveals the searchable full-IANA fallback (#1000,
// mirroring the Booker's #219 picker); a real zone id can never collide with it.
const MORE_ZONES = "__more_zones__";

interface ManageBookingProps {
  token: string;
  bucketCode: string;
  startsAt: string;
  status: string;
  eventName: string;
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

function fmt(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

export default function ManageBooking({
  token,
  bucketCode,
  startsAt,
  status: initialStatus,
  eventName,
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

  const done = status === "cancelled" || status === "completed";

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

  return (
    <div data-theme={theme} className="min-h-dvh bg-bg p-6 text-fg">
      <div className="mx-auto max-w-xl">
        <h1 className="text-lg font-semibold tracking-tight text-fg">{eventName}</h1>
        <p className="mt-1 text-sm text-fg-muted">
          {status === "cancelled" ? (
            <span className="text-[var(--error)]">This booking is cancelled.</span>
          ) : (
            <>
              <span className="tabular-nums text-fg">{fmt(start, timeZone)}</span>
            </>
          )}
        </p>

        {/* #634: don't dead-end a cancelled lead. Offer a warm path back into
            the same bucket they were routed to. */}
        {status === "cancelled" && (
          <div className="mt-6">
            <p className="text-sm text-fg-muted">
              Changed your mind? You can grab a new time whenever you&apos;re ready.
            </p>
            <a
              href={`/book?xbc=${encodeURIComponent(bucketCode)}`}
              className="pn-btn pn-btn--primary mt-3 inline-flex min-h-[44px] rounded-lg px-5 text-sm"
            >
              Book a new time
            </a>
          </div>
        )}

        {status !== "cancelled" && (
          <div className="mt-2">
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
              className="-ml-1 min-h-11 max-w-full truncate rounded-md border border-transparent bg-transparent px-1 text-sm text-fg-muted hover:border-border"
            >
              {selectOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
              {allZones.length > 0 && (
                <option value={MORE_ZONES}>More zones...</option>
              )}
            </select>
            {showAllZones && allZones.length > 0 && (
              <div className="mt-2 flex items-center gap-1.5 text-sm">
                <label htmlFor="manage-tz-search" className="sr-only">
                  Search all timezones
                </label>
                {/* Native datalist: free keyboard + screen-reader support, no custom
                    ARIA. isKnownTimeZone gates the free text so a typo can't apply a
                    bad zone; a valid pick applies it and collapses the search (#1000). */}
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
                  className="min-h-11 w-full rounded-md border border-border bg-transparent px-2 text-sm text-fg-muted"
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
        )}

        {/* #1336: while the reschedule panel is open, Close and Cancel booking are
            both hidden and the panel's own "Keep my current time" link is the only
            way back, so an irreversible action is not sitting beside the times a
            lead is reading. */}
        {!done && !confirmingCancel && !rescheduling && (
          <div className="mt-6 flex flex-wrap gap-3">
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
              className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg border border-[var(--error)] px-5 text-sm font-semibold text-[var(--error)] transition-colors hover:bg-[rgba(196,61,61,0.06)] disabled:opacity-60"
            >
              <XIcon />
              Cancel booking
            </button>
          </div>
        )}

        {!done && confirmingCancel && (
          <div className="mt-6 rounded-lg border border-[var(--error)] bg-[rgba(196,61,61,0.04)] p-4">
            <p className="text-sm font-semibold text-fg">Cancel this booking?</p>
            <p className="mt-1 text-sm text-fg-muted">This can&apos;t be undone.</p>
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
                {busy ? "Cancelling…" : "Yes, cancel"}
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
                Keep it
              </button>
            </div>
          </div>
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

        {rescheduling && !done && (
          <div className="mt-6 border-t border-border pt-6">
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
            {/* The same day strip and times panel the booker runs on (#1336), so
                a lead moving a call meets the surface they booked on and a fix to
                either reaches both. No time renders until a day is chosen. */}
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
            {/* The only way back out while the panel is open (#1336). Cancel
                booking is hidden above, so an irreversible action is not sitting
                beside the times a lead is reading. */}
            <button
              onClick={closeReschedule}
              className="mt-5 inline-flex min-h-11 items-center text-sm text-fg-muted underline underline-offset-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pennie-sky"
            >
              Keep my current time
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
