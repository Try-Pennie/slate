/**
 * The coordinator booking page's rules (#4205), in one pure reducer the page only sends
 * events to (Dan's rule for a screen whose state moves together), and the view it draws
 * from. Settled as docs/design/coordinator-booking.html; the decisions are named where
 * they are kept. `scripts/test-coordinator-booking-page.ts` drives it directly.
 *
 * What the page holds: the Lead field and its lookup, the customer found, their existing
 * call, the days and times Slate offers them, the day and time chosen, the reason for a
 * move, the confirmation dialog, placing, and the done state. Every effect (calling the
 * server, a clock, focus) lives in the component; this decides what each event means.
 *
 * Times are the CUSTOMER's own throughout, with no zone (D6), apart from the dialog,
 * which reads the zone back (D23). Pure: luxon and relative imports only.
 */
import { DateTime } from "luxon";
import { COORDINATOR_PAGE_COPY as COPY, fillCopy } from "./booking-page-copy.ts";
import { parseLeadReference } from "./lead-reference.ts";
import type { OfferedDays } from "./bookable-hours.ts";
import type { Customer, ExistingCallView } from "./customer.ts";
import type { PlacedCallSummary, PlacedOn } from "../booking/placed-booking.ts";
import type { PlaceCallRequest } from "./place-call.ts";
import { CURATED_ZONES, humanizeZone } from "../booking/timezones.ts";
import { formatClockTime, formatLongDate } from "../date/parse.ts";

// ---- What the server answers, as the page needs it ------------------------------------------

/** The lookup's answer: the server action's, narrowed to what the page reads. */
export type LookupAnswer =
  | { ok: true; customer: Customer; existingCall: ExistingCallView; days: OfferedDays }
  | { ok: false; sentence: string };

/** The place call's answer, narrowed to what the page reads. */
export type PlaceAnswer =
  | { kind: "booked" | "moved"; on: PlacedOn; advisorName: string | null; startsAt: string; sentence: string }
  | { kind: "needs-confirm"; call: PlacedCallSummary; sentence: string }
  | { kind: "possible-match"; call: PlacedCallSummary; matchedOn: "email-and-phone" | "email-or-phone"; sentence: string }
  | { kind: "refused"; sentence: string };

// ---- State -----------------------------------------------------------------------------------

export interface PageCustomer {
  leadId: string;
  name: string;
  /** Null when the Lead has no first name; the page says "the customer". */
  first: string | null;
  phone: string | null;
  zone: string;
}

export type PageExistingCall =
  | { kind: "none" }
  | { kind: "unreadable" }
  /** A call the booking will move once the coordinator confirms they told the customer. */
  | { kind: "move"; call: PlacedCallSummary }
  /** A call matching only on email or phone: booking is refused until it is sorted out. */
  | { kind: "loose"; call: PlacedCallSummary; matchedOn: "email-and-phone" | "email-or-phone" };

export interface PageFound {
  customer: PageCustomer;
  existing: PageExistingCall;
  days: OfferedDays;
}

export interface PageDone {
  moved: boolean;
  startsAt: string;
  advisorName: string | null;
  onPlaceholder: boolean;
}

export type PagePhase = "idle" | "finding" | "found" | "placing" | "done";

export interface PageState {
  phase: PagePhase;
  lead: string;
  /** The sentence under the Lead field, or null. */
  refusal: string | null;
  /** Bumped per lookup the page starts; an answer for an older one is ignored. */
  lookup: { seq: number; leadId: string | null };
  found: PageFound | null;
  told: boolean;
  /** A press landed on the locked card, so the pointer is up (D11). */
  nudged: boolean;
  /** How many presses landed on the locked card, so the live region says it again each time. */
  said: number;
  /** The page moved focus to the checkbox, which keeps its ring until focus leaves. */
  ringTold: boolean;
  day: string | null;
  start: string | null;
  reason: string | null;
  detail: string;
  confirming: boolean;
  /** Why the last booking attempt did not book, said under the confirm. */
  failure: string | null;
  place: { seq: number };
  /** One per customer found, kept across retries, so a booking is made once (D30). */
  submissionId: string | null;
  /** When the running lookup or booking started, for its still working count. */
  startedAt: number | null;
  done: PageDone | null;
}

