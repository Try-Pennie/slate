// The judgement behind `pnpm report:pilot-compare` (#2946): across trypennie's 50/50
// split on every tier, does Slate book more applications than cal.com, and do more
// of the booked calls actually happen?
//
// Pure: no `@/` imports, no network, no clock (the instant is passed in). The
// command (scripts/report-pilot-compare.ts) reads Salesforce, Slate, cal.com and
// the Regal call store and hands the rows here; scripts/test-pilot-compare.ts drives
// every outcome with hand written rows.
//
// THE RULES, each decided once here (Dan, 2026-10-01, #2946 and #2945):
//
// 1. The unit is an APPLICATION: a Salesforce `Submission__c`, keyed on the first 15
//    characters of its id, which is exactly what trypennie's `slateBucket` hashes.
//    The Lead (`00Q`) is only how a Regal call is tied back to it.
// 2. INTENTION TO TREAT. Every application is judged on the side its hash assigned
//    it (`slateBucket(id) < 50`), whatever system it then booked on. A second,
//    labelled row reads by the system that took the booking, and leakage (booked on
//    the other side's system) is counted by cause.
// 3. A FIXED SPAN. Applications created in the window are judged on outcomes inside
//    SPAN_DAYS of being made: a booking made inside the span, and a call held at a
//    final start inside it. An application whose span has not closed is not in the
//    cohort yet, so numerator and denominator always cover the same days (L711),
//    except in a partial look (rule 9), which is labelled and never a result.
// 4. MATCHING. A Slate booking carries the application id. A cal.com booking is
//    matched by the id it carries, else by email AND phone to the LATEST application
//    created before it; several prior applications on different Leads is ambiguous,
//    never a pick (L521). Unmatched and ambiguous are counted, and past
//    MAX_UNMATCHED_SHARE the run refuses, because a matching gap that differs by
//    system would read as a rate difference (L478).
// 5. RESCHEDULES are collapsed on both systems: a chain is one booking, made when
//    its first link was made, held or not at its LAST link's start. cal.com marks the
//    old half `cancelled` with `rescheduledToUid` set, so that is not a cancel.
// 6. A SHOW is ONE human Regal call (not the AI agent) with at least 300 s of talk
//    time, starting from 15 minutes before to 60 minutes after the final start
//    (Dan, 2026-10-01 on #2945: never summed across calls). A cancelled booking is
//    not held.
// 7. THE SPLIT IS CHECKED FROM STORED READINGS, and assumed only where none can vouch
//    for it (#3641). Salesforce keeps no history of SlatePilotActive__c,
//    SlatePilotPercent__c or SlatePilotTiers__c, and none will be turned on (Dan,
//    2026-10-01, #2946), so the monitor lane stores a reading every quarter hour with
//    the record's last edit time, and `checkSplitReadings` judges the window from them:
//    a reading off the split is a change with its own exit code, an edit inside the
//    window leaves the span before it unverified (only the last edit is visible), and
//    with no successful reading the run states the old assumption. Every run says which.
//    What Salesforce holds NOW is still read and printed, and a current value that
//    contradicts the assumption has its own exit code too.
// 8. A READOUT DATE fixed once. The first readable run proposes one; it is then
//    recorded in READOUT_DATE below, in git, so later runs cannot move it. A run
//    after the first span closes and before that date is PROVISIONAL (one before the
//    first span closes is PARTIAL, rule 9), and from the date on the cohort stops growing.
// 9. A PARTIAL LOOK before the first full window (#2976, Dan 2026-10-01). Between the
//    window opening and the first application's span closing, a run reports the
//    rates measured so far over applications whose span is still OPEN, so the trend
//    can be watched. Every line is labelled partial, it says how much of the first
//    full window it covers, each rate carries an EARLY interval worded as biased low
//    and not a result (#3073), it prints no verdict, and it exits on its own code. A show is judged only once its call can have happened and
//    reached the store; the booking rate is biased low on both sides, and says so.

import { DateTime } from "luxon";
import { slateBucket, leadKey, compareHalves, daysNeeded, normalCdf, MIN_LEADS_PER_HALF, MIN_OUTCOMES_PER_HALF } from "./pilot-split.ts";
import type { CalcomListedBooking } from "../../src/lib/calcom/upcoming-bookings.ts";
import type { PilotSettings } from "../../src/lib/salesforce/pilot-settings.ts";
import type { PilotSettingsRow } from "../../src/lib/monitor/pilot-settings-samples.ts";
import { reasonOf } from "../../src/lib/monitor/pilot-offers.ts";

export type Side = "slate" | "calcom";

/** Every outcome on its own code (L11). Only `compared` is a readout. */
export const PILOT_COMPARE_EXIT = {
  /** The readout: the fixed date is reached and every half is readable. */
  compared: 0,
  /** Credentials for a source are missing here; nothing was read. */
  notConfigured: 1,
  /**
   * Nothing to judge yet: the window has not opened, or a rehearsal's span has
   * not closed. Once the window opens a real run looks at what is there so far
   * and exits `partial` instead.
   */
  windowNotOpen: 2,
  salesforceUnreadable: 3,
  calcomUnreadable: 4,
  slateUnreadable: 5,
  regalUnreadable: 6,
  /** Not one application in a pilot tier was created in the cohort. */
  noApplications: 7,
  /** One side holds no applications at all. */
  emptyHalf: 8,
  /** Too many cal.com bookings could not be tied to an application. */
  tooManyUnmatched: 9,
  /** The Regal call store holds no call in the span: shows cannot be judged. */
  noCallsStored: 10,
  /** A side is under the minimum sample, so the difference is not yet readable. */
  tooFewToRead: 11,
  /** A comparison before the fixed readout date (or before one is fixed). */
  provisional: 12,
  /** A rehearsal against days outside the window: proves the reads, never a result. */
  rehearsal: 13,
  /** What Salesforce holds NOW contradicts the assumed split. */
  settingsNowDiffer: 14,
  /** An input this command takes could not be read. */
  inputUnreadable: 15,
  /** Rates so far before the first span closes (#2976): a trend to watch, never a result. */
  partial: 16,
  /** A stored reading inside the window saw a split other than the assumed one (#3641). */
  splitChanged: 17,
  /**
   * A booking update (#3698): bookings within 24 hours through yesterday, with no held
   * calls or show rates. A trend to read between readouts, never a result.
   */
  bookingUpdate: 18,
} as const;

const EXIT_LABEL: Record<number, string> = {
  [PILOT_COMPARE_EXIT.notConfigured]: "not-configured",
  [PILOT_COMPARE_EXIT.windowNotOpen]: "window-not-open",
  [PILOT_COMPARE_EXIT.salesforceUnreadable]: "salesforce-unreadable",
  [PILOT_COMPARE_EXIT.calcomUnreadable]: "calcom-unreadable",
  [PILOT_COMPARE_EXIT.slateUnreadable]: "slate-unreadable",
  [PILOT_COMPARE_EXIT.regalUnreadable]: "regal-unreadable",
  [PILOT_COMPARE_EXIT.noApplications]: "no-applications",
  [PILOT_COMPARE_EXIT.emptyHalf]: "empty-half",
  [PILOT_COMPARE_EXIT.tooManyUnmatched]: "too-many-unmatched",
  [PILOT_COMPARE_EXIT.noCallsStored]: "no-calls-stored",
  [PILOT_COMPARE_EXIT.inputUnreadable]: "input-unreadable",
};

// --- the fixed design ----------------------------------------------------------------

/** The zone every boundary is stated in. One conversion, here (L39). */
export const ZONE = "America/New_York";
/** The window opens at midnight Eastern on 2026-10-02, after trypennie #519 deployed. */
export const WINDOW_START_ET = "2026-10-02";
/** Assumed for the whole window and never checked (rule 7). */
export const ASSUMED_PERCENT = 50;
export const ASSUMED_TIERS: readonly string[] = ["1", "2", "3", "4", "5"];
/** Days after an application is made in which its booking and its call must happen. */
export const SPAN_DAYS = 7;
/**
 * How long after a span closes before it is judged: a call starting 60 minutes after
 * a final start, lasting up to an hour, delivered by Regal after it ends. Three hours
 * is generous over that on purpose; a span judged early reads a held call as missing.
 */
export const JUDGE_GRACE_MS = 3 * 3_600_000;
/**
 * The fixed readout date (rule 8), as an Eastern calendar date, or null until the
 * first readable run proposes one. Recording it is a code change on purpose: it is
 * reviewed, and nobody can move it by setting a variable. Fixed on 2026-10-12 from
 * that run's proposal (the window start plus the 22 day show rate estimate), when the
 * booking rate already read Slate higher and held calls could not be told apart.
 */
export const READOUT_DATE: string | null = "2026-10-24";

/** A show: one human call of at least this much talk time... */
export const SHOW_MIN_TALK_S = 300;
/** ...starting no earlier than this before the final start... */
export const SHOW_BEFORE_MS = 15 * 60_000;
/** ...and no later than this after it. */
export const SHOW_AFTER_MS = 60 * 60_000;

/** Past this share of contact matched cal.com bookings unmatched or ambiguous, refuse (#2945 measured 5.8%). */
export const MAX_UNMATCHED_SHARE = 0.1;
/** The smallest absolute rise the days estimate is sized for, unless PILOT_COMPARE_LIFT says otherwise. */
export const DEFAULT_LIFT = 0.02;

/**
 * How long each attempt of the contact read may take (#3695). That read filters
 * `Submission__c` on `Email_SO__c`, which is not a selective filter, so a 50 address
 * batch can run past the 10 s an ordinary Salesforce attempt is given; on 2026-10-13
 * two of four runs refused there, and a retry of the same 10 s attempt fails the same
 * way. A minute is generous for one batch and still ends a hung read.
 */
export const CONTACT_READ_TIMEOUT_MS = 60_000;

