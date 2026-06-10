"use client";

import { useEffect, useMemo, useState } from "react";

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
  const timeZone = useMemo(() => tz(), []);
  const [start, setStart] = useState(startsAt);
  const [status, setStatus] = useState(initialStatus);
  const [rescheduling, setRescheduling] = useState(false);
  const [slots, setSlots] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    const res = await fetch(`/api/bookings/${token}/reschedule`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ start: newStart }),
    });
    if (res.ok) {
      const d = await res.json();
      setStart(d.startsAt);
      setStatus("rescheduled");
      setRescheduling(false);
    } else {
      const d = await res.json().catch(() => ({}));
      setError(d.error ?? "Could not reschedule.");
    }
    setBusy(false);
  }

  async function cancel() {
    if (!confirm("Cancel this booking?")) return;
    setBusy(true);
    const res = await fetch(`/api/bookings/${token}/cancel`, { method: "POST" });
    if (res.ok) setStatus("cancelled");
    setBusy(false);
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
              <span className="tabular-nums text-fg">{fmt(start, timeZone)}</span>{" "}
              <span className="text-fg-muted">({timeZone})</span>
            </>
          )}
        </p>

        {!done && (
          <div className="mt-6 flex flex-wrap gap-3">
            <button
              onClick={() => setRescheduling((v) => !v)}
              className="pn-btn pn-btn--additional min-h-[44px] rounded-lg px-5 text-sm"
            >
              {rescheduling ? "Close" : "Reschedule"}
            </button>
            <button
              onClick={cancel}
              disabled={busy}
              className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg border border-[var(--error)] px-5 text-sm font-semibold text-[var(--error)] transition-colors hover:bg-[rgba(196,61,61,0.06)] disabled:opacity-60"
            >
              <XIcon />
              Cancel booking
            </button>
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
            <p className="mb-3 text-sm font-semibold text-fg">Pick a new time</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {slots.slice(0, 30).map((iso) => (
                <button
                  key={iso}
                  disabled={busy}
                  onClick={() => reschedule(iso)}
                  className="min-h-11 rounded-md border border-border bg-surface px-2 py-2 text-sm tabular-nums text-fg hover:border-fg/45 disabled:opacity-60"
                >
                  {timeLabel(iso, timeZone)}
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