export function initialPageState(): PageState {
  return {
    phase: "idle",
    lead: "",
    refusal: null,
    lookup: { seq: 0, leadId: null },
    found: null,
    told: false,
    nudged: false,
    said: 0,
    ringTold: false,
    day: null,
    start: null,
    reason: null,
    detail: "",
    confirming: false,
    failure: null,
    place: { seq: 0 },
    submissionId: null,
    startedAt: null,
    done: null,
  };
}

export type PageEvent =
  | { type: "leadEdited"; value: string; at: number }
  | { type: "findPressed"; at: number }
  | { type: "lookupAnswered"; seq: number; answer: LookupAnswer }
  | { type: "lookupNoAnswer"; seq: number }
  | { type: "toldChanged"; checked: boolean }
  | { type: "lockedAttempt" }
  | { type: "pointedToBox" }
  | { type: "boxLeft" }
  | { type: "dayChosen"; date: string }
  | { type: "timeChosen"; start: string }
  | { type: "reasonChosen"; code: string }
  | { type: "detailEdited"; value: string }
  | { type: "confirmPressed" }
  | { type: "dialogClosed" }
  | { type: "placePressed"; submissionId: string; at: number }
  | { type: "placeAnswered"; seq: number; outcome: PlaceAnswer }
  | { type: "placeNoAnswer"; seq: number }
  | { type: "again" };

// ---- The rules -------------------------------------------------------------------------------

const busy = (s: PageState) => s.phase === "finding" || s.phase === "placing";
export const isMove = (s: PageState) => s.found?.existing.kind === "move";
/** The card is locked behind the box, or behind a call that cannot be moved from here. */
export const isLocked = (s: PageState) =>
  s.phase !== "done" && ((isMove(s) && !s.told) || s.found?.existing.kind === "loose");
/** Every control on the booking card is off. */
const cardOff = (s: PageState) => busy(s) || s.phase === "done" || isLocked(s);
const daysOf = (s: PageState) => (s.found?.days.ok ? s.found.days.days : []);
const startsOn = (s: PageState, date: string | null) => daysOf(s).find((d) => d.date === date)?.starts ?? [];
const timeChosen = (s: PageState) => s.start !== null && startsOn(s, s.day).includes(s.start);
const needsDetail = (s: PageState) => s.reason === COPY.newTime.detailCode;
const reasonDone = (s: PageState) => !isMove(s) || (s.reason !== null && (!needsDetail(s) || s.detail.trim().length > 0));
export const isReady = (s: PageState) => s.found !== null && timeChosen(s) && reasonDone(s) && !isLocked(s);
const sameLead = (a: string, b: string) => a.slice(0, 15) === b.slice(0, 15);

function startLookup(s: PageState, leadId: string, at: number): PageState {
  return { ...s, phase: "finding", refusal: null, lookup: { seq: s.lookup.seq + 1, leadId }, startedAt: at, confirming: false };
}

const clearedBooking = {
  told: false,
  nudged: false,
  said: 0,
  ringTold: false,
  day: null,
  start: null,
  reason: null,
  detail: "",
  confirming: false,
  failure: null,
  submissionId: null,
} as const;

function existingOf(view: ExistingCallView): PageExistingCall {
  if (view.kind !== "found") return view;
  return view.happens === "moves-when-confirmed" ? { kind: "move", call: view.call } : { kind: "loose", call: view.call, matchedOn: view.matchedOn };
}

function foundOf(answer: Extract<LookupAnswer, { ok: true }>): PageFound {
  const c = answer.customer;
  return {
    customer: { leadId: c.salesforceLeadId, name: c.name ?? c.firstName ?? COPY.more.theCustomer, first: c.firstName, phone: c.phone, zone: c.zone },
    existing: existingOf(answer.existingCall),
    days: answer.days,
  };
}