/**
 * Read every batch in turn and return all their records, or throw. A failed batch
 * refuses the whole read, never a short one (a short read would report fewer matched
 * bookings as a finding), and the refusal says which batch failed and how many were
 * read before it, so a slow Salesforce reads differently from one that answered
 * nothing (#3695).
 */
export async function readEveryBatch<B, R>(batches: readonly B[], read: (batch: B) => Promise<readonly R[]>): Promise<R[]> {
  const records: R[] = [];
  for (const [i, batch] of batches.entries()) {
    try {
      records.push(...(await read(batch)));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`batch ${i + 1} of ${batches.length} failed (${i} of ${batches.length} batches were read): ${reason}`, { cause: err });
    }
  }
  return records;
}

// --- by where the application came from (#3701) ------------------------------------------

/** The `Source__c` an application made on trypennie.com's own form carries. */
export const FORM_SOURCE = "trypennie.com";

/**
 * When trypennie's offer portal started choosing the booker after the income form
 * created the Submission (trypennie #522, its merge commit's production deploy).
 * Before it the page chose before any Submission existed, so it showed cal.com to
 * partner leads on Slate's side: 125 of the 131 Slate side partner applications that
 * booked on cal.com from Oct 2 to 12 did so before this instant.
 */
export const PORTAL_FIX_MS = Date.parse("2026-10-04T20:03:19Z");

/**
 * Form or partner. Anything that is not the form, a missing source included, counts
 * with partners and other sources, so no application drops out of the cuts.
 */
export function sourceGroup(source: string | null): "form" | "partner" {
  return source === FORM_SOURCE ? "form" : "partner";
}

export interface SourceCut {
  label: string;
  keep: (j: Judged) => boolean;
  /** Days of applications the cut covers, for its days estimate. */
  days: number;
}

/**
 * The by source cuts a window reports. Partner applications are reported both from the
 * window start and from the offer portal fix when the window opens before it (Dan,
 * 2026-10-13, on #3701), so nothing in the design fixed on 2026-10-01 is dropped and
 * the clean days can be read on their own.
 */
export function sourceCuts(window: PilotWindow): SourceCut[] {
  const days = (fromMs: number) => (window.cohortEndMs - fromMs) / 86_400_000;
  const cuts: SourceCut[] = [
    { label: "trypennie.com form applications", keep: (j) => sourceGroup(j.source) === "form", days: days(window.startMs) },
    {
      label: `Partner and other applications, from ${etLabel(window.startMs)}`,
      keep: (j) => sourceGroup(j.source) === "partner",
      days: days(window.startMs),
    },
  ];
  if (window.startMs < PORTAL_FIX_MS && window.cohortEndMs > PORTAL_FIX_MS) {
    cuts.push({
      label: `Partner and other applications, from the offer portal fix at ${etLabel(PORTAL_FIX_MS)}`,
      keep: (j) => sourceGroup(j.source) === "partner" && j.createdMs >= PORTAL_FIX_MS,
      days: days(PORTAL_FIX_MS),
    });
  }
  return cuts;
}

/**
 * The cal.com event types a lead books an advisor call on: every "Senior Loan
 * Advisor Call" type on the team, plus the 1:1 review, read from
 * `/organizations/19474/teams/19546/event-types` on 2026-10-01. The pennie
 * second call type (2204740), Client Sync (an advisor's own link, the twin of Slate's named bookings) and the test and
 * demo types are not a lead booking, and are counted as left out by id.
 */
export const CALCOM_LEAD_EVENT_TYPES: Readonly<Record<number, string>> = {
  1314152: "review",
  1835761: "connect",
  3234190: "call",
  4855566: "terms",
  3348067: "income",
  1367988: "apply",
  1413856: "meet",
};

// --- inputs ----------------------------------------------------------------------------

/** One `Submission__c`. Email and phone are held in memory only and never printed. */
export interface Application {
  id: string;
  createdAt: string;
  /** `XBC_SO__c`, three digits; the first is the tier. */
  xbc: string | null;
  /** `Lead__c`, the `00Q` the Regal call store is keyed on. */
  leadId: string | null;
  email: string | null;
  /** Last ten digits of `Mobile_Number_SO__c`. */
  phone10: string | null;
  /** `Source__c`: `trypennie.com` for the form, a partner's name otherwise (#3701). */
  source: string | null;
}

/** One real, routed Slate booking. Slate reschedules in place, so a row is a whole chain. */
export interface SlateBookingRow {
  id: string;
  submissionId: string | null;
  /**
   * Made through a landing page's inline card (#3718), which always offers Slate:
   * its stored link carried `layout=inline`. The application it ties to is not part
   * of the split and leaves the cohort, on both sides.
   */
  inlineCard: boolean;
  /**
   * Made from a development host on a real bucket (#2974): a host page recorded that
   * is not the production site, judged by `isTestSourceBooking` when the report reads
   * it. Test traffic, so the BOOKING leaves the count, and the readout says how many.
   */
  testSource: boolean;
  createdAt: string;
  startsAt: string;
  status: string;
  agentEmail: string | null;
  source: string | null;
}

export interface RegalCall {
  leadKey: string;
  startedAt: string;
  talkTimeS: number;
  isAiAgent: boolean;
}

/** `WebsiteConfiguration__c` as Salesforce holds it now, read by src/lib/salesforce/pilot-settings.ts. */
export type { PilotSettings };

export type Read<T> = { ok: true; value: T } | { ok: false; message: string };

// --- the window ------------------------------------------------------------------------

export interface PilotWindow {
  startMs: number;
  spanMs: number;
  /** Applications created before this instant are in the cohort. */
  cohortEndMs: number;
  /** Bookings and calls are read up to here. */
  readEndMs: number;
  rehearsal: boolean;
  /** No span has closed yet: every application so far is shown with its span open (rule 9). */
  partial: boolean;
  readout: { date: string | null; reached: boolean };
  lift: number;
  /**
   * A booking update (#3698), or null for every other run. `referenceEndMs` closes the
   * newest cohort whose full span has passed, which the 24 hour window is measured
   * against, or is null before any has.
   */
  update: { referenceEndMs: number | null } | null;
}

/** Midnight Eastern on an ISO calendar date, as epoch ms: the one ET to UTC conversion. */
export function etMidnightMs(isoDate: string): number | null {
  const d = DateTime.fromISO(isoDate, { zone: ZONE }).startOf("day");
  return d.isValid ? d.toMillis() : null;
}

/** The Eastern midnight at or before an instant. */
export function etDayFloorMs(ms: number): number {
  return DateTime.fromMillis(ms, { zone: ZONE }).startOf("day").toMillis();
}

/** An instant as an Eastern date and time, for the report. */
export function etLabel(ms: number): string {
  return DateTime.fromMillis(ms, { zone: ZONE }).toFormat("yyyy-LL-dd HH:mm 'ET'");
}

const ASSUMPTION_LINE =
  `ASSUMED, NOT CHECKED: the split held at ${ASSUMED_PERCENT}% Slate on tiers ${ASSUMED_TIERS.join(";")} for the whole window. ` +
  "Salesforce keeps no history of SlatePilotActive__c, SlatePilotPercent__c or SlatePilotTiers__c, so a change inside the " +
  "window cannot be seen by this report (Dan, 2026-10-01, #2946).";

export type WindowPlan = { ok: true; window: PilotWindow } | { ok: false; exit: number; lines: string[] };

/**
 * Where the cohort ends now. Applications count once their whole span plus the
 * grace has passed, on whole Eastern days so every run covers whole days, and never
 * past a fixed readout date.
 *
 * A REHEARSAL (PILOT_COMPARE_REHEARSAL_START, an Eastern date, with
 * PILOT_COMPARE_REHEARSAL_SPAN_HOURS) runs the same reads over earlier days to
 * prove them before the window has a closed span. It is labelled on every line that
 * matters and exits on its own code: its days were not a 50/50 split on every tier.
 */
/** The span a booking update counts a booking inside (#3698). */
export const UPDATE_SPAN_MS = 24 * 3_600_000;

/**
 * A booking update (#3698): every application whose 24 hours and grace have passed,
 * judged on bookings made in those 24 hours. Not floored to whole days, so it runs
 * through yesterday. Before any application's 24 hours have passed it refuses, never a
 * partial look: an update that showed rates so far would be one more way to read a
 * trend as a result.
 */
function planBookingUpdate(nowMs: number, lift: number, refuse: (exit: number, message: string) => WindowPlan): WindowPlan {
  const startMs = etMidnightMs(WINDOW_START_ET) as number;
  const cohortEndMs = nowMs - UPDATE_SPAN_MS - JUDGE_GRACE_MS;
  if (cohortEndMs <= startMs) {
    return refuse(
      PILOT_COMPARE_EXIT.windowNotOpen,
      `no application made since ${etLabel(startMs)} has had its 24 hours close yet, so there is no booking to count. The first is countable from ${etLabel(startMs + UPDATE_SPAN_MS + JUDGE_GRACE_MS)}.`,
    );
  }
  const closed = etDayFloorMs(nowMs - SPAN_DAYS * 86_400_000 - JUDGE_GRACE_MS);
  return {
    ok: true,
    window: {
      startMs,
      spanMs: UPDATE_SPAN_MS,
      cohortEndMs,
      readEndMs: nowMs,
      rehearsal: false,
      partial: false,
      readout: { date: null, reached: false },
      lift,
      update: { referenceEndMs: closed > startMs ? closed : null },
    },
  };
}

/**
 * How many of each side's bookings came within `withinMs` of the application, out of
 * every booking in its span: what a booking update's 24 hour window misses, measured on
 * a cohort whose full span has closed (#3698).
 */
