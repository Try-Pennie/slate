"use client";

import { useEffect, useMemo, useState } from "react";

interface ManageBookingProps {
  token: string;
  bucketCode: string;
  startsAt: string;
  status: string;
  eventName: string;
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
    <div className="mx-auto max-w-xl p-6">
      <h1 className="text-lg font-semibold tracking-tight">{eventName}</h1>
      <p className="mt-1 text-sm text-neutral-600">
        {status === "cancelled" ? (
          <span className="text-red-600">This booking is cancelled.</span>
        ) : (
          <>
            {fmt(start, timeZone)}{" "}
            <span className="text-neutral-400">({timeZone})</span>
          </>
        )}
      </p>

      {!done && (
        <div className="mt-6 flex gap-3">
          <button
            onClick={() => setRescheduling((v) => !v)}
            className="rounded-md border border-neutral-300 px-4 py-2 text-sm hover:border-neutral-500"
          >
            {rescheduling ? "Close" : "Reschedule"}
          </button>
          <button
            onClick={cancel}
            disabled={busy}
            className="rounded-md border border-red-200 px-4 py-2 text-sm text-red-600 hover:border-red-400 disabled:opacity-60"
          >
            Cancel booking
          </button>
        </div>
      )}

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      {rescheduling && !done && (
        <div className="mt-6 border-t border-neutral-200 pt-6">
          <p className="mb-3 text-sm font-medium">Pick a new time</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {slots.slice(0, 30).map((iso) => (
              <button
                key={iso}
                disabled={busy}
                onClick={() => reschedule(iso)}
                className="rounded-md border border-neutral-200 px-2 py-2 text-xs hover:border-neutral-500 disabled:opacity-60"
              >
                {timeLabel(iso, timeZone)}
              </button>
            ))}
            {slots.length === 0 && (
              <p className="text-sm text-neutral-400">No times available.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