export function reducePage(s: PageState, e: PageEvent): PageState {
  switch (e.type) {
    case "leadEdited": {
      if (s.phase === "done") return s;
      const next = { ...s, lead: e.value };
      const ref = parseLeadReference(e.value);
      // D22: a whole Lead ID or link looks the customer up at once; the customer already
      // on the page is not looked up again.
      if (!ref.ok || busy(s)) return next;
      if (s.found && sameLead(s.found.customer.leadId, ref.leadId)) return next;
      return startLookup(next, ref.leadId, e.at);
    }
    case "findPressed": {
      if (busy(s) || s.phase === "done") return s;
      const ref = parseLeadReference(s.lead);
      if (!ref.ok) return { ...s, refusal: COPY.lead.notALeadId };
      return startLookup(s, ref.leadId, e.at);
    }
    case "lookupAnswered":
    case "lookupNoAnswer": {
      if (e.seq !== s.lookup.seq || s.phase !== "finding") return s;
      const failed = e.type === "lookupNoAnswer" ? COPY.more.lookupNoAnswer : e.answer.ok ? null : e.answer.sentence;
      if (failed !== null || e.type === "lookupNoAnswer") {
        return { ...s, phase: s.found ? "found" : "idle", refusal: failed, startedAt: null };
      }
      if (!e.answer.ok) return s;
      return { ...s, ...clearedBooking, phase: "found", refusal: null, startedAt: null, found: foundOf(e.answer) };
    }
    case "toldChanged":
      if (!isMove(s) || busy(s) || s.phase === "done") return s;
      return { ...s, told: e.checked, nudged: false, said: 0, ringTold: false };
    case "lockedAttempt":
      if (!isLocked(s)) return s;
      return { ...s, nudged: true, said: s.said + 1 };
    case "pointedToBox":
      return isLocked(s) ? { ...s, ringTold: true } : s;
    case "boxLeft":
      return s.ringTold ? { ...s, ringTold: false } : s;
    case "dayChosen": {
      if (cardOff(s)) return s;
      const starts = startsOn(s, e.date);
      if (starts.length === 0) return s; // a closed day cannot be chosen (D13)
      return { ...s, day: e.date, start: s.start !== null && starts.includes(s.start) ? s.start : null };
    }
    case "timeChosen":
      if (cardOff(s) || !startsOn(s, s.day).includes(e.start)) return s; // D15
      return { ...s, start: e.start };
    case "reasonChosen":
      if (cardOff(s) || !isMove(s)) return s;
      return { ...s, reason: e.code };
    case "detailEdited":
      if (cardOff(s)) return s;
      return { ...s, detail: e.value.slice(0, COPY.newTime.detailMax) };
    case "confirmPressed":
      if (!isReady(s) || busy(s) || s.phase === "done") return s;
      return { ...s, confirming: true, failure: null };
    case "dialogClosed":
      if (!s.confirming || busy(s)) return s; // D26: ignored while placing
      return { ...s, confirming: false };
    case "placePressed":
      if (!s.confirming || !isReady(s) || busy(s)) return s;
      return { ...s, phase: "placing", place: { seq: s.place.seq + 1 }, submissionId: s.submissionId ?? e.submissionId, startedAt: e.at };
    case "placeAnswered":
    case "placeNoAnswer": {
      if (e.seq !== s.place.seq || s.phase !== "placing" || !s.found) return s;
      const back = { ...s, phase: "found" as const, confirming: false, startedAt: null };
      if (e.type === "placeNoAnswer") return { ...back, failure: COPY.more.placeNoAnswer };
      const o = e.outcome;
      switch (o.kind) {
        case "booked":
        case "moved":
          return {
            ...back,
            phase: "done",
            failure: null,
            done: { moved: o.kind === "moved", startsAt: o.startsAt, advisorName: o.advisorName, onPlaceholder: o.on === "placeholder" },
          };
        case "needs-confirm":
          // A call appeared after the lookup: the card locks behind the box like any move.
          return {
            ...back,
            told: false,
            found: { ...s.found, existing: { kind: "move", call: o.call } },
            failure: fillCopy(COPY.more.needsConfirm, { first: firstOf(s.found.customer) }),
          };
        case "possible-match":
          return { ...back, failure: null, found: { ...s.found, existing: { kind: "loose", call: o.call, matchedOn: o.matchedOn } } };
        case "refused":
          return { ...back, failure: o.sentence };
      }
      return back;
    }
    case "again":
      return initialPageState();
  }
}

