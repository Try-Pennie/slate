"use client";

import { DateTime } from "luxon";
import { formatClockTime } from "@/lib/date/parse";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ArrowRightIcon } from "@/components/icons";
import { BookerStrip, BookerStripSkeleton } from "@/components/BookerStrip";
import { SlotTimes } from "@/components/SlotTimes";
import { useSlotPicker } from "@/components/use-slot-picker";
import { rescheduleOffersAlternatives } from "@/lib/booking/nearest-slots";
import { NearestTimesPanel } from "@/components/NearestTimes";
import { validateAttendee, type AttendeeErrors } from "@/lib/attendee";
import { prefillPhone } from "@/lib/phone-format";
import { usePhoneCaret } from "@/lib/usePhoneCaret";
import { HONEYPOT_FIELD } from "@/lib/booking/honeypot";
import {
  isNextDaysReply,
  NEXT_DAYS_FAILURE,
  nextDaysFailureFor,
  type NextDaysFailure,
} from "@/lib/booking/next-days-reply";
import { getJson, postJson, REQUEST_TIMEOUT_MS } from "@/lib/http";
import { useStalledAfter } from "@/lib/useStalledAfter";
import { BobbingDots } from "@/components/BobbingDots";
import { ConfirmationMark } from "@/components/ConfirmationMark";
import { messageLines } from "@/lib/booking/slot-picker";
import {
  BOOKING_ERROR_COPY,
  CONFIRMED_COPY,
  DETAILS_COPY,
  contactDisclosure,
  DUPLICATE_COPY,
  HONEYPOT_LABEL,
  MOVE_COPY,
  movedContactNote,
  CLOSED_BODY,
  UNCLASSIFIED_EMPTY_NOTICE,
  UNCLASSIFIED_EMPTY_RETRY,
  NEXT_DAYS_COPY,
  descriptionParagraphs,
  phonePrefillNotice,
  allTimesTaken,
  noAdvisorsAvailable,
  closedNoReopenDate,
  closedUntil,
  confirmedAnnouncement,
  confirmedWhen,
  duplicateSetFor,
  inviteOnItsWay,
  keepExistingTime,
  moveToTime,
} from "@/lib/booking/booker-copy";
import { labelColorFor } from "@/lib/brand-label";
import {
  deviceTimeZone,
  timezoneOptions,
  resolveZone,
} from "@/lib/booking/timezones";
import { SelectField } from "@/components/ui/SelectField";
import { embedParentOrigin } from "@/lib/embed/parent-origin";
import ReasonPicker from "@/components/ReasonPicker";
import { validateReason, type ReasonOption } from "@/lib/booking/core";

interface Attendee {
  name: string;
  email: string;
  phone: string;
}

/** The lead's OTHER active booking, surfaced by /booking so the confirmation
 *  screen can offer to view or cancel it (#626).
 *
 *  #1340: only a strong (salesforce / external id) or medium (email AND phone)
 *  identity match carries the booking's details. A weak one-signal match (a
 *  shared household phone, a couple on one email) arrives as `disclose: false`
 *  and carries nothing, because that booking may belong to someone else and its
 *  manage token can reschedule or cancel it. Mirrors `DuplicateWarning` in
 *  `src/lib/booking/orchestration.ts`; the union is what stops a surface
 *  rendering a start time the server deliberately withheld. */
type DuplicateWarning =
  | { disclose: true; startsAt: string; manageUrl: string }
  | { disclose: false };

/** The call this lead already has, returned by /booking instead of creating a
 *  second one (#1337). Graded exactly as the warning above: a weak one-signal
 *  match carries nothing, so there is no time to show and no token to move
 *  with. Mirrors `ExistingCall` in `src/lib/booking/orchestration.ts`. */
type ExistingCall =
  | { disclose: true; startsAt: string; advisorName: string | null; manageToken: string }
  | { disclose: false };

interface BookerProps {
  bucketCode: string;
  /**
   * The `xbc` exactly as it arrived, which is NOT always `bucketCode`: a blank or
   * unreadable one is routed to the Low pool (#1908) and this is the only record
   * of what the upstream page actually sent. Carried so the booking can be counted
   * as a catch-all rather than as a lead who genuinely asked for that pool.
   */
  requestedCode?: string;
  salesforceId: string | null;
  attendee: Attendee;
  prefill: Record<string, string>;
  /** True when rendered inside the embed iframe (drives postMessage to host). */
  embedded?: boolean;
  /** Palette, from the embed `ui` config. Defaults to light. */
  theme?: "light" | "dark";
  /** Brand accent (hex) from the embed `ui` config; tints dots/ring/confirm. */
  brandColor?: string;
  /** Host page origin (from widget.js), used as the postMessage target so the
   *  booking-success payload is never broadcast to "*" (#593). */
  parentOrigin?: string;
  /** Active reschedule reason options, resolved from the store server-side
   *  (#346), for the Move offered when a lead already has a call (#1337). A
   *  reschedule records a mandatory reason and the lead is asked for it here
   *  (Dan, 2026-08-07), so the UI and the server share one live set. */
  rescheduleReasons: ReasonOption[];
  /** Org-wide booking horizon in days (#216), resolved server-side and passed in.
   *  REQUIRED on purpose: a required prop makes tsc flag any construction site that
   *  forgets it, so the old hardcoded HORIZON_DAYS=4 divergence (AUD-076) can't come
   *  back through a silent default. */
  horizonDays: number;
  /**
   * The call this lead ALREADY has, resolved server side from the id in the path
   * (#2166).
   *
   * On `/booking/{salesforceId}` the lead is known from the first render, so the
   * notice is put in front of them before they pick a time rather than after the
   * confirm refuses. Null on `/book` with no id, where nothing identifies them
   * until they submit their details and the confirm check is the first moment
   * anybody can be recognised.
   */
  landingCall?: ExistingCall | null;
}

