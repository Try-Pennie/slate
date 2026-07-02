"use client";

import { useEffect, useMemo, useState } from "react";

import { timezoneOptions } from "@/lib/booking/timezones";
import {
  RESCHEDULE_REASONS,
  CANCEL_REASONS,
  validateReason,
} from "@/lib/booking/core";
import ReasonPicker from "@/components/ReasonPicker";
import { postJson } from "@/lib/http";

interface ManageBookingProps {
  token: string;
  bucketCode: string;
  startsAt: string;
  status: string;
  eventName: string;
  /** Presentational only; scopes the Pennie tokens via data-theme. */
  theme?: "light" | "dark";
}

function AlertIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5" strokeLinecap="round" />
      <path d="M12 16.5h.01" strokeLinecap="round" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
    </svg>
  );
}

const tz = () =>
  typeof Intl !== "undefined"
    ? Intl.DateTimeFormat().resolvedOptions().timeZone
    : "America/New_York";

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

function timeLabel(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
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
  theme = "light",
}: ManageBookingProps) {
  const detectedZone = useMemo(() => tz(), []);
  const [timeZone, setTimeZone] = useState(detectedZone);
  const zoneOptions = useMemo(() => timezoneOptions(detectedZone), [detectedZone]);
  const [start, setStart] = useState(startsAt);
  const [status, setStatus] = useState(initialStatus);
  const [rescheduling, setRescheduling] = useState(false);
  const [slots, setSlots] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [pendingIso, setPendingIso] = useState<string | null>(null);

  // Mandatory reschedule/cancel reason (#326).
  const [reschedReason, setReschedReason] = useState("");
  const [reschedDetail, setReschedDetail] = useState("");
  const [cancelReason, setCancelReason] = useState("");
  const [cancelDetail, setCancelDetail] = useState("");
  const reschedReasonValid = validateReason("reschedule", {
    code: reschedReason,
    detail: reschedDetail,
  }).ok;
  const cancelReasonValid = validateReason("cancel", {
    code: cancelReason,
    detail: cancelDetail,
  }).ok;

  useEffect(() => {
    if (!rescheduling) return;
    fetch(`/api/availability?bucket=${encodeURIComponent(bucketCode)}`, {
      cache: "no-store",
    })
      .then((r) => (r.ok ? r.json() : { slots: [] }))
      .then((d) => setSlots(d.slots ?? []));
  }, [rescheduling, bucketCode]);

  const done = status === "cancelled" || status === "completed";

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

        {status !== "cancelled" && (
          <div className="mt-2">
            <label htmlFor="manage-tz" className="sr-only">
              Timezone
            </label>
            <select
              id="manage-tz"
              value={timeZone}
              onChange={(e) => setTimeZone(e.target.value)}
              className="-ml-1 min-h-11 max-w-full truncate rounded-md border border-transparent bg-transparent px-1 text-sm text-fg-muted hover:border-border"
            >
              {zoneOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        )}

        {!done && !confirmingCancel && (
          <div className="mt-6 flex flex-wrap gap-3">
            <button
              onClick={() => {
                setRescheduling((v) => !v);
                setReschedReason("");
                setReschedDetail("");
              }}
              className="pn-btn pn-btn--additional min-h-[44px] rounded-lg px-5 text-sm"
            >
              {rescheduling ? "Close" : "Reschedule"}
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
                options={CANCEL_REASONS}
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

        {error && (
          <p
            role="alert"
            className="mt-4 flex items-start gap-2 text-sm text-[var(--error)]"
          >
            <span className="mt-0.5 shrink-0">
              <AlertIcon />
            </span>
            {error}
          </p>
        )}

        {rescheduling && !done && (
          <div className="mt-6 border-t border-border pt-6">
            <div className="mb-4">
              <ReasonPicker
                legend="Why are you rescheduling?"
                options={RESCHEDULE_REASONS}
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
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {slots.slice(0, 30).map((iso) => (
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
                  {pendingIso === iso ? "Moving…" : timeLabel(iso, timeZone)}
                </button>
              ))}
              {slots.length === 0 && (
                <p className="text-sm text-fg-muted">No times left, pick another.</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
