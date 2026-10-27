/**
 * The coordinator booking design's fixture as the page renders it (#4205).
 *
 * The settled design (docs/design/coordinator-booking.html) draws eighteen frames from one
 * set of data, committed as docs/design/fixtures/coordinator-booking.json, and the page's
 * `?frame=` preview draws the real component from the same file, so the design match
 * score compares like with like. Each frame is REACHED, not drawn: the customer is a
 * lookup answer whose days come from the real start time predicate (`offeredDays`), and
 * the frame's moment is the reducer's own events, as a coordinator would send them. Only
 * ever reached behind `designFixturesEnabled` (the e2e flag AND a request to this
 * machine). `scripts/test-coordinator-booking-design-fixture.ts` holds the file to the
 * design and its copy to the page's.
 *
 * The design gives Pennie's hours as the first and last START of each day, so they are
 * handed to the predicate as a call of no length: its last start is then the hours' own
 * end, and a day counts toward the horizon until that start has passed, as the design
 * counts it. Pure: JSON in, the frame's state out.
 */
import { DateTime } from "luxon";
import type { BusinessHoursRules } from "../availability/compute.ts";
import { CURATED_ZONES } from "../booking/timezones.ts";
import { offeredDays } from "./bookable-hours.ts";
import { initialPageState, reducePage, zoneNames, type LookupAnswer, type PageEvent, type PageState } from "./booking-page.ts";
import type { COORDINATOR_PAGE_COPY } from "./booking-page-copy.ts";
import type { Customer } from "./customer.ts";

type Copy = typeof COORDINATOR_PAGE_COPY;

interface DesignCustomer {
  name: string;
  phone: string;
  zone: string;
  advisor: string;
  existingCall: { when: string; advisor: string; dayName: string } | null;
  firstName: string;
  utcOffsetMin: number;
  zoneSpoken: string;
}

export interface CoordinatorBookingDesignFixture {
  about?: string;
  design: {
    nowUtc: string;
    daysOffered: number;
    callingWindow: { first: string; endBefore: string };
    placeholderFrom: string;
    startWith: string;
    samId: string;
    refusalSample: string;
    org: { zone: string; utcOffsetMin: number; hours: Record<string, [string, string] | null> };
    customers: Record<string, DesignCustomer>;
    page: Copy["page"];
    lead: Copy["lead"];
    customer: Copy["customer"];
    newTime: Omit<Copy["newTime"], "detailMax"> & { detailMax: number; reasons: { code: string; label: string }[] };
    outcome: Copy["outcome"];
    warning: Copy["warning"];
    day: Copy["day"];
    dialog: Copy["dialog"];
    [more: string]: unknown;
  };
  frames: Record<string, { theme: string; state: string; nowUtc?: string }>;
}

export interface CoordinatorBookingFrame {
  theme: "light" | "dark";
  state: PageState;
  /** The fixture's clock, which the frame's page holds still. */
  nowMs: number;
  reasons: { code: string; label: string }[];
}

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
};

/** The IANA zone the design names as "Arizona (Phoenix)", by the product's own zone list. */
export function designZone(label: string): string {
  const z = CURATED_ZONES.find((c) => zoneNames(c.id).name === label);
  if (!z) throw new Error(`no listed zone is named "${label}"`);
  return z.id;
}

