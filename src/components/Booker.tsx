"use client";

import { DateTime } from "luxon";
import { formatClockTime, formatLongDate } from "@/lib/date/parse";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { AlertIcon, ArrowRightIcon, ClockIcon, GlobeIcon, PennieMark, PhoneOutlineIcon } from "@/components/icons";
import { BookerButton } from "@/components/BookerButton";
import type { BookerButtonVariant } from "@/components/booker-button";
import { BookerStrip, BookerStripSkeleton } from "@/components/BookerStrip";
import { SlotTimes } from "@/components/SlotTimes";
import { useSlotPicker } from "@/components/use-slot-picker";
import {
  CallMeNowConfirmation,
  CallMeNowRow,
  useCallMeNow,
  type CallMeNowConfig,
} from "@/components/CallMeNow";
import {
  EMBED_MESSAGE,
  LINK_FAILED,
  type BookingCancelledDetail,
} from "@/lib/embed/lifecycle-events";
import { rescheduleOffersAlternatives } from "@/lib/booking/nearest-slots";
import { NearestTimesPanel } from "@/components/NearestTimes";
import {
  validateAttendee,
  nameFieldErrors,
  joinName,
  prefillNameFields,
  type AttendeeErrors,
  type NameFieldErrors,
} from "@/lib/attendee";
import { prefillPhone } from "@/lib/phone-format";
import { usePhoneCaret } from "@/lib/usePhoneCaret";
import { PHONE_COPY, advisorWillCall } from "@/lib/booking/manage-copy";
import { UnsavedGuard } from "@/components/ui/UnsavedGuard";
import { HONEYPOT_FIELD } from "@/lib/booking/honeypot";
import {
  isNextDaysReply,
  NEXT_DAYS_FAILURE,
  nextDaysFailureFor,
  type NextDaysFailure,
} from "@/lib/booking/next-days-reply";
import { getJson, postJson, REQUEST_TIMEOUT_MS } from "@/lib/http";
import { NEXT_DAYS_TIMEOUT_MS } from "@/lib/availability/next-available";
import { testPassHeaders, testPassRefusalSentence } from "@/lib/embed/test-pass-header";
import { TestModeBand } from "@/components/TestModeBand";
import { PIECE_MESSAGE, type InlinePiece, type OpenBookerRequest } from "@/lib/embed/lifecycle-events";
import { useStalledAfter } from "@/lib/useStalledAfter";
import { ConfirmationMark, preloadConfirmationMark } from "@/components/ConfirmationMark";
import { messageLines } from "@/lib/booking/slot-picker";
import {
  BOOKING_ERROR_COPY,
  CONFIRMED_COPY,
  DETAILS_COPY,
  INLINE_CARD_COPY,
  PICKER_COPY,
  chosenWhen,
  longDayLabel,
  DUPLICATE_COPY,
  HONEYPOT_LABEL,
  MOVE_COPY,
  BOOKER_CANCEL_COPY,
  BOOKER_PHONE_COPY,
  cancelConsequenceFor,
  movedContactNote,
  CLOSED_BODY,
  UNCLASSIFIED_EMPTY_NOTICE,
  UNCLASSIFIED_EMPTY_RETRY,
  NEXT_DAYS_COPY,
  descriptionParagraphs,
  phonePrefillNotice,
  allTimesTaken,
  AGENT_LINK_COPY,
  noAdvisorsAvailable,
  closedNoReopenDate,
  closedUntil,
  confirmedAdvisor,
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
  zoneLabel as zoneReadName,
} from "@/lib/booking/timezones";
import { withinLeadCallingWindow } from "@/lib/booking/lead-calling-window";
import { SelectField } from "@/components/ui/SelectField";
import {
  embedParentOrigin,
  originMismatchMessage,
  parentOriginMismatch,
} from "@/lib/embed/parent-origin";
import { isFramed, referrerOriginForConfirm } from "@/lib/embed/referrer-origin";
import { postClientReport } from "@/components/ClientErrorBeacon";
import ReasonPicker from "@/components/ReasonPicker";
import { validateReason, type ReasonOption } from "@/lib/booking/core";

/** What the page hands over: one name, as every layer below the form carries it. */
interface Attendee {
  name: string;
  /** #2835: the first name a returning lead ANSWERED beside `name`, when Slate
   *  holds one. Seeds the first field whole whenever `name` starts with it. */
  firstName?: string;
  email: string;
  phone: string;
}

/**
 * What the FORM holds (#2362).
 *
 * The name is two fields here and one everywhere else. cal.com asks for a first
 * name and Slate worked one out by splitting whatever was typed into a single
 * box, which is right for "Mary Smith" and wrong for "Smith, Mary"; that value is
 * not internal, it reaches Regal and greets the lead in the first message Pennie
 * sends. The two are joined on submit, so the payload, the stored row and every
 * consumer are unchanged.
 */
interface AttendeeFields {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

/** The fields, in the order they are asked and in the order focus walks them. */
const ATTENDEE_FIELDS = ["firstName", "lastName", "email", "phone"] as const;

/**
 * What a browser should offer to fill each field with.
 *
 * Named per field rather than derived from the key, because the two name fields
 * take the values the platform actually publishes: a browser that has "Mary" and
 * "Smith" stored cannot fill either from a field calling itself `name`.
 */
const AUTOCOMPLETE = {
  firstName: "given-name",
  lastName: "family-name",
  email: "email",
  phone: "tel",
} as const;

/** What can be wrong, per field the lead can actually correct. */
type FormFieldErrors = NameFieldErrors & Pick<AttendeeErrors, "email" | "phone">;

/**
 * A server refusal, shown against a field.
 *
 * The API judges the joined `name`, so it can only ever blame `name`. The form
 * asks in two fields and makes the first one required, so that refusal belongs on
 * the first name: putting it on a field the lead cannot see would be a message
 * about a state they cannot change (L111).
 */
function formErrorsFromServer(errors: AttendeeErrors): FormFieldErrors {
  const { name, ...rest } = errors;
  return name ? { ...rest, firstName: name } : rest;
}

/** Move focus to the first refused field, in the order the form shows them, so a
 *  refusal from our check and one from the server land the lead in the same place. */
function focusFirstFieldError(errors: FormFieldErrors): void {
  const first = ATTENDEE_FIELDS.find((f) => errors[f]);
  if (first) document.getElementById(`booker-${first}`)?.focus();
}

/**
 * The confirm's `referrerOrigin` field (#2728), spread into the body so it is
 * ABSENT rather than null when there is nothing to send. Read at confirm time, off
 * the browser, because the frame and the referrer are facts about this page load.
 */
function confirmReferrerOrigin(): { referrerOrigin?: string } {
  if (typeof window === "undefined") return {};
  const origin = referrerOriginForConfirm({
    referrer: document.referrer,
    ownOrigin: window.location.origin,
    framed: isFramed(window),
  });
  return origin ? { referrerOrigin: origin } : {};
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

/**
 * The call this lead already has, returned by /booking instead of creating a second
 * one (#1337). Graded exactly as the warning above: a weak one-signal match carries
 * nothing, so there is no time to show and no token to move with.
 *
 * IMPORTED rather than mirrored (#2167). It was a hand written copy of the server's
 * shape, which is two spellings of one contract that nothing holds together: the
 * `mayCancel` field added here would have been absent from the copy, the panel
 * would have read `undefined`, and the cancel would simply never have appeared with
 * every test that mounts the component still green (L263, L317). `import type` is
 * erased, so no server module reaches the bundle.
 */
import type { ExistingCall } from "@/lib/booking/orchestration";
import { leadRescheduleTimesUrl } from "@/lib/booking/reschedule-times-url";
import { programLeadHeaders, programLeadTimesUrl } from "@/lib/booking/program-lead-header";
import { PLACEHOLDER_DAY_FULL_CODE } from "@/lib/booking/placeholder-day-full";
import type { CalendarLinks } from "@/lib/booking/calendar-links";
import AddToCalendar from "@/components/AddToCalendar";
import { MarkedLabel } from "@/components/ui/MarkedLabel";

interface BookerProps {
  bucketCode: string;
  /**
   * An agent's own booking link (#2073), when the booker is drawn for one: the
   * readable name from the address (#3026), or an old 64 hex token. The times then come from that one agent (`/api/availability?advisor=`)
   * and the confirm names the link instead of a bucket, so `bucketCode` is empty
   * and never sent. Null or absent on every routed page.
   */
  agentLink?: string | null;
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
  /**
   * #3718: the compact card a landing page draws in place through cal.com's
   * `Cal("inline")` (widget.js asks for `layout=inline`), as settled in
   * docs/design/inline-booker.html. Its first screen is the card; picking a time
   * goes on into the same details and confirm steps as the full booker.
   */
  layout?: "inline";
  /**
   * #3718: the inline card's Call me now row, or null for none. Set only when the
   * page asked for it (`callMeNow=above|below`) for a lead. The contact details are
   * the ones the HOST PAGE sent, never ones Slate looked up, because the press checks
   * them against the Lead and Salesforce's own values would always match.
   */
  callMeNow?: CallMeNowConfig | null;
  /**
   * #3718 (Geoff, 2026-10-15): one piece of the inline card, placed by the page on
   * its own: the times tile, or the Call me now row. A picked time, View more times
   * and a press each ask the page for the pop up booker (`PIECE_MESSAGE`) rather
   * than changing the piece. Null draws the whole card.
   */
  piece?: InlinePiece | null;
  /**
   * #3718: the pop up a times piece opened for a picked time: it lands on the
   * details step for it, or on its day saying it has gone.
   */
  initialSlot?: string | null;
  /** #3718: the pop up a times piece opened for View more times: it lands on this day. */
  initialDay?: string | null;
  /** #3718: the pop up a Call me now piece opened: it makes the request on arrival. */
  pressCallMeNow?: boolean;
  /** Palette, from the embed `ui` config. Defaults to light. */
  theme?: "light" | "dark";
  /** Brand accent (hex) from the embed `ui` config; tints dots/ring/confirm. */
  brandColor?: string;
  /**
   * #3718: the inline card's background as the host page set it, with the text
   * colour that reads on it (`judgeHostColours`). Undefined keeps Slate's card. It
   * paints only what sits directly on the card: the title and the line under the
   * confirmation. The panels keep their own surface.
   */
  cardSurface?: { background: string; ink: string };
  /** Host page origin (from widget.js), used as the postMessage target so the
   *  booking-success payload is never broadcast to "*" (#593). */
  parentOrigin?: string;
  /**
   * The bucket is a TEST bucket (#2660): the booking lands on a test calendar,
   * sends no text and reaches no downstream system. Established by the page
   * from the bucket row, and drawn on EVERY screen this component can show, so
   * neither a tester nor a stray lead can mistake it for a real booking (L678).
   */
  isTest?: boolean;
  /**
   * The short lived pass `/book` hands a page on an approved website when the
   * bucket is the public test bucket (#2666), sent as a header on the availability
   * read, the next days search and the confirm. Null for every other bucket, which
   * is sent exactly as it always was.
   */
  testPass?: string | null;
  /** Active reschedule reason options, resolved from the store server-side
   *  (#346), for the Move offered when a lead already has a call (#1337). A
   *  reschedule records a mandatory reason and the lead is asked for it here
   *  (Dan, 2026-08-07), so the UI and the server share one live set. */
  rescheduleReasons: ReasonOption[];
  /**
   * Active CANCEL reason options, resolved from the store server side (#346), for
   * the cancel offered to a lead the link recognises (#2167). A cancel records a
   * mandatory reason exactly as a reschedule does, so the UI and the server share
   * one live set rather than each holding a list.
   */
  cancelReasons: ReasonOption[];
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
  /**
   * #4389: a signed token saying this lead is a program lead, minted on the server by
   * `/booking/{salesforceId}` only (never `/book` or the widget). Read by the times
   * (#4390) and the confirm (#4391); null for every other lead.
   */
  programLeadToken?: string | null;
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
  /** #3495: the tier whose times are on show, handed back with the confirm so the
   *  server records it instead of reading the cache for it. NEVER rendered: the lead
   *  must not see routing (#259, Dan 2026-10-07). Null or absent when the answer
   *  named none, and then nothing is handed back. */
  shownTier?: string | null;
  /** #3797: when the list on show was computed, handed back with the confirm so a
   *  time somebody else took since then counts as a lost race, not a stale offer.
   *  NEVER rendered. Null or absent when the answer carried none. */
  slotsComputedAt?: string | null;
}

export type { CallMeNowConfig };

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
    // #3718: the inline card's surface, the booker's raised grey (round seven).
    card: "bg-surface-elevated",
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
    navHover: "hover:bg-[color-mix(in_srgb,var(--fg)_4%,transparent)]",
    skeleton: "bg-[var(--pennie-wild-sand)]",
    confirm: "bg-accent text-fg-on-sky hover:bg-accent-hover",
    backHover: "hover:text-fg",
    // #3718: the inline card's surface, Geoff's sky wash (round six).
    // theme-pair-ok: light half of a two map palette, see the note above
    card: "bg-pennie-sky-soft",
  },
};


