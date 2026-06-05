"use client";

import { DateTime } from "luxon";
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
  eventType: { name: string; description: string | null; durationMin: number };
  slots: string[];
}

const localZone = () =>
  typeof Intl !== "undefined"
    ? Intl.DateTimeFormat().resolvedOptions().timeZone
    : "America/New_York";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function ClockIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" strokeLinecap="round" />
    </svg>
  );
}
function PhoneIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M5 4h3l2 5-2 1a12 12 0 005 5l1-2 5 2v3a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2z" strokeLinejoin="round" />
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

export default function Booker({
  bucketCode,
  salesforceId,
  attendee: initialAttendee,
  prefill,
  embedded = false,
}: BookerProps) {
  const zone = useMemo(() => localZone(), []);
  const today = useMemo(() => DateTime.now().setZone(zone).startOf("day"), [zone]);

  const [month, setMonth] = useState(() => today.startOf("month"));
  const [meta, setMeta] = useState<AvailabilityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const [hour12, setHour12] = useState(true);
  const [attendee, setAttendee] = useState<Attendee>(initialAttendee);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<{ start: string } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const loadSlots = useCallback(async () => {
    const monthStart = month.startOf("month");
    const from = DateTime.max(monthStart, today).toUTC().toISO();
    const to = month.endOf("month").toUTC().toISO();
    const res = await fetch(
      `/api/availability?bucket=${encodeURIComponent(bucketCode)}&from=${encodeURIComponent(from!)}&to=${encodeURIComponent(to!)}`,
      { cache: "no-store" },
    );
    if (res.ok) setMeta((await res.json()) as AvailabilityResponse);
    setLoading(false);
  }, [bucketCode, month, today]);

  useEffect(() => {
    void (async () => {
      await loadSlots();
    })();
  }, [loadSlots]);

  const slotsByDay = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const iso of meta?.slots ?? []) {
      const key = DateTime.fromISO(iso).setZone(zone).toISODate();
      if (!key) continue;
      const list = map.get(key) ?? [];
      list.push(iso);
      map.set(key, list);
    }
    return map;
  }, [meta, zone]);

  // Derive the active day (don't sync via effect): the chosen day if it still
  // has slots, else the first available day in the loaded month.
  const firstAvailable = useMemo(
    () => [...slotsByDay.keys()].sort()[0] ?? null,
    [slotsByDay],
  );
  const activeDay =
    selectedDay && slotsByDay.has(selectedDay) ? selectedDay : firstAvailable;

  // Tell the embedding page our height so the iframe resizes with no scroll.
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
  }, [embedded, meta, activeDay, selectedSlot, confirmed]);

  const monthCells = useMemo(() => {
    const start = month.startOf("month");
    const lead = start.weekday % 7; // Sunday-first column index
    const cells: (DateTime | null)[] = Array.from({ length: lead }, () => null);
    for (let d = 1; d <= start.daysInMonth!; d++) {
      cells.push(start.set({ day: d }));
    }
    return cells;
  }, [month]);

  const daySlots = activeDay ? (slotsByDay.get(activeDay) ?? []) : [];

  function fmtTime(iso: string) {
    const dt = DateTime.fromISO(iso).setZone(zone);
    return hour12
      ? `${dt.toFormat("h:mm")}${dt.toFormat("a").toLowerCase()}`
      : dt.toFormat("HH:mm");
  }

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
        timezone: zone,
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
          { type: "slate:bookingSuccessful", data: { booking: data, salesforceId } },
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

  const shell =
    "mx-auto max-w-4xl overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-950 text-neutral-200";

  if (confirmed) {
    return (
      <div ref={rootRef} className={shell}>
        <div className="p-10 text-center">
          <h2 className="text-lg font-semibold text-white">You&apos;re booked</h2>
          <p className="mt-2 text-sm text-neutral-400">
            {DateTime.fromISO(confirmed.start).setZone(zone).toFormat("cccc, LLL d")} at{" "}
            {fmtTime(confirmed.start)}
          </p>
          <p className="mt-1 text-xs text-neutral-500">
            A calendar invite is on its way to {attendee.email || "your email"}.
          </p>
        </div>
      </div>
    );
  }

  const selectedDate = activeDay ? DateTime.fromISO(activeDay).setZone(zone) : null;

  return (
    <div ref={rootRef} className={shell}>
      <div className="grid grid-cols-1 md:grid-cols-[260px_1fr_240px]">
        {/* Event panel */}
        <aside className="border-b border-neutral-800 p-6 md:border-b-0 md:border-r">
          <div className="mb-4 flex h-9 w-9 items-center justify-center rounded-full bg-neutral-800 text-xs font-semibold text-neutral-200">
            PE
          </div>
          <p className="text-xs font-medium text-neutral-400">{meta?.bucket.name ?? ""}</p>
          <h1 className="mt-1 text-xl font-semibold leading-snug text-white">
            {meta?.eventType.name ?? "Book a call"}
          </h1>
          {meta?.eventType.description && (
            <p className="mt-3 text-sm leading-relaxed text-neutral-400">
              {meta.eventType.description}
            </p>
          )}
          <div className="mt-5 space-y-2 text-sm text-neutral-300">
            <div className="flex items-center gap-2">
              <span className="text-neutral-500">
                <ClockIcon />
              </span>
              {meta ? `${meta.eventType.durationMin}m` : ""}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-neutral-500">
                <PhoneIcon />
              </span>
              {attendee.phone || "Attendee phone number"}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-neutral-500">
                <GlobeIcon />
              </span>
              {zone.replace(/_/g, " ")}
            </div>
          </div>
        </aside>

        {/* Calendar */}
        <section className="border-b border-neutral-800 p-6 md:border-b-0">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white">
              {month.toFormat("LLLL")}{" "}
              <span className="font-normal text-neutral-500">{month.toFormat("yyyy")}</span>
            </h2>
            <div className="flex gap-1">
              <button
                aria-label="Previous month"
                disabled={month.toMillis() <= today.startOf("month").toMillis()}
                onClick={() => {
                  setLoading(true);
                  setMonth((m) => m.minus({ months: 1 }));
                  setSelectedDay(null);
                  setSelectedSlot(null);
                }}
                className="rounded p-1 text-neutral-400 hover:bg-neutral-800 disabled:opacity-30"
              >
                ‹
              </button>
              <button
                aria-label="Next month"
                onClick={() => {
                  setLoading(true);
                  setMonth((m) => m.plus({ months: 1 }));
                  setSelectedDay(null);
                  setSelectedSlot(null);
                }}
                className="rounded p-1 text-neutral-400 hover:bg-neutral-800"
              >
                ›
              </button>
            </div>
          </div>

          <div className="grid grid-cols-7 gap-1 text-center text-[11px] uppercase tracking-wide text-neutral-500">
            {WEEKDAYS.map((d) => (
              <div key={d} className="py-1">
                {d}
              </div>
            ))}
          </div>
          <div className="mt-1 grid grid-cols-7 gap-1">
            {monthCells.map((cell, i) => {
              if (!cell) return <div key={`b${i}`} />;
              const key = cell.toISODate()!;
              const has = slotsByDay.has(key);
              const isSelected = key === activeDay;
              const isToday = key === today.toISODate();
              return (
                <button
                  key={key}
                  disabled={!has}
                  onClick={() => {
                    setSelectedDay(key);
                    setSelectedSlot(null);
                  }}
                  className={[
                    "relative aspect-square rounded-md text-sm",
                    has
                      ? "text-neutral-100 hover:bg-neutral-800"
                      : "cursor-default text-neutral-700",
                    isSelected ? "bg-neutral-800 ring-1 ring-white" : "",
                  ].join(" ")}
                >
                  {cell.day}
                  {isToday && (
                    <span className="absolute bottom-1 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-emerald-500" />
                  )}
                </button>
              );
            })}
          </div>
        </section>

        {/* Times / booking form */}
        <section className="flex max-h-[420px] flex-col p-6">
          {selectedSlot ? (
            <div className="space-y-3">
              <button
                onClick={() => setSelectedSlot(null)}
                className="text-xs text-neutral-400 hover:text-neutral-200"
              >
                ‹ Back
              </button>
              <p className="text-sm font-semibold text-white">
                {selectedDate?.toFormat("ccc d")} · {fmtTime(selectedSlot)}
              </p>
              {(["name", "email", "phone"] as const).map((field) => (
                <input
                  key={field}
                  className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-500"
                  placeholder={field[0].toUpperCase() + field.slice(1)}
                  type={field === "email" ? "email" : "text"}
                  value={attendee[field]}
                  onChange={(e) =>
                    setAttendee((a) => ({ ...a, [field]: e.target.value }))
                  }
                />
              ))}
              {error && <p className="text-sm text-red-400">{error}</p>}
              <button
                onClick={submit}
                disabled={submitting}
                className="w-full rounded-md bg-white px-4 py-2.5 text-sm font-medium text-neutral-900 hover:bg-neutral-200 disabled:opacity-60"
              >
                {submitting ? "Booking…" : "Confirm"}
              </button>
            </div>
          ) : (
            <>
              <div className="mb-3 flex items-center justify-between">
                <p className="text-sm font-semibold text-white">
                  {selectedDate ? (
                    <>
                      {selectedDate.toFormat("ccc")}{" "}
                      <span className="text-neutral-500">{selectedDate.toFormat("dd")}</span>
                    </>
                  ) : (
                    "Pick a day"
                  )}
                </p>
                <div className="flex rounded-md border border-neutral-800 text-xs">
                  {[true, false].map((is12) => (
                    <button
                      key={String(is12)}
                      onClick={() => setHour12(is12)}
                      className={`px-2 py-1 ${hour12 === is12 ? "bg-neutral-800 text-white" : "text-neutral-400"}`}
                    >
                      {is12 ? "12h" : "24h"}
                    </button>
                  ))}
                </div>
              </div>
              <div className="-mr-2 flex-1 space-y-2 overflow-y-auto pr-2">
                {loading ? (
                  Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} className="h-10 animate-pulse rounded-lg bg-neutral-900" />
                  ))
                ) : daySlots.length === 0 ? (
                  <p className="text-sm text-neutral-500">No times available.</p>
                ) : (
                  daySlots.map((iso) => (
                    <button
                      key={iso}
                      onClick={() => setSelectedSlot(iso)}
                      className="flex w-full items-center gap-2 rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2.5 text-left text-sm text-neutral-100 hover:border-neutral-600"
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                      {fmtTime(iso)}
                    </button>
                  ))
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
