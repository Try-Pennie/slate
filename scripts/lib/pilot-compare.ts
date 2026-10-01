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
//    cohort yet, so numerator and denominator always cover the same days (L711).
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
// 7. THE SPLIT IS ASSUMED, NOT CHECKED. Salesforce keeps no history of
//    SlatePilotActive__c, SlatePilotPercent__c or SlatePilotTiers__c, and none will
//    be turned on (Dan, 2026-10-01, #2946), so the comparison trusts that the split
//    held at 50 on tiers 1 to 5 across the window and says so on EVERY run. What
//    Salesforce holds NOW is read and printed, and a current value that contradicts
//    the assumption has its own exit code.
// 8. A READOUT DATE fixed once. The first readable run proposes one; it is then
//    recorded in READOUT_DATE below, in git, so later runs cannot move it. Every run
//    before it is PROVISIONAL, and from it on the cohort stops growing.

import { DateTime } from "luxon";
import { slateBucket, leadKey, compareHalves, daysNeeded, normalCdf, MIN_LEADS_PER_HALF, MIN_OUTCOMES_PER_HALF } from "./pilot-split.ts";
import type { CalcomListedBooking } from "../../src/lib/calcom/upcoming-bookings.ts";

export type Side = "slate" | "calcom";

/** Every outcome on its own code (L11). Only `compared` is a readout. */
export const PILOT_COMPARE_EXIT = {
  /** The readout: the fixed date is reached and every half is readable. */
  compared: 0,
  /** Credentials for a source are missing here; nothing was read. */
  notConfigured: 1,
  /** No application's span has closed yet, so nothing can be judged. */
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
 * reviewed, and nobody can move it by setting a variable.
 */
export const READOUT_DATE: string | null = null;

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
}