export function bookingWindowCatch(m: Matched, withinMs: number): Record<Side, { within: number; booked: number }> {
  const out: Record<Side, { within: number; booked: number }> = { slate: { within: 0, booked: 0 }, calcom: { within: 0, booked: 0 } };
  for (const a of m.apps) {
    if (a.chains.length === 0) continue;
    out[a.side].booked++;
    if (a.chains.some((c) => c.createdMs < a.createdMs + withinMs)) out[a.side].within++;
  }
  return out;
}

export function planWindow(nowMs: number, env: Record<string, string | undefined>, readoutDate: string | null = READOUT_DATE): WindowPlan {
  const refuse = (exit: number, message: string): WindowPlan => ({
    ok: false,
    exit,
    lines: [`FAILED (${EXIT_LABEL[exit]}): ${message}`, ASSUMPTION_LINE, "Compared: nothing; no application was judged."],
  });
  const liftRaw = (env.PILOT_COMPARE_LIFT ?? "").trim();
  const lift = liftRaw === "" ? DEFAULT_LIFT : Number(liftRaw);
  if (!Number.isFinite(lift) || lift <= 0 || lift >= 1) {
    return refuse(PILOT_COMPARE_EXIT.inputUnreadable, `PILOT_COMPARE_LIFT="${liftRaw}" is not a fraction above 0 and below 1 (0.02 for two points).`);
  }
  const updateRaw = (env.PILOT_COMPARE_BOOKING_UPDATE ?? "").trim();
  if (updateRaw !== "" && updateRaw !== "1") {
    return refuse(PILOT_COMPARE_EXIT.inputUnreadable, `PILOT_COMPARE_BOOKING_UPDATE="${updateRaw}" is not 1; set it to 1 for a booking update, or leave it unset.`);
  }
  const rehearsalStart = (env.PILOT_COMPARE_REHEARSAL_START ?? "").trim();
  if (updateRaw === "1") {
    if (rehearsalStart !== "") {
      return refuse(PILOT_COMPARE_EXIT.inputUnreadable, "PILOT_COMPARE_BOOKING_UPDATE and PILOT_COMPARE_REHEARSAL_START cannot be combined: an update reads the real window.");
    }
    return planBookingUpdate(nowMs, lift, refuse);
  }
  let startMs: number;
  let spanMs = SPAN_DAYS * 86_400_000;
  if (rehearsalStart !== "") {
    const s = /^\d{4}-\d{2}-\d{2}$/.test(rehearsalStart) ? etMidnightMs(rehearsalStart) : null;
    if (s === null) return refuse(PILOT_COMPARE_EXIT.inputUnreadable, `PILOT_COMPARE_REHEARSAL_START="${rehearsalStart}" is not a date (YYYY-MM-DD, Eastern).`);
    const hoursRaw = (env.PILOT_COMPARE_REHEARSAL_SPAN_HOURS ?? "").trim();
    const hours = hoursRaw === "" ? SPAN_DAYS * 24 : Number(hoursRaw);
    if (!Number.isFinite(hours) || hours <= 0) {
      return refuse(PILOT_COMPARE_EXIT.inputUnreadable, `PILOT_COMPARE_REHEARSAL_SPAN_HOURS="${hoursRaw}" is not a number of hours above 0.`);
    }
    startMs = s;
    spanMs = hours * 3_600_000;
  } else {
    startMs = etMidnightMs(WINDOW_START_ET) as number;
  }
  const rehearsal = rehearsalStart !== "";
  // Whole days for a real run; a rehearsal's span may be hours, so it is not floored.
  const closed = nowMs - spanMs - JUDGE_GRACE_MS;
  let cohortEndMs = rehearsal ? closed : etDayFloorMs(closed);
  const readoutMs = !rehearsal && readoutDate !== null ? etMidnightMs(readoutDate) : null;
  if (!rehearsal && readoutDate !== null && readoutMs === null) {
    return refuse(PILOT_COMPARE_EXIT.inputUnreadable, `READOUT_DATE "${readoutDate}" in scripts/lib/pilot-compare.ts is not a date.`);
  }
  const reached = readoutMs !== null && cohortEndMs >= readoutMs;
  if (readoutMs !== null && cohortEndMs > readoutMs) cohortEndMs = readoutMs;
  // Rule 9: the window has opened but no span has closed, so look at what is there so far.
  if (cohortEndMs <= startMs && !rehearsal && nowMs > startMs) {
    return { ok: true, window: { startMs, spanMs, cohortEndMs: nowMs, readEndMs: nowMs, rehearsal, partial: true, readout: { date: null, reached: false }, lift, update: null } };
  }
  if (cohortEndMs <= startMs) {
    const firstMs = firstJudgeableMs(startMs, spanMs);
    const why = rehearsal
      ? `no application made since ${etLabel(startMs)} has had its ${spanLabel(spanMs)} span close yet, so nothing can be judged.`
      : `the window opens at ${etLabel(startMs)}, so no application has been made in it yet.`;
    return refuse(PILOT_COMPARE_EXIT.windowNotOpen, `${why} The first whole day is judgeable from ${etLabel(firstMs)}.`);
  }
  return { ok: true, window: { startMs, spanMs, cohortEndMs, readEndMs: nowMs, rehearsal, partial: false, readout: { date: rehearsal ? null : readoutDate, reached }, lift, update: null } };
}

/** When the first whole Eastern day of applications can be judged. */
function firstJudgeableMs(startMs: number, spanMs: number): number {
  return startMs + 86_400_000 + spanMs + JUDGE_GRACE_MS;
}

function spanLabel(spanMs: number): string {
  const hours = spanMs / 3_600_000;
  return hours % 24 === 0 ? `${hours / 24} day` : `${hours} hour`;
}

/** A refusal once reading has begun, still saying what was assumed and what was compared. */
export function refusal(exit: number, message: string, compared = "nothing; no application was judged."): { exit: number; lines: string[] } {
  return { exit, lines: [`FAILED (${EXIT_LABEL[exit] ?? "failed"}): ${message}`, ASSUMPTION_LINE, `Compared: ${compared}`] };
}

// --- matching ---------------------------------------------------------------------------

export interface Chain {
  system: Side;
  createdMs: number;
  /** Null when the final link of a reschedule could not be read. */
  finalStartMs: number | null;
  cancelled: boolean;
  advisor: string | null;
  submissionKey: string | null;
  email: string | null;
  phone10: string | null;
  /** How leakage is explained: the Slate page (`source`), or the cal.com event type. */
  label: string;
}

export interface ChainSet {
  chains: Chain[];
  /** cal.com bookings rescheduled from a booking made before the window. */
  beganBeforeWindow: number;
  /** cal.com reschedules whose new booking could not be read. */
  unresolved: number;
  /** cal.com bookings on an event type that is not a lead booking, by id. */
  otherEventTypes: Record<string, number>;
}

/**
 * Collapse cal.com's rows into chains (rule 5). The rows are every booking MADE since
 * the window opened, so the first link of a chain made inside the window is present;
 * a row rescheduled from a uid that is not present began before the window.
 */
export function calcomChains(rows: readonly CalcomListedBooking[]): ChainSet {
  const byUid = new Map(rows.map((r) => [r.uid, r]));
  const out: ChainSet = { chains: [], beganBeforeWindow: 0, unresolved: 0, otherEventTypes: {} };
  for (const root of rows) {
    if (root.rescheduledFromUid !== null) {
      if (!byUid.has(root.rescheduledFromUid)) out.beganBeforeWindow++;
      continue;
    }
    const slug = root.eventTypeId === null ? undefined : CALCOM_LEAD_EVENT_TYPES[root.eventTypeId];
    if (slug === undefined) {
      const k = String(root.eventTypeId ?? "none");
      out.otherEventTypes[k] = (out.otherEventTypes[k] ?? 0) + 1;
      continue;
    }
    let last = root;
    let resolved = true;
    const seen = new Set([root.uid]);
    while (last.rescheduledToUid !== null) {
      const next = byUid.get(last.rescheduledToUid);
      if (next === undefined || seen.has(next.uid)) {
        resolved = false;
        break;
      }
      seen.add(next.uid);
      last = next;
    }
    if (!resolved) out.unresolved++;
    const sub = [last, root].map((r) => r.submissionId).find((s) => s !== null) ?? null;
    const status = last.status.toLowerCase();
    out.chains.push({
      system: "calcom",
      createdMs: Date.parse(root.createdAt),
      finalStartMs: resolved ? Date.parse(last.start) : null,
      cancelled: resolved && (status === "cancelled" || status === "rejected"),
      advisor: last.hostEmail,
      submissionKey: sub === null ? null : leadKey(sub),
      email: root.attendeeEmails[0] ?? null,
      phone10: root.attendeePhone10,
      label: `cal.com ${slug}`,
    });
  }
  return out;
}

/** Slate's rows as chains: Slate reschedules in place, so each row is already one. */
export function slateChains(rows: readonly SlateBookingRow[]): Chain[] {
  return rows.map((r) => ({
    system: "slate" as const,
    createdMs: Date.parse(r.createdAt),
    finalStartMs: Date.parse(r.startsAt),
    cancelled: r.status === "cancelled",
    advisor: r.agentEmail === null ? null : r.agentEmail.trim().toLowerCase(),
    submissionKey: r.submissionId === null ? null : leadKey(r.submissionId),
    email: null,
    phone10: null,
    label: `Slate ${r.source ?? "no source"}`,
  }));
}

export interface AppOutcome {
  key: string;
  tier: string;
  side: Side;
  createdMs: number;
  leadKey: string | null;
  /** Where the application came from (#3701). */
  source: string | null;
  /** Chains made inside the application's span. */
  chains: Chain[];
}