interface AvailabilityResponse {
  // Only the routing code is exposed to leads — never the internal bucket name (#259).
  bucket: { code: string };
  orgName: string;
  eventType: { name: string; description: string | null; durationMin: number };
  slots: string[];
  /** Why there is nothing to offer (#1328), when there is nothing. Null when the
   *  server could not tell, in which case the vaguer copy is the honest one. */
  emptyBecause?:
    | { kind: "closed"; reopensOn: string | null }
    /** #2158: nobody in the bucket's pool at all. Kept apart from `busy` because
     *  the two call for opposite responses and, said as one word, a lead reads
     *  the wrong one. */
    | { kind: "unstaffed" }
    | { kind: "busy" }
    | null;
}

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
  // Every wash below is the LIGHT half of a pair whose dark half, above, swaps it
  // for an accent tint. `--fg` is graphite while this half applies, so the pair
  // is fixed against fixed. That is the shape #2007 asks for, expressed as two
  // maps rather than as a `dark:` prefix per class, which is why each line
  // carries the marker rather than the block.
  light: {
    shell: "bg-surface text-fg",
    border: "border-border",
    title: "text-fg",
    muted: "text-fg-muted",
    faint: "text-fg-muted",
    body: "text-fg",
    // theme-pair-ok: light half of a two map palette, see the note above
    avatar: "bg-pennie-sky-soft text-fg",
    // theme-pair-ok: light half of a two map palette, see the note above
    dayOn: "text-fg hover:bg-pennie-sky-soft",
    dayOff: "cursor-default text-fg-muted opacity-50",
    daySelected: "bg-pennie-sky-soft",
    ring: "ring-accent",
    slot: "border-border bg-surface text-fg hover:border-fg/45",
    input:
      "bg-surface text-fg placeholder:text-fg-muted shadow-[inset_0_0_0_1px_var(--border)]",
    toggleBorder: "border-border",
    // theme-pair-ok: light half of a two map palette, see the note above
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

/** Sentinel <option> value: picking it reveals the full-list search (#219). */

export default function Booker({
  bucketCode,
  requestedCode,
  salesforceId,
  landingCall,
  attendee: initialAttendee,
  prefill,
  embedded = false,
  theme = "light",
  brandColor,
  parentOrigin,
  horizonDays,
  rescheduleReasons,
}: BookerProps) {
  // #1849: a fixed US list. A lead whose browser reports a non US zone is shown
  // Eastern rather than their own. Nothing is mis-booked, because the stored
  // instant is always UTC; what changes is what they READ, and that is the trade
  // Dan took knowingly. The "more zones" search went with it, since a way out of
  // a fixed list is not a smaller version of fixing the list.
  const detectedZone = useMemo(() => deviceTimeZone(), []);
  const [zone, setZone] = useState(resolveZone(detectedZone).id);
  const selectOptions = useMemo(() => timezoneOptions(), []);
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

  // Bare `DateTime` (= DateTime<boolean>) matches BookerCalendar's prop contract;
  // @types/luxon's generic validity would otherwise infer a narrower type that
  // onMonthChange (DateTime<boolean>) can't set.
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  // #1337: the confirm was DECLINED because this person already has an active
  // call. Nothing was created. The screen offers to move that call into the slot
  // they just picked; `disclose: false` means the match was one signal only, so
  // nothing about it may be shown and there is nothing to move from here (#1340).
  const [existingCall, setExistingCall] = useState<ExistingCall | null>(landingCall ?? null);
  /**
   * True while the panel on screen is the LANDING one, which has no picked time
   * behind it and so cannot offer a move.
   *
   * Its own flag rather than inferred from `selectedSlot` being null: the confirm
   * path clears the slot on some refusals, and a panel that decided what to offer
   * by looking at the slot would silently turn into the landing one there (L55).
   */
  const [onLanding, setOnLanding] = useState(Boolean(landingCall));
  const [moveReason, setMoveReason] = useState("");
  const [moveDetail, setMoveDetail] = useState("");
  // #1329 / #1339: the first bookable days on the far side of a closure, fetched
  // only when a lead presses the button, so the longer search is paid for by the
  // few who arrive during a shutdown rather than by every recompute pass. Null
  // until asked for; an empty array means we looked and there is genuinely nothing.
  const [nextDaySlots, setNextDaySlots] = useState<string[] | null>(null);
  const [loadingNext, setLoadingNext] = useState(false);
  const [nextFailure, setNextFailure] = useState<NextDaysFailure | null>(null);
  const [hour12, setHour12] = useState(true);
  // #1332: a prefilled number is what the advisor ends up calling, and most real
  // leads arrive with one from the landing page, so it reads the same as a typed
  // one. Normalised HERE rather than in each page that builds the props, so a new
  // construction site cannot forget.
  //
  // #1356: a number Pennie cannot call is DROPPED rather than passed through, and
  // the drop is reported, because the field caps at ten digits so the lead cannot
  // type it back either. An empty field with no explanation would send them to
  // press confirm and be told "enter your phone number", which is true and useless.
  const initialPhone = useMemo(() => prefillPhone(initialAttendee.phone), [initialAttendee.phone]);
  const [attendee, setAttendee] = useState<Attendee>(() => ({
    ...initialAttendee,
    phone: initialPhone.value,
  }));
  // Shown until they type something, then it has served its purpose: it explains
  // an empty field, and the field is no longer empty. The SENTENCE comes from the
  // reason the number was dropped, never from the value, so an unfinished number
  // cannot be explained as a foreign one (#1409).
  const phoneNotice =
    attendee.phone === "" ? phonePrefillNotice(initialPhone.dropped) : null;
  // Honeypot (#1033): a real user never sees or fills the hidden decoy below, so
  // it stays empty; a bot that fills every field trips the server-side check.
  const [honeypot, setHoneypot] = useState("");
  const [fieldErrors, setFieldErrors] = useState<AttendeeErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // #1332 shapes the number as it is typed; #2162 keeps the caret where the lead
  // put it while that happens. Both live in the hook, so the manage page cannot
  // have one without the other.
  const phone = usePhoneCaret((formatted) => {
    setAttendee((a) => ({ ...a, phone: formatted }));
    setFieldErrors((f) => (f.phone ? { ...f, phone: undefined } : f));
  });
  const [confirmed, setConfirmed] = useState<{
    start: string;
    manageUrl?: string | null;
    duplicateWarning?: DuplicateWarning | null;
    /** What a move ALSO changed, when the lead typed new details (#2164). */
    contactChanged?: { name: boolean; email: boolean; phone: boolean } | null;
  } | null>(null);
  // Three distinct states for the confirm (owner rule): started → this flips the
  // still-alive cue at ~10s → the postJson timeout converts a hang to error.
  const stalled = useStalledAfter(submitting);
  // #1364: the middle of the three states for the next-available search, which is
  // a separate action from the confirm and so needs its own watchdog rather than
  // sharing one flag with it.
  const lookingStalled = useStalledAfter(loadingNext);
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

  // #1339: the button that revealed the far-side days is gone once they are on
  // screen, so focus would drop to <body> and a keyboard user would have to walk
  // the whole page again to reach the days they just asked for.
  useEffect(() => {
    if (!nextDaySlots || nextDaySlots.length === 0) return;
    rootRef.current
      ?.querySelector<HTMLButtonElement>("[role='group'][aria-label='Available days'] button")
      ?.focus();
  }, [nextDaySlots]);

  // Request exactly the precomputed window [today, today + horizonDays]. The
  // horizon is the org-wide setting (#216), resolved server-side and passed in as
  // a prop (single source of truth, AUD-076) rather than duplicated here.
  //
  // #1416: this window used to be intersected with the CALENDAR MONTH being
  // viewed, which the deleted month grid needed and the day strip never did. At a
  // month boundary that clipped the horizon: with four bookable days and today the
  // 30th, `min(monthEnd, horizonEnd)` asked only to the 31st and the lead was
  // offered two days instead of four. Nothing about the strip ever wanted a month.
  const availabilityUrl = useMemo(() => {
    const from = today.toUTC().toISO();
    const to = today.plus({ days: horizonDays }).toUTC().toISO();
    return `/api/availability?bucket=${encodeURIComponent(bucketCode)}&from=${encodeURIComponent(from!)}&to=${encodeURIComponent(to!)}`;
  }, [bucketCode, today, horizonDays]);

  // The shared picker (#1336) owns the fetch, the abort + supersession guard
  // (#629), the day grouping in the viewer's zone, the chosen day and the
  // loading / failed / empty states, so the booker and the reschedule surfaces
  // cannot drift apart again. No day is chosen until the lead chooses one.
  const picker = useSlotPicker({ url: availabilityUrl, zone, slotsOverride: nextDaySlots });
  const meta = picker.payload as AvailabilityResponse | null;
  /**
   * The time a request was just refused for, or null (#1319, #1549). Set only on a 409 race,
   * and cleared as soon as the lead picks anything, because the offer only makes sense while
   * the refusal is the thing on screen.
   *
   * The `variant` rides along rather than living in a second state, so the two cannot
   * disagree: this surface can be refused in two different moments, a confirm part-way
   * through booking, and a move of a call the lead already has, and the reassurance those two
   * people need is not the same sentence.
   */
  const [refused, setRefused] = useState<{ slot: string; variant: "book" | "move" } | null>(
    null,
  );
  const refusedSlot = refused?.slot ?? null;
  const activeDay = picker.selectedDay;
  const loading = picker.view.kind === "loading";

  // The single origin every outbound embed message targets. Never "*": the
  // success payload carries lead PII, so a wildcard could hand it to whatever
  // origin the parent later becomes (#593). null when the framer is unknown, in
  // which case we skip the post rather than broadcast.
  const parentTargetOrigin = useMemo(
    () =>
      embedParentOrigin(
        parentOrigin,
        typeof document !== "undefined" ? document.referrer : null,
      ),
    [parentOrigin],
  );
  const postToParent = useCallback(
    (message: unknown) => {
      if (!parentTargetOrigin) return;
      window.parent.postMessage(message, parentTargetOrigin);
    },
    [parentTargetOrigin],
  );

  // Tell the embedding page our height so the iframe resizes with no scroll.
  useEffect(() => {
    if (!embedded || !rootRef.current) return;
    const post = () =>
      postToParent({
        type: "slate:resize",
        height: rootRef.current?.scrollHeight ?? 0,
      });
    const ro = new ResizeObserver(post);
    ro.observe(rootRef.current);
    post();
    return () => ro.disconnect();
  }, [embedded, meta, activeDay, selectedSlot, confirmed, postToParent]);

  // Keydowns inside the iframe never reach the host page, so relay Escape
  // for the host's modal chrome to close on (widget.js listens for it).
  useEffect(() => {
    if (!embedded) return;
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        postToParent({ type: "slate:escape" });
      }
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  }, [embedded, postToParent]);

  function fmtTime(iso: string) {
    const dt = DateTime.fromISO(iso).setZone(zone);
    // The 12 hour spelling comes from the shared formatter (#1765); the 24 hour
    // one is the lead's own preference and has only ever had one spelling.
    return hour12 ? (formatClockTime(dt) ?? "") : dt.toFormat("HH:mm");
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
        manageUrl?: string;
        error?: string;
        fieldErrors?: AttendeeErrors;
        duplicateWarning?: DuplicateWarning | null;
        existingCall?: ExistingCall | null;
      }>(
        "/booking",
        {
          bucketCode,
          requestedCode,
          start: selectedSlot,
          timezone: zone,
          salesforceId,
          attendee: {
            name: attendee.name.trim(),
            email: attendee.email.trim(),
            phone: attendee.phone.trim(),
          },
          prefill,
          // Empty for every real lead; a bot filling all fields sends a value the
          // server rejects (#1033).
          [HONEYPOT_FIELD]: honeypot,
        },
        // Convert a wedged confirm (server accepted, never responds) into the
        // retryable error below instead of an endless "Booking your call…" (#626).
        { timeoutMs: REQUEST_TIMEOUT_MS },
      );

      if (ok) {
        setConfirmed({
          start: data.startsAt ?? selectedSlot,
          manageUrl: data.manageUrl ?? null,
          duplicateWarning: data.duplicateWarning ?? null,
        });
        if (embedded) {
          postToParent({
            type: "slate:bookingSuccessful",
            data: { booking: data, salesforceId },
          });
        }
      } else if (status === 409 && data.existingCall) {
        // Declined, not failed: this person already has an active call and
        // nothing was created (#1337). The slot they picked is kept so the offer
        // to move the existing call into it can name it.
        setExistingCall(data.existingCall);
      } else if (status === 409) {
        setError(BOOKING_ERROR_COPY.slotTaken);
        // #1319: remember WHICH time went, so the alternatives below can leave it out. It is
        // the one time we know is gone, and the reload can still be carrying it.
        setRefused(selectedSlot ? { slot: selectedSlot, variant: "book" } : null);
        setSelectedSlot(null);
        // Re-run the load so the stale list is swapped for the loading state
        // rather than left tappable with a time that has gone.
        picker.retry();
      } else {
        if (data.fieldErrors) setFieldErrors(data.fieldErrors);
        setError(data.error ?? BOOKING_ERROR_COPY.generic);
      }
    } finally {
      setSubmitting(false);
    }
  }

  const moveReasonValid = validateReason(
    { code: moveReason, detail: moveDetail },
    rescheduleReasons,
  ).ok;

  /** Move the call this lead already has into the slot they just picked (#1337).
   *  Goes through the same lead reschedule endpoint their emailed manage link
   *  uses, so the reason, the audit trail and the webhook are identical. */
  async function moveExistingCall() {
    if (!existingCall?.disclose || !selectedSlot) return;
    setSubmitting(true);
    setError(null);
    try {
      const { ok, status, data } = await postJson<{
        startsAt?: string;
        error?: string;
        reason?: string;
        contactChanged?: { name: boolean; email: boolean; phone: boolean };
      }>(
        `/api/bookings/${encodeURIComponent(existingCall.manageToken)}/reschedule`,
        {
          start: selectedSlot,
          reason: moveReason,
          reasonDetail: moveDetail || undefined,
          // #2164: the details on this visit, which are routinely a CORRECTION of
          // the ones the call was booked with. The server writes whichever of them
          // actually moved and rewrites the invite; sending them unchanged costs
          // nothing, because it compares before it writes.
          attendee: {
            name: attendee.name.trim(),
            email: attendee.email.trim(),
            phone: attendee.phone.trim(),
          },
        },
        { timeoutMs: REQUEST_TIMEOUT_MS },
      );
      if (ok) {
        setExistingCall(null);
        setConfirmed({
          start: data.startsAt ?? selectedSlot,
          manageUrl: null,
          contactChanged: data.contactChanged ?? null,
        });
        return;
      }
      // Nobody was holding that slot during the decision, so it can go. Say so
      // and put them back in the picker rather than failing silently or leaving
      // them with neither call moved nor a new one booked.
      setExistingCall(null);
      setSelectedSlot(null);
      setError(
        status === 409
          ? BOOKING_ERROR_COPY.slotTaken
          : (data.error ?? BOOKING_ERROR_COPY.moveFailed),
      );
      // #1549: and the soonest times still open beneath it, as on a refused confirm. This
      // lead has a call they were trying to KEEP, so the offer carries the move wording:
      // nothing of theirs was lost. Only when the refusal really means that time is gone.
      if (rescheduleOffersAlternatives(status, data.reason)) {
        setRefused({ slot: selectedSlot, variant: "move" });
      }
      picker.retry();
    } finally {
      setSubmitting(false);
    }
  }

  const shell = `mx-auto max-w-4xl overflow-hidden rounded-xl shadow-xs ${c.shell}`;

  // #1337: declined because this person already has an active call. Nothing was
  // created. No policy voice: the rule is not explained (that makes the panel
  // about us and draws attention to something the lead never asked about), the
  // call they have is simply put in front of them with the obvious thing to do.
  if (existingCall) {
    const longDay = (iso: string) =>
      DateTime.fromISO(iso).setZone(zone).toFormat("cccc, LLLL d");
    const shortDay = (iso: string) =>
      DateTime.fromISO(iso).setZone(zone).toFormat("ccc, LLL d");
    const newWhen = selectedSlot
      ? `${shortDay(selectedSlot)} at ${fmtTime(selectedSlot)}`
      : null;
    return (
      <div ref={rootRef} data-theme={theme} className={shell}>
        <div className="mx-auto max-w-md p-8">
          <h2 className={`text-xl font-semibold ${c.title}`}>
            You already have a call booked
          </h2>
          {existingCall.disclose ? (
            <>
              <p className={`mt-3 text-sm tabular-nums ${c.body}`}>
                {longDay(existingCall.startsAt)} at {fmtTime(existingCall.startsAt)}
                {/* No name rather than a wrong one when the advisor cannot be
                    resolved (L75): a booking can be reassigned, so the name is
                    read live and simply left out when it is unavailable. */}
                {existingCall.advisorName ? `, with ${existingCall.advisorName}.` : "."}
              </p>
              {newWhen && !onLanding && (
                <p className={`mt-4 text-sm ${c.body}`}>
                  Would you like to move it to <span className="tabular-nums">{newWhen}</span>{" "}
                  instead?
                </p>
              )}
              {/* #2166: the LANDING panel has no picked time behind it, so it
                  cannot offer a move and does not ask for a reason for one. The
                  way on is the picker, which is what the lead came for. */}
              {!onLanding && (
              <div className="mt-5">
                <ReasonPicker
                  legend={MOVE_COPY.reasonLegend}
                  options={rescheduleReasons}
                  code={moveReason}
                  detail={moveDetail}
                  onCode={setMoveReason}
                  onDetail={setMoveDetail}
                  idPrefix="booker-move-reason"
                />
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
              <div className="mt-6 flex flex-col gap-3">
                {onLanding ? (
                  <button
                    onClick={() => {
                      setExistingCall(null);
                      setOnLanding(false);
                    }}
                    className={`inline-flex min-h-12 items-center justify-center rounded-lg px-5 text-sm font-semibold ${c.confirm}`}
                    style={confirmStyle}
                  >
                    {MOVE_COPY.pickAnotherTime}
                  </button>
                ) : (
                  <>
                    <button
                      onClick={() => void moveExistingCall()}
                      disabled={submitting || !moveReasonValid || !selectedSlot}
                      className={`inline-flex min-h-12 items-center justify-center rounded-lg px-5 text-sm font-semibold disabled:opacity-60 ${c.confirm}`}
                      style={confirmStyle}
                    >
                      {submitting
                        ? MOVE_COPY.moving
                        : newWhen
                          ? moveToTime(newWhen)
                          : MOVE_COPY.moveNoTime}
                    </button>
                    <button
                      onClick={() => {
                        setExistingCall(null);
                        setSelectedSlot(null);
                        setMoveReason("");
                        setMoveDetail("");
                      }}
                      disabled={submitting}
                      className={`inline-flex min-h-12 items-center justify-center rounded-lg border px-5 text-sm font-semibold disabled:opacity-60 ${c.toggleBorder} ${c.body} ${c.navHover}`}
                    >
                      {keepExistingTime(shortDay(existingCall.startsAt))}
                    </button>
                  </>
                )}
              </div>
              {submitting && stalled && (
                <p role="status" className={`mt-4 text-center text-xs ${c.muted}`}>
                  {DETAILS_COPY.stillWorking}
                </p>
              )}
            </>
          ) : (
            // The match was one signal only, so that call may belong to someone
            // else: it is not named and its manage token is not handed over, which
            // also means there is nothing to move from here (#1340).
            <p className={`mt-3 text-sm ${c.muted}`}>
              {DUPLICATE_COPY.checkYourEmail}
            </p>
          )}
        </div>
      </div>
    );
  }

  if (confirmed) {
    const movedNote = confirmed.contactChanged
      ? movedContactNote(confirmed.contactChanged)
      : null;
    const confirmedDay = DateTime.fromISO(confirmed.start)
      .setZone(zone)
      .toFormat("cccc, LLL d");
    const confirmedTime = fmtTime(confirmed.start);
    const zoneLabel = zone.replace(/_/g, " ");
    // Carry the booker's theme onto the manage link so the manage page opens in
    // the same appearance (light is the default there, so only dark needs it).
    const manageHref =
      confirmed.manageUrl && theme === "dark"
        ? `${confirmed.manageUrl}${confirmed.manageUrl.includes("?") ? "&" : "?"}theme=dark`
        : confirmed.manageUrl;
    return (
      <div ref={rootRef} data-theme={theme} className={shell}>
        {/* Entrance animates opacity/transform only: a height animation would
            jitter the embed iframe via the ResizeObserver above. #637: the embed
            gets the same branded coins illustration as the standalone page (one
            delight moment); confirmation is a one-time swap, so the single iframe
            resize it triggers is not the animated-height jitter guarded above. */}
        <div className="pn-confirm-enter p-10 text-center">
          <ConfirmationMark />
          <h2
            ref={confirmedHeadingRef}
            tabIndex={-1}
            className={`mt-6 text-[length:var(--fs-h4)] font-semibold leading-snug outline-none ${c.title}`}
          >
            {CONFIRMED_COPY.heading}
          </h2>
          <p className={`mt-2 text-sm ${c.muted}`}>
            {/* Assembled by one builder so the preview shows exactly this line,
                with the markup only carrying the tabular figures (#1343). */}
            {confirmedWhen(confirmedDay, confirmedTime, zoneLabel)}
          </p>
          <p className={`mt-1 text-xs ${c.faint}`}>
            {inviteOnItsWay(attendee.email)}
          </p>
          {/* #2164: a move that also corrected the lead's own details says so.
              Silently applying half of what somebody asked for is the one outcome
              they cannot check. */}
          {movedNote && (
            <p className={`mt-3 text-sm ${c.muted}`}>{movedNote}</p>
          )}
          {manageHref && (
            // Opens in a new tab so an embed lead keeps this confirmation instead
            // of navigating the iframe away to the manage page (#637).
            <a
              href={manageHref}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-5 inline-flex min-h-[44px] items-center gap-1 text-sm font-semibold text-[var(--accent-ink,inherit)] underline underline-offset-2 hover:no-underline"
            >
              {CONFIRMED_COPY.manageLink}
              <span aria-hidden="true">→</span>
            </a>
          )}
          <p role="status" className="sr-only">
            {confirmedAnnouncement(confirmedDay, confirmedTime, zoneLabel)}
          </p>
          {confirmed.duplicateWarning && (
            <div
              role="status"
              className="mx-auto mt-6 max-w-sm rounded-xl bg-pennie-sky-soft px-5 py-4 text-left dark:bg-accent/15"
            >
              <p className={`text-sm font-semibold ${c.title}`}>
                {DUPLICATE_COPY.heading}
              </p>
              {confirmed.duplicateWarning.disclose ? (
                <>
                  <p className={`mt-1 text-sm ${c.muted}`}>
                    {duplicateSetFor(
                      `${DateTime.fromISO(confirmed.duplicateWarning.startsAt)
                        .setZone(zone)
                        .toFormat("cccc, LLL d")} at ${fmtTime(confirmed.duplicateWarning.startsAt)}`,
                    )}
                  </p>
                  <a
                    href={confirmed.duplicateWarning.manageUrl}
                    className="mt-2 inline-flex min-h-9 items-center gap-1 text-sm font-semibold text-[var(--accent-ink,inherit)] underline underline-offset-2 hover:no-underline"
                  >
                    {DUPLICATE_COPY.viewOrCancel}
                    <span aria-hidden="true">→</span>
                  </a>
                </>
              ) : (
                /* #1340: the match was one signal only (a shared phone or a
                   shared email), so that booking may belong to someone else.
                   Its time and its manage link are withheld: the token is the
                   only thing protecting it. The lead is pointed at the
                   confirmation email they already hold instead. */
                <p className={`mt-1 text-sm ${c.muted}`}>
                  {DUPLICATE_COPY.checkYourEmail}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  // `activeDay` is a bare date keyed in `zone`, so parse it back in that zone:
  // `.setZone` on a machine-zone midnight would slide the label a day when the
  // picked zone differs from the device's.
  const selectedDate = activeDay ? DateTime.fromISO(activeDay, { zone }) : null;

  // Rose error notice; rendered in whichever right-column branch is active
  // (the 409 race resets selectedSlot, so the message must show on the slot list too).
  // Plain rose text per the DS forms recipe: rose on the 12% wash is only 4.33:1 (AA fail).
  /**
   * #1319, #1549: the soonest times still open, under a refusal. The panel is shared with the
   * manage page, because both surfaces refuse in the same way for the same reason and a
   * private copy each is the divergence #1336 removed from the picker itself.
   *
   * Tapping one SELECTS it and leaves Confirm to the lead. Booking on the tap would turn a
   * glance into a commitment, right after the product has already surprised them once.
   */
  const nearestPanel = (
    <NearestTimesPanel
      refused={refusedSlot}
      slots={picker.slots}
      view={picker.view}
      zone={zone}
      variant={refused?.variant ?? "book"}
      onSelect={(iso) => {
        // Put the picker on that time's own day, so the rest of the surface agrees
        // with what was just chosen rather than still showing the old one.
        picker.selectDay(DateTime.fromISO(iso, { zone }).toISODate());
        setSelectedSlot(iso);
        setRefused(null);
        setError(null);
      }}
    />
  );

  const errorAlert = error ? (
    <div>
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
      {nearestPanel}
    </div>
  ) : null;

  // #1328: "All times are taken right now. Check back soon." is untrue in both
  // halves when the reason is a closure: nothing is taken, we are shut, and soon
  // may be a week. A lead reads it as a busy week, comes back tomorrow to the same
  // screen, and is never told anything. The server says which it is; when it cannot
  // tell, the vaguer line is the honest one, because a wrongly claimed closure
  // names a date the lead would act on.
  const closure = meta?.emptyBecause?.kind === "closed" ? meta.emptyBecause : null;
  const isClosure = closure !== null;

  // #1414: THREE causes, not two. The server sets `emptyBecause` whenever it can
  // tell, so its absence means an older response shape or a classifier that did not
  // run, and reporting that as "all times are taken" claims a measurement nobody
  // made. It is not the load failure either: the read succeeded, so blaming the
  // lead's connection would be a claim the check never established (L11).
  //
  // "Unknown" means the SERVER returned a window with nothing in it and did not say
  // why. That is not the same as a view with nothing in it for other reasons, so
  // the third state requires an empty PAYLOAD rather than merely an empty view.
  const serverReturnedNothing = meta !== null && meta.slots.length === 0;
  const emptyCause: "closed" | "busy" | "unstaffed" | "unknown" =
    meta?.emptyBecause?.kind ?? (serverReturnedNothing ? "unknown" : "busy");
  const emptyMessage =
    closure !== null
      ? closure.reopensOn
        ? closedUntil(closure.reopensOn, zone)
        : closedNoReopenDate()
      : // #2158: a FOURTH cause, and the one "all times are taken" was most wrong
        // about. An unstaffed bucket has nothing taken and no soon to check back
        // at, so it gets its own sentence with no invitation to return.
        emptyCause === "unstaffed"
        ? noAdvisorsAvailable()
        : emptyCause === "busy"
          ? allTimesTaken()
          : UNCLASSIFIED_EMPTY_NOTICE;

  // Dan, 2026-08-12: the far ahead search is offered for a CLOSURE only. A week
  // that is merely full is a staffing problem to fix rather than a reason to send a
  // lead weeks into the future, and this is the slowest action in the product. An
  // unknown cause counts as busy here: it could be either, and treating it as a
  // closure would put the button back on every busy week, which is what this
  // removes. Somebody being TOLD we are full is #1412's job, not the lead's.

  // #1339: the body only belongs under a closure we can date. "Before then" needs a
  // `then` to refer to, so it dangles under "We are closed right now", and under
  // "All times are taken" it is simply false: that week is staffed, it is full.
  const showClosedBody = Boolean(closure?.reopensOn);

  /** Look past the bounded window for the first days we can actually offer. */
  async function revealNextDays() {
    setLoadingNext(true);
    setNextFailure(null);
    // #1364: through the shared helper, so this read carries the same request
    // ceiling as every other lead-facing call. It had no timeout at all, and this
    // is the slowest action in the product (up to eight windows, each doing real
    // calendar work per bookable agent), so a wedged request left "Looking" on
    // screen indefinitely with no way for a lead to tell it had died. The abort
    // arrives here as `ok: false`, which is already the failed screen below.
    const res = await getJson<unknown>(
      `/api/availability/next?bucket=${encodeURIComponent(bucketCode)}`,
      { timeoutMs: REQUEST_TIMEOUT_MS, cache: "no-store" },
    );
    // An error state and an empty state are different screens: "we looked and
    // there is nothing" must never be shown for "we could not look". #2155: that
    // included a 200 whose payload this page cannot read, which used to be read as
    // an empty result, on the LAST thing offered to a lead who has already found
    // nothing nearby. The reply is typed `unknown`, so tsc refuses to let it be
    // used as slots until the guard has said it is.
    const failure = nextDaysFailureFor(res);
    if (failure === null && res.ok && isNextDaysReply(res.data)) {
      setNextDaySlots(res.data.slots);
    } else {
      setNextFailure(failure);
    }
    setLoadingNext(false);
  }

  /** The first revealed day, in words, or null when nothing has been revealed. */
  const revealedFrom =
    nextDaySlots && nextDaySlots.length > 0 && picker.days[0]
      ? DateTime.fromISO(picker.days[0], { zone }).toFormat("cccc, LLLL d")
      : null;

  // #1329 / #1339: with nothing bookable nearby, "check back soon" gives a lead
  // nothing to act on and no idea when soon is, so they leave. This names the
  // reason, and offers the way through. The longer search runs only when the button
  // is pressed. `nextDaySlots === []` means we looked and there is genuinely
  // nothing, which is a different screen from having failed to look.
  const closurePanel = (
    <div className="space-y-3 text-center">
      <p className={`text-sm ${c.faint}`}>{emptyMessage}</p>
      {showClosedBody && (
        // Each sentence on its own line, through the same helper every panel uses,
        // so the second never starts halfway across (#1336).
        <p className={`text-sm ${c.faint}`}>
          {messageLines(CLOSED_BODY).map((line) => (
            <span key={line} className="block">
              {line}
            </span>
          ))}
        </p>
      )}
      {/* #1414: the way out of a window we could not explain. It re-runs the
          availability read, which is the only thing that could change the answer;
          the far ahead search is deliberately NOT offered, because we do not know
          there is a far side to look at. */}
      {emptyCause === "unknown" && (
        <button
          onClick={() => picker.retry()}
          className={`inline-flex min-h-11 items-center justify-center rounded-lg border px-4 text-sm font-semibold ${c.toggleBorder} ${c.body} ${c.navHover}`}
        >
          {UNCLASSIFIED_EMPTY_RETRY}
        </button>
      )}
      {isClosure && nextDaySlots === null && (
        <>
          {nextFailure !== null && (
            <p role="alert" className="text-sm text-[var(--error)]">
              {nextFailure === NEXT_DAYS_FAILURE.unreadable
                ? NEXT_DAYS_COPY.unreadable
                : NEXT_DAYS_COPY.failed}
            </p>
          )}
          <button
            onClick={() => void revealNextDays()}
            disabled={loadingNext}
            className={`inline-flex min-h-11 items-center justify-center rounded-lg border px-4 text-sm font-semibold disabled:opacity-60 ${c.toggleBorder} ${c.body} ${c.navHover}`}
          >
            {loadingNext ? (
              // Dots AND the word. The dots are what reads as working from the
              // corner of an eye; the word is what reaches anyone who cannot see
              // them, and the dots are aria-hidden so it is not announced twice.
              <span className="inline-flex items-center gap-2">
                <BobbingDots />
                {NEXT_DAYS_COPY.looking}
              </span>
            ) : nextFailure !== null ? (
              NEXT_DAYS_COPY.retry
            ) : (
              NEXT_DAYS_COPY.ask
            )}
          </button>
          {/* Still ALIVE, distinct from started: a search this slow needs to say so
              before a lead concludes it is broken and leaves. Announced, so it
              reaches somebody who is not watching the button. Gone the instant the
              search settles, in either direction, because by then the claim that it
              is still running would be false. */}
          {loadingNext && lookingStalled && (
            <p role="status" className={`text-xs ${c.muted}`}>
              {NEXT_DAYS_COPY.stillLooking}
            </p>
          )}
        </>
      )}
      {nextDaySlots !== null && nextDaySlots.length === 0 && (
        <p className={`text-sm ${c.faint}`}>
          {NEXT_DAYS_COPY.foundNothing}
        </p>
      )}
    </div>
  );

  /**
   * How a time is WRITTEN: the reader's timezone, and 12 or 24 hour (#2160).
   *
   * One row, above the day strip, because they are one question ("how are these
   * times spelled") and because both are settled before the reader starts
   * choosing rather than after. They used to sit below the strip on two separate
   * lines, right aligned and left aligned, so nothing said they belonged together.
   *
   * Rendered on the DETAILS step too (#2172, Dan 2026-09-09). Hiding them there
   * was wrong for a reason specific to this screen: the day strip directly below
   * the row stays visible and stays live, since a day chip takes the lead back to
   * that day's times. A row that appeared and disappeared while the control under
   * it stayed put reads as a layout fault rather than as a step boundary.
   *
   * Changing the zone on that step moves nothing: the chosen slot is held as an
   * instant, so only its spelling changes.
   */
  const displayControls = (
    <div
      data-display-controls
      className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span className={c.faint}>
          <GlobeIcon />
        </span>
        <label htmlFor="booker-tz" className="sr-only">
          Timezone
        </label>
        <SelectField
          id="booker-tz"
          ariaLabel="Timezone"
          value={zone}
          onChange={setZone}
          className="max-w-full"
          options={selectOptions.map((o) => ({ value: o.id, label: o.label }))}
        />
      </div>
      <div className={`inline-flex shrink-0 rounded-md border ${c.toggleBorder}`}>
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
  );

  // Times / booking form (the 420px
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
          {/* #2172: this line is the details step's own statement of what is
              being booked, so it reads `hour12` and `zone` through the same
              `fmtTime` the list does. Two formatters here would let the summary
              and the times disagree about the same instant. */}
          <p data-testid="chosen-time" className={`text-sm font-semibold ${c.title}`}>
            {selectedDate?.toFormat("ccc d")} · {fmtTime(selectedSlot)}
          </p>
          {(["name", "email", "phone"] as const).map((field) => (
            <div key={field}>
              {/* Persistent visible label (#632): the field's purpose stays put
                  after a value is typed, unlike the old placeholder-only step. */}
              <label
                htmlFor={`booker-${field}`}
                className={`mb-1 block text-xs font-semibold ${c.muted}`}
              >
                {field[0].toUpperCase() + field.slice(1)}
              </label>
              <input
                id={`booker-${field}`}
                className={`min-h-12 w-full rounded-sm px-4 text-base ${c.input}`}
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
                ref={field === "phone" ? phone.attach : undefined}
                onChange={
                  field === "phone"
                    ? phone.onChange
                    : (e) => {
                        const next = e.target.value;
                        setAttendee((a) => ({ ...a, [field]: next }));
                        setFieldErrors((f) =>
                          f[field] ? { ...f, [field]: undefined } : f,
                        );
                      }
                }
              />
              {fieldErrors[field] && (
                <p
                  id={`booker-${field}-error`}
                  className="mt-1 text-sm text-[var(--error)]"
                >
                  {fieldErrors[field]}
                </p>
              )}
              {/* #1356: why the number they arrived with is not in the field. Not
                  an error, because they have done nothing wrong and nothing has
                  failed yet, so it is not styled or announced as one; it is the
                  reason a field they expected to be filled is empty. */}
              {field === "phone" && phoneNotice && !fieldErrors.phone && (
                <p className={`mt-1 text-sm ${c.muted}`}>{phoneNotice}</p>
              )}
            </div>
          ))}
          {/* Honeypot (#1033): off-screen and removed from the a11y tree + tab
              order, so a sighted, keyboard, or screen-reader user never reaches
              it and it stays blank. A form-scraping bot still sees it in the DOM
              and fills it; the server rejects any submission that carries a value.
              Positioned off-screen (not display:none) because some bots skip
              display:none fields. */}
          <div
            aria-hidden="true"
            style={{ position: "absolute", left: "-9999px", width: 1, height: 1, overflow: "hidden" }}
          >
            <label htmlFor={`booker-${HONEYPOT_FIELD}`}>{HONEYPOT_LABEL}</label>
            <input
              id={`booker-${HONEYPOT_FIELD}`}
              name={HONEYPOT_FIELD}
              type="text"
              tabIndex={-1}
              autoComplete="off"
              value={honeypot}
              onChange={(e) => setHoneypot(e.target.value)}
            />
          </div>
          {errorAlert}
          {/* #1041: what handing over the number actually leads to, said before
              the commitment rather than after it. It describes what happens and
              claims no agreement, because Slate records no consent anywhere and
              copy is a contract. It renders in the embed too: this is about the
              data being collected, not about whose page is around it. */}
          <p className={`text-center text-xs ${c.muted}`}>{contactDisclosure()}</p>
          <button
            onClick={submit}
            disabled={submitting}
            style={confirmStyle}
            className={`group inline-flex min-h-14 w-full items-center justify-center gap-2 rounded-xl px-4 text-base font-semibold ${c.confirm} active:translate-y-px disabled:opacity-60`}
          >
            {submitting ? DETAILS_COPY.confirming : DETAILS_COPY.confirm}
            {!submitting && (
              <ArrowRightIcon className="h-4 w-4 transition-transform duration-150 ease-[cubic-bezier(0.2,0.8,0.2,1)] group-enabled:group-hover:translate-x-1" />
            )}
          </button>
          {submitting && stalled && (
            <p
              role="status"
              className={`flex items-center justify-center gap-2 text-xs ${c.muted}`}
            >
              {DETAILS_COPY.stillWorking}
            </p>
          )}
        </div>
      ) : (
        <>
          {/* The day the times belong to is headed inside SlotTimes ("Times on
              Sat, Aug 15"). The two controls that decide how a time is WRITTEN
              live above the day strip now (#2160), not here. The polite
              announcement lives in SlotTimes, mounted across every state swap so
              a settled count is heard rather than silence (#633). */}
          {errorAlert && <div className="mb-3">{errorAlert}</div>}
          <div className="-mx-2 -my-1 flex-1 overflow-y-auto px-2 py-1">
            {/* The shared times panel (#1336) owns every state here, including
                the rule that no time renders until a day is chosen. The booker
                keeps its own slot chrome (the accent dot, the 12/24h label). */}
            <SlotTimes
              view={picker.view}
              timeZone={zone}
              onRetry={picker.retry}
              classes={{
                muted: `text-sm ${c.faint}`,
                heading: `text-sm font-semibold tabular-nums ${c.title}`,
                retry: `inline-flex min-h-9 items-center rounded-md border px-3 text-sm ${c.toggleBorder} ${c.body} ${c.navHover}`,
                grid: "space-y-2",
              }}
              noDaysNode={closurePanel}
              renderSlot={(iso) => (
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
              )}
            />
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
      {/* #1335: paragraphs, not one block. The copy is a description followed by an
          ask ("join from somewhere quiet, not while driving"), and the second half is
          a real instruction that changes how the call goes; run together they read as
          one paragraph and the ask stops reading as an ask. */}
      {descriptionParagraphs(meta?.eventType.description).map((para, i) => (
        <p key={i} className={`mt-3 text-sm leading-relaxed ${c.muted}`}>
          {para}
        </p>
      ))}
      <div className={`mt-5 space-y-2 text-sm ${c.body}`}>
        <div className="flex items-center gap-2">
          <span className={c.faint}>
            <ClockIcon />
          </span>
          {meta ? `${meta.eventType.durationMin}m` : ""}
        </div>
        {/* #1333 / #1357: the number here is the LEAD's own, echoed back so they can
            check what they typed, and LABELLED as theirs. The number that used to sit
            here was the main Pennie line, which read as a promise about who would
            call: agents are assigned round robin at confirm time and call from their
            own lines, so a lead screening unknown numbers could have missed the real
            call while waiting for the one they were shown. A bare number in a row of
            facts would reintroduce exactly that reading.

            Dan's call on #1333 (2026-08-12): "Your number:" rather than a sentence
            about the call. The panel cannot honestly say anything about the call at
            all, since the agent is not chosen until confirm, so it claims nothing in
            either direction and just shows the value back.

            Rendered only once there IS a number, rather than as a placeholder row:
            a row that says "Attendee phone number" is a label pretending to be a
            value, and inventing one for a field the lead has not filled in is the
            thing this panel got wrong in the first place. */}
        {attendee.phone && (
          <div className="flex items-start gap-2">
            <span className={`mt-0.5 shrink-0 ${c.faint}`}>
              <PhoneIcon />
            </span>
            <span>
              {DETAILS_COPY.yourNumber}{" "}
              <span className="tabular-nums">{attendee.phone}</span>
            </span>
          </div>
        )}
        <div className="flex items-center gap-2">
          <span className={c.faint}>
            <GlobeIcon />
          </span>
          {zone.replace(/_/g, " ")}
        </div>
      </div>
    </aside>
  );

  return (
    <div ref={rootRef} data-theme={theme} className={shell}>
      <div className="grid grid-cols-1 md:grid-cols-[260px_1fr]">
        {eventPanel}
        <div className="flex flex-col">
          {/* px-6 pt-6 aligns the strip's chips with the padded times list below. */}
          <div className="px-6 pt-6">
            {displayControls}
            {loading ? (
              // As many placeholder chips as days are about to arrive, so the
              // row does not change width as content lands.
              <BookerStripSkeleton skeletonClass={c.skeleton} count={horizonDays} />
            ) : (
              <>
                {/* #1339: the revealed block says where it starts, because these
                    days are NOT the next few days and a bare strip out here would
                    read as though they were. Announced politely and given focus,
                    since the button that revealed it is gone. */}
                {revealedFrom && (
                  <p
                    role="status"
                    className={`mb-3 text-sm ${c.muted}`}
                  >
                    Our next available days, from {revealedFrom}.
                  </p>
                )}
                <BookerStrip
                  today={today}
                  days={picker.days}
                  activeDay={activeDay}
                  zone={zone}
                  onSelect={(iso) => {
                    picker.selectDay(iso);
                    setSelectedSlot(null);
                  }}
                />
              </>
            )}
          </div>
          {timesPanel}
        </div>
      </div>
    </div>
  );
}