/** One real, routed Slate booking. Slate reschedules in place, so a row is a whole chain. */
export interface SlateBookingRow {
  id: string;
  submissionId: string | null;
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

/** `WebsiteConfiguration__c` as Salesforce holds it now. */
export interface PilotSettings {
  active: boolean | null;
  percent: number | null;
  tiers: string | null;
  lastModified: string | null;
}

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
  readout: { date: string | null; reached: boolean };
  lift: number;
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
  const rehearsalStart = (env.PILOT_COMPARE_REHEARSAL_START ?? "").trim();
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
  if (cohortEndMs <= startMs) {
    const firstMs = startMs + 86_400_000 + spanMs + JUDGE_GRACE_MS;
    return refuse(
      PILOT_COMPARE_EXIT.windowNotOpen,
      `no application made since ${etLabel(startMs)} has had its ${spanLabel(spanMs)} span close yet, so nothing can be judged. ` +
        `The first whole day is judgeable from ${etLabel(firstMs)}.`,
    );
  }
  return { ok: true, window: { startMs, spanMs, cohortEndMs, readEndMs: nowMs, rehearsal, readout: { date: rehearsal ? null : readoutDate, reached }, lift } };
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
    beganBeforeWindow: number;
    unresolved: number;
    otherEventTypes: Record<string, number>;
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
  for (const a of input.applications) {
    const created = Date.parse(a.createdAt);
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
      chains: [],
    });
  }

  // Every application known for contact matching, newest last per person.
  const byContact = new Map<string, { key: string; createdMs: number; lead: string }[]>();
  const seen = new Set<string>();
  for (const a of [...input.applications, ...input.contactApplications]) {
    const key = leadKey(a.id);
    const e = emailKey(a.email);
    if (seen.has(key) || e === null || a.phone10 === null) continue;
    seen.add(key);
    const k = `${e}|${a.phone10}`;
    const list = byContact.get(k) ?? [];
    list.push({ key, createdMs: Date.parse(a.createdAt), lead: a.leadId === null ? `app:${key}` : leadKey(a.leadId) });
    byContact.set(k, list);
  }

  const cal = calcomChains(input.calcom);
  const counts: Matched["counts"] = {
    slateBookings: input.slate.length,
    slateWithoutId: 0,
    calcomChains: cal.chains.length,
    byId: 0,
    byContact: 0,
    needingContact: 0,
    unmatched: 0,
    ambiguous: 0,
    outsideCohort: 0,
    afterSpan: 0,
    beganBeforeWindow: cal.beganBeforeWindow,
    unresolved: cal.unresolved,
    otherEventTypes: cal.otherEventTypes,
  };

  const attach = (chain: Chain, key: string) => {
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

  for (const chain of [...slateChains(input.slate), ...cal.chains]) {
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
  side: Side;
  booked: boolean;
  /** The system of its first booking, or null when it booked nothing. */
  system: Side | null;
  bothSystems: boolean;
  /** At least one booking's final start fell inside the span, so a show can be judged. */
  judgeable: boolean;
  held: boolean;
  noLead: boolean;
  advisor: string;
  firstChain: Chain | null;
}

export function judgeApplication(app: AppOutcome, spanMs: number, callsByLead: ReadonlyMap<string, readonly RegalCall[]>): Judged {
  const chains = [...app.chains].sort((a, b) => a.createdMs - b.createdMs);
  const spanEnd = app.createdMs + spanMs;
  const judgeableChains = chains.filter((c) => c.finalStartMs !== null && c.finalStartMs < spanEnd);
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
    side: app.side,
    booked: chains.length > 0,
    system: chains[0]?.system ?? null,
    bothSystems: new Set(chains.map((c) => c.system)).size > 1,
    judgeable: judgeableChains.length > 0 && app.leadKey !== null,
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
  matched: Matched;
  calls: CallsRead;
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

export function judgePilotCompare(input: CompareInput): { exit: number; lines: string[]; proposedReadout: string | null } {
  const { window, settings, matched, calls } = input;
  const lines: string[] = [];
  const callsByLead = new Map<string, RegalCall[]>();
  for (const c of calls.calls) {
    const list = callsByLead.get(c.leadKey) ?? [];
    list.push(c);
    callsByLead.set(c.leadKey, list);
  }
  const judged = matched.apps.map((a) => judgeApplication(a, window.spanMs, callsByLead));
  const bySide = (side: Side) => judged.filter((j) => j.side === side);
  const days = (window.cohortEndMs - window.startMs) / 86_400_000;
  const c = matched.counts;
  const comparedLine =
    `Compared: ${plural(judged.length, "application")} (Slate side ${bySide("slate").length}, cal.com side ${bySide("calcom").length}), ` +
    `${plural(judged.filter((j) => j.booked).length, "booked application")}, ${plural(calls.calls.length, "Regal call")} read for their Leads.`;

  const header = [
    `${window.rehearsal ? "REHEARSAL (not a result: these days were not the 50/50 split on every tier). " : ""}` +
      `Slate against cal.com, intention to treat by hash side, tiers ${ASSUMED_TIERS.join(";")}.`,
    `Cohort: applications made from ${etLabel(window.startMs)} to ${etLabel(window.cohortEndMs)} (${days.toFixed(window.rehearsal ? 2 : 0)} days), ` +
      `each judged on what happened within ${spanLabel(window.spanMs)}s of being made.`,
    ASSUMPTION_LINE,
    `Salesforce now holds: active ${String(settings.active)}, ${String(settings.percent)}%, tiers ${settings.tiers ?? "empty"}, last modified ${settings.lastModified ?? "unknown"}.`,
  ];

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
  if (dueBeforeStore > 0) {
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
  if (calls.storedInSpan === 0 || calls.storeBeganMs === null) {
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
    const booking = compareHalves({ leads: s.length, bookings: sb }, { leads: k.length, bookings: kb });
    const heldPer = compareHalves({ leads: s.length, bookings: sh }, { leads: k.length, bookings: kh });
    const show = clusteredDifference(set.filter((j) => j.judgeable).map((j) => ({ side: j.side, cluster: j.advisor, y: j.held })));
    const out: string[] = [];
    const readableBooking = !short(s.length, sb) && !short(k.length, kb);
    const readableShow = !short(show.slate.units, show.slate.outcomes) && !short(show.calcom.units, show.calcom.outcomes);
    out.push(`${label}:`);
    out.push(
      `  applications  Slate ${s.length}, cal.com ${k.length}`,
      `  booking rate  Slate ${sb}/${s.length} (${pct(booking.slateRate)}), cal.com ${kb}/${k.length} (${pct(booking.calcomRate)}); ` +
        (readableBooking ? intervalText(booking) : "not yet readable"),
      `  held per application  Slate ${sh}/${s.length} (${pct(heldPer.slateRate)}), cal.com ${kh}/${k.length} (${pct(heldPer.calcomRate)}); ` +
        (!short(s.length, sh) && !short(k.length, kh) ? intervalText(heldPer) : "not yet readable"),
      `  show rate (held over booked)  Slate ${show.slate.outcomes}/${show.slate.units} (${pct(show.slate.rate)}), ` +
        `cal.com ${show.calcom.outcomes}/${show.calcom.units} (${pct(show.calcom.rate)}), ${plural(show.clusters, "advisor")}; ` +
        (readableShow ? intervalText(show) : "not yet readable"),
    );
    const perDay = (s.length + k.length) / Math.max(perDayDays, 1e-9);
    const dBook = daysNeeded({ leadsPerDay: perDay, percent: ASSUMED_PERCENT, baseRate: booking.calcomRate, lift: window.lift });
    const showPerDay = (show.slate.units + show.calcom.units) / Math.max(perDayDays, 1e-9);
    const dShow = daysNeeded({ leadsPerDay: showPerDay, percent: ASSUMED_PERCENT, baseRate: show.calcom.rate, lift: window.lift });
    out.push(
      `  days needed to see ${points(window.lift)}: booking rate ${dBook.ok ? plural(dBook.days, "day") : `none (${dBook.reason})`}; ` +
        `show rate ${dShow.ok ? `${plural(dShow.days, "day")} at least (advisor clustering adds to it)` : `none (${dShow.reason})`}`,
    );
    return { out, readableBooking, readableShow, dBook, dShow };
  };

  const overall = rateBlock("All pilot tiers (headline, intention to treat)", judged, days);
  lines.push(...overall.out);
  for (const tier of ASSUMED_TIERS) {
    const set = judged.filter((j) => j.tier === tier);
    if (set.length === 0) {
      lines.push(`Tier ${tier} (${TIER_LABEL[tier] ?? tier}): no applications.`);
      continue;
    }
    lines.push(...rateBlock(`Tier ${tier} (${TIER_LABEL[tier] ?? tier})`, set, days).out);
  }

  // --- the second row: by the system that took the booking ------------------------------
  const booked = judged.filter((j) => j.booked);
  const bySystem = clusteredDifference(
    booked.filter((j) => j.judgeable && j.system !== null).map((j) => ({ side: j.system as Side, cluster: j.advisor, y: j.held })),
  );
  lines.push(
    "By the system that took the booking (NOT randomised: who books where is chosen by the lead and the page, so this row can differ from the headline for reasons that are not the booker):",
    `  booked applications  Slate ${booked.filter((j) => j.system === "slate").length}, cal.com ${booked.filter((j) => j.system === "calcom").length}`,
    `  show rate  Slate ${bySystem.slate.outcomes}/${bySystem.slate.units} (${pct(bySystem.slate.rate)}), cal.com ${bySystem.calcom.outcomes}/${bySystem.calcom.units} (${pct(bySystem.calcom.rate)}); ` +
      intervalText(bySystem),
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
  if (c.slateWithoutId > 0) left.push(`${plural(c.slateWithoutId, "Slate booking")} carrying no application id (API bookings)`);
  if (c.unmatched > 0) left.push(`${plural(c.unmatched, "cal.com booking")} matching no application by email and phone`);
  if (c.ambiguous > 0) left.push(`${plural(c.ambiguous, "cal.com booking")} matching applications on several Leads`);
  if (c.outsideCohort > 0) left.push(`${plural(c.outsideCohort, "booking")} by an application outside the cohort (made before it, too recently, or in another tier)`);
  if (c.afterSpan > 0) left.push(`${plural(c.afterSpan, "booking")} made after its application's span closed`);
  if (c.beganBeforeWindow > 0) left.push(`${plural(c.beganBeforeWindow, "cal.com reschedule")} of a booking made before the window`);
  if (c.unresolved > 0) left.push(`${plural(c.unresolved, "cal.com reschedule")} whose new booking could not be read (booked, show not judged)`);
  const other = Object.entries(c.otherEventTypes);
  if (other.length > 0) left.push(`cal.com bookings on event types that are not a lead booking: ${other.map(([id, n]) => `${id} (${n})`).join(", ")}`);
  if (notJudgeable > 0) left.push(`${plural(notJudgeable, "booked application")} whose final start fell after the span, so its show is not judged`);
  const noLead = booked.filter((j) => j.noLead).length;
  if (noLead > 0) left.push(`${plural(noLead, "booked application")} with no Lead in Salesforce, so no call can be tied to it`);
  lines.push(
    `Matching: ${c.byId} bookings by the id they carry, ${c.byContact} cal.com bookings by email and phone (${c.unmatched + c.ambiguous} of ${c.needingContact} not tied, ${pct(missShare)}).`,
  );
  if (left.length > 0) lines.push(`Left out: ${left.join("; ")}.`);
  lines.push(
    `A show is one human Regal call of at least ${SHOW_MIN_TALK_S} s starting from 15 minutes before to 60 minutes after the final start; ` +
      `${plural(calls.storedInSpan, "call")} were stored over the span read. Booking rate is per application; GA4's per visitor rate (report:pilot-split) is a different population.`,
  );

  // --- the verdict -----------------------------------------------------------------------
  let proposedReadout: string | null = null;
  const needDays = [overall.dBook, overall.dShow].filter((d) => d.ok).map((d) => (d as { days: number }).days);
  if (needDays.length > 0) {
    proposedReadout = DateTime.fromMillis(window.startMs, { zone: ZONE }).plus({ days: Math.max(...needDays) }).toISODate();
  }
  const disagree = settingsDisagreement(settings);
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
  if (!overall.readableBooking) {
    lines.push(
      `Not yet readable: each side needs at least ${MIN_LEADS_PER_HALF} applications, ${MIN_OUTCOMES_PER_HALF} bookings and ${MIN_OUTCOMES_PER_HALF} without one before the headline means anything.`,
    );
    if (exit === PILOT_COMPARE_EXIT.compared || exit === PILOT_COMPARE_EXIT.provisional) exit = PILOT_COMPARE_EXIT.tooFewToRead;
  }
  if (disagree !== null) {
    lines.push(`SETTINGS NOW DIFFER from the assumed split: ${disagree}. The comparison above assumed 50% on tiers ${ASSUMED_TIERS.join(";")} throughout, and that is now known to be false at least today.`);
    exit = PILOT_COMPARE_EXIT.settingsNowDiffer;
  }
  return { exit, lines, proposedReadout };
}