export interface Matched {
  apps: AppOutcome[];
  /** Applications in the cohort outside the pilot tiers, or with no readable tier. */
  outsideTiers: number;
  noTier: number;
  counts: {
    slateBookings: number;
    slateWithoutId: number;
    calcomChains: number;
    byId: number;
    byContact: number;
    /** Contact matched cal.com chains needing a match: the refusal's denominator. */
    needingContact: number;
    unmatched: number;
    ambiguous: number;
    /** Tied to an application outside the cohort (made before the window, too recent, or another tier). */
    outsideCohort: number;
    /** Made after the application's span closed. */
    afterSpan: number;
    /** Applications left out because they booked through the inline card (#3718). */
    inlineCardApps: number;
    /** Slate bookings left out as test traffic from a development host (#2974). */
    testSourceBookings: number;
    beganBeforeWindow: number;
    unresolved: number;
    otherEventTypes: Record<string, number>;
    /** Applications and bookings carrying an instant that does not parse: the run refuses on any. */
    unreadable: number;
  };
}

/** Normalise an address for matching; held in memory only. */
const emailKey = (e: string | null): string | null => (e === null || e.trim() === "" ? null : e.trim().toLowerCase());

/**
 * Tie every booking to an application and judge which applications are in the
 * cohort. `contactApplications` is every application Salesforce holds for the
 * addresses of cal.com bookings that carry no id, at any date: matching only within
 * the cohort would report a booking by an older application as unmatched.
 */
export function matchBookings(input: {
  window: PilotWindow;
  applications: readonly Application[];
  contactApplications: readonly Application[];
  slate: readonly SlateBookingRow[];
  calcom: readonly CalcomListedBooking[];
}): Matched {
  const { window } = input;
  const cohort = new Map<string, AppOutcome>();
  let outsideTiers = 0;
  let noTier = 0;
  let unreadable = 0;
  for (const a of input.applications) {
    const created = Date.parse(a.createdAt);
    // A NaN compares false against both bounds and would leave the cohort in silence (L50).
    if (!Number.isFinite(created)) {
      unreadable++;
      continue;
    }
    if (!(created >= window.startMs && created < window.cohortEndMs)) continue;
    const tier = a.xbc !== null && /^\d/.test(a.xbc.trim()) ? a.xbc.trim()[0] : null;
    if (tier === null) {
      noTier++;
      continue;
    }
    if (!ASSUMED_TIERS.includes(tier)) {
      outsideTiers++;
      continue;
    }
    const key = leadKey(a.id);
    cohort.set(key, {
      key,
      tier,
      side: slateBucket(key) < ASSUMED_PERCENT ? "slate" : "calcom",
      createdMs: created,
      leadKey: a.leadId === null ? null : leadKey(a.leadId),
      source: a.source,
      chains: [],
    });
  }

  // Every application known for contact matching, newest last per person.
  const byContact = new Map<string, { key: string; createdMs: number; lead: string }[]>();
  const seen = new Set<string>();
  for (const a of [...input.applications, ...input.contactApplications]) {
    const key = leadKey(a.id);
    if (seen.has(key)) continue;
    seen.add(key);
    // An application read only by email is matched on its creation time too, so an
    // unreadable one refuses like any other (L50). One in the cohort list was already
    // counted above, and `seen` keeps it from being counted twice.
    if (!Number.isFinite(Date.parse(a.createdAt))) {
      if (!input.applications.includes(a)) unreadable++;
      continue;
    }
    const e = emailKey(a.email);
    if (e === null || a.phone10 === null) continue;
    const k = `${e}|${a.phone10}`;
    const list = byContact.get(k) ?? [];
    list.push({ key, createdMs: Date.parse(a.createdAt), lead: a.leadId === null ? `app:${key}` : leadKey(a.leadId) });
    byContact.set(k, list);
  }

  const cal = calcomChains(input.calcom);
  const counts: Matched["counts"] = {
    slateBookings: input.slate.length,
    testSourceBookings: 0,
    slateWithoutId: 0,
    calcomChains: cal.chains.length,
    byId: 0,
    byContact: 0,
    needingContact: 0,
    unmatched: 0,
    ambiguous: 0,
    outsideCohort: 0,
    afterSpan: 0,
    inlineCardApps: 0,
    beganBeforeWindow: cal.beganBeforeWindow,
    unresolved: cal.unresolved,
    otherEventTypes: cal.otherEventTypes,
    unreadable,
  };

  // #2974: test traffic from a development host is no lead's booking, so it leaves
  // FIRST, before anything else reads the Slate bookings (the inline card exclusion
  // included). Only the booking leaves: a developer booking under a real application's
  // id says nothing about whether that application booked, so the application is
  // judged on its other bookings.
  const leadSlate = input.slate.filter((r) => !r.testSource);
  counts.testSourceBookings = input.slate.length - leadSlate.length;

  // #3718: an application that booked through a landing page's inline card always got
  // Slate, so it is not part of the split. The WHOLE application leaves, on whichever
  // side its hash put it, before any booking is tied to it: dropping only its Slate
  // booking would leave a cal.com side application reading as one that never booked.
  // Only an application that WAS in the cohort leaves it; one never in it (made before
  // the window, too recently, or in another tier) keeps its bookings counted as
  // outside the cohort, like any other.
  const viaInlineCard = new Set(
    leadSlate
      .filter((r) => r.inlineCard && r.submissionId !== null)
      .map((r) => leadKey(r.submissionId as string))
      .filter((key) => cohort.delete(key)),
  );
  counts.inlineCardApps = viaInlineCard.size;

  const attach = (chain: Chain, key: string) => {
    // A booking by an application left out above is neither attached nor counted
    // as outside the cohort: its absence is already said once, as that application.
    if (viaInlineCard.has(key)) return;
    const app = cohort.get(key);
    if (app === undefined) {
      counts.outsideCohort++;
      return;
    }
    if (chain.createdMs >= app.createdMs + window.spanMs) {
      counts.afterSpan++;
      return;
    }
    app.chains.push(chain);
  };

  for (const chain of [...slateChains(leadSlate), ...cal.chains]) {
    if (!Number.isFinite(chain.createdMs) || (chain.finalStartMs !== null && !Number.isFinite(chain.finalStartMs))) {
      counts.unreadable++;
      continue;
    }
    if (chain.submissionKey !== null) {
      counts.byId++;
      attach(chain, chain.submissionKey);
      continue;
    }
    if (chain.system === "slate") {
      counts.slateWithoutId++;
      continue;
    }
    counts.needingContact++;
    const e = emailKey(chain.email);
    const prior =
      e === null || chain.phone10 === null
        ? []
        : (byContact.get(`${e}|${chain.phone10}`) ?? []).filter((c) => c.createdMs <= chain.createdMs);
    if (prior.length === 0) {
      counts.unmatched++;
      continue;
    }
    if (new Set(prior.map((c) => c.lead)).size > 1) {
      counts.ambiguous++;
      continue;
    }
    counts.byContact++;
    const latest = prior.reduce((a, b) => (b.createdMs > a.createdMs ? b : a));
    attach(chain, latest.key);
  }
  return { apps: [...cohort.values()], outsideTiers, noTier, counts };
}

/** The Lead keys whose calls decide a show: every booked application's. */
export function leadKeysToRead(m: Matched): string[] {
  return [...new Set(m.apps.filter((a) => a.chains.length > 0 && a.leadKey !== null).map((a) => a.leadKey as string))].sort();
}

// --- judging one application -------------------------------------------------------------

export interface Judged {
  key: string;
  tier: string;
  /** Where the application came from, and when, for the by source cuts (#3701). */
  source: string | null;
  createdMs: number;
  side: Side;
  booked: boolean;
  /** The system of its first booking, or null when it booked nothing. */
  system: Side | null;
  bothSystems: boolean;
  /** At least one booking's final start fell inside the span, so a show can be judged. */
  judgeable: boolean;
  /** A partial look only: a booking inside the span whose call can still happen and
   *  reach the store, so it is set aside rather than read as not held. */
  callAhead: boolean;
  held: boolean;
  noLead: boolean;
  advisor: string;
  firstChain: Chain | null;
}

/**
 * `dueByMs` is how far calls can be trusted to have arrived: a booking whose show window
 * closes after it is not judged. A full run's spans closed long before now, so it
 * passes nothing; a partial run passes now less the grace, so a call still ahead is
 * left out rather than read as a no show.
 */
export function judgeApplication(app: AppOutcome, spanMs: number, callsByLead: ReadonlyMap<string, readonly RegalCall[]>, dueByMs = Infinity): Judged {
  const chains = [...app.chains].sort((a, b) => a.createdMs - b.createdMs);
  const spanEnd = app.createdMs + spanMs;
  const judgeableChains = chains.filter((c) => c.finalStartMs !== null && c.finalStartMs < spanEnd && c.finalStartMs + SHOW_AFTER_MS <= dueByMs);
  const calls = app.leadKey === null ? [] : (callsByLead.get(app.leadKey) ?? []);
  const isShow = (c: Chain) =>
    !c.cancelled &&
    c.finalStartMs !== null &&
    calls.some((call) => {
      const t = Date.parse(call.startedAt);
      return !call.isAiAgent && call.talkTimeS >= SHOW_MIN_TALK_S && t >= (c.finalStartMs as number) - SHOW_BEFORE_MS && t <= (c.finalStartMs as number) + SHOW_AFTER_MS;
    });
  const heldChain = app.leadKey === null ? undefined : judgeableChains.find(isShow);
  const clusterChain = heldChain ?? judgeableChains[judgeableChains.length - 1] ?? chains[chains.length - 1];
  return {
    key: app.key,
    tier: app.tier,
    source: app.source,
    createdMs: app.createdMs,
    side: app.side,
    booked: chains.length > 0,
    system: chains[0]?.system ?? null,
    bothSystems: new Set(chains.map((c) => c.system)).size > 1,
    judgeable: judgeableChains.length > 0 && app.leadKey !== null,
    callAhead:
      heldChain === undefined &&
      app.leadKey !== null &&
      chains.some((c) => !c.cancelled && c.finalStartMs !== null && c.finalStartMs < spanEnd && c.finalStartMs + SHOW_AFTER_MS > dueByMs),
    held: heldChain !== undefined,
    noLead: chains.length > 0 && app.leadKey === null,
    // An application with no named advisor is its own cluster, never pooled into one
    // giant "unknown" advisor that would swamp the variance.
    advisor: clusterChain?.advisor ?? `unknown:${app.key}`,
    firstChain: chains[0] ?? null,
  };
}

