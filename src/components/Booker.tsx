"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface Attendee {
  name: string;
  email: string;
  phone: string;
}

interface BookerProps {
  bucketCode: string;
  salesforceId: string | null;
  attendee: Attendee;
  prefill: Record<string, string>;
  /** True when rendered inside the embed iframe (drives postMessage to host). */
  embedded?: boolean;
}

interface AvailabilityResponse {
  bucket: { code: string; name: string };
  eventType: { name: string; durationMin: number };
  slots: string[];
}

const tz = () =>
  typeof Intl !== "undefined"
    ? Intl.DateTimeFormat().resolvedOptions().timeZone
    : "America/New_York";

function dayKey(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

function dayLabel(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(iso));
}

function timeLabel(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

export default function Booker({
  bucketCode,
  salesforceId,
  attendee: initialAttendee,
  prefill,
  embedded = false,
}: BookerProps) {
  const timeZone = useMemo(() => tz(), []);
  const [meta, setMeta] = useState<AvailabilityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const [attendee, setAttendee] = useState<Attendee>(initialAttendee);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<{ start: string } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const loadSlots = useCallback(async () => {
    const res = await fetch(
      `/api/availability?bucket=${encodeURIComponent(bucketCode)}`,
      { cache: "no-store" },
    );
    if (res.ok) {
      const data: AvailabilityResponse = await res.json();
      setMeta(data);
      const firstDay = data.slots.length
        ? dayKey(data.slots[0], timeZone)
        : null;
      setSelectedDay((prev) => prev ?? firstDay);
    }
    setLoading(false);
  }, [bucketCode, timeZone]);

  useEffect(() => {
    void (async () => {
      await loadSlots();
    })();
  }, [loadSlots]);

  // Tell the embedding page our height so the iframe can resize with no scroll.
  useEffect(() => {
    if (!embedded || !rootRef.current) return;
    const post = () =>
      window.parent.postMessage(
        { type: "slate:resize", height: rootRef.current?.scrollHeight ?? 0 },
        "*",
      );
    const ro = new ResizeObserver(post);
    ro.observe(rootRef.current);
    post();
    return () => ro.disconnect();
  }, [embedded, meta, confirmed, selectedDay]);

  const slotsByDay = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const iso of meta?.slots ?? []) {
      const key = dayKey(iso, timeZone);
      const list = map.get(key) ?? [];
      list.push(iso);
      map.set(key, list);
    }
    return map;
  }, [meta, timeZone]);

  const days = useMemo(() => [...slotsByDay.keys()], [slotsByDay]);

  async function submit() {
    if (!selectedSlot) return;
    setSubmitting(true);
    setError(null);
    const res = await fetch("/api/bookings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bucketCode,
        start: selectedSlot,
        timezone: timeZone,
        salesforceId,
        attendee: {
          name: attendee.name || undefined,
          email: attendee.email || undefined,
          phone: attendee.phone || undefined,
        },
        prefill,
      }),
    });

    if (res.ok) {
      const data = await res.json();
      setConfirmed({ start: data.startsAt });
      if (embedded) {
        window.parent.postMessage(
          { type: "slate:booking", booking: data, salesforceId },
          "*",
        );
      }
    } else if (res.status === 409) {
      setError("That time was just taken. Please pick another.");
      setSelectedSlot(null);
      await loadSlots();
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Something went wrong. Please try again.");
    }
    setSubmitting(false);
  }

  if (confirmed) {
    return (
      <div ref={rootRef} className="mx-auto max-w-xl p-6 text-center">
        <div className="rounded-lg border border-neutral-200 p-8">
          <h2 className="text-lg font-semibold">You&apos;re booked!</h2>
          <p className="mt-2 text-sm text-neutral-600">
            {dayLabel(confirmed.start, timeZone)} at{" "}
            {timeLabel(confirmed.start, timeZone)}
          </p>
          <p className="mt-1 text-xs text-neutral-400">
            A calendar invite is on its way to {attendee.email || "your email"}.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="mx-auto max-w-2xl p-6">
      <header className="mb-5">
        <h1 className="text-lg font-semibold tracking-tight">
          {meta?.eventType.name ?? "Book a call"}
        </h1>
        <p className="text-sm text-neutral-500">
          {meta ? `${meta.eventType.durationMin} min` : ""} · times shown in{" "}
          {timeZone}
        </p>
      </header>

      {loading ? (
        <p className="text-sm text-neutral-400">Loading availability…</p>
      ) : days.length === 0 ? (
        <p className="text-sm text-neutral-500">
          No times are currently available. Please check back soon.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-[160px_1fr]">
          <div className="flex gap-2 overflow-x-auto sm:flex-col sm:overflow-visible">
            {days.map((d) => {
              const iso = slotsByDay.get(d)![0];
              return (
                <button
                  key={d}
                  onClick={() => {
                    setSelectedDay(d);
                    setSelectedSlot(null);
                  }}
                  className={`shrink-0 rounded-md border px-3 py-2 text-sm ${
                    selectedDay === d
                      ? "border-neutral-900 bg-neutral-900 text-white"
                      : "border-neutral-200 hover:border-neutral-400"
                  }`}
                >
                  {dayLabel(iso, timeZone)}
                </button>
              );
            })}
          </div>

          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {(selectedDay ? (slotsByDay.get(selectedDay) ?? []) : []).map(
              (iso) => (
                <button
                  key={iso}
                  onClick={() => setSelectedSlot(iso)}
                  className={`rounded-md border px-2 py-2 text-sm ${
                    selectedSlot === iso
                      ? "border-neutral-900 bg-neutral-900 text-white"
                      : "border-neutral-200 hover:border-neutral-400"
                  }`}
                >
                  {timeLabel(iso, timeZone)}
                </button>
              ),
            )}
          </div>
        </div>
      )}

      {selectedSlot && (
        <div className="mt-6 space-y-3 border-t border-neutral-200 pt-6">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <input
              className="rounded-md border border-neutral-300 px-3 py-2 text-sm"
              placeholder="Name"
              value={attendee.name}
              onChange={(e) =>
                setAttendee((a) => ({ ...a, name: e.target.value }))
              }
            />
            <input
              className="rounded-md border border-neutral-300 px-3 py-2 text-sm"
              placeholder="Email"
              type="email"
              value={attendee.email}
              onChange={(e) =>
                setAttendee((a) => ({ ...a, email: e.target.value }))
              }
            />
            <input
              className="rounded-md border border-neutral-300 px-3 py-2 text-sm"
              placeholder="Phone"
              value={attendee.phone}
              onChange={(e) =>
                setAttendee((a) => ({ ...a, phone: e.target.value }))
              }
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            onClick={submit}
            disabled={submitting}
            className="w-full rounded-md bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-60 sm:w-auto"
          >
            {submitting
              ? "Booking…"
              : `Confirm ${timeLabel(selectedSlot, timeZone)}`}
          </button>
        </div>
      )}
    </div>
  );
}