/** Sentinel <option> value: picking it reveals the full-list search (#219). */

export default function Booker({
  bucketCode,
  agentLink = null,
  requestedCode,
  salesforceId,
  landingCall,
  attendee: initialAttendee,
  prefill,
  embedded = false,
  layout,
  callMeNow = null,
  piece = null,
  initialSlot = null,
  initialDay = null,
  pressCallMeNow = false,
  theme = "light",
  brandColor,
  cardSurface,
  parentOrigin,
  isTest = false,
  testPass = null,
  programLeadToken = null,
  horizonDays,
  rescheduleReasons,
  cancelReasons,
}: BookerProps) {
  // #1849: a fixed US list. A lead whose browser reports a non US zone is shown
  // Eastern rather than their own. Nothing is mis-booked, because the stored
  // instant is always UTC; what changes is what they READ, and that is the trade
  // Dan took knowingly. The "more zones" search went with it, since a way out of
  // a fixed list is not a smaller version of fixing the list.
  const detectedZone = useMemo(() => deviceTimeZone(), []);
  const [zone, setZone] = useState(resolveZone(detectedZone));
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
  /**
   * True while the picker is on screen FOR the call this lead already has (#2203).
   *
   * The panel is hidden while it is set, and choosing a time clears it, which is
   * what brings the panel back with a move to offer. Both are EVENTS rather than a
   * condition read off `selectedSlot`, for the same reason `onLanding` is its own
   * flag: the move's own refusal path clears the slot, and a panel inferring its
   * state from that would silently turn into the wrong one there (L55).
   */
  const [pickingMoveTime, setPickingMoveTime] = useState(false);
  /**
   * The link itself named this lead, so the product knows who they are without
   * being told again (#2166). Everything downstream that would otherwise fall back
   * to the anonymous flow reads this: a lead who arrived recognised stays
   * recognised, through a picker, a kept time and a refused move alike (L676).
   */
  const recognisedOnArrival = Boolean(landingCall);
  // #2167: cancelling the call they already have, from the panel that recognised
  // them. Its own three states: not asked, confirming, and done. `cancelled` is a
  // SCREEN rather than a flag on the panel, because after it there is no call left
  // for the panel to be about.
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelDetail, setCancelDetail] = useState("");
  const [moveReason, setMoveReason] = useState("");
  const [moveDetail, setMoveDetail] = useState("");
  /**
   * Correcting the number the advisor will ring, from the panel (#2207, #2213).
   *
   * `callPhone` is what the panel SHOWS, seeded from the server and rewritten from
   * what the save stored, so the line always reads back the number Slate actually
   * holds rather than the keystrokes. Its own state rather than the prop, because
   * a save changes it and a prop cannot (L14).
   */
  const [callPhone, setCallPhone] = useState<string | null>(
    landingCall?.disclose ? landingCall.phone : null,
  );
  const [editingCallPhone, setEditingCallPhone] = useState(false);
  /**
   * The lead corrected the number on THIS screen (#2210).
   *
   * Two routes write that field: this panel through the phone endpoint, and the
   * move through `attendee`, which for a recognised lead is whatever the LINK
   * carried and nothing they typed. The move's copy was read at page load, so it
   * is older, and applying it would write the stale number back over the
   * correction with nothing reporting a fault (L443).
   *
   * Its own flag rather than comparing the two numbers: the panel only ever holds
   * four digits of the stored one, so it cannot tell "they corrected it to
   * something new" from "the link happens to agree", and only the first of those
   * is a reason to act.
   */
  const [phoneCorrectedHere, setPhoneCorrectedHere] = useState(false);
  const [callPhoneDraft, setCallPhoneDraft] = useState("");
  const [callPhoneError, setCallPhoneError] = useState<string | null>(null);
  const [savingCallPhone, setSavingCallPhone] = useState(false);
  const callPhoneStalled = useStalledAfter(savingCallPhone);
  // #1329 / #1339: the first bookable days on the far side of a closure, fetched
  // only when a lead presses the button, so the longer search is paid for by the
  // few who arrive during a shutdown rather than by every recompute pass. Null
  // until asked for; an empty array means we looked and there is genuinely nothing.
  const [nextDaySlots, setNextDaySlots] = useState<string[] | null>(null);
  const [loadingNext, setLoadingNext] = useState(false);
  const [nextFailure, setNextFailure] = useState<NextDaysFailure | null>(null);
  /** #2666: the server's sentence when the next days search refused the test pass. */
  const [nextPassRefusal, setNextPassRefusal] = useState<string | null>(null);
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
  // #2362: a prefilled full name is shown SPLIT, in the two fields, so the guess
  // is in front of the lead and can be corrected before they commit. An inference
  // somebody can see and change is not one presented as a recorded fact (L192).
  //
  // #2835: unless Slate holds the first name they ANSWERED beside that name, in
  // which case the fields show it whole ("Mary Jo" / "Smith") rather than a split
  // of it. Held so the move can tell an untouched guess from an answer below.
  const [nameSeed] = useState(() => prefillNameFields(initialAttendee.name, initialAttendee.firstName));
  const [attendee, setAttendee] = useState<AttendeeFields>(() => ({
    firstName: nameSeed.firstName,
    lastName: nameSeed.lastName,
    email: initialAttendee.email,
    phone: initialPhone.value,
  }));
  /** The one name every layer below this form carries. */
  const attendeeName = joinName(attendee);
  // Shown until they type something, then it has served its purpose: it explains
  // an empty field, and the field is no longer empty. The SENTENCE comes from the
  // reason the number was dropped, never from the value, so an unfinished number
  // cannot be explained as a foreign one (#1409).
  const phoneNotice =
    attendee.phone === "" ? phonePrefillNotice(initialPhone.dropped) : null;
  // Honeypot (#1033): a real user never sees or fills the hidden decoy below, so
  // it stays empty; a bot that fills every field trips the server-side check.
  const [honeypot, setHoneypot] = useState("");
  // Keyed by the FIELD a lead can correct, which is not what the server judges:
  // it validates the joined name and can only answer `name`, so a refusal from it
  // is shown on the first name, the field the form makes required (#2362).
  const [fieldErrors, setFieldErrors] = useState<FormFieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // #1332 shapes the number as it is typed; #2162 keeps the caret where the lead
  // put it while that happens. Both live in the hook, so the manage page cannot
  // have one without the other.
  const phone = usePhoneCaret((formatted) => {
    setAttendee((a) => ({ ...a, phone: formatted }));
    setFieldErrors((f) => (f.phone ? { ...f, phone: undefined } : f));
  });
  // #2207: the panel's own field gets the same hook, so a lead correcting a digit
  // in the middle of their number can do it here too. A second surface that took a
  // number without it would be the #2162 defect back in one corner.
  // Destructured at the call, not read off the object at each use: the hooks lint
  // treats a member read on the hook's result during render as touching a ref,
  // even though `attach` is deliberately a callback ref for exactly that reason
  // (see usePhoneCaret's own note).
  const { attach: attachCallPhone, onChange: onCallPhoneChange } = usePhoneCaret(
    (formatted) => {
      setCallPhoneDraft(formatted);
      setCallPhoneError(null);
    },
  );
  const [confirmed, setConfirmed] = useState<{
    start: string;
    manageUrl?: string | null;
    duplicateWarning?: DuplicateWarning | null;
    /** What a move ALSO changed, when the lead typed new details (#2164). */
    contactChanged?: { name: boolean; email: boolean; phone: boolean } | null;
    /**
     * Who will call, and the call's add to calendar links (#2165). Both are read
     * off the SAME response that gave `start`, so they always describe the call
     * this lead just made or moved, never the other booking a duplicate warning
     * names. A weak match (#1340) never reaches this state at all: its panel
     * withholds the time and the token, and the move that would confirm it is
     * offered only on `disclose`, so the name and the links are withheld on the
     * same predicate. Null links draw no group (a time the server could not read
     * builds none); a null name draws the sentence without one.
     */
    advisorName: string | null;
    calendarLinks: CalendarLinks | null;
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
    if (selectedSlot) document.getElementById("booker-firstName")?.focus();
  }, [selectedSlot]);

  // #2636: the confirmation animation starts loading while the lead types their
  // details, so it is usually ready on the confirmation screen. Not before a
  // time is picked, because a lead only browsing days never sees it.
  useEffect(() => {
    if (selectedSlot) preloadConfirmationMark();
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
  const moveAdvisorToken =
    existingCall?.disclose && existingCall.rescheduleTimesFrom === "advisor"
      ? existingCall.manageToken
      : null;
  const availabilityUrl = useMemo(() => {
    const from = today.toUTC().toISO();
    const to = today.plus({ days: horizonDays }).toUTC().toISO();
    const range = `from=${encodeURIComponent(from!)}&to=${encodeURIComponent(to!)}`;
    // #2827: this lead already has a call booked through an advisor's own link,
    // and a time picked here can only MOVE that call, which keeps its advisor or
    // refuses. So the times are that advisor's, read by the call's manage token
    // through the one URL builder the manage page uses, never this page's pool.
    if (moveAdvisorToken) {
      return `${leadRescheduleTimesUrl("advisor", { bucketCode, manageToken: moveAdvisorToken })}&${range}`;
    }
    // #2073: an agent's own link reads that one agent's times, never a pool's.
    const subject = agentLink
      ? `advisor=${encodeURIComponent(agentLink)}`
      : `bucket=${encodeURIComponent(bucketCode)}`;
    return `/api/availability?${subject}&${range}`;
  }, [agentLink, bucketCode, today, horizonDays, moveAdvisorToken]);

  // The shared picker (#1336) owns the fetch, the abort + supersession guard
  // (#629), the day grouping in the viewer's zone, the chosen day and the
  // loading / failed / empty states, so the booker and the reschedule surfaces
  // cannot drift apart again. No day is chosen until the lead chooses one.
  // #4390: a program lead's token rides on the pool's times only: an advisor's own times
  // (their link, or the move of a call booked through it) have no placeholder to add.
  // #4391: and while this lead holds a call, the times are for MOVING it, so they are read
  // with that call's own move token (null for a call that is not a program lead's), never
  // the page's new booking token, so the times shown are the ones the move may take.
  const timesProgramToken =
    agentLink || moveAdvisorToken
      ? null
      : existingCall?.disclose
        ? (existingCall.programLeadMoveToken ?? null)
        : programLeadToken;
  const picker = useSlotPicker({
    url: availabilityUrl,
    zone,
    leadZone: zone,
    slotsOverride: nextDaySlots,
    testPass,
    programLeadToken: timesProgramToken,
  });
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
  const inline = layout === "inline";
  // #3718: the Call me now row, only on the inline card and only when the page asked.
  // The times piece never shows the row, so it asks nothing: the Call me now piece
  // beside it is the one that checks, once per visitor.
  const cmn = useCallMeNow(inline && piece !== "times" ? callMeNow : null, { autoPress: pressCallMeNow });
  // #3718: the inline card opens on the first bookable day with its times showing,
  // as settled; the full booker still waits for the lead to choose (#1336). A day
  // is still chosen before any time is drawn, so that rule holds here too.
  //
  // The day holding the EARLIEST BOOKABLE slot, not the first day on the strip: a day
  // whose times all fall outside the lead's calling hours (#2310) is still on the
  // strip, and opening on it would show a card with no times. Only when nothing is
  // bookable at all does it open on the first day, whose own message then says why.
  useEffect(() => {
    if (!inline || activeDay !== null || picker.days.length === 0) return;
    const earliest = [...picker.slots].sort()[0];
    const day = earliest ? DateTime.fromISO(earliest, { zone }).toISODate() : null;
    picker.selectDay(day && picker.days.includes(day) ? day : picker.days[0]!);
  }, [inline, activeDay, picker, zone]);

  // #3718: the pop up a times piece opened lands where the lead was: on the details
  // step for the time they picked, or on its day saying it has gone (somebody booked
  // it in between), or on the day View more times was pressed for. Once per load.
  // "Gone" is read from what loaded rather than stored: the picked time is not among
  // the times offered, and the lead has not chosen another since.
  // The address may spell the time with an offset while the times are offered in
  // UTC, so it is matched by instant and the offered spelling is what gets chosen.
  // An unreadable one gives NaN, which matches nothing and so reads as gone.
  const [leadChoseAfterLanding, setLeadChoseAfterLanding] = useState(false);
  const timesKnown = picker.days.length > 0 && picker.view.kind !== "loading";
  const initialMs = initialSlot ? DateTime.fromISO(initialSlot, { setZone: true }).toMillis() : NaN;
  const offeredInitialSlot = initialSlot
    ? (picker.slots.find((s) => DateTime.fromISO(s, { setZone: true }).toMillis() === initialMs) ?? null)
    : null;
  const pickedTimeGone =
    !inline && !!initialSlot && timesKnown && !offeredInitialSlot && !leadChoseAfterLanding;
  const landed = useRef(false);
  useEffect(() => {
    if (inline || landed.current || !timesKnown) return;
    if (!initialSlot && !initialDay) return;
    landed.current = true;
    const day = initialSlot ? DateTime.fromISO(initialSlot, { zone }).toISODate() : initialDay;
    if (day && picker.days.includes(day)) picker.selectDay(day);
    if (offeredInitialSlot) chooseSlot(offeredInitialSlot);
  }, [inline, initialSlot, initialDay, offeredInitialSlot, picker, zone, timesKnown]);

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
  /** #3718: a piece asking the page for the pop up booker (widget.js opens it). */
  const askPage = useCallback(
    (req: OpenBookerRequest) => postToParent({ type: PIECE_MESSAGE.openBooker, data: req }),
    [postToParent],
  );

  // #2641: the browser drops a post whose target is not the real parent, with no
  // error on either side, so a host that declared the wrong origin (www, a preview
  // deploy, staging) loses the resize and the success message silently. Report
  // the two ORIGINS once per load, never the referrer's path, which can carry a
  // lead's details. The server logs every report and mentions it in Slack daily.
  const mismatchReported = useRef(false);
  useEffect(() => {
    if (!embedded || mismatchReported.current) return;
    if (typeof window === "undefined") return;
    const mismatch = parentOriginMismatch({
      declared: parentOrigin,
      referrer: document.referrer,
      ownOrigin: window.location.origin,
    });
    if (!mismatch) return;
    mismatchReported.current = true;
    postClientReport({
      kind: "origin_mismatch",
      message: originMismatchMessage(mismatch),
      page: `/book/${bucketCode}`,
      bucketCode,
    });
  }, [embedded, parentOrigin, bucketCode]);

  // Tell the embedding page our height so the iframe resizes with no scroll.
  //
  // #2769: the height reported is the TALLEST this booker has drawn, held for the
  // life of the frame, never the current step's. The modal used to change size at
  // every step (the picker, then a taller confirm step, then a much shorter
  // existing call panel or confirmation), and Dan's rule is that a stepped flow in
  // a fixed frame keeps one size and removes things instead. The root fills the
  // frame it is given (`min-h-screen` below) and a short step centres inside it,
  // so a shorter step is laid out FOR the box rather than shrinking it. Holding
  // the number here as well as in the layout covers the frame being hidden: a
  // closed modal's document reads its content height, and the reopened box would
  // otherwise come back at whatever step the lead left it on.
  const heldFrameHeight = useRef(0);
  useEffect(() => {
    if (!embedded || !rootRef.current) return;
    const post = () => {
      const measured = rootRef.current?.scrollHeight ?? 0;
      heldFrameHeight.current = Math.max(heldFrameHeight.current, measured);
      postToParent({ type: "slate:resize", height: heldFrameHeight.current });
    };
    const ro = new ResizeObserver(post);
    ro.observe(rootRef.current);
    post();
    return () => ro.disconnect();
    // Every state that swaps the ROOT element is listed, because each screen is
    // its own root and an observer left on the old one measures nothing: the
    // existing call panel and the cancelled screen were missing, so neither ever
    // reported a height and the frame stayed at its floor (#2766).
  }, [embedded, meta, activeDay, selectedSlot, confirmed, existingCall, pickingMoveTime, cancelled, postToParent]);

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

  // #2658: the lifecycle the host page's GA4 funnel is built on, announced as
  // cal.com's booker announces it so the host's one listener needs no Slate
  // branch. Three messages, each through postToParent (the known parent origin,
  // never "*"), none carrying the lead's contact. Viewed and ready are sent at most
  // once per frame load, and only by a frame that announces stages (below, #3718):
  //
  // - bookerViewed on that frame's first render, saying whether times were ALREADY loaded
  //   at that moment. They almost never are (the availability is fetched), and
  //   that is the point: a viewed with slotsLoaded false and no ready after it is
  //   the "lead saw an empty calendar" failure the spec exists to catch.
  // - bookerReady the first time the availability answers with at least one time.
  //   An answer with none is deliberately silent here.
  // - linkFailed when the availability read fails, once per failure: a retry that
  //   fails again is a second failure and says so.
  const timesLoaded = !loading && picker.view.kind !== "failed" && picker.slots.length > 0;
  const availabilityFailed = picker.view.kind === "failed";
  const viewedPosted = useRef(false);
  const readyPosted = useRef(false);
  const failedPosted = useRef(false);
  // #3718 (Dan, 2026-10-15): GA4 counts a booker view once per visit, so of the
  // frames a page with the card's pieces holds, only the times piece (or the whole
  // card) announces viewed and ready. The Call me now piece and the pop ups a piece
  // opens stay quiet; a failure and a booking are still announced from anywhere.
  const announceStages =
    embedded && piece !== "callMeNow" && !pressCallMeNow && !initialSlot && !initialDay;
  useEffect(() => {
    if (!announceStages || viewedPosted.current) return;
    viewedPosted.current = true;
    postToParent({ type: EMBED_MESSAGE.bookerViewed, data: { slotsLoaded: timesLoaded } });
  }, [announceStages, postToParent, timesLoaded]);
  useEffect(() => {
    if (!announceStages || !timesLoaded || readyPosted.current) return;
    readyPosted.current = true;
    postToParent({ type: EMBED_MESSAGE.bookerReady, data: { slotsLoaded: true } });
  }, [announceStages, postToParent, timesLoaded]);
  useEffect(() => {
    if (!embedded) return;
    if (!availabilityFailed) {
      failedPosted.current = false;
      return;
    }
    if (failedPosted.current) return;
    failedPosted.current = true;
    postToParent({ type: EMBED_MESSAGE.linkFailed, data: LINK_FAILED.availabilityFailed });
  }, [embedded, postToParent, availabilityFailed]);

  function fmtTime(iso: string) {
    const dt = DateTime.fromISO(iso).setZone(zone);
    // The 12 hour spelling comes from the shared formatter (#1765); the 24 hour
    // one is the lead's own preference and has only ever had one spelling.
    return hour12 ? (formatClockTime(dt) ?? "") : dt.toFormat("HH:mm");
  }

  async function submit() {
    if (!selectedSlot) return;

    // Two judgements, one per question. `validateAttendee` is the shared rule the
    // server runs too, over the joined name; `nameFieldErrors` says WHICH of the
    // two name fields to blame, which the joined value cannot (#2362).
    const errors: FormFieldErrors = {
      ...formErrorsFromServer(validateAttendee({ ...attendee, name: attendeeName })),
      ...nameFieldErrors(attendee),
    };
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      focusFirstFieldError(errors);
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const { ok, status, data } = await postJson<{
        startsAt?: string;
        manageUrl?: string;
        advisorName?: string | null;
        calendarLinks?: CalendarLinks | null;
        error?: string;
        fieldErrors?: AttendeeErrors;
        duplicateWarning?: DuplicateWarning | null;
        existingCall?: ExistingCall | null;
        code?: string;
      }>(
        "/booking",
        {
          // #2073: an agent's own link names the link, and the server decides
          // which bucket the booking is stored in; a routed page names its bucket.
          // #3495: and the tier its times came from, handed back unseen.
          // #3797: and when that list was computed, also unseen.
          ...(agentLink
            ? { agentLink }
            : {
                bucketCode,
                requestedCode,
                ...(meta?.shownTier ? { shownTier: meta.shownTier } : {}),
                ...(meta?.slotsComputedAt ? { slotsComputedAt: meta.slotsComputedAt } : {}),
              }),
          start: selectedSlot,
          timezone: zone,
          salesforceId,
          attendee: {
            name: attendeeName,
            // #2549: the first name as answered, so the booking stores it rather
            // than Regal splitting it back out of the joined name.
            firstName: attendee.firstName.trim(),
            email: attendee.email.trim(),
            phone: attendee.phone.trim(),
          },
          prefill,
          // #2728: the ORIGIN of the page that framed us, so the off site check can
          // judge a host that declared none. Never the path or query, and absent
          // when this is its own page. The server reduces it again regardless.
          ...confirmReferrerOrigin(),
          // Empty for every real lead; a bot filling all fields sends a value the
          // server rejects (#1033).
          [HONEYPOT_FIELD]: honeypot,
          // #4391: the token the texted link's page signed, so the confirm can use the
          // placeholder's extra times. In the body, which is never logged; absent for
          // every other lead.
          ...(programLeadToken ? { programLeadToken } : {}),
        },
        // Convert a wedged confirm (server accepted, never responds) into the
        // retryable error below instead of an endless "Booking your call…" (#626).
        // #2666: the test pass rides along on the public test bucket only. A pass
        // that ran out while the page sat open comes back as a 403 carrying its own
        // sentence, which the `data.error` branch below shows as it is.
        // #3566: a confirm whose connection dropped is sent once more by itself, so a
        // lead never sees an error for a one-off blip. Safe because the server answers
        // a resend of a confirm that DID arrive with the booking it made (#2638).
        { timeoutMs: REQUEST_TIMEOUT_MS, headers: testPassHeaders(testPass), resendOnDrop: true },
      );

      if (ok) {
        setConfirmed({
          start: data.startsAt ?? selectedSlot,
          manageUrl: data.manageUrl ?? null,
          duplicateWarning: data.duplicateWarning ?? null,
          advisorName: data.advisorName ?? null,
          calendarLinks: data.calendarLinks ?? null,
        });
        if (embedded) {
          postToParent({
            type: "slate:bookingSuccessful",
            data: { booking: data, salesforceId, outcome: "created" },
          });
        }
      } else if (status === 409 && data.existingCall) {
        // Declined, not failed: this person already has an active call and
        // nothing was created (#1337). The slot they picked is kept so the offer
        // to move the existing call into it can name it.
        setExistingCall(data.existingCall);
        // #2207: and the number it shows. Set here rather than derived, so a
        // number the lead has since corrected on this screen is not overwritten by
        // a later render (L14).
        setCallPhone(data.existingCall.disclose ? data.existingCall.phone : null);
      } else if (status === 409 && data.code === PLACEHOLDER_DAY_FULL_CODE) {
        // #4391: the day's extra times filled up while this lead was typing. Not "just
        // taken" (L11): nobody took that time. The reload shows the day's real times.
        setError(BOOKING_ERROR_COPY.placeholderDayFull);
        setSelectedSlot(null);
        picker.retry();
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
        if (data.fieldErrors) {
          const refused = formErrorsFromServer(data.fieldErrors);
          setFieldErrors(refused);
          // #3359: taken to the field to change, as the form's own check does. A
          // refusal Google made at the calendar arrives here, after our check passed.
          focusFirstFieldError(refused);
        }
        setError(data.error ?? BOOKING_ERROR_COPY.generic);
      }
    } finally {
      setSubmitting(false);
    }
  }

  /**
   * Kept whole rather than reduced to `.ok`, because the refusal is SAID now
   * rather than expressed by switching the button off (#2605, L109). The
   * sentence is `validateReason`'s own, which the server answers with too, so
   * one omission cannot be described two ways (L41).
   */
  const cancelReasonCheck = validateReason(
    { code: cancelReason, detail: cancelDetail },
    cancelReasons,
  );
  const [cancelReasonError, setCancelReasonError] = useState<string | null>(null);
  const [moveReasonError, setMoveReasonError] = useState<string | null>(null);

  /**
   * Cancel the call this lead already has (#2167), through the same lead cancel
   * endpoint the manage page uses, so the reason, the audit trail and the webhook
   * are identical whichever door they came in by.
   *
   * Offered only when the server said `mayCancel`, which is the strong id tiers.
   */
  async function cancelExistingCall() {
    if (!existingCall?.disclose || !existingCall.mayCancel) return;
    setSubmitting(true);
    setError(null);
    try {
      const { ok, data } = await postJson<{
        error?: string;
        booking?: { id: string; startsAt: string; endsAt: string };
      }>(
        `/api/bookings/${encodeURIComponent(existingCall.manageToken)}/cancel`,
        { reason: cancelReason, reasonDetail: cancelDetail || undefined },
        { timeoutMs: REQUEST_TIMEOUT_MS },
      );
      if (ok) {
        // Read back on the page they are on, rather than left to be inferred from
        // a panel that quietly changed shape (L608).
        setCancelled(true);
        setExistingCall(null);
        setConfirmingCancel(false);
        // #2658: and told to the host page, as cal.com's `bookingCancelled`, so
        // its funnel records the cancel. The booking is named from the server's
        // answer; what it did not answer is null rather than guessed, and the
        // start is the one this panel has been showing all along. The reason is
        // the CODE the lead chose, a vocabulary value, never their own words.
        if (embedded) {
          const detail: BookingCancelledDetail = {
            booking: {
              uid: data.booking?.id ?? null,
              startTime: data.booking?.startsAt ?? existingCall.startsAt,
              endTime: data.booking?.endsAt ?? null,
              cancellationReason: cancelReason,
            },
          };
          postToParent({ type: EMBED_MESSAGE.bookingCancelled, data: detail });
        }
        return;
      }
      setError(data.error ?? BOOKER_CANCEL_COPY.failed);
    } finally {
      setSubmitting(false);
    }
  }

  const moveReasonCheck = validateReason(
    { code: moveReason, detail: moveDetail },
    rescheduleReasons,
  );

  /** Commit the move, saying what is missing rather than sitting there dead. */
  function commitMove() {
    if (!selectedSlot) return;
    if (!moveReasonCheck.ok) {
      setMoveReasonError(moveReasonCheck.error);
      document.getElementById(`booker-move-reason-${moveReason || rescheduleReasons[0]?.code}`)?.focus();
      return;
    }
    setMoveReasonError(null);
    void moveExistingCall();
  }

  /** The same rule on the cancel confirm. */
  function commitCancelExisting() {
    if (!cancelReasonCheck.ok) {
      setCancelReasonError(cancelReasonCheck.error);
      document.getElementById(`booker-cancel-reason-${cancelReason || cancelReasons[0]?.code}`)?.focus();
      return;
    }
    setCancelReasonError(null);
    void cancelExistingCall();
  }

  /** Move the call this lead already has into the slot they just picked (#1337).
   *  Goes through the same lead reschedule endpoint their emailed manage link
   *  uses, so the reason, the audit trail and the webhook are identical. */
  /**
   * Correct the number the advisor will ring, from the panel (#2207).
   *
   * Through `/api/bookings/{token}/phone`, the same endpoint the manage page's own
   * control uses, so one correction path carries the validation, the audit trail
   * and the stale invite alert rather than two that drift (L41, L263).
   */
  async function saveCallPhone() {
    if (!existingCall?.disclose) return;
    setSavingCallPhone(true);
    setCallPhoneError(null);
    try {
      const { ok, data } = await postJson<{ phone?: string; error?: string }>(
        `/api/bookings/${encodeURIComponent(existingCall.manageToken)}/phone`,
        { phone: callPhoneDraft },
        { timeoutMs: REQUEST_TIMEOUT_MS },
      );
      if (ok && data.phone) {
        // Read back from what was STORED, never from what was typed: the server
        // formats the number it kept, and the panel renders that rather than
        // rewriting it here, so the line and the record cannot disagree (#2213).
        setCallPhone(data.phone);
        // #2210: from here the move must not send a number. This one is newer
        // than anything the link carried.
        setPhoneCorrectedHere(true);
        setEditingCallPhone(false);
        setCallPhoneDraft("");
        return;
      }
      // The server's own sentence: a number we cannot call, an incomplete number,
      // an unknown link and a call that has already happened send the reader to
      // four different places (L11). The field stays open holding what they typed,
      // because a refused number must never read as saved.
      setCallPhoneError(data.error ?? PHONE_COPY.failed);
    } finally {
      setSavingCallPhone(false);
    }
  }

  /** Only the details that carry a value: see the send site below (#2203). */
  const typedDetails: { name?: string; firstName?: string; email?: string; phone?: string } = {};
  if (attendeeName) typedDetails.name = attendeeName;
  // #2549: travels with the name. #2835: the server now also stores a first name
  // that moved on its own, so an untouched SPLIT must not travel: it is Slate's
  // guess, and sent back it would overwrite an answered first name or be stored as
  // one (L192). An answered seed, or anything the lead edited, is an answer.
  const nameIsUntouchedGuess =
    nameSeed.guessed && attendee.firstName === nameSeed.firstName && attendee.lastName === nameSeed.lastName;
  if (attendeeName && attendee.firstName.trim() && !nameIsUntouchedGuess) {
    typedDetails.firstName = attendee.firstName.trim();
  }
  if (attendee.email.trim()) typedDetails.email = attendee.email.trim();
  // #2210: and never the number, once one has been corrected on this screen. The
  // panel offers no correction for the name or the email, so those still travel:
  // this is a rule about the one field two routes write, not about the payload.
  if (attendee.phone.trim() && !phoneCorrectedHere) typedDetails.phone = attendee.phone.trim();
  const hasTypedDetails = Object.keys(typedDetails).length > 0;

  async function moveExistingCall() {
    if (!existingCall?.disclose || !selectedSlot) return;
    setSubmitting(true);
    setError(null);
    try {
      const { ok, status, data } = await postJson<{
        id?: string;
        startsAt?: string;
        endsAt?: string;
        manageUrl?: string;
        advisorName?: string | null;
        calendarLinks?: CalendarLinks | null;
        error?: string;
        reason?: string;
        code?: string;
        contactChanged?: { name: boolean; email: boolean; phone: boolean };
      }>(
        `/api/bookings/${encodeURIComponent(existingCall.manageToken)}/reschedule`,
        {
          start: selectedSlot,
          reason: moveReason,
          reasonDetail: moveDetail || undefined,
          // #2310: the zone the lead picked this time in, judged by the server.
          timezone: zone,
          // #4391: this call's own move token, when it is a program lead's, so the move
          // can use the placeholder's extra times. Never the page's new booking token,
          // which the route refuses for a move.
          ...(existingCall.programLeadMoveToken ? { programLeadMoveToken: existingCall.programLeadMoveToken } : {}),
          // #2164: the details on this visit, which are routinely a CORRECTION of
          // the ones the call was booked with. The server writes whichever of them
          // actually moved and rewrites the invite; sending them unchanged costs
          // nothing, because it compares before it writes.
          //
          // #2203: only the ones that actually carry a value. A lead recognised by
          // their link never fills a form, so these are whatever the link brought,
          // routinely nothing. `updateBookingContact` judges every field a caller
          // SENDS, so a blank one is not "no correction", it is a correction to
          // empty, and it comes back as "Enter your name" about a name nobody was
          // asked for, refusing the move.
          ...(hasTypedDetails ? { attendee: typedDetails } : {}),
        },
        { timeoutMs: REQUEST_TIMEOUT_MS },
      );
      if (ok) {
        setExistingCall(null);
        setConfirmed({
          start: data.startsAt ?? selectedSlot,
          manageUrl: null,
          contactChanged: data.contactChanged ?? null,
          // The move's own answer, at the NEW time and with whoever the move left
          // the call with, rather than the panel's copy from before it moved.
          advisorName: data.advisorName ?? null,
          calendarLinks: data.calendarLinks ?? null,
        });
        // #2644: the same message a fresh booking posts, so a host that ends the
        // booking by redirecting on it (trypennie does, to its booking confirmed
        // page, looked up by data.booking.id) ends a moved call the same way.
        // `outcome` lets a host tell the two apart if it wants to; one that does
        // not gets one event either way.
        if (embedded) {
          postToParent({
            type: "slate:bookingSuccessful",
            data: { booking: data, salesforceId, outcome: "rescheduled" },
          });
        }
        return;
      }
      // Nobody was holding that slot during the decision, so it can go. Say so
      // and put them back in the picker rather than failing silently or leaving
      // them with neither call moved nor a new one booked.
      //
      // #2203: back in the picker STILL RECOGNISED when the link named them. The
      // call was not moved, so they still have it, and clearing it here would send
      // them through the form to be told so by a 409 (L676).
      if (recognisedOnArrival) setPickingMoveTime(true);
      else setExistingCall(null);
      setSelectedSlot(null);
      setError(
        data.code === PLACEHOLDER_DAY_FULL_CODE
          ? BOOKING_ERROR_COPY.placeholderDayFull
          : status === 409
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

  /**
   * Choosing a time, from wherever it was offered (#2203).
   *
   * One function rather than a `setSelectedSlot` at each surface, because the
   * choice ENDS the move picker and a second call site that forgot to would leave
   * a recognised lead facing the details form again, which is the defect itself
   * back in one corner of the product (L613).
   */
  function chooseSlot(iso: string) {
    setSelectedSlot(iso);
    setPickingMoveTime(false);
    setLeadChoseAfterLanding(true);
  }

  /**
   * One primary action on the panel at a time (#2207).
   *
   * Sky is the only action colour in the design system, so a sky fill is a claim
   * that THIS is the thing to press. While the number field is open, the thing to
   * press is Save, and the panel's own move or pick button steps back to the
   * outline treatment rather than competing with it. Found by looking at the panel
   * at a real window with the field open, which is the only thing that could have
   * found it (L606).
   *
   * Here rather than at each button, because there are two of them (the landing
   * panel's and the move panel's) and a rule applied at one site is the divergence
   * a shared decision exists to prevent (L613).
   */
  const panelActionIsPrimary = !editingCallPhone;
  const panelActionVariant: BookerButtonVariant = panelActionIsPrimary
    ? "primary"
    : "secondary";
  const panelActionStyle = panelActionIsPrimary ? confirmStyle : undefined;
  /** Marks whichever control currently carries the emphasis, so the "exactly one"
   *  rule can be asserted rather than eyeballed on every change. */
  const panelPrimaryProps = (isPrimary: boolean) =>
    isPrimary ? { "data-testid": "panel-primary" } : {};

  // #2729: `@container` makes the booker's own width the thing its layout reads.
  // It used to switch to two columns on the VIEWPORT (`md:`), and inside the
  // widget's iframe the viewport is the frame, which the modal held narrower than
  // the breakpoint, so the modal drew the phone layout on every desktop. A
  // container variant (`@3xl:`, 48rem, the same width the old breakpoint used) is
  // right in any host, any frame and any modal size. `max-w-4xl` is the width the
  // widget's desktop modal is sized to match (`public/widget.js`), and
  // `embed-two-column.test.tsx` holds the two together.
  //
  // #2769: in the embed the root also FILLS the frame (the frame's own viewport,
  // which is the height the host set from `slate:resize`), as a column, so a
  // shorter screen centres in the held box rather than leaving the page beneath
  // it showing (#2766). The standalone page keeps its own layout.
  //
  // #3718: the inline card IS the frame's content, sized to itself rather than
  // filling the frame, because the host sizes the frame from it: filling would
  // hold the frame at the tallest step it had drawn.
  const shell = inline
    ? `@container overflow-hidden rounded-2xl p-5 ${c.card} ${c.body}`
    : `@container mx-auto max-w-4xl overflow-hidden rounded-xl shadow-xs ${c.shell}${
        embedded ? " flex min-h-screen flex-col" : ""
      }`;
  /**
   * #2769: the ONE box every step fills in the widget's desktop modal. Everything
   * under the test band is this tall at two columns, on every screen: the picker's
   * times list grows to fill it, a short screen (the confirmation, the existing
   * call panel, the cancelled screen) centres in it, and a long one scrolls INSIDE
   * it, so the modal never changes size between steps (Dan, 2026-09-25: "keep it a
   * consistent size and just remove things as needed").
   *
   * 624px is measured, not guessed: in Chrome in the 896px modal on 2026-09-25
   * the confirm step, once it lost the day strip, was 624px under the band, the
   * tallest of the steps a lead normally passes through (the picker with a full
   * list was 576). Sizing the box to the confirm step rather than the picker means
   * Confirm booking is never below the fold; the picker spends the difference on
   * more visible times. It fits a 768px tall laptop inside the modal's 90dvh cap.
   * jsdom cannot lay out, so the number is written down here.
   *
   * Below two columns (a phone, where the modal is the whole screen and so is one
   * size already) the body takes its content's height and the frame grows to the
   * tallest step it has drawn (the held height above).
   */
  const embedBody = (children: ReactNode) =>
    embedded ? (
      <div data-embed-body className="flex min-h-0 flex-1 flex-col overflow-y-auto @3xl:h-[624px] @3xl:flex-none">
        {children}
      </div>
    ) : (
      children
    );
  // #2660: the test line, on EVERY screen this component can show. Each screen
  // below is its own root, so the band is placed in each rather than around a
  // shared frame this component does not have; a screen without it would read as
  // nothing to warn about (L678), and the confirmation is the one a stray lead
  // reads last. Null on a real booking, so nothing is drawn rather than an empty
  // band.
  //
  // #2748: framed, the band stops short of the corner the host's close control
  // sits in, so the control never sits on it.
  const testBand = isTest ? <TestModeBand framed={embedded} bucketCode={bucketCode} /> : null;

  // #1337: declined because this person already has an active call. Nothing was
  // created. No policy voice: the rule is not explained (that makes the panel
  // about us and draws attention to something the lead never asked about), the
  // call they have is simply put in front of them with the obvious thing to do.
  if (existingCall && !pickingMoveTime) {
    // #2205: with the year, because the details step commits to a time spelled
    // that way and this panel reads one back. Two readbacks of the same kind of
    // fact spelling it differently is the duplication rule in reverse (L118).
    const longDay = (iso: string) => longDayLabel(iso, zone, { year: true });
    const shortDay = (iso: string) =>
      DateTime.fromISO(iso).setZone(zone).toFormat("ccc, LLL d");
    const newWhen = selectedSlot
      ? `${shortDay(selectedSlot)} at ${fmtTime(selectedSlot)}`
      : null;
    return (
      <div ref={rootRef} data-theme={theme} className={shell}>
        {testBand}
        {/* #2766: the width of the picker's details column rather than a narrow
            one (max-w-md read as a half filled box in the 896px modal), and
            centred in the held box (#2769), so a short screen still reads as one
            designed surface. */}
        {embedBody(
        <div className="mx-auto my-auto w-full max-w-2xl p-6 @3xl:p-8">
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
              {/* #2207: the number the call actually depends on, and the way to
                  fix it. Shown in full (#2213), in the manage page's own sentence,
                  so a lead reads back exactly what Slate holds on either screen. A
                  quiet line plus a real button at rest, not an always open field:
                  most leads never need it and should not be invited to fiddle
                  (L49). */}
              <div className="mt-3">
                <p className={`text-sm ${c.muted}`}>
                  {callPhone ? advisorWillCall(callPhone) : BOOKER_PHONE_COPY.noNumber}
                </p>
                {editingCallPhone ? (
                  // form-restore-ok: this form exists only after the lead presses
                  // the change button, so it is never in the page a reload parses
                  // and nothing of it can be restored (#2718).
                  <form
                    className="mt-3"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void saveCallPhone();
                    }}
                  >
                    {/* #2076: a corrected number is typed work, and this panel
                        carries links out of it (the legal footer, and the embed
                        host's own page). Nothing typed here is lost by clicking
                        one. */}
                    <UnsavedGuard
                      what="changes to your phone number"
                      formName="booker-call-phone"
                    />
                    <label
                      htmlFor="booker-call-phone"
                      className={`mb-1 block text-xs font-semibold ${c.muted}`}
                    >
                      {PHONE_COPY.label}
                    </label>
                    <input
                      id="booker-call-phone"
                      className={`min-h-12 w-full rounded-sm px-4 text-base ${c.input}`}
                      type="tel"
                      autoComplete="tel"
                      inputMode="tel"
                      aria-describedby={
                        callPhoneError ? "booker-call-phone-error" : "booker-call-phone-hint"
                      }
                      aria-invalid={callPhoneError ? true : undefined}
                      value={callPhoneDraft}
                      ref={attachCallPhone}
                      onChange={onCallPhoneChange}
                    />
                    {callPhoneError ? (
                      <p
                        id="booker-call-phone-error"
                        role="alert"
                        className="mt-1 text-sm text-[var(--error)]"
                      >
                        {callPhoneError}
                      </p>
                    ) : (
                      <p id="booker-call-phone-hint" className={`mt-1 text-sm ${c.muted}`}>
                        {PHONE_COPY.hint}
                      </p>
                    )}
                    <div className="mt-3 flex flex-col gap-2">
                      <BookerButton
                        palette={c}
                        variant="primary"
                        type="submit"
                        disabled={savingCallPhone}
                        busy={savingCallPhone}
                        style={confirmStyle}
                        data-testid="panel-primary"
                      >
                        {savingCallPhone ? PHONE_COPY.saving : PHONE_COPY.save}
                      </BookerButton>
                      <BookerButton
                        palette={c}
                        variant="secondary"
                        type="button"
                        onClick={() => {
                          setEditingCallPhone(false);
                          setCallPhoneDraft("");
                          setCallPhoneError(null);
                        }}
                        disabled={savingCallPhone}
                      >
                        {PHONE_COPY.cancel}
                      </BookerButton>
                    </div>
                    {/* Still ALIVE, distinct from started and from failed, on an
                        action that reaches Google as well as the database. */}
                    {savingCallPhone && callPhoneStalled && (
                      <p role="status" className={`mt-2 text-xs ${c.muted}`}>
                        {PHONE_COPY.stillWorking}
                      </p>
                    )}
                  </form>
                ) : (
                  <button
                    onClick={() => setEditingCallPhone(true)}
                    className={`mt-1 inline-flex min-h-9 items-center text-sm font-semibold underline underline-offset-2 hover:no-underline ${c.muted}`}
                  >
                    {callPhone ? PHONE_COPY.trigger : BOOKER_PHONE_COPY.addTrigger}
                  </button>
                )}
              </div>
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
                  onCode={(c) => { setMoveReason(c); setMoveReasonError(null); }}
                  onDetail={(d) => { setMoveDetail(d); setMoveReasonError(null); }}
                  idPrefix="booker-move-reason"
                  error={moveReasonError}
                />
              </div>
              )}
              {/* One error on the panel, wherever the reader is looking. While the
                  cancel confirmation is open it carries its own, inside the box the
                  decision is being made in, so this one stands down rather than
                  saying the same thing twice on one screen (L605). */}
              {error && !confirmingCancel && (
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
              {/* #2167: the exit. Its own confirmation, because a cancel destroys
                  something and puts nothing in its place, and the sentence inside
                  it names the call being given up rather than saying "cannot be
                  undone" about no call in particular. */}
              {existingCall.mayCancel && confirmingCancel ? (
                <div className="mt-6 rounded-lg border border-[var(--error)] bg-[color-mix(in_srgb,var(--error)_4%,transparent)] p-4">
                  <p className={`text-sm font-semibold ${c.title}`}>
                    {BOOKER_CANCEL_COPY.heading}
                  </p>
                  <p className={`mt-1 text-sm ${c.muted}`}>
                    {cancelConsequenceFor(
                      `${longDay(existingCall.startsAt)} at ${fmtTime(existingCall.startsAt)}`,
                    )}
                  </p>
                  <div className="mt-4">
                    <ReasonPicker
                      legend={BOOKER_CANCEL_COPY.reasonLegend}
                      options={cancelReasons}
                      code={cancelReason}
                      detail={cancelDetail}
                      onCode={(c) => { setCancelReason(c); setCancelReasonError(null); }}
                      onDetail={(d) => { setCancelDetail(d); setCancelReasonError(null); }}
                      idPrefix="booker-cancel-reason"
                      error={cancelReasonError}
                    />
                  </div>
                  {error && (
                    <p role="alert" className="mt-4 flex items-start gap-2 text-sm text-[var(--error)]">
                      <span className="mt-0.5 shrink-0">
                        <AlertIcon width={15} height={15} />
                      </span>
                      {error}
                    </p>
                  )}
                  <div className="mt-4 flex flex-col gap-3">
                    <BookerButton
                      palette={c}
                      variant="danger"
                      onClick={commitCancelExisting}
                      disabled={submitting}
                      busy={submitting}
                    >
                      {submitting ? BOOKER_CANCEL_COPY.confirming : BOOKER_CANCEL_COPY.confirm}
                    </BookerButton>
                    <BookerButton
                      palette={c}
                      variant="secondary"
                      onClick={() => {
                        setConfirmingCancel(false);
                        setCancelReason("");
                        setCancelDetail("");
                        setError(null);
                      }}
                      disabled={submitting}
                    >
                      {BOOKER_CANCEL_COPY.keep}
                    </BookerButton>
                  </div>
                </div>
              ) : (
              <div className="mt-6 flex flex-col gap-3">
                {onLanding ? (
                  <BookerButton
                    palette={c}
                    variant={panelActionVariant}
                    onClick={() => {
                      // #2203: the call is KEPT. Clearing it here dropped a lead
                      // the link had just named into the anonymous flow, which
                      // then asked them to retype the name, email and phone it
                      // already held, and answered with a 409 naming this very
                      // call (L676).
                      setOnLanding(false);
                      setPickingMoveTime(true);
                    }}
                    style={panelActionStyle}
                    {...panelPrimaryProps(panelActionIsPrimary)}
                  >
                    {MOVE_COPY.pickAnotherTime}
                  </BookerButton>
                ) : (
                  <>
                    <BookerButton
                      palette={c}
                      variant={panelActionVariant}
                      onClick={commitMove}
                      disabled={submitting || !selectedSlot}
                      busy={submitting}
                      style={panelActionStyle}
                      {...panelPrimaryProps(panelActionIsPrimary)}
                    >
                      {submitting
                        ? MOVE_COPY.moving
                        : newWhen
                          ? moveToTime(newWhen)
                          : MOVE_COPY.moveNoTime}
                    </BookerButton>
                    <BookerButton
                      palette={c}
                      variant="secondary"
                      onClick={() => {
                        // #2203: a lead the link named still HAS this call, so the
                        // way back is the panel about it. Dropping them into the
                        // anonymous picker would set up the same refusal again.
                        if (recognisedOnArrival) setOnLanding(true);
                        else setExistingCall(null);
                        setSelectedSlot(null);
                        setMoveReason("");
                        setMoveDetail("");
                      }}
                      disabled={submitting}
                    >
                      {keepExistingTime(shortDay(existingCall.startsAt))}
                    </BookerButton>
                  </>
                )}
                {/* Last, and quietest. Rare and irreversible goes at the bottom
                    (L609), and it is a plain control rather than a red one until
                    it is pressed: nothing is destroyed by opening the question. */}
                {existingCall.mayCancel && (
                  <BookerButton
                    palette={c}
                    variant="quiet"
                    onClick={() => setConfirmingCancel(true)}
                    disabled={submitting}
                  >
                    {BOOKER_CANCEL_COPY.start}
                  </BookerButton>
                )}
              </div>
              )}
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
        </div>,
        )}
      </div>
    );
  }

  // #2167: the call is gone, said on the page they were standing on. Its own screen
  // rather than a line on the panel, because after this there is no call for the
  // panel to be about, and they came here to book: the way on is offered.
  if (cancelled) {
    return (
      <div ref={rootRef} data-theme={theme} className={shell}>
        {testBand}
        {embedBody(
        <div className="mx-auto my-auto w-full max-w-md p-8 text-center">
          <h2 className={`text-xl font-semibold ${c.title}`}>
            {BOOKER_CANCEL_COPY.doneHeading}
          </h2>
          <BookerButton
            palette={c}
            variant="primary"
            className="mt-6"
            onClick={() => {
              setCancelled(false);
              setOnLanding(false);
              setSelectedSlot(null);
            }}
            style={confirmStyle}
          >
            {BOOKER_CANCEL_COPY.doneBookAgain}
          </BookerButton>
        </div>,
        )}
      </div>
    );
  }

  if (confirmed) {
    const movedNote = confirmed.contactChanged
      ? movedContactNote(confirmed.contactChanged)
      : null;
    // #2205: the last thing most leads read, and the other place a committed time
    // is read back, so it is spelled exactly as the step that committed to it: the
    // full weekday, month, day and year, through the one shared formatter rather
    // than a second `toFormat` beside it (L118, #2221).
    const confirmedDay = longDayLabel(confirmed.start, zone, { year: true });
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
        {testBand}
        {/* Entrance animates opacity/transform only: a height animation would
            jitter the embed iframe via the ResizeObserver above. #637: the embed
            gets the same branded coins illustration as the standalone page (one
            delight moment); confirmation is a one-time swap, so the single iframe
            resize it triggers is not the animated-height jitter guarded above. */}
        {embedBody(
        <div className="pn-confirm-enter my-auto w-full p-10 text-center">
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
          {/* #2165: who will call, named when the booking holds a name. */}
          <p className={`mt-1 text-sm ${c.muted}`}>
            {confirmedAdvisor(confirmed.advisorName)}
          </p>
          <p className={`mt-1 text-xs ${c.faint}`}>
            {inviteOnItsWay(attendee.email)}
          </p>
          {/* #2165: save it now, while the lead is looking at it, rather than
              whenever the invite reaches them. The shared group the manage page
              draws too; left aligned inside a centred column so its heading sits
              over its own buttons. */}
          {confirmed.calendarLinks && (
            <AddToCalendar
              links={confirmed.calendarLinks}
              className="mx-auto mt-6 max-w-md text-left"
            />
          )}
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
                    {/* The same spelling as the line above it: this names a call
                        the lead already has, on the screen that just named the one
                        they made, and two dates a few lines apart written two ways
                        read as two different kinds of fact (#2205, L118). */}
                    {duplicateSetFor(
                      `${longDayLabel(confirmed.duplicateWarning.startsAt, zone, {
                        year: true,
                      })} at ${fmtTime(confirmed.duplicateWarning.startsAt)}`,
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
        </div>,
        )}
      </div>
    );
  }

  // The chosen day used to be derived here, from `activeDay`, a bare date that had
  // to be parsed back in `zone` or the label slid by a day. #2361 builds the line
  // from `selectedSlot` and `zone` through `longDayLabel` instead, so the instant
  // itself names its own day and there is nothing to keep in step.

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
        chooseSlot(iso);
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
          <AlertIcon width={15} height={15} />
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
          ? // #2073: one named advisor, so it names them rather than "all times".
            agentLink
            ? AGENT_LINK_COPY.noTimes
            : allTimesTaken()
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
    // #2799: its OWN ceiling rather than the shared 20s one, because the full walk
    // for the biggest pool lands right about there. It is derived from the server
    // walk's worst case, so re-measuring that walk moves this with it.
    // #4390: a program lead's token in a header and their zone in the address, as on
    // the ordinary times read, so the placeholder's starts are offered out here too.
    const res = await getJson<unknown>(
      programLeadTimesUrl(`/api/availability/next?bucket=${encodeURIComponent(bucketCode)}`, timesProgramToken, zone),
      {
        timeoutMs: NEXT_DAYS_TIMEOUT_MS,
        cache: "no-store",
        headers: { ...testPassHeaders(testPass), ...programLeadHeaders(timesProgramToken) },
      },
    );
    // #2666: a refused test pass is neither "we could not look" nor "unreadable":
    // it has its own sentence (reload, or tell us), carried by the reply itself.
    const passRefusal = res.ok ? null : testPassRefusalSentence(res.data);
    if (passRefusal !== null) {
      setNextPassRefusal(passRefusal);
      setLoadingNext(false);
      return;
    }
    setNextPassRefusal(null);
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
      ? formatLongDate(DateTime.fromISO(picker.days[0], { zone }))
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
        <BookerButton
          palette={c}
          variant="secondary"
          size="sm"
          onClick={() => picker.retry()}
        >
          {UNCLASSIFIED_EMPTY_RETRY}
        </BookerButton>
      )}
      {/* #2073: not on an agent's own link. The far ahead search walks a
          bucket's pool, so on a named link it would offer another agent's days. */}
      {isClosure && !agentLink && nextDaySlots === null && (
        <>
          {nextPassRefusal !== null ? (
            <p role="alert" className="text-sm text-[var(--error)]">
              {nextPassRefusal}
            </p>
          ) : nextFailure !== null && (
            <p role="alert" className="text-sm text-[var(--error)]">
              {nextFailure === NEXT_DAYS_FAILURE.unreadable
                ? NEXT_DAYS_COPY.unreadable
                : NEXT_DAYS_COPY.failed}
            </p>
          )}
          <BookerButton
            palette={c}
            variant="secondary"
            size="sm"
            onClick={() => void revealNextDays()}
            disabled={loadingNext}
            busy={loadingNext}
          >
            {loadingNext ? (
              // The word alone here: the dots are the button's own `busy`, which
              // is where every other working cue on this surface comes from since
              // #2604. Hand rolling them beside it left one site on the old
              // convention, and it would have gone invisible the day this button
              // became primary, because those dots carried the accent and a
              // primary button is FILLED with it.
              NEXT_DAYS_COPY.looking
            ) : nextFailure !== null ? (
              NEXT_DAYS_COPY.retry
            ) : (
              NEXT_DAYS_COPY.ask
            )}
          </BookerButton>
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
      // #2748: framed, the row stops short of the host's close control, which
      // sits in this corner of the frame.
      className={`mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs${
        embedded ? " @3xl:pr-10" : ""
      }`}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span className={c.faint}>
          <GlobeIcon width={15} height={15} />
        </span>
        <label htmlFor="booker-tz" className="sr-only">
          Timezone
        </label>
        <SelectField
          id="booker-tz"
          ariaLabel="Timezone"
          value={zone}
          onChange={(next) => {
            setZone(next);
            // #2310: a time chosen under the old zone may be outside the lead's
            // calling window under the new one. The list re-filters on its own;
            // the choice has to be let go here, or Confirm would post a time
            // the list no longer offers.
            if (selectedSlot && !withinLeadCallingWindow(selectedSlot, next)) setSelectedSlot(null);
          }}
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
    // #2769: in the embed's two column box the section FILLS what is left under
    // the strip, so the times list grows into the box and a long confirm step
    // scrolls inside it rather than growing it. The confirm step also starts
    // closer to the row above, since the strip that sat between them is gone.
    <section
      className={
        // #3718: the inline card's panel carries its own padding and grows with its
        // times, so the section adds neither.
        inline
          ? "flex flex-col"
          : `flex flex-col p-6 ${selectedSlot ? "" : "max-h-[420px]"}${
              embedded
                ? ` @3xl:min-h-0 @3xl:flex-1 ${selectedSlot ? "pt-2 @3xl:overflow-y-auto" : "@3xl:max-h-none"}`
                : ""
            }`
      }
    >
      {selectedSlot ? (
        /* The step ARRIVES rather than appearing in the same frame the times
           left (Dan, 2026-09-22: "clicking the time (like 8am) felt bad. it
           jumped immediately to the next page. I like the speed but it was
           jarring"). Nothing is delayed: the animation is on the incoming
           content, which is interactive from its first frame, so the speed he
           liked is untouched and only the eye gets something to follow.

           `pn-confirm-enter` rather than a transition invented here, so the
           booker keeps one vocabulary of motion, and because that keyframe is
           already opacity and transform ONLY: the embed's ResizeObserver posts
           scrollHeight, and anything animating height jitters the iframe. The
           global reduced-motion guard collapses it to the final frame, which is
           the resting state, so somebody who asked for less motion gets the
           content instantly. */
        <div className="pn-confirm-enter space-y-3">
          <button
            onClick={() => setSelectedSlot(null)}
            aria-label="Back to time selection"
            className={`inline-flex min-h-9 items-center text-xs ${c.muted} ${c.backHover}`}
          >
            ‹ Back
          </button>
          {/* #2361: the step says what it is for, once, above the thing being
              committed to. */}
          <h2 className={`text-base font-semibold ${c.title}`}>{DETAILS_COPY.heading}</h2>
          {/* #2172: this line is the details step's own statement of what is
              being booked, so it reads `hour12` and `zone` through the same
              `fmtTime` the list does. Two formatters here would let the summary
              and the times disagree about the same instant.

              #2361: and it states the whole instant, weekday and month and year
              included. It used to say "Tue 15" and a time, while the only other
              place the date appeared was the day strip, whose chips carry no
              year at all. */}
          <p data-testid="chosen-time" className={`text-sm font-semibold tabular-nums ${c.title}`}>
            {chosenWhen(longDayLabel(selectedSlot, zone, { year: true }), fmtTime(selectedSlot))}
          </p>
          {ATTENDEE_FIELDS.map((field) => (
            <div key={field}>
              {/* Persistent visible label (#632): the field's purpose stays put
                  after a value is typed, unlike the old placeholder-only step. */}
              <label
                htmlFor={`booker-${field}`}
                className={`mb-1 block text-xs font-semibold ${c.muted}`}
              >
                {DETAILS_COPY.fields[field]}
              </label>
              <input
                id={`booker-${field}`}
                className={`min-h-12 w-full rounded-sm px-4 text-base ${c.input}`}
                type={
                  field === "email" ? "email" : field === "phone" ? "tel" : "text"
                }
                autoComplete={AUTOCOMPLETE[field]}
                inputMode={
                  field === "email" ? "email" : field === "phone" ? "tel" : undefined
                }
                // The last name is the one optional field, as it is on cal.com, so
                // somebody with one name is never refused (#2362).
                aria-required={field === "lastName" ? undefined : "true"}
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
          {/* #2204: nothing sits between the last field and the button. The
              sentence that used to (#1041) said what the button would do and what
              the field above it was for, which is the screen explained back to
              the reader (L604), and every fact in it was already on the page: the
              heading names the call, the line under it states the time, the field
              is labelled Phone and the button says Confirm booking. */}
          <BookerButton
            palette={c}
            variant="primary"
            size="lg"
            onClick={submit}
            disabled={submitting}
            busy={submitting}
            style={confirmStyle}
            className="group w-full gap-2 active:translate-y-px"
          >
            {submitting ? DETAILS_COPY.confirming : DETAILS_COPY.confirm}
            {!submitting && (
              <ArrowRightIcon className="h-4 w-4 transition-transform duration-150 ease-[cubic-bezier(0.2,0.8,0.2,1)] group-enabled:group-hover:translate-x-1" />
            )}
          </BookerButton>
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
          {pickedTimeGone && (
            <p role="status" className={`mb-3 text-sm ${c.body}`}>
              {PICKER_COPY.pickedTimeGone}
            </p>
          )}
          <div className="-mx-2 -my-1 flex-1 overflow-y-auto px-2 py-1">
            {/* The shared times panel (#1336) owns every state here, including
                the rule that no time renders until a day is chosen. The booker
                keeps its own slot chrome (the accent dot, the 12/24h label). */}
            <SlotTimes
              view={picker.view}
              timeZone={zone}
              reader={{ kind: "lead" }}
              onRetry={picker.retry}
              failedMessage={picker.failedMessage}
              classes={{
                muted: `text-sm ${c.faint}`,
                heading: `text-sm font-semibold tabular-nums ${c.title}`,
                retry: `inline-flex min-h-9 items-center rounded-md border px-3 text-sm ${c.toggleBorder} ${c.body} ${c.navHover}`,
                // #3718: the card lays its times out three across, two on a phone.
                grid: inline ? "grid grid-cols-2 gap-2 @sm:grid-cols-3" : "space-y-2",
                viewMore: `mx-auto mt-1 flex min-h-11 items-center px-3 text-sm font-semibold ${c.title}`,
              }}
              firstShown={inline ? 6 : undefined}
              onViewMore={piece === "times" ? (day) => askPage({ day }) : undefined}
              dayHeading={!inline}
              noDaysNode={closurePanel}
              renderSlot={(iso) => (
                <button
                  key={iso}
                  onClick={() => (piece === "times" ? askPage({ slot: iso }) : chooseSlot(iso))}
                  className={`flex min-h-11 w-full items-center rounded-md border px-3 py-2.5 text-sm tabular-nums ${inline ? "justify-center" : "text-left"} ${c.slot}`}
                >
                  <MarkedLabel
                    className="gap-2"
                    mark={<span className="h-1.5 w-1.5 rounded-full bg-pennie-green" style={dotStyle} />}
                  >
                    {fmtTime(iso)}
                  </MarkedLabel>
                </button>
              )}
            />
          </div>
        </>
      )}
    </section>
  );

  const eventPanel = (
    <aside className={`border-b p-6 ${c.border} @3xl:border-b-0 @3xl:border-r`}>
      {/* #2629: the Pennie mark, where the first build drew the organisation's
          initials ("PE"), which meant nothing to a lead. Same slot and size, so
          nothing else on the card moves. Named for the organisation only once its
          name has loaded; until then it is decoration. */}
      <div
        data-org-mark
        className={`mb-4 flex h-9 w-9 items-center justify-center rounded-full ${c.avatar}`}
        style={confirmStyle}
      >
        <PennieMark label={meta?.orgName || undefined} width={16} height={18} />
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
            <ClockIcon width={15} height={15} />
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
            thing this panel got wrong in the first place.

            And only while the details step is CLOSED (#2208, L605). Read as one
            composed screen rather than as two components, this row and the Phone
            field state the same number twice, side by side on a laptop and one
            above the other on a phone. The FIELD is the one that survives: it is
            the number that will be submitted, it is labelled, and it is the only
            one of the two the lead can change. The row is not deleted, because
            while a time is being picked there is no field at all and this is then
            the only place a prefilled lead can read back what Slate holds, which
            prefilling made the ordinary case rather than a rarity. */}
        {attendee.phone && !selectedSlot && (
          // Label and number each on their own line, the number never broken at its
          // hyphen, and the icon centred on the pair: the panel is too narrow for
          // both on one line, and wrapping mid number left "7858" on its own.
          <div className="flex items-center gap-2">
            <span className={`shrink-0 ${c.faint}`}>
              <PhoneOutlineIcon width={15} height={15} />
            </span>
            <span>
              {DETAILS_COPY.yourNumber}{" "}
              <span className="block whitespace-nowrap tabular-nums">{attendee.phone}</span>
            </span>
          </div>
        )}
        <div className="flex items-center gap-2">
          <span className={c.faint}>
            <GlobeIcon width={15} height={15} />
          </span>
          {zone.replace(/_/g, " ")}
        </div>
      </div>
    </aside>
  );

  if (inline) {
    // #3718: the card, as settled: a title, then a panel holding the day strip and
    // the times. Once a time is chosen the panel holds the details step instead. The
    // Call me now row sits above or below that panel, as the page asked, and a press
    // that went through replaces the panel with its confirmation.
    const cmnRow =
      callMeNow && !selectedSlot ? (
        <CallMeNowRow
          phase={cmn.phase}
          position={callMeNow.position}
          onPress={piece === "callMeNow" ? () => askPage({ callMeNow: "press" }) : cmn.press}
          palette={c}
          titleClass={c.title}
          mutedClass={c.faint}
          confirmStyle={confirmStyle}
        />
      ) : null;
    const rowShown = cmnRow !== null && ["offered", "pressing", "failed", "refused"].includes(cmn.phase);
    // #3718 (Geoff, 2026-10-15): one piece on its own, just its tile. The frame
    // around it is rounded by widget.js, and the page behind the tile is the tile's
    // own surface, so the root paints nothing of its own.
    if (piece === "callMeNow") {
      return (
        <div ref={rootRef} data-theme={theme} className={c.body}>
          {rowShown && cmnRow}
        </div>
      );
    }
    if (piece === "times") {
      return (
        <div ref={rootRef} data-theme={theme} className={`@container bg-surface p-[18px] ${c.body}`}>
          {testBand}
          <p className={`mb-3 text-sm ${c.body}`}>{INLINE_CARD_COPY.chooseTime}</p>
          <div className="mb-3">
            {loading ? (
              <BookerStripSkeleton skeletonClass={c.skeleton} count={horizonDays} />
            ) : (
              <BookerStrip
                today={today}
                days={picker.days}
                activeDay={activeDay}
                zone={zone}
                onSelect={(iso) => picker.selectDay(iso)}
              />
            )}
          </div>
          {timesPanel}
          {picker.view.kind === "times" && (
            <p className={`mt-3 text-center text-xs ${c.faint}`}>{INLINE_CARD_COPY.timesIn(zoneReadName(zone))}</p>
          )}
        </div>
      );
    }
    // One frame and one title for both bodies: the confirmation after a press that
    // went through, or the times with the row beside them.
    const inkStyle = cardSurface ? { color: cardSurface.ink } : undefined;
    return (
      <div
        ref={rootRef}
        data-theme={theme}
        className={shell}
        style={cardSurface ? { backgroundColor: cardSurface.background } : undefined}
      >
        {testBand}
        <p className={`mb-3.5 text-[length:var(--fs-h5,1.25rem)] font-semibold ${c.title}`} style={inkStyle}>
          {INLINE_CARD_COPY.title}
        </p>
        {cmn.phase === "confirmed" ? (
          <CallMeNowConfirmation
            firstName={callMeNow?.firstName ?? null}
            textLine={cmn.textLine}
            onBackToTimes={cmn.backToTimes}
            onCardStyle={inkStyle}
            palette={c}
            titleClass={c.title}
            mutedClass={c.faint}
          />
        ) : (
          <>
        {rowShown && callMeNow?.position === "above" && <div className="mb-3">{cmnRow}</div>}
        <div className="rounded-2xl bg-surface p-[18px]">
          {!selectedSlot && (
            <>
              <p className={`mb-3 text-sm ${c.body}`}>{INLINE_CARD_COPY.chooseTime}</p>
              <div className="mb-3">
                {loading ? (
                  <BookerStripSkeleton skeletonClass={c.skeleton} count={horizonDays} />
                ) : (
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
                )}
              </div>
            </>
          )}
          {timesPanel}
          {/* Only over times actually on screen: while loading, failed or closed
              there are none for the zone to describe (L11). */}
          {!selectedSlot && picker.view.kind === "times" && (
            <p className={`mt-3 text-center text-xs ${c.faint}`}>{INLINE_CARD_COPY.timesIn(zoneReadName(zone))}</p>
          )}
        </div>
        {rowShown && callMeNow?.position === "below" && <div className="mt-3">{cmnRow}</div>}
          </>
        )}
      </div>
    );
  }

  return (
    <div ref={rootRef} data-theme={theme} className={shell}>
        {testBand}
      {embedBody(
      <div className="grid flex-1 grid-cols-1 @3xl:grid-cols-[260px_1fr]">
        {eventPanel}
        <div className="flex min-h-0 flex-col">
          {/* px-6 pt-6 aligns the strip's chips with the padded times list below. */}
          <div className="px-6 pt-6">
            {displayControls}
            {/* #2769: the confirm step drops the strip in the embed. The step's
                own line states the chosen day and time, so the strip was a second
                statement of one fact (L605), and it was what made the confirm step
                taller than the box the picker set. The standalone page keeps it
                (#2172: a live chip takes the lead back to that day's times). */}
            {embedded && selectedSlot ? null : loading ? (
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
      </div>,
      )}
    </div>
  );
}