// --- statistics ---------------------------------------------------------------------------

const Z_95 = 1.959963984540054;

export interface ClusteredComparison {
  slate: { units: number; outcomes: number; rate: number };
  calcom: { units: number; outcomes: number; rate: number };
  clusters: number;
  difference: number | null;
  low: number | null;
  high: number | null;
  p: number | null;
}

/**
 * Slate minus cal.com in a rate whose units share a CLUSTER (the advisor), with a
 * cluster robust interval. One advisor's calls rise and fall together, so treating
 * them as independent would claim more certainty than the data holds. The variance
 * of the difference is G/(G-1) times the sum over clusters of the squared summed
 * linearised residuals, (y - p) / n signed by side; an advisor who serves both
 * systems is ONE cluster, so the covariance that creates is counted, not ignored.
 */
export function clusteredDifference(units: readonly { side: Side; cluster: string; y: boolean }[]): ClusteredComparison {
  const half = (side: Side) => {
    const u = units.filter((x) => x.side === side);
    const outcomes = u.filter((x) => x.y).length;
    return { units: u.length, outcomes, rate: u.length > 0 ? outcomes / u.length : 0 };
  };
  const s = half("slate");
  const c = half("calcom");
  const clusterSums = new Map<string, number>();
  for (const x of units) {
    const h = x.side === "slate" ? s : c;
    const e = ((x.y ? 1 : 0) - h.rate) / h.units;
    clusterSums.set(x.cluster, (clusterSums.get(x.cluster) ?? 0) + (x.side === "slate" ? e : -e));
  }
  const g = clusterSums.size;
  const base = { slate: s, calcom: c, clusters: g };
  if (s.units === 0 || c.units === 0) return { ...base, difference: null, low: null, high: null, p: null };
  const diff = s.rate - c.rate;
  if (g < 2) return { ...base, difference: diff, low: null, high: null, p: null };
  let sum = 0;
  for (const v of clusterSums.values()) sum += v * v;
  const se = Math.sqrt((g / (g - 1)) * sum);
  if (!(se > 0)) return { ...base, difference: diff, low: null, high: null, p: null };
  return { ...base, difference: diff, low: diff - Z_95 * se, high: diff + Z_95 * se, p: Math.min(1, 2 * (1 - normalCdf(Math.abs(diff / se)))) };
}