/** What the server is asked to place, once the dialog's main button was pressed; else null. */
export function placeRequest(s: PageState): PlaceCallRequest | null {
  if (s.phase !== "placing" || !s.found || s.start === null || s.submissionId === null) return null;
  const existing = s.found.existing;
  return {
    reference: s.found.customer.leadId,
    startIso: s.start,
    submissionId: s.submissionId,
    ...(existing.kind === "move" && s.reason !== null
      ? { move: { bookingId: existing.call.bookingId, reasonCode: s.reason, reasonDetail: needsDetail(s) ? s.detail : "" } }
      : {}),
  };
}

// ---- Words ---------------------------------------------------------------------------------

/**
 * The customer's zone as named once in their details ("Arizona (Phoenix)") and as read
 * back in the dialog ("Arizona time (Phoenix)"), from the product's one zone list.
 */
export function zoneNames(zone: string): { name: string; spoken: string } {
  const label = CURATED_ZONES.find((z) => z.id === zone)?.label;
  const m = label ? /^(.*?)(?: time)? \((.*)\)$/.exec(label) : null;
  if (m) return { name: `${m[1]} (${m[2]})`, spoken: `${m[1]} time (${m[2]})` };
  const city = humanizeZone(zone);
  return { name: city, spoken: `${city} time` };
}

const firstOf = (c: PageCustomer) => c.first ?? COPY.more.theCustomer;
const at = (iso: string, zone: string) => DateTime.fromISO(iso, { zone });
const longDay = (iso: string, zone: string) => formatLongDate(at(iso, zone)) ?? iso;
const clockOf = (iso: string, zone: string) => formatClockTime(at(iso, zone)) ?? iso;
const whenOf = (iso: string, zone: string) => `${longDay(iso, zone)} at ${clockOf(iso, zone)}`;
const dayNameOf = (iso: string, zone: string) => at(iso, zone).setLocale("en-US").toFormat("cccc");
const callAdvisor = (call: PlacedCallSummary) => (call.onPlaceholder ? COPY.outcome.marciaName : call.advisorName ?? COPY.more.anAdvisor);

// ---- The view --------------------------------------------------------------------------------

export interface DayChip {
  date: string;
  top: string;
  num: string;
  bottom: string;
  label: string;
  pressed: boolean;
  disabled: boolean;
}

export interface TimeSlot {
  start: string;
  label: string;
  pressed: boolean;
}

export interface PageView {
  lead: { value: string; finding: boolean; refusal: string | null };
  customer: { name: string; phone: string; zone: string; clock: string } | null;
  notice: { heading: string; lines: string[]; told?: { label: string; checked: boolean; disabled: boolean; ring: boolean } } | null;
  booking: {
    locked: boolean;
    days: DayChip[];
    line: { text: string; tone: "muted" | "fg" | "error" };
    times: { morning: TimeSlot[]; afternoon: TimeSlot[]; disabled: boolean };
    reason: { value: string | null; placeholder: string; options: { value: string; label: string }[]; disabled: boolean } | null;
    detail: { value: string; disabled: boolean; label: string; max: number } | null;
    confirm: { label: string; refused: boolean; placing: boolean; note: string | null; failure: string | null };
    /** The press catcher over the locked card, by its accessible name. */
    catcher: string | null;
    overlay: string | null;
  } | null;
  dialog: { title: string; when: string; moves: string | null; back: string; go: string; placing: boolean; pending: string } | null;
  done: { heading: string; when: string; with: string; link: string | null; by: string; again: string } | null;
  /** The polite live region's text. */
  live: string;
}

