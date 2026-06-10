"use client";

import { DateTime } from "luxon";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ArrowRightIcon, CheckBadgeIcon } from "@/components/icons";

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
  /** Palette, from the embed `ui` config. Defaults to light. */
  theme?: "light" | "dark";
  /** Brand accent (hex) from the embed `ui` config; tints dots/ring/confirm. */
  brandColor?: string;
}

interface AvailabilityResponse {
  bucket: { code: string; name: string };
  orgName: string;
  eventType: { name: string; description: string | null; durationMin: number };
  slots: string[];
}

const localZone = () =>
  typeof Intl !== "undefined"
    ? Intl.DateTimeFormat().resolvedOptions().timeZone
    : "America/New_York";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Avatar initials from the org name: "Pennie" -> "PE", "Acme Co" -> "AC". */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "•";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/**
 * Pennie token-driven palette. Both keys lean on the semantic vars
 * (--bg/--surface/--fg/--border), which `data-theme` on the Booker root
 * flips per theme; only the wash/skeleton values differ per key.
 */
const PALETTE = {
  dark: {
    shell: "bg-surface text-fg",
    border: "border-border",
    title: "text-fg",
    muted: "text-fg-muted",
    faint: "text-fg-muted",
    body: "text-fg",
    avatar: "bg-accent/20 text-fg",
    dayOn: "text-fg hover:bg-fg/10",
    dayOff: "cursor-default text-fg-muted opacity-50",
    daySelected: "bg-accent/20",
    ring: "ring-accent",
    slot: "border-border bg-surface text-fg hover:border-fg/45",
    input:
      "bg-surface text-fg placeholder:text-fg-muted shadow-[inset_0_0_0_1px_var(--border)]",
    toggleBorder: "border-border",
    toggleOn: "bg-accent/20 text-fg",
    toggleOff: "text-fg-muted",
    navHover: "hover:bg-fg/10",
    skeleton: "bg-fg/10",
    confirm: "bg-accent text-fg-on-sky hover:bg-accent-hover",
    backHover: "hover:text-fg",
  },
  light: {
    shell: "bg-surface text-fg",
    border: "border-border",
    title: "text-fg",
    muted: "text-fg-muted",
    faint: "text-fg-muted",
    body: "text-fg",
    avatar: "bg-pennie-sky-soft text-fg",
    dayOn: "text-fg hover:bg-pennie-sky-soft",
    dayOff: "cursor-default text-fg-muted opacity-50",
    daySelected: "bg-pennie-sky-soft",
    ring: "ring-accent",
    slot: "border-border bg-surface text-fg hover:border-fg/45",
    input:
      "bg-surface text-fg placeholder:text-fg-muted shadow-[inset_0_0_0_1px_var(--border)]",
    toggleBorder: "border-border",
    toggleOn: "bg-pennie-sky-soft text-fg",
    toggleOff: "text-fg-muted",
    navHover: "hover:bg-[rgba(52,52,52,0.04)]",
    skeleton: "bg-[var(--pennie-wild-sand)]",
    confirm: "bg-accent text-fg-on-sky hover:bg-accent-hover",
    backHover: "hover:text-fg",
  },
};

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
function AlertIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5" strokeLinecap="round" />
      <path d="M12 16.5h.01" strokeLinecap="round" />
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
  theme = "light",
  brandColor,
}: BookerProps) {
  const zone = useMemo(() => localZone(), []);
  const today = useMemo(() => DateTime.now().setZone(zone).startOf("day"), [zone]);
  const c = PALETTE[theme];
  // Brand accent overrides (inline, since the hex is dynamic). Undefined = keep
  // the palette default (green dots, themed ring/confirm).
  const dotStyle = brandColor ? { backgroundColor: brandColor } : undefined;
  const ringStyle = brandColor ? { boxShadow: `inset 0 0 0 1.5px ${brandColor}` } : undefined;
  // Label stays graphite via --fg-on-sky: white-on-sky fails AA (1.69:1).
  const confirmStyle = brandColor
    ? { backgroundColor: brandColor, color: "var(--fg-on-sky)" }
    : undefined;

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
  const confirmedHeadingRef = useRef<HTMLHeadingElement>(null);

  // a11y: move focus to the confirmation heading so the success is announced.
  useEffect(() => {
    if (confirmed) confirmedHeadingRef.current?.focus();
  }, [confirmed]);

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

  const shell = `mx-auto max-w-4xl overflow-hidden rounded-xl shadow-xs ${c.shell}`;

  if (confirmed) {
    const confirmedDay = DateTime.fromISO(confirmed.start)
      .setZone(zone)
      .toFormat("cccc, LLL d");
    const confirmedTime = fmtTime(confirmed.start);
    const zoneLabel = zone.replace(/_/g, " ");
    return (
      <div ref={rootRef} data-theme={theme} className={shell}>
        {/* Entrance animates opacity/transform only: a height animation would
            jitter the embed iframe via the ResizeObserver above. */}
        <div className="pn-confirm-enter p-10 text-center">
          {embedded ? (
            <span className="inline-flex h-16 w-16 items-center justify-center rounded-full bg-pennie-sky-soft text-[var(--accent)]">
              <CheckBadgeIcon width={32} height={32} />
            </span>
          ) : (
            <div className="mx-auto flex max-w-72 items-center justify-center rounded-xl bg-pennie-sky-soft px-6 py-5">
              {/* Plain <img>: OpenNext on Cloudflare has no image loader configured. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/brand/pic-1-coins.png"
                alt=""
                aria-hidden="true"
                width={144}
                height={144}
                className="h-36 w-36 object-contain"
              />
            </div>
          )}
          <h2
            ref={confirmedHeadingRef}
            tabIndex={-1}
            className={`mt-6 text-[length:var(--fs-h4)] font-semibold leading-snug outline-none ${c.title}`}
          >
            You&apos;re all set
          </h2>
          <p className={`mt-2 text-sm ${c.muted}`}>
            {confirmedDay} at <span className="tabular-nums">{confirmedTime}</span> (
            {zoneLabel})
          </p>
          <p className={`mt-1 text-xs ${c.faint}`}>
            A calendar invite is on its way to {attendee.email || "your email"}.
          </p>
          <p role="status" className="sr-only">
            Booked. {confirmedDay} at {confirmedTime} {zoneLabel}. A calendar invite
            is on its way.
          </p>
        </div>
      </div>
    );
  }

  const selectedDate = activeDay ? DateTime.fromISO(activeDay).setZone(zone) : null;

  // Rose error notice; rendered in whichever right-column branch is active
  // (the 409 race resets selectedSlot, so the message must show on the slot list too).
  // Plain rose text per the DS forms recipe: rose on the 12% wash is only 4.33:1 (AA fail).
  const errorAlert = error ? (
    <p
      id="booker-error"
      role="alert"
      className="flex items-start gap-2 text-sm text-[var(--error)]"
    >
      <span className="mt-0.5 shrink-0">
        <AlertIcon />
      </span>
      {error}
    </p>
  ) : null;

  return (
    <div ref={rootRef} data-theme={theme} className={shell}>
      <div className="grid grid-cols-1 md:grid-cols-[260px_1fr_240px]">
        {/* Event panel */}
        <aside className={`border-b p-6 ${c.border} md:border-b-0 md:border-r`}>
          <div
            className={`mb-4 flex h-9 w-9 items-center justify-center rounded-full text-xs font-semibold ${c.avatar}`}
            style={confirmStyle}
          >
            {meta ? initials(meta.orgName) : ""}
          </div>
          <p className={`text-xs font-medium ${c.muted}`}>{meta?.bucket.name ?? ""}</p>
          <h1 className={`mt-1 text-xl font-semibold leading-snug ${c.title}`}>
            {meta?.eventType.name ?? "Book a call"}
          </h1>
          {meta?.eventType.description && (
            <p className={`mt-3 text-sm leading-relaxed ${c.muted}`}>
              {meta.eventType.description}
            </p>
          )}
          <div className={`mt-5 space-y-2 text-sm ${c.body}`}>
            <div className="flex items-center gap-2">
              <span className={c.faint}>
                <ClockIcon />
              </span>
              {meta ? `${meta.eventType.durationMin}m` : ""}
            </div>
            <div className="flex items-center gap-2">
              <span className={c.faint}>
                <PhoneIcon />
              </span>
              {attendee.phone || "Attendee phone number"}
            </div>
            <div className="flex items-center gap-2">
              <span className={c.faint}>
                <GlobeIcon />
              </span>
              {zone.replace(/_/g, " ")}
            </div>
          </div>
        </aside>

        {/* Calendar */}
        <section className={`border-b p-6 ${c.border} md:border-b-0`}>
          <div className="mb-4 flex items-center justify-between">
            <h2 className={`text-sm font-semibold ${c.title}`}>
              {month.toFormat("LLLL")}{" "}
              <span className={`font-normal ${c.faint}`}>{month.toFormat("yyyy")}</span>
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
                className={`inline-flex h-11 w-11 items-center justify-center rounded-md text-lg ${c.muted} ${c.navHover} disabled:opacity-30`}
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
                className={`inline-flex h-11 w-11 items-center justify-center rounded-md text-lg ${c.muted} ${c.navHover}`}
              >
                ›
              </button>
            </div>
          </div>

          <div className={`grid grid-cols-7 gap-1 text-center text-xs uppercase tracking-wide ${c.faint}`}>
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
                  aria-label={`${cell.toFormat("cccc, LLLL d")}${isToday ? ", today" : ""}`}
                  aria-pressed={isSelected}
                  aria-current={isToday ? "date" : undefined}
                  style={isSelected ? ringStyle : undefined}
                  className={[
                    "relative aspect-square min-h-[44px] rounded-sm text-sm tabular-nums",
                    has ? c.dayOn : c.dayOff,
                    isSelected
                      ? `font-semibold ${c.daySelected} ${brandColor ? "" : `ring-1 ${c.ring}`}`
                      : "",
                  ].join(" ")}
                >
                  {cell.day}
                  {isToday && (
                    <span
                      className="absolute bottom-1 left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-pennie-green"
                      style={dotStyle}
                    />
                  )}
                </button>
              );
            })}
          </div>
        </section>

        {/* Times / booking form (the 420px cap is for the scrolling slot list only) */}
        <section className={`flex flex-col p-6 ${selectedSlot ? "" : "max-h-[420px]"}`}>
          {selectedSlot ? (
            <div className="space-y-3">
              <button
                onClick={() => setSelectedSlot(null)}
                aria-label="Back to time selection"
                className={`inline-flex min-h-9 items-center text-xs ${c.muted} ${c.backHover}`}
              >
                ‹ Back
              </button>
              <p className={`text-sm font-semibold ${c.title}`}>
                {selectedDate?.toFormat("ccc d")} · {fmtTime(selectedSlot)}
              </p>
              {(["name", "email", "phone"] as const).map((field) => (
                <div key={field}>
                  <label htmlFor={`booker-${field}`} className="sr-only">
                    {field[0].toUpperCase() + field.slice(1)}
                  </label>
                  <input
                    id={`booker-${field}`}
                    className={`min-h-12 w-full rounded-sm px-4 text-base ${c.input}`}
                    placeholder={field[0].toUpperCase() + field.slice(1)}
                    type={
                      field === "email" ? "email" : field === "phone" ? "tel" : "text"
                    }
                    autoComplete={field === "phone" ? "tel" : field}
                    inputMode={
                      field === "email" ? "email" : field === "phone" ? "tel" : undefined
                    }
                    value={attendee[field]}
                    onChange={(e) =>
                      setAttendee((a) => ({ ...a, [field]: e.target.value }))
                    }
                  />
                </div>
              ))}
              {errorAlert}
              <button
                onClick={submit}
                disabled={submitting}
                style={confirmStyle}
                className={`group inline-flex min-h-14 w-full items-center justify-center gap-2 rounded-xl px-4 text-base font-semibold ${c.confirm} active:translate-y-px disabled:opacity-60`}
              >
                {submitting ? "Booking your call…" : "Confirm booking"}
                {!submitting && (
                  <ArrowRightIcon className="h-4 w-4 transition-transform duration-150 ease-[cubic-bezier(0.2,0.8,0.2,1)] group-enabled:group-hover:translate-x-1" />
                )}
              </button>
            </div>
          ) : (
            <>
              <div className="mb-1 flex items-center justify-between">
                <p className={`text-sm font-semibold tabular-nums ${c.title}`}>
                  {selectedDate ? (
                    <>
                      {selectedDate.toFormat("ccc")}{" "}
                      <span className={c.faint}>{selectedDate.toFormat("dd")}</span>
                    </>
                  ) : (
                    "Pick a day"
                  )}
                </p>
                <div className={`inline-flex overflow-hidden rounded-md border text-xs ${c.toggleBorder}`}>
                  {[true, false].map((is12) => (
                    <button
                      key={String(is12)}
                      onClick={() => setHour12(is12)}
                      aria-pressed={hour12 === is12}
                      className={`min-h-9 px-3 tabular-nums ${hour12 === is12 ? c.toggleOn : c.toggleOff}`}
                    >
                      {is12 ? "12h" : "24h"}
                    </button>
                  ))}
                </div>
              </div>
              <p className={`mb-3 flex items-center gap-1.5 text-xs ${c.faint}`}>
                <GlobeIcon />
                <span>
                  <span className="sr-only">Timezone: </span>
                  {zone.replace(/_/g, " ")}
                </span>
              </p>
              {errorAlert && <div className="mb-3">{errorAlert}</div>}
              <div className="-mr-2 flex-1 space-y-2 overflow-y-auto pr-2">
                {loading ? (
                  Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} className={`h-11 animate-pulse rounded-md ${c.skeleton}`} />
                  ))
                ) : daySlots.length === 0 ? (
                  <p className={`text-sm ${c.faint}`}>No times left that day, pick another.</p>
                ) : (
                  daySlots.map((iso) => (
                    <button
                      key={iso}
                      onClick={() => setSelectedSlot(iso)}
                      className={`flex min-h-11 w-full items-center gap-2 rounded-md border px-3 py-2.5 text-left text-sm tabular-nums ${c.slot}`}
                    >
                      <span
                        className="h-1.5 w-1.5 rounded-full bg-pennie-green"
                        style={dotStyle}
                      />
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