// --- the report ------------------------------------------------------------------------------

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const points = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)} points`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const TIER_LABEL: Record<string, string> = { "1": "Low", "2": "Medium", "3": "High", "4": "Very High", "5": "Ultra High" };

function short(units: number, outcomes: number): boolean {
  return units < MIN_LEADS_PER_HALF || outcomes < MIN_OUTCOMES_PER_HALF || units - outcomes < MIN_OUTCOMES_PER_HALF;
}

function intervalText(d: { difference: number | null; low: number | null; high: number | null; p: number | null }): string {
  if (d.difference === null) return "no difference: a side is empty";
  if (d.low === null || d.high === null || d.p === null) return `${points(d.difference)}, no interval (no spread to estimate one from)`;
  const verdict = d.low > 0 ? "Slate higher" : d.high < 0 ? "Slate lower" : "cannot be told apart";
  const p = d.p < 0.001 ? "p below 0.001" : `p = ${d.p.toFixed(3)}`;
  return `${points(d.difference)}, 95% interval ${points(d.low)} to ${points(d.high)}, ${p}: ${verdict}`;
}

/**
 * The partial look's interval (#3073, Dan 2026-10-03): the same estimate, worded so it
 * can never be read as the result. Every application here has had less than its span
 * to book, so the booking rate and held per application are biased low on both sides,
 * and a show rate is early; each line says which beside the numbers. It carries no verdict: "Slate higher" is a
 * finding, and a partial look must not make one.
 */
function partialIntervalText(
  readable: boolean,
  d: { difference: number | null; low: number | null; high: number | null },
  // Only a rate whose numerator can still grow for applications already counted is
  // biased low: the booking rate and held per application. A show rate leaves calls
  // still ahead out of both sides of its fraction, so it is early but not low.
  caveat: "biased low, not a result" | "early, not a result",
): string {
  if (!readable) return "so far; too few to estimate an early interval";
  if (d.difference === null) return "so far; no early interval: a side is empty";
  if (d.low === null || d.high === null) return "so far; no early interval (no spread to estimate one from)";
  return `so far; early 95% interval ${points(d.low)} to ${points(d.high)} around ${points(d.difference)} (${caveat})`;
}

export interface CallsRead {
  calls: RegalCall[];
  /** Every call the store received over the span read, for anyone: zero means the store is not filling. */
  storedInSpan: number;
  /**
   * The earliest call the store holds at all, or null when it holds none. A booking
   * whose show window closed before this cannot be judged: the store did not exist
   * yet, and a count over the span cannot see that (it was measured healthy in the
   * first rehearsal while every show in it read as missing). A gap in the MIDDLE of
   * the window is the #2944 monitor's job, which pages under 80% written.
   */
  storeBeganMs: number | null;
}

export interface CompareInput {
  window: PilotWindow;
  settings: PilotSettings;
  /** The quarter hourly readings of the split stored over the window (#3641). */
  readings: readonly PilotSettingsRow[];
  matched: Matched;
  calls: CallsRead;
  /** A booking update only (#3698): the newest closed cohort, matched over its full span, or null before one has closed. */
  reference?: Matched | null;
}

/** Settings now, against the assumption: null when they agree. */
export function settingsDisagreement(s: PilotSettings): string | null {
  const tiers = (s.tiers ?? "")
    .split(/[;,\s]+/)
    .filter((t) => t !== "")
    .sort()
    .join(";");
  const problems: string[] = [];
  if (s.active !== true) problems.push(`SlatePilotActive__c is ${String(s.active)}`);
  if (s.percent !== ASSUMED_PERCENT) problems.push(`SlatePilotPercent__c is ${String(s.percent)}`);
  if (tiers !== [...ASSUMED_TIERS].sort().join(";")) problems.push(`SlatePilotTiers__c is ${s.tiers === null ? "empty" : `"${s.tiers}"`}`);
  return problems.length === 0 ? null : problems.join(", ");
}

/** The most edits named one by one; the rest are counted. */
const MAX_EDITS_LISTED = 10;

export interface SplitCheck {
  /** unchecked: no successful reading; checked: every reading agreed; changed: one did not. */
  status: "unchecked" | "checked" | "changed";
  lines: string[];
  /** Readings carrying a time that could not be read, refused like any other (L50). */
  unreadable: number;
}

/**
 * What the stored readings of the split say about the window (#3641, replacing rule 7's
 * assumption wherever there are readings). Salesforce keeps no history of the split, but
 * every reading carries the record's last edit time, and a record not edited since the
 * previous reading cannot have changed in between, however long the gap. So:
 *
 * - a reading off the assumed split is a CHANGE, named with the readings that saw it;
 * - an edit inside the window with the split the same on both sides is not a change,
 *   but a change UNDONE before that edit cannot be ruled out (only the last edit is
 *   visible), so the span from the reading before it, or the window's opening, to the
 *   edit is named as unverified;
 * - a span with no edit in it is checked, however few readings it had;
 * - after the last reading the split is assumed, and says so.
 *
 * Readings are deduplicated by when Salesforce was read, since two samples served from
 * one cached read are one look. A failed reading is counted and never read as a split.
 */
export function checkSplitReadings(rows: readonly PilotSettingsRow[], fromMs: number, toMs: number): SplitCheck {
  let unreadable = 0;
  let failed = 0;
  const byRead = new Map<number, { readMs: number; modifiedMs: number; disagree: string | null }>();
  for (const r of rows) {
    // parse-ok: every stamp here is judged by Number.isFinite before use.
    const sampledMs = Date.parse(r.sampled_at);
    if (!Number.isFinite(sampledMs)) {
      unreadable++;
      continue;
    }
    if (!r.ok) {
      failed++;
      continue;
    }
    const readMs = Date.parse(r.read_at ?? "");
    const modifiedMs = Date.parse(r.record_modified_at ?? "");
    if (!Number.isFinite(readMs) || !Number.isFinite(modifiedMs)) {
      unreadable++;
      continue;
    }
    byRead.set(readMs, {
      readMs,
      modifiedMs,
      disagree: settingsDisagreement({ active: r.active, percent: r.percent === null ? null : Number(r.percent), tiers: r.tiers, lastModified: null }),
    });
  }
  const readings = [...byRead.values()].sort((a, b) => a.readMs - b.readMs);
  const failedLine =
    failed > 0
      ? `${plural(failed, "reading")} failed to read Salesforce and ${failed === 1 ? "is" : "are"} left out; the edit times of the readings either side still cover the span between them.`
      : null;
  if (readings.length === 0) {
    return {
      status: "unchecked",
      lines: [ASSUMPTION_LINE, ...(failed > 0 ? [`Every one of the ${plural(failed, "reading")} of Salesforce stored over the window failed, so none could check it.`] : [])],
      unreadable,
    };
  }

  const split = `${ASSUMED_PERCENT}% Slate on tiers ${ASSUMED_TIERS.join(";")}`;
  const firstMs = readings[0]!.readMs;
  const lastMs = readings[readings.length - 1]!.readMs;
  const lines: string[] = [];

  // Changes: runs of consecutive readings that disagree the same way.
  const changes: { fromMs: number; toMs: number; what: string }[] = [];
  for (const r of readings) {
    const run = changes[changes.length - 1];
    if (r.disagree === null) continue;
    const prev = readings[readings.indexOf(r) - 1];
    if (run && prev && prev.disagree === r.disagree && run.toMs === prev.readMs) run.toMs = r.readMs;
    else changes.push({ fromMs: r.readMs, toMs: r.readMs, what: r.disagree });
  }
  for (const c of changes) {
    lines.push(
      `THE SPLIT CHANGED inside the window: Salesforce read ${c.what} ` +
        (c.fromMs === c.toMs ? `at ${etLabel(c.fromMs)}` : `in the readings from ${etLabel(c.fromMs)} to ${etLabel(c.toMs)}`) +
        `, not the assumed ${split}, so the comparison above mixes leads split two ways.`,
    );
  }

  // Edits with the split the same on both sides: a change undone before them cannot be
  // ruled out, from the reading before (or the window's opening) to the edit.
  const edits: { afterMs: number; editMs: number }[] = [];
  readings.forEach((r, i) => {
    const prev = i === 0 ? null : readings[i - 1]!;
    const afterMs = prev === null ? fromMs : prev.readMs;
    const editedInside = prev === null ? r.modifiedMs >= fromMs : r.modifiedMs > prev.readMs;
    if (!editedInside || r.disagree !== null || (prev !== null && prev.disagree !== null)) return;
    edits.push({ afterMs, editMs: r.modifiedMs });
  });

  const span = `in ${plural(readings.length, "reading")} of Salesforce from ${etLabel(firstMs)} to ${etLabel(lastMs)}`;
  if (changes.length === 0 && edits.length === 0) {
    lines.push(
      `CHECKED: the split read ${split} ${span}, and the record holding it was not edited from ${etLabel(fromMs)} to ${etLabel(lastMs)}, ` +
        `so it held throughout that time. After ${etLabel(lastMs)} it is assumed.`,
    );
  } else if (changes.length === 0) {
    lines.push(
      `CHECKED IN PART: the split read ${split} ${span}, but the record holding it was edited inside the window, and Salesforce keeps no ` +
        `history, so a change undone before an edit cannot be ruled out in the spans below. Ask whoever edited it. After ${etLabel(lastMs)} it is assumed.`,
    );
  }
  for (const e of edits.slice(0, MAX_EDITS_LISTED)) {
    lines.push(`  edited at ${etLabel(e.editMs)}: unverified from ${etLabel(e.afterMs)} to ${etLabel(e.editMs)}`);
  }
  if (edits.length > MAX_EDITS_LISTED) lines.push(`  and ${plural(edits.length - MAX_EDITS_LISTED, "more edit")} like these`);
  if (failedLine !== null) lines.push(failedLine);
  if (lastMs < toMs && changes.length > 0) lines.push(`After ${etLabel(lastMs)} the split is assumed.`);
  return { status: changes.length > 0 ? "changed" : "checked", lines, unreadable };
}

/**
 * The command's read of the stored readings (#3641). A failed read REFUSES on exit 5
 * rather than answering an empty list: no readings is the old assumption, so an
 * unreadable table must never pass for one that holds nothing.
 */
export async function readSplitReadings(
  fetchRows: () => Promise<PilotSettingsRow[]>,
): Promise<{ ok: true; rows: PilotSettingsRow[] } | { ok: false; exit: number; lines: string[] }> {
  try {
    return { ok: true, rows: await fetchRows() };
  } catch (err) {
    return { ok: false, ...refusal(PILOT_COMPARE_EXIT.slateUnreadable, `the stored readings of the split could not be read: ${reasonOf(err)}`) };
  }
}

/** The exits `judgeLines` gives when it judged something; every other exit is a refusal. */
export const JUDGED_EXITS: ReadonlySet<number> = new Set([
  PILOT_COMPARE_EXIT.compared,
  PILOT_COMPARE_EXIT.partial,
  PILOT_COMPARE_EXIT.rehearsal,
  PILOT_COMPARE_EXIT.provisional,
  PILOT_COMPARE_EXIT.settingsNowDiffer,
  PILOT_COMPARE_EXIT.tooFewToRead,
  PILOT_COMPARE_EXIT.splitChanged,
  PILOT_COMPARE_EXIT.bookingUpdate,
]);

export function judgePilotCompare(input: CompareInput): { exit: number; lines: string[]; proposedReadout: string | null } {
  const result = judgeLines(input);
  if (input.window.update !== null) {
    // An update is labelled on every line, like a partial look, so no line of it can be
    // quoted as a result; a refusal keeps its own code.
    return { ...result, lines: result.lines.map((l) => `[UPDATE] ${l}`), proposedReadout: null };
  }
  if (!input.window.partial) return result;
  // Rule 9: a partial look is labelled on every line, and exits on its own code
  // unless it refused, so it can never be read or scripted as a result.
  // Decided on the exit code, never the wording: anything that is not a judgement
  // is a refusal and keeps its own code, so a new refusal is covered by default.
  const refused = !JUDGED_EXITS.has(result.exit);
  return {
    exit: refused ? result.exit : PILOT_COMPARE_EXIT.partial,
    lines: result.lines.map((l) => `[PARTIAL] ${l}`),
    proposedReadout: null,
  };
}

function judgeLines(input: CompareInput): { exit: number; lines: string[]; proposedReadout: string | null } {
  const { window, settings, matched, calls } = input;
  const partial = window.partial;
  /** A booking update (#3698): bookings only, no calls read, never a readout. */
  const update = window.update !== null;
  const lines: string[] = [];
  // A rehearsal's days are before any reading was stored, so it keeps the assumption.
  const split: SplitCheck = window.rehearsal
    ? { status: "unchecked", lines: [ASSUMPTION_LINE], unreadable: 0 }
    : checkSplitReadings(input.readings, window.startMs, window.readEndMs);
  const callsByLead = new Map<string, RegalCall[]>();
  for (const c of calls.calls) {
    const list = callsByLead.get(c.leadKey) ?? [];
    list.push(c);
    callsByLead.set(c.leadKey, list);
  }
  const judged = matched.apps.map((a) => judgeApplication(a, window.spanMs, callsByLead, partial ? window.readEndMs - JUDGE_GRACE_MS : Infinity));
  const bySide = (side: Side) => judged.filter((j) => j.side === side);
  const days = (window.cohortEndMs - window.startMs) / 86_400_000;
  const c = matched.counts;
  const comparedLine =
    `Compared: ${plural(judged.length, "application")} (Slate side ${bySide("slate").length}, cal.com side ${bySide("calcom").length}), ` +
    `${plural(judged.filter((j) => j.booked).length, "booked application")}, ${plural(calls.calls.length, "Regal call")} read for their Leads.`;

  const created = matched.apps.map((a) => a.createdMs);
  const firstMs = firstJudgeableMs(window.startMs, window.spanMs);
  const ageDays = (ms: number) => ((window.readEndMs - ms) / 86_400_000).toFixed(2);
  const header = update
    ? [
        `BOOKING UPDATE (not a readout): Slate against cal.com bookings, intention to treat by hash side, tiers ${ASSUMED_TIERS.join(";")}.`,
        `Cohort: applications made from ${etLabel(window.startMs)} to ${etLabel(window.cohortEndMs)} (${days.toFixed(2)} days), ` +
          "each counted as booked when it booked within 24 hours of being made. Held calls and show rates are left out: many calls are booked days ahead.",
        ...split.lines,
      ]
    : partial
    ? [
        `Not a readout: no application's ${spanLabel(window.spanMs)} span has closed yet. Slate against cal.com so far, intention to treat by hash side, tiers ${ASSUMED_TIERS.join(";")}.`,
        `Cohort so far: applications made from ${etLabel(window.startMs)} to now, ${etLabel(window.readEndMs)} (${days.toFixed(2)} days), every one with its span still open.`,
        `Coverage: ${pct(Math.min(1, (window.readEndMs - window.startMs) / (firstMs - window.startMs)))} of the way to the first full window, judgeable from ${etLabel(firstMs)}` +
          (created.length > 0
            ? `; the oldest application here has had ${ageDays(created.reduce((a, b) => Math.min(a, b), Infinity))} of its ${spanLabel(window.spanMs)}s, the newest ${ageDays(created.reduce((a, b) => Math.max(a, b), -Infinity))}.`
            : "."),
        ...split.lines,
      ]
    : [
        `${window.rehearsal ? "REHEARSAL (not a result: these days were not the 50/50 split on every tier). " : ""}` +
          `Slate against cal.com, intention to treat by hash side, tiers ${ASSUMED_TIERS.join(";")}.`,
        `Cohort: applications made from ${etLabel(window.startMs)} to ${etLabel(window.cohortEndMs)} (${days.toFixed(window.rehearsal ? 2 : 0)} days), ` +
          `each judged on what happened within ${spanLabel(window.spanMs)}s of being made.`,
        ...split.lines,
      ];
  header.push(
    `Salesforce now holds: active ${String(settings.active)}, ${String(settings.percent)}%, tiers ${settings.tiers ?? "empty"}, last modified ${settings.lastModified ?? "unknown"}.`,
  );

  const unreadableRows = c.unreadable + split.unreadable + calls.calls.filter((call) => !Number.isFinite(Date.parse(call.startedAt))).length;
  if (unreadableRows > 0) {
    return {
      exit: PILOT_COMPARE_EXIT.inputUnreadable,
      lines: [
        `FAILED (input-unreadable): ${plural(unreadableRows, "row")} carried a time that could not be read (an application's creation, a ` +
          "booking's creation or start, a call's start, or a reading of the split). An unreadable time compares false against every bound, so it would leave the " +
          "cohort or miss a show in silence (L50).",
        ...header,
        comparedLine,
      ],
      proposedReadout: null,
    };
  }
  if (judged.length === 0) {
    return {
      exit: PILOT_COMPARE_EXIT.noApplications,
      lines: [
        `FAILED (no-applications): Salesforce returned no application in tiers ${ASSUMED_TIERS.join(";")} made in the cohort ` +
          `(${matched.outsideTiers} in other tiers, ${matched.noTier} with no XBC). A read that finds nothing is never a result.`,
        ...header,
        comparedLine,
      ],
      proposedReadout: null,
    };
  }
  if (bySide("slate").length === 0 || bySide("calcom").length === 0) {
    return {
      exit: PILOT_COMPARE_EXIT.emptyHalf,
      lines: [`FAILED (empty-half): one side holds no applications, so there is nothing to compare.`, ...header, comparedLine],
      proposedReadout: null,
    };
  }
  const missShare = c.needingContact > 0 ? (c.unmatched + c.ambiguous) / c.needingContact : 0;
  if (missShare > MAX_UNMATCHED_SHARE) {
    return {
      exit: PILOT_COMPARE_EXIT.tooManyUnmatched,
      lines: [
        `FAILED (too-many-unmatched): ${c.unmatched} unmatched and ${c.ambiguous} ambiguous of ${plural(c.needingContact, "cal.com booking")} ` +
          `carrying no application id (${pct(missShare)}, refused above ${pct(MAX_UNMATCHED_SHARE)}; #2945 measured 5.8%). Bookings tied to no ` +
          "application read as applications that never booked, on the cal.com side only, which is a rate difference made by the matching.",
        ...header,
        comparedLine,
      ],
      proposedReadout: null,
    };
  }
  const dueBeforeStore =
    calls.storeBeganMs === null
      ? 0
      : matched.apps.filter((a) =>
          a.chains.some((ch) => ch.finalStartMs !== null && ch.finalStartMs < a.createdMs + window.spanMs && ch.finalStartMs + SHOW_AFTER_MS < (calls.storeBeganMs as number)),
        ).length;
  if (dueBeforeStore > 0 && !update) {
    return {
      exit: PILOT_COMPARE_EXIT.noCallsStored,
      lines: [
        `FAILED (no-calls-stored): the Regal call store began at ${etLabel(calls.storeBeganMs as number)}, and ${plural(dueBeforeStore, "booked application")} ` +
          "were due before it (their show window closed before its first call), so they would read as no shows.",
        ...header,
        comparedLine,
      ],
      proposedReadout: null,
    };
  }
  if (!update && (calls.storedInSpan === 0 || calls.storeBeganMs === null)) {
    return {
      exit: PILOT_COMPARE_EXIT.noCallsStored,
      lines: [
        "FAILED (no-calls-stored): the Regal call store (regal_call_outcomes, #2944) holds no call at all over the span read, so every " +
          "booking would read as a no show. Check the regal_call_outcomes monitor before reading a show rate.",
        ...header,
        comparedLine,
      ],
      proposedReadout: null,
    };
  }

  lines.push(...header, comparedLine);

  // --- the headline: intention to treat --------------------------------------------------
  const rateBlock = (label: string, set: Judged[], perDayDays: number) => {
    const s = set.filter((j) => j.side === "slate");
    const k = set.filter((j) => j.side === "calcom");
    const sb = s.filter((j) => j.booked).length;
    const kb = k.filter((j) => j.booked).length;
    const sh = s.filter((j) => j.held).length;
    const kh = k.filter((j) => j.held).length;
    // In a partial look a booking whose call is still ahead cannot have been held yet,
    // so it is left out of held per application rather than read as a no show, the
    // same way the show rate leaves it out.
    const heldBase = (set: Judged[]) => (partial ? set.filter((j) => !j.callAhead).length : set.length);
    const sBase = heldBase(s);
    const kBase = heldBase(k);
    const booking = compareHalves({ leads: s.length, bookings: sb }, { leads: k.length, bookings: kb });
    const heldPer = compareHalves({ leads: sBase, bookings: sh }, { leads: kBase, bookings: kh });
    const show = clusteredDifference(set.filter((j) => j.judgeable).map((j) => ({ side: j.side, cluster: j.advisor, y: j.held })));
    const out: string[] = [];
    const readableBooking = !short(s.length, sb) && !short(k.length, kb);
    const readableShow = !short(show.slate.units, show.slate.outcomes) && !short(show.calcom.units, show.calcom.outcomes);
    // A partial look prints the rates so far and nothing that reads as a finding.
    const judgedText = (
      readable: boolean,
      d: Parameters<typeof intervalText>[0],
      caveat: "biased low, not a result" | "early, not a result" = "biased low, not a result",
    ) => (partial ? partialIntervalText(readable, d, caveat) : readable ? intervalText(d) : "not yet readable");
    out.push(`${label}:`);
    if (update) {
      out.push(
        `  applications  Slate ${s.length}, cal.com ${k.length}`,
        `  booking rate  Slate ${sb}/${s.length} (${pct(booking.slateRate)}), cal.com ${kb}/${k.length} (${pct(booking.calcomRate)}); ` +
          (readableBooking ? intervalText(booking) : "not yet readable"),
      );
      const perDayUpdate = (s.length + k.length) / Math.max(perDayDays, 1e-9);
      const dUpdate = daysNeeded({ leadsPerDay: perDayUpdate, percent: ASSUMED_PERCENT, baseRate: booking.calcomRate, lift: window.lift });
      out.push(`  days needed to see ${points(window.lift)}: booking rate ${dUpdate.ok ? plural(dUpdate.days, "day") : `none (${dUpdate.reason})`}`);
      return { out, readableBooking, readableShow: false, dBook: dUpdate, dShow: dUpdate };
    }
    out.push(
      `  applications  Slate ${s.length}, cal.com ${k.length}`,
      `  booking rate  Slate ${sb}/${s.length} (${pct(booking.slateRate)}), cal.com ${kb}/${k.length} (${pct(booking.calcomRate)}); ` +
        judgedText(readableBooking, booking),
      `  held per application  Slate ${sh}/${sBase} (${pct(heldPer.slateRate)}), cal.com ${kh}/${kBase} (${pct(heldPer.calcomRate)}); ` +
        judgedText(!short(sBase, sh) && !short(kBase, kh), heldPer),
      `  show rate (held over booked)  Slate ${show.slate.outcomes}/${show.slate.units} (${pct(show.slate.rate)}), ` +
        `cal.com ${show.calcom.outcomes}/${show.calcom.units} (${pct(show.calcom.rate)}), ${plural(show.clusters, "advisor")}; ` +
        judgedText(readableShow, show, "early, not a result"),
    );
    const perDay = (s.length + k.length) / Math.max(perDayDays, 1e-9);
    const dBook = daysNeeded({ leadsPerDay: perDay, percent: ASSUMED_PERCENT, baseRate: booking.calcomRate, lift: window.lift });
    const showPerDay = (show.slate.units + show.calcom.units) / Math.max(perDayDays, 1e-9);
    const dShow = daysNeeded({ leadsPerDay: showPerDay, percent: ASSUMED_PERCENT, baseRate: show.calcom.rate, lift: window.lift });
    if (!partial) {
      out.push(
        `  days needed to see ${points(window.lift)}: booking rate ${dBook.ok ? plural(dBook.days, "day") : `none (${dBook.reason})`}; ` +
          `show rate ${dShow.ok ? `${plural(dShow.days, "day")} at least (advisor clustering adds to it)` : `none (${dShow.reason})`}`,
      );
    }
    return { out, readableBooking, readableShow, dBook, dShow };
  };

  const overall = rateBlock(partial ? "All pilot tiers so far (intention to treat)" : "All pilot tiers (headline, intention to treat)", judged, days);
  lines.push(...overall.out);
  if (update) {
    const ref = input.reference ?? null;
    const refEnd = window.update?.referenceEndMs ?? null;
    if (ref === null || refEnd === null) {
      lines.push("How much a 24 hour window misses: not measured yet, because no cohort has had its full 7 days close. Read the booking rates as low on both sides.");
    } else {
      const c24 = bookingWindowCatch(ref, window.spanMs);
      const share = (x: { within: number; booked: number }) => (x.booked > 0 ? pct(x.within / x.booked) : "no bookings");
      lines.push(
        `A 24 hour window caught ${c24.slate.within} of ${c24.slate.booked} bookings on Slate's side (${share(c24.slate)}) and ` +
          `${c24.calcom.within} of ${c24.calcom.booked} on cal.com's (${share(c24.calcom)}), measured on applications made ` +
          `${etLabel(window.startMs)} to ${etLabel(refEnd)}, whose 7 days have closed.`,
      );
    }
  }
  if (partial) {
    lines.push(
      `Read with care: the booking rate is biased low on both sides, because every application here has had less than its ${spanLabel(window.spanMs)}s to book. ` +
        `The show rate and held per application count only bookings whose call time has passed (plus ${JUDGE_GRACE_MS / 3_600_000} hours for the call to reach the store); a booking whose call is still ahead is left out ` +
        "rather than read as a no show, which favours bookings made for soon after applying.",
    );
  }
  for (const tier of ASSUMED_TIERS) {
    const set = judged.filter((j) => j.tier === tier);
    if (set.length === 0) {
      lines.push(`Tier ${tier} (${TIER_LABEL[tier] ?? tier}): no applications.`);
      continue;
    }
    lines.push(...rateBlock(`Tier ${tier} (${TIER_LABEL[tier] ?? tier})`, set, days).out);
  }

  // --- by where the application came from (#3701) --------------------------------------
  // Form and partner applications have moved in opposite directions, so the headline
  // alone hides both. These cuts are judged by the same rules and never change the exit.
  const cuts = sourceCuts(window);
  lines.push("By where the application came from (each judged by the same rules; the headline above stays the readout):");
  if (cuts.length > 2) {
    lines.push(
      `  Partner applications are also reported from ${etLabel(PORTAL_FIX_MS)}: until then trypennie's offer portal, where partner leads apply and book, ` +
        "chose its booker before the application existed and so showed cal.com to partner leads on Slate's side (trypennie #522).",
    );
  }
  for (const cut of cuts) {
    const set = judged.filter(cut.keep);
    if (set.length === 0) {
      lines.push(`${cut.label}: no applications.`);
      continue;
    }
    lines.push(...rateBlock(cut.label, set, cut.days).out);
  }

  // --- the second row: by the system that took the booking ------------------------------
  const booked = judged.filter((j) => j.booked);
  const bySystem = clusteredDifference(
    booked.filter((j) => j.judgeable && j.system !== null).map((j) => ({ side: j.system as Side, cluster: j.advisor, y: j.held })),
  );
  lines.push(
    "By the system that took the booking (NOT randomised: who books where is chosen by the lead and the page, so this row can differ from the headline for reasons that are not the booker):",
    `  booked applications  Slate ${booked.filter((j) => j.system === "slate").length}, cal.com ${booked.filter((j) => j.system === "calcom").length}`,
  );
  if (!update) lines.push(
    `  show rate  Slate ${bySystem.slate.outcomes}/${bySystem.slate.units} (${pct(bySystem.slate.rate)}), cal.com ${bySystem.calcom.outcomes}/${bySystem.calcom.units} (${pct(bySystem.calcom.rate)}); ` +
      (partial
        ? partialIntervalText(
            !short(bySystem.slate.units, bySystem.slate.outcomes) && !short(bySystem.calcom.units, bySystem.calcom.outcomes),
            bySystem,
            "early, not a result",
          )
        : intervalText(bySystem)),
  );

  // --- leakage by cause ----------------------------------------------------------------
  const leaked = booked.filter((j) => j.system !== j.side);
  const causes = new Map<string, number>();
  for (const j of leaked) {
    const chain = j.firstChain as Chain;
    const how = chain.system === "calcom" ? (chain.submissionKey !== null ? "carried this application's id" : "matched by email and phone") : "carried this application's id";
    const k = `${j.side === "slate" ? "Slate side booked on" : "cal.com side booked on"} ${chain.label}, ${how}`;
    causes.set(k, (causes.get(k) ?? 0) + 1);
  }
  lines.push(
    `Leakage: ${plural(leaked.length, "booked application")} booked first on the other side's system ` +
      `(${pct(booked.length > 0 ? leaked.length / booked.length : 0)} of booked), ${booked.filter((j) => j.bothSystems).length} booked on both systems.`,
  );
  for (const [k, n] of [...causes].sort((a, b) => b[1] - a[1])) lines.push(`  ${n}  ${k}`);

  // --- what was left out ---------------------------------------------------------------
  const notJudgeable = booked.filter((j) => !j.judgeable && !j.noLead).length;
  const left: string[] = [];
  if (matched.outsideTiers > 0) left.push(`${plural(matched.outsideTiers, "application")} in tiers outside the pilot`);
  if (matched.noTier > 0) left.push(`${plural(matched.noTier, "application")} with no XBC`);
  if (c.inlineCardApps > 0) {
    left.push(`${plural(c.inlineCardApps, "application")} that booked through a landing page's inline card, which always offers Slate (#3718)`);
  }
  if (c.testSourceBookings > 0) {
    left.push(`${plural(c.testSourceBookings, "Slate booking")} made from a development host, which is test traffic (#2974)`);
  }
  if (c.slateWithoutId > 0) left.push(`${plural(c.slateWithoutId, "Slate booking")} carrying no application id (API bookings)`);
  if (c.unmatched > 0) left.push(`${plural(c.unmatched, "cal.com booking")} matching no application by email and phone`);
  if (c.ambiguous > 0) left.push(`${plural(c.ambiguous, "cal.com booking")} matching applications on several Leads`);
  if (c.outsideCohort > 0) left.push(`${plural(c.outsideCohort, "booking")} by an application outside the cohort (made before it, too recently, or in another tier)`);
  if (c.afterSpan > 0) left.push(`${plural(c.afterSpan, "booking")} made after its application's span closed`);
  if (c.beganBeforeWindow > 0) left.push(`${plural(c.beganBeforeWindow, "cal.com reschedule")} of a booking made before the window`);
  if (c.unresolved > 0) left.push(`${plural(c.unresolved, "cal.com reschedule")} whose new booking could not be read (booked, show not judged)`);
  const other = Object.entries(c.otherEventTypes);
  if (other.length > 0) left.push(`cal.com bookings on event types that are not a lead booking: ${other.map(([id, n]) => `${id} (${n})`).join(", ")}`);
  if (notJudgeable > 0 && !update) {
    left.push(
      `${plural(notJudgeable, "booked application")} whose final start fell after the span${partial ? " or whose call is still ahead" : ""}, so its show is not judged`,
    );
  }
  const noLead = booked.filter((j) => j.noLead).length;
  if (noLead > 0) left.push(`${plural(noLead, "booked application")} with no Lead in Salesforce, so no call can be tied to it`);
  lines.push(
    `Matching: ${c.byId} bookings by the id they carry, ${c.byContact} cal.com bookings by email and phone (${c.unmatched + c.ambiguous} of ${c.needingContact} not tied, ${pct(missShare)}).`,
  );
  if (left.length > 0) lines.push(`Left out: ${left.join("; ")}.`);
  if (!update) lines.push(
    `A show is one human Regal call of at least ${SHOW_MIN_TALK_S} s starting from 15 minutes before to 60 minutes after the final start; ` +
      `${plural(calls.storedInSpan, "call")} were stored over the span read. Booking rate is per application; GA4's per visitor rate (report:pilot-split) is a different population.`,
  );

  // --- the verdict -----------------------------------------------------------------------
  const disagree = settingsDisagreement(settings);
  if (update) {
    lines.push(
      "BOOKING UPDATE: not a readout. Bookings within 24 hours only, from applications whose 24 hours have passed; held calls, show rates " +
        "and a readout date come only from the full report.",
    );
    if (disagree !== null) lines.push(`SETTINGS NOW DIFFER from the assumed split: ${disagree}.`);
    const exit = split.status === "changed" ? PILOT_COMPARE_EXIT.splitChanged : disagree !== null ? PILOT_COMPARE_EXIT.settingsNowDiffer : PILOT_COMPARE_EXIT.bookingUpdate;
    return { exit, lines, proposedReadout: null };
  }
  if (partial) {
    if (disagree !== null) lines.push(`SETTINGS NOW DIFFER from the assumed split: ${disagree}.`);
    return { exit: PILOT_COMPARE_EXIT.partial, lines, proposedReadout: null };
  }
  let proposedReadout: string | null = null;
  const needDays = [overall.dBook, overall.dShow].filter((d) => d.ok).map((d) => (d as { days: number }).days);
  if (needDays.length > 0) {
    proposedReadout = DateTime.fromMillis(window.startMs, { zone: ZONE }).plus({ days: Math.max(...needDays) }).toISODate();
  }
  let exit: number = PILOT_COMPARE_EXIT.compared;
  if (window.rehearsal) {
    lines.push("REHEARSAL: the reads and the judgement ran end to end; the numbers above are not a result.");
    exit = PILOT_COMPARE_EXIT.rehearsal;
  } else if (window.readout.date === null) {
    lines.push(
      `PROVISIONAL: no readout date is fixed yet. ` +
        (proposedReadout !== null
          ? `This run proposes ${proposedReadout} (the window start plus the longer days estimate). Record it as READOUT_DATE in scripts/lib/pilot-compare.ts so later runs cannot move it.`
          : "This run could not propose one (no days estimate); re-run once both sides have bookings and shows."),
    );
    exit = PILOT_COMPARE_EXIT.provisional;
  } else if (!window.readout.reached) {
    lines.push(`PROVISIONAL: the readout date is ${window.readout.date}; until applications through then have closed their span, this is an interim look.`);
    exit = PILOT_COMPARE_EXIT.provisional;
  } else {
    lines.push(`READOUT: applications made through ${window.readout.date}, the date fixed in advance.`);
  }
  // A readout needs BOTH headline rates readable: the issue asks for booking rate and
  // show rate, and a run whose show rate prints "not yet readable" is not a readout.
  if (!overall.readableBooking) {
    lines.push(
      `Not yet readable: the booking rate. Each side needs at least ${MIN_LEADS_PER_HALF} applications, ${MIN_OUTCOMES_PER_HALF} bookings and ${MIN_OUTCOMES_PER_HALF} without one before it means anything.`,
    );
  }
  if (!overall.readableShow) {
    lines.push(
      `Not yet readable: the show rate. Each side needs at least ${MIN_LEADS_PER_HALF} booked applications whose show can be judged, ${MIN_OUTCOMES_PER_HALF} held and ${MIN_OUTCOMES_PER_HALF} not held before it means anything.`,
    );
  }
  if (disagree !== null) {
    lines.push(`SETTINGS NOW DIFFER from the assumed split: ${disagree}. The comparison above assumed 50% on tiers ${ASSUMED_TIERS.join(";")} throughout, and that is now known to be false at least today.`);
  }
  // One precedence, worst first, so no code is lost under another: a rehearsal is never
  // a result (13); then a reading that saw the split change inside the window (17), which
  // is proof where 14 is only today's value; then settings that contradict the
  // assumption now (14); then a sample too small on either headline rate (11); then
  // provisional (12); then the readout (0). Every condition that holds is still printed
  // above, whichever names the run.
  if (window.rehearsal) exit = PILOT_COMPARE_EXIT.rehearsal;
  else if (split.status === "changed") exit = PILOT_COMPARE_EXIT.splitChanged;
  else if (disagree !== null) exit = PILOT_COMPARE_EXIT.settingsNowDiffer;
  else if (!overall.readableBooking || !overall.readableShow) exit = PILOT_COMPARE_EXIT.tooFewToRead;
  return { exit, lines, proposedReadout };
}
