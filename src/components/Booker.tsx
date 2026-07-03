"use client";

import { DateTime } from "luxon";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ArrowRightIcon, CheckBadgeIcon } from "@/components/icons";
import { BookerCalendar } from "@/components/BookerCalendar";
import { BookerStrip } from "@/components/BookerStrip";
import { validateAttendee, type AttendeeErrors } from "@/lib/attendee";
import { postJson, REQUEST_TIMEOUT_MS } from "@/lib/http";
import { useStalledAfter } from "@/lib/useStalledAfter";
import type { BookerLayout } from "@/lib/booking/layout";
import { labelColorFor } from "@/lib/brand-label";
import { timezoneOptions } from "@/lib/booking/timezones";

interface Attendee {
  name: string;
  email: string;
  phone: string;
}

/** The lead's OTHER active booking, surfaced by /booking so the confirmation
 *  screen can offer to view or cancel it (#626). */
interface DuplicateWarning {
  startsAt: string;
  manageUrl: string;
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
  /** Date-picker layout: a horizontal day strip (default) or the month grid. */
  layout?: BookerLayout;
}

interface AvailabilityResponse {
  // Only the routing code is exposed to leads — never the internal bucket name (#259).
  bucket: { code: string };
  orgName: string;
  eventType: { name: string; description: string | null; durationMin: number };
  slots: string[];
}