export function pageView(s: PageState, ctx: { nowMs: number; reasons: readonly { code: string; label: string }[] }): PageView {
  const f = s.found;
  if (s.phase === "done" && s.done && f) {
    const d = s.done;
    const zone = f.customer.zone;
    const first = firstOf(f.customer);
    const o = COPY.outcome;
    return {
      lead: { value: s.lead, finding: false, refusal: null },
      customer: null,
      notice: null,
      booking: null,
      dialog: null,
      done: {
        heading: d.moved ? o.moved : o.booked,
        when: whenOf(d.startsAt, zone),
        with: d.onPlaceholder ? fillCopy(o.withMarcia, { first }) : fillCopy(o.withAdvisor, { advisor: d.advisorName ?? COPY.more.anAdvisor }),
        link: d.moved ? fillCopy(o.linkWorks, { first }) : null,
        by: d.moved ? o.movedByYou : o.bookedByYou,
        again: o.again,
      },
      live: "",
    };
  }
  const lead = { value: s.lead, finding: s.phase === "finding", refusal: s.refusal };
  if (!f) return { lead, customer: null, notice: null, booking: null, dialog: null, done: null, live: "" };

  const c = f.customer;
  const first = firstOf(c);
  const zone = c.zone;
  const names = zoneNames(zone);
  const nowLocal = DateTime.fromMillis(ctx.nowMs, { zone });
  const customer = {
    name: c.name,
    phone: c.phone ?? COPY.more.noPhone,
    zone: names.name,
    clock: fillCopy(COPY.customer.clock, { time: formatClockTime(nowLocal) ?? "", first }),
  };

  const existing = f.existing;
  const off = cardOff(s);
  const locked = isLocked(s);
  let notice: PageView["notice"] = null;
  if (existing.kind === "move") {
    const w = COPY.warning;
    const vars = { first, when: whenOf(existing.call.startsAt, zone), advisor: callAdvisor(existing.call), dayName: dayNameOf(existing.call.startsAt, zone) };
    notice = {
      heading: fillCopy(w.heading, vars),
      lines: [`${fillCopy(w.details, vars)} ${w.consequence}`],
      told: { label: fillCopy(w.told, vars), checked: s.told, disabled: busy(s), ring: s.ringTold },
    };
  } else if (existing.kind === "loose") {
    const m = COPY.more;
    const vars = { first, when: whenOf(existing.call.startsAt, zone), matched: existing.matchedOn === "email-and-phone" ? m.matchedBoth : m.matchedOne };
    notice = { heading: fillCopy(m.looseHeading, vars), lines: [`${fillCopy(m.looseDetails, vars)} ${fillCopy(m.looseConsequence, vars)}`] };
  } else if (existing.kind === "unreadable") {
    notice = { heading: fillCopy(COPY.more.callUnreadableHeading, { first }), lines: [COPY.more.callUnreadableDetails] };
  }

  const today = nowLocal.toISODate();
  const tomorrow = nowLocal.plus({ days: 1 }).toISODate();
  const days: DayChip[] = daysOf(s).map((d) => {
    const dt = DateTime.fromISO(d.date, { zone }).setLocale("en-US");
    const open = d.starts.length > 0;
    return {
      date: d.date,
      top: d.date === today ? COPY.day.today : d.date === tomorrow ? COPY.day.tomorrow : dt.toFormat("ccc"),
      num: String(dt.day),
      bottom: open ? dt.toFormat("LLL") : COPY.day.closed,
      label: `${formatLongDate(dt) ?? d.date}${d.date === today ? `, ${COPY.day.today}` : ""}${open ? "" : `, ${COPY.day.closed}`}`,
      pressed: d.date === s.day,
      disabled: off || !open,
    };
  });

  const starts = startsOn(s, s.day);
  let line: { text: string; tone: "muted" | "fg" | "error" };
  if (!f.days.ok) line = { text: COPY.more.daysUnreadable, tone: "error" };
  else if (existing.kind === "loose") line = { text: COPY.more.looseLine, tone: "muted" };
  else if (locked) line = { text: fillCopy(COPY.warning.unlock, { first }), tone: "muted" };
  else if (daysOf(s).every((d) => d.starts.length === 0)) line = { text: COPY.more.noDays, tone: "muted" };
  else if (!s.day || starts.length === 0) line = { text: COPY.newTime.pickDay, tone: "muted" };
  else line = { text: fillCopy(COPY.newTime.hours, { day: longDay(s.day, zone), from: clockOf(starts[0]!, zone), to: clockOf(starts[starts.length - 1]!, zone) }), tone: "fg" };

  const slots = starts.map((t) => ({ start: t, label: clockOf(t, zone), pressed: t === s.start, morning: at(t, zone).hour < 12 }));
  const toSlot = ({ start, label, pressed }: TimeSlot) => ({ start, label, pressed });
  const move = isMove(s);
  const placing = s.phase === "placing";
  const chosen = timeChosen(s);
  const confirmLabel = !chosen
    ? move
      ? COPY.newTime.moveIdle
      : COPY.newTime.bookIdle
    : fillCopy(move ? COPY.newTime.move : COPY.newTime.book, { day: longDay(s.day!, zone), time: clockOf(s.start!, zone) });
  // The note under the confirm, only while there is something to say: what still stops it.
  const note = placing || !move || !chosen || locked ? null : s.reason === null ? COPY.newTime.reasonNeeded : !reasonDone(s) ? COPY.newTime.detailNeeded : null;

  const lockedSay =
    existing.kind === "move"
      ? fillCopy(COPY.warning.lockedSay, { first, dayName: dayNameOf(existing.call.startsAt, zone) })
      : existing.kind === "loose"
        ? fillCopy(COPY.more.looseConsequence, { first })
        : "";

  const booking: PageView["booking"] = {
    locked,
    days,
    line,
    times: { morning: slots.filter((t) => t.morning).map(toSlot), afternoon: slots.filter((t) => !t.morning).map(toSlot), disabled: off || starts.length === 0 },
    reason: move
      ? { value: s.reason, placeholder: COPY.newTime.reasonPlaceholder, options: ctx.reasons.map((r) => ({ value: r.code, label: r.label })), disabled: off }
      : null,
    detail: move && needsDetail(s) ? { value: s.detail, disabled: off, label: COPY.newTime.detailLabel, max: COPY.newTime.detailMax } : null,
    confirm: { label: confirmLabel, refused: !isReady(s) && !placing, placing, note, failure: s.failure },
    catcher: locked ? lockedSay : null,
    overlay: locked && s.nudged ? COPY.warning.overlay : null,
  };

  let dialog: PageView["dialog"] = null;
  if (s.confirming && s.day && s.start) {
    const d = COPY.dialog;
    const vars = {
      name: c.name,
      first,
      day: longDay(s.start, zone),
      time: clockOf(s.start, zone),
      zone: names.spoken,
      old: existing.kind === "move" ? whenOf(existing.call.startsAt, zone) : "",
    };
    dialog = {
      title: fillCopy(move ? d.titleMove : d.titleBook, vars),
      when: fillCopy(d.when, vars),
      moves: move ? fillCopy(d.moves, vars) : null,
      back: d.back,
      go: move ? d.move : d.book,
      placing,
      pending: move ? COPY.outcome.moving : COPY.outcome.booking,
    };
  }

  // Said on every press on the locked card; a changed string, so a repeat is spoken.
  const live = locked && s.said > 0 ? lockedSay + (s.said % 2 ? "" : " ") : "";
  return { lead, customer, notice, booking, dialog, done: null, live };
}