/** One frame of the design, from the fixture. Refuses a frame or a state the fixture does not name. */
export function coordinatorBookingFrame(fixture: CoordinatorBookingDesignFixture, frameId: string): CoordinatorBookingFrame {
  const frame = Object.prototype.hasOwnProperty.call(fixture.frames, frameId) ? fixture.frames[frameId] : undefined;
  if (!frame) throw new Error(`the fixture names no frame "${frameId}"`);
  if (frame.theme !== "light" && frame.theme !== "dark") throw new Error(`frame "${frameId}" has no theme named ${frame.theme}`);
  const d = fixture.design;
  const nowMs = Date.parse(frame.nowUtc ?? d.nowUtc);
  const hours: BusinessHoursRules = {
    zone: d.org.zone,
    rules: Object.entries(d.org.hours).flatMap(([weekday, span]) =>
      span ? [{ weekday: Number(weekday), start_minute: minutesOf(span[0]), end_minute: minutesOf(span[1]) }] : [],
    ),
    exceptions: [],
  };

  const answerFor = (id: string): LookupAnswer => {
    const c = d.customers[id];
    if (!c) throw new Error(`the fixture holds no customer ${id}`);
    const zone = designZone(c.zone);
    const year = DateTime.fromMillis(nowMs, { zone }).year;
    const customer: Customer = {
      salesforceLeadId: id,
      name: c.name,
      firstName: c.firstName,
      email: null,
      phone: c.phone,
      zone,
      zoneFrom: "zip",
      bucketCode: "design",
      bucketSource: "salesforce",
      bucketIsTest: false,
      durationMin: 0,
    };
    let existingCall: Extract<LookupAnswer, { ok: true }>["existingCall"] = { kind: "none" };
    if (c.existingCall) {
      const when = DateTime.fromFormat(`${c.existingCall.when.replace(/(am|pm)$/, (x) => x.toUpperCase())} ${year}`, "cccc, LLLL d 'at' h:mma yyyy", {
        zone,
        locale: "en-US",
      });
      if (!when.isValid) throw new Error(`the fixture's call "${c.existingCall.when}" is not a time`);
      existingCall = {
        kind: "found",
        happens: "moves-when-confirmed",
        call: { bookingId: `design-${id}`, startsAt: when.toUTC().toISO()!, timezone: zone, advisorName: c.existingCall.advisor, onPlaceholder: false },
      };
    }
    const days = offeredDays({ hours, zone, durationMin: 0, nowMs, horizonDays: d.daysOffered });
    return { ok: true, customer, existingCall, days: { ok: true, days } };
  };

  const find = (id: string): PageEvent[] => [
    { type: "leadEdited", value: id, at: nowMs },
    { type: "lookupAnswered", seq: 1, answer: answerFor(id) },
  ];
  // The design's day row is DAYS; a frame names a day by its place in it and a time by its minute.
  const pick = (id: string, dayIndex: number, minute: number): PageEvent[] => {
    const answer = answerFor(id);
    if (!answer.ok || !answer.days.ok) throw new Error("the fixture's customer has no days");
    const day = answer.days.days[dayIndex];
    if (!day) throw new Error(`frame "${frameId}" names day ${dayIndex}, which the row does not hold`);
    const start = DateTime.fromISO(day.date, { zone: answer.customer.zone }).set({ hour: Math.floor(minute / 60), minute: minute % 60 }).toISO()!;
    return [
      { type: "dayChosen", date: day.date },
      { type: "timeChosen", start },
    ];
  };
  const placed = (id: string, moved: boolean, minute: number, startsAt: () => string): PageEvent[] => [
    { type: "placePressed", submissionId: "00000000-0000-4000-8000-000000004205", at: nowMs },
    {
      type: "placeAnswered",
      seq: 1,
      outcome: {
        kind: moved ? "moved" : "booked",
        on: minute >= minutesOf(d.placeholderFrom) ? "placeholder" : "advisor",
        advisorName: d.customers[id]!.advisor,
        startsAt: startsAt(),
        sentence: "",
      },
    },
  ];
  const other = d.newTime.reasons.find((r) => r.code === d.newTime.detailCode)?.code;
  if (!other) throw new Error(`the fixture's reasons hold no ${d.newTime.detailCode}`);
  const firstReason = d.newTime.reasons[0]!.code;

  const jordan = d.startWith;
  const sam = d.samId;
  const unlocked = (): PageEvent[] => [...find(jordan), { type: "toldChanged", checked: true }, ...pick(jordan, 3, 840)];
  const run = (events: PageEvent[]) => events.reduce(reducePage, initialPageState());
  const startOf = (events: PageEvent[]) => () => run(events).start!;

  const STATES: Record<string, () => PageEvent[]> = {
    locked: () => find(jordan),
    "locked-pressed": () => [...find(jordan), { type: "lockedAttempt" }],
    unlocked,
    other: () => [...unlocked(), { type: "reasonChosen", code: other }],
    "dialog-move": () => [...unlocked(), { type: "reasonChosen", code: firstReason }, { type: "confirmPressed" }],
    "done-move": () => {
      const ready: PageEvent[] = [...unlocked(), { type: "reasonChosen", code: firstReason }, { type: "confirmPressed" }];
      return [...ready, ...placed(jordan, true, 840, startOf(ready))];
    },
    "sam-empty": () => find(sam),
    "sam-dialog": () => [...find(sam), ...pick(sam, 1, 600), { type: "confirmPressed" }],
    "sam-done-advisor": () => {
      const ready: PageEvent[] = [...find(sam), ...pick(sam, 1, 600), { type: "confirmPressed" }];
      return [...ready, ...placed(sam, false, 600, startOf(ready))];
    },
    "sam-done-marcia": () => {
      const at = minutesOf(d.placeholderFrom);
      const ready: PageEvent[] = [...find(sam), ...pick(sam, 1, at), { type: "confirmPressed" }];
      return [...ready, ...placed(sam, false, at, startOf(ready))];
    },
    refusal: () => [
      { type: "leadEdited", value: d.refusalSample, at: nowMs },
      { type: "findPressed", at: nowMs },
    ],
  };
  const make = Object.prototype.hasOwnProperty.call(STATES, frame.state) ? STATES[frame.state] : undefined;
  if (!make) throw new Error(`frame "${frameId}" has no state named ${frame.state}`);
  return { theme: frame.theme, state: run(make()), nowMs, reasons: d.newTime.reasons.map((r) => ({ code: r.code, label: r.label })) };
}