const localZone = () =>
  typeof Intl !== "undefined"
    ? Intl.DateTimeFormat().resolvedOptions().timeZone
    : "America/New_York";


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
  layout = "strip",
}: BookerProps) {
  // Options derive from the *detected* zone (fixed) so a traveling lead's own
  // zone stays in the list even after they switch the selection to a curated one.
  const detectedZone = useMemo(() => localZone(), []);
  const [zone, setZone] = useState(detectedZone);
  const zoneOptions = useMemo(() => timezoneOptions(detectedZone), [detectedZone]);
  const today = useMemo(() => DateTime.now().setZone(zone).startOf("day"), [zone]);
  const c = PALETTE[theme];
  // Brand accent overrides (inline, since the hex is dynamic). Undefined = keep
  // the palette default (green dots, themed ring/confirm).
  const dotStyle = brandColor ? { backgroundColor: brandColor } : undefined;
  // Label picked by luminance: graphite for light brands (sky 7.36:1), beige
  // for dark ones (a graphite label on navy would be 1.5:1).
  const confirmStyle = brandColor
    ? { backgroundColor: brandColor, color: labelColorFor(brandColor) }
    : undefined;

  const [month, setMonth] = useState(() => today.startOf("month"));
  const [meta, setMeta] = useState<AvailabilityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const [hour12, setHour12] = useState(true);
  const [attendee, setAttendee] = useState<Attendee>(initialAttendee);
  const [fieldErrors, setFieldErrors] = useState<AttendeeErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<{
    start: string;
    duplicateWarning?: DuplicateWarning | null;
  } | null>(null);
  // Three distinct states for the confirm (owner rule): started → this flips the
  // still-alive cue at ~10s → the postJson timeout converts a hang to error.
  const stalled = useStalledAfter(submitting);
  const rootRef = useRef<HTMLDivElement>(null);
  const confirmedHeadingRef = useRef<HTMLHeadingElement>(null);

  // a11y: move focus to the confirmation heading so the success is announced.
  useEffect(() => {
    if (confirmed) confirmedHeadingRef.current?.focus();
  }, [confirmed]);

  // a11y: when a slot is picked the slot list unmounts and the attendee form
  // mounts in its place; without this, keyboard focus drops to <body> and the
  // user has to re-traverse the calendar to reach the form.
  useEffect(() => {
    if (selectedSlot) document.getElementById("booker-name")?.focus();
  }, [selectedSlot]);

  const loadSlots = useCallback(async () => {
    // Set loading here too (not just on month change) so the post-409 refetch
    // swaps the stale slot list for skeletons instead of leaving it tappable.
    setLoading(true);
    setLoadError(false);
    // Only request the precomputed window [today, today+HORIZON_DAYS] (mirrors the
    // server constant in src/lib/availability/slot-cache.ts). A month entirely
    // beyond the horizon has no bookable slots — render it unavailable WITHOUT a
    // fetch that would otherwise anchor a cold compute outside the warmed window.
    const HORIZON_DAYS = 4;
    const horizonEnd = today.plus({ days: HORIZON_DAYS });
    const monthStart = month.startOf("month");
    const fromDt = DateTime.max(monthStart, today);
    if (fromDt > horizonEnd) {
      setMeta((prev) => (prev ? { ...prev, slots: [] } : prev));
      setLoading(false);
      return;
    }
    const from = fromDt.toUTC().toISO();
    const to = DateTime.min(month.endOf("month"), horizonEnd).toUTC().toISO();
    try {
      const res = await fetch(
        `/api/availability?bucket=${encodeURIComponent(bucketCode)}&from=${encodeURIComponent(from!)}&to=${encodeURIComponent(to!)}`,
        { cache: "no-store" },
      );
      if (res.ok) {
        setMeta((await res.json()) as AvailabilityResponse);
      } else {
        // Distinguish a failed fetch from a genuinely empty month, so the user
        // sees "couldn't load" + retry rather than a permanent "no availability".
        setLoadError(true);
      }
    } catch {
      setLoadError(true);
    }
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

  // Keydowns inside the iframe never reach the host page, so relay Escape
  // for the host's modal chrome to close on (widget.js listens for it).
  useEffect(() => {
    if (!embedded) return;
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        window.parent.postMessage({ type: "slate:escape" }, "*");
      }
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  }, [embedded]);

  const daySlots = activeDay ? (slotsByDay.get(activeDay) ?? []) : [];

  function fmtTime(iso: string) {
    const dt = DateTime.fromISO(iso).setZone(zone);
    return hour12
      ? `${dt.toFormat("h:mm")}${dt.toFormat("a").toLowerCase()}`
      : dt.toFormat("HH:mm");
  }

  async function submit() {
    if (!selectedSlot) return;

    const errors = validateAttendee(attendee);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      const first = (["name", "email", "phone"] as const).find((f) => errors[f]);
      if (first) document.getElementById(`booker-${first}`)?.focus();
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const { ok, status, data } = await postJson<{
        startsAt?: string;
        error?: string;
        fieldErrors?: AttendeeErrors;
        duplicateWarning?: DuplicateWarning | null;
      }>(
        "/booking",
        {
          bucketCode,
          start: selectedSlot,
          timezone: zone,
          salesforceId,
          attendee: {
            name: attendee.name.trim(),
            email: attendee.email.trim(),
            phone: attendee.phone.trim(),
          },
          prefill,
        },
        // Convert a wedged confirm (server accepted, never responds) into the
        // retryable error below instead of an endless "Booking your call…" (#626).
        { timeoutMs: REQUEST_TIMEOUT_MS },
      );

      if (ok) {
        setConfirmed({
          start: data.startsAt ?? selectedSlot,
          duplicateWarning: data.duplicateWarning ?? null,
        });
        if (embedded) {
          window.parent.postMessage(
            { type: "slate:bookingSuccessful", data: { booking: data, salesforceId } },
            "*",
          );
        }
      } else if (status === 409) {
        setError("That time was just taken. Please pick another.");
        setSelectedSlot(null);
        await loadSlots();
      } else {
        if (data.fieldErrors) setFieldErrors(data.fieldErrors);
        setError(data.error ?? "Something went wrong. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
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
          {confirmed.duplicateWarning && (
            <div
              role="status"
              className="mx-auto mt-6 max-w-sm rounded-xl bg-pennie-sky-soft px-5 py-4 text-left dark:bg-accent/15"
            >
              <p className={`text-sm font-semibold ${c.title}`}>
                Heads up: you already have another call booked
              </p>
              <p className={`mt-1 text-sm ${c.muted}`}>
                It&apos;s set for{" "}
                <span className="tabular-nums">
                  {DateTime.fromISO(confirmed.duplicateWarning.startsAt)
                    .setZone(zone)
                    .toFormat("cccc, LLL d")}{" "}
                  at {fmtTime(confirmed.duplicateWarning.startsAt)}
                </span>
                . If you only need one, you can view or cancel it.
              </p>
              <a
                href={confirmed.duplicateWarning.manageUrl}
                className="mt-2 inline-flex min-h-9 items-center gap-1 text-sm font-semibold text-[var(--accent-ink,inherit)] underline underline-offset-2 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
              >
                View or cancel that booking
                <span aria-hidden="true">→</span>
              </a>
            </div>
          )}
        </div>
      </div>
    );
  }

  // `activeDay` is a bare date keyed in `zone` (see slotsByDay), so parse it back
  // in that zone — `.setZone` on a machine-zone midnight would slide the label a
  // day when the picked zone differs from the device's.
  const selectedDate = activeDay ? DateTime.fromISO(activeDay, { zone }) : null;

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

  // Times / booking form — rendered once and shared by both layouts (the 420px
  // cap is for the scrolling slot list only).
  const timesPanel = (
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
                aria-required="true"
                aria-invalid={fieldErrors[field] ? true : undefined}
                aria-describedby={
                  fieldErrors[field] ? `booker-${field}-error` : undefined
                }
                value={attendee[field]}
                onChange={(e) => {
                  setAttendee((a) => ({ ...a, [field]: e.target.value }));
                  setFieldErrors((f) =>
                    f[field] ? { ...f, [field]: undefined } : f,
                  );
                }}
              />
              {fieldErrors[field] && (
                <p
                  id={`booker-${field}-error`}
                  className="mt-1 text-sm text-[var(--error)]"
                >
                  {fieldErrors[field]}
                </p>
              )}
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
          {submitting && stalled && (
            <p
              role="status"
              className={`flex items-center justify-center gap-2 text-xs ${c.muted}`}
            >
              Still working… this is taking longer than usual.
            </p>
          )}
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
            <div className={`inline-flex rounded-md border text-xs ${c.toggleBorder}`}>
              {[true, false].map((is12) => (
                <button
                  key={String(is12)}
                  onClick={() => setHour12(is12)}
                  aria-pressed={hour12 === is12}
                  className={`min-h-9 px-3 tabular-nums ${is12 ? "rounded-l-[9px]" : "rounded-r-[9px]"} ${hour12 === is12 ? c.toggleOn : c.toggleOff}`}
                >
                  {is12 ? "12h" : "24h"}
                </button>
              ))}
            </div>
          </div>
          <div className="mb-3 flex items-center gap-1.5 text-xs">
            <span className={c.faint}>
              <GlobeIcon />
            </span>
            <label htmlFor="booker-tz" className="sr-only">
              Timezone
            </label>
            <select
              id="booker-tz"
              value={zone}
              onChange={(e) => setZone(e.target.value)}
              className={`-ml-1 min-h-11 max-w-full truncate rounded-md border border-transparent bg-transparent px-1 text-xs hover:border-border ${c.body}`}
            >
              {zoneOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          {errorAlert && <div className="mb-3">{errorAlert}</div>}
          <div className="-mx-2 -my-1 flex-1 space-y-2 overflow-y-auto px-2 py-1">
            {loading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className={`h-11 animate-pulse rounded-md ${c.skeleton}`} />
              ))
            ) : loadError ? (
              <div className="space-y-2">
                <p className={`flex items-start gap-2 text-sm text-[var(--error)]`} role="alert">
                  <span className="mt-0.5 shrink-0">
                    <AlertIcon />
                  </span>
                  Couldn&apos;t load available times. Check your connection.
                </p>
                <button
                  onClick={() => void loadSlots()}
                  className={`inline-flex min-h-9 items-center rounded-md border px-3 text-sm ${c.toggleBorder} ${c.body} ${c.navHover}`}
                >
                  Try again
                </button>
              </div>
            ) : slotsByDay.size === 0 ? (
              <p className={`text-sm ${c.faint}`}>No availability this month. Try another month.</p>
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
  );

  const eventPanel = (
    <aside className={`border-b p-6 ${c.border} md:border-b-0 md:border-r`}>
      <div
        className={`mb-4 flex h-9 w-9 items-center justify-center rounded-full text-xs font-semibold ${c.avatar}`}
        style={confirmStyle}
      >
        {meta ? initials(meta.orgName) : ""}
      </div>
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
  );

  const calendarPanel = (
    <section className={`border-b p-6 ${c.border} md:border-b-0`}>
      <BookerCalendar
        month={month}
        today={today}
        canPrev={month.startOf("month") > today.startOf("month")}
        // Availability is cache-limited; once a loaded month comes back
        // empty there's nothing further to page into. Stay optimistic while
        // a month is still loading.
        canNext={loading || (meta?.slots.length ?? 0) > 0}
        onMonthChange={(m) => {
          setLoading(true);
          setMonth(m);
          setSelectedDay(null);
          setSelectedSlot(null);
        }}
        isSelected={(d) => d.toISODate() === activeDay}
        isDisabled={(d) => !slotsByDay.has(d.toISODate()!)}
        onSelect={(d) => {
          setSelectedDay(d.toISODate()!);
          setSelectedSlot(null);
        }}
        selectedStyle={confirmStyle}
        todayDotStyle={dotStyle}
      />
    </section>
  );

  return (
    <div ref={rootRef} data-theme={theme} className={shell}>
      {layout === "month" ? (
        <div className="grid grid-cols-1 md:grid-cols-[260px_1fr_240px]">
          {eventPanel}
          {calendarPanel}
          {timesPanel}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-[260px_1fr]">
          {eventPanel}
          <div className="flex flex-col">
            {/* px-6 pt-6 aligns the strip's chips with the padded times list below. */}
            <div className="px-6 pt-6">
              <BookerStrip
                today={today}
                availableDays={[...slotsByDay.keys()].sort()}
                activeDay={activeDay}
                zone={zone}
                onSelect={(iso) => {
                  setSelectedDay(iso);
                  setSelectedSlot(null);
                }}
              />
            </div>
            {timesPanel}
          </div>
        </div>
      )}
    </div>
  );
}
