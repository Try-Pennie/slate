// The Slate against cal.com comparison across every pilot tier (#2946). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-pilot-compare.ts
//
// Everything `pnpm report:pilot-compare` decides lives in scripts/lib/pilot-compare.ts
// and is driven here with hand written rows: no network, no Salesforce, no cal.com,
// no Regal, no real clock (every instant is passed in).
import { assert, eq, finish } from "./lib/harness.ts";
import {
  planWindow,
  calcomChains,
  matchBookings,
  judgeApplication,
  clusteredDifference,
  judgePilotCompare,
  leadKeysToRead,
  settingsDisagreement,
  checkSplitReadings,
  readSplitReadings,
  etMidnightMs,
  PILOT_COMPARE_EXIT,
  ASSUMED_PERCENT,
  MAX_UNMATCHED_SHARE,
  SPAN_DAYS,
  READOUT_DATE,
  type Application,
  type SlateBookingRow,
  type RegalCall,
  type PilotSettings,
  type PilotWindow,
  type AppOutcome,
  type Chain,
  JUDGED_EXITS,
  CONTACT_READ_TIMEOUT_MS,
  readEveryBatch,
  sourceGroup,
  sourceCuts,
  PORTAL_FIX_MS,
  bookingWindowCatch,
  etDayFloorMs,
  JUDGE_GRACE_MS,
} from "./lib/pilot-compare.ts";
import { SF_TIMEOUT_MS } from "../src/lib/salesforce/retry.ts";
import { slateBucket, compareHalves } from "./lib/pilot-split.ts";
import type { CalcomListedBooking } from "../src/lib/calcom/upcoming-bookings.ts";
import { collectSoqlComplete, querySoqlComplete, type SoqlPage } from "../src/lib/salesforce/rest.ts";
import { settingsFromRecords } from "../src/lib/salesforce/pilot-settings.ts";
import type { PilotSettingsRow } from "../src/lib/monitor/pilot-settings-samples.ts";

const H = 3_600_000;
const D = 24 * H;
const WINDOW_START = Date.parse("2026-10-02T04:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

// --- ids on a known side --------------------------------------------------------------
// The hash itself is pinned against trypennie's own output in test-pilot-split.ts;
// here it only sorts invented ids onto the side each fixture needs.
const pool = { slate: [] as string[], calcom: [] as string[] };
for (let i = 0; pool.slate.length < 6000 || pool.calcom.length < 6000; i++) {
  const id = `a04Ui0000${String(i).padStart(6, "0")}XYZ`;
  (slateBucket(id) < ASSUMED_PERCENT ? pool.slate : pool.calcom).push(id);
}
const take = { slate: 0, calcom: 0 };
const nextId = (side: "slate" | "calcom") => pool[side][take[side]++];

const settingsOk: PilotSettings = { active: true, percent: 50, tiers: "1;2;3;4;5", lastModified: "2026-10-01T15:41:16Z" };

function windowAt(over: Partial<PilotWindow> = {}): PilotWindow {
  return {
    startMs: WINDOW_START,
    spanMs: SPAN_DAYS * D,
    cohortEndMs: WINDOW_START + 14 * D,
    readEndMs: WINDOW_START + 22 * D,
    rehearsal: false,
    partial: false,
    readout: { date: null, reached: false },
    lift: 0.02,
    update: null,
    ...over,
  };
}

let leadN = 0;
function app(side: "slate" | "calcom", over: Partial<Application> = {}): Application {
  leadN++;
  return {
    id: nextId(side),
    createdAt: iso(WINDOW_START + 2 * D),
    xbc: "112",
    leadId: `00QUi0000${String(leadN).padStart(6, "0")}AAA`,
    email: `lead${leadN}@example.test`,
    phone10: `555${String(leadN).padStart(7, "0")}`,
    source: "trypennie.com",
    ...over,
  };
}

function slateRow(a: Application, over: Partial<SlateBookingRow> = {}): SlateBookingRow {
  return {
    id: `b-${a.id}`,
    submissionId: a.id,
    inlineCard: false,
    testSource: false,
    createdAt: iso(Date.parse(a.createdAt) + H),
    startsAt: iso(Date.parse(a.createdAt) + D),
    status: "confirmed",
    agentEmail: "advisor.one@pennie.test",
    source: "my-offers-result",
    ...over,
  };
}

let calN = 0;
function calRow(over: Partial<CalcomListedBooking> = {}): CalcomListedBooking {
  calN++;
  return {
    id: calN,
    uid: `uid${calN}`,
    start: iso(WINDOW_START + 3 * D),
    status: "accepted",
    host: "advisor-two",
    submissionId: null,
    attendeeEmails: [],
    createdAt: iso(WINDOW_START + 2 * D + H),
    end: null,
    eventTypeId: 1314152,
    rescheduledFromUid: null,
    rescheduledToUid: null,
    attendeePhone10: null,
    hostEmail: "advisor.two@pennie.test",
    ...over,
  };
}

const showCall = (a: Application, startMs: number, over: Partial<RegalCall> = {}): RegalCall => ({
  leadKey: (a.leadId as string).slice(0, 15),
  startedAt: iso(startMs),
  talkTimeS: 600,
  isAiAgent: false,
  ...over,
});

const hasAssumption = (lines: string[]) => lines.some((l) => l.startsWith("ASSUMED, NOT CHECKED") && /cannot be seen/.test(l));
const hasCompared = (lines: string[]) => lines.some((l) => l.startsWith("Compared:"));
const clean = (lines: string[]) => !lines.some((l) => /undefined|NaN|\[object Object\]/.test(l));

// --- 1. exit codes are distinct ----------------------------------------------------------
{
  const codes = Object.values(PILOT_COMPARE_EXIT);
  eq(new Set(codes).size, codes.length, "every outcome has its own exit code");
  eq(PILOT_COMPARE_EXIT.compared, 0, "only the readout exits 0");
}

// --- 2. the window -------------------------------------------------------------------------
{
  eq(etMidnightMs("2026-10-02"), WINDOW_START, "midnight Eastern on 2026-10-02 is 04:00 UTC (daylight time)");
  eq(etMidnightMs("2026-11-02"), Date.parse("2026-11-02T05:00:00.000Z"), "and after the clocks change, 05:00 UTC: one conversion handles both");

  const early = planWindow(Date.parse("2026-10-01T20:00:00Z"), {});
  assert(!early.ok && early.exit === PILOT_COMPARE_EXIT.windowNotOpen, "before any span has closed the run refuses as window-not-open");
  if (!early.ok) {
    assert(hasAssumption(early.lines) && hasCompared(early.lines), "and still says what it assumed and that it compared nothing");
    assert(early.lines.some((l) => /judgeable from 2026-10-10/.test(l)), "and names when the first day becomes judgeable");
    assert(early.lines.some((l) => /the window opens at/.test(l)), "and says the window has not opened, not that a span has not closed");
  }

  // Ten days in: applications made on 10-02 and 10-03 have closed their 7 day span plus grace.
  const now = Date.parse("2026-10-12T12:00:00Z");
  // null explicitly: this case is about a run before any date is fixed, not the committed one.
  const w = planWindow(now, {}, null);
  assert(w.ok, "ten days in the window is open");
  if (w.ok) {
    eq(w.window.startMs, WINDOW_START, "the cohort starts at the window");
    eq(iso(w.window.cohortEndMs), "2026-10-05T04:00:00.000Z", "and ends on the Eastern midnight before the latest closed span");
    eq(w.window.readEndMs, now, "bookings and calls are read up to now");
    eq(w.window.readout, { date: null, reached: false }, "no readout date is fixed yet");
    eq(w.window.lift, 0.02, "the days estimate is sized for two points by default");
  }

  const fixed = planWindow(now, {}, "2026-10-04");
  assert(fixed.ok && fixed.window.readout.reached, "a readout date already passed is reached");
  if (fixed.ok) eq(iso(fixed.window.cohortEndMs), "2026-10-04T04:00:00.000Z", "and the cohort stops growing at it");
  const later = planWindow(now, {}, "2026-10-20");
  assert(later.ok && !later.window.readout.reached && later.window.readout.date === "2026-10-20", "a readout still ahead is not reached");

  const badLift = planWindow(now, { PILOT_COMPARE_LIFT: "2" });
  assert(!badLift.ok && badLift.exit === PILOT_COMPARE_EXIT.inputUnreadable, "a lift given as a percentage is refused, not read as 200 points");
  const badReadout = planWindow(now, {}, "someday");
  assert(!badReadout.ok && badReadout.exit === PILOT_COMPARE_EXIT.inputUnreadable, "an unreadable fixed readout date is refused");

  const reh = planWindow(Date.parse("2026-10-01T22:00:00Z"), { PILOT_COMPARE_REHEARSAL_START: "2026-09-30", PILOT_COMPARE_REHEARSAL_SPAN_HOURS: "6" });
  assert(reh.ok && reh.window.rehearsal, "a rehearsal over earlier days opens before the window does");
  if (reh.ok) {
    eq(reh.window.spanMs, 6 * H, "with the span it was given");
    eq(reh.window.readout.date, null, "and never a readout");
  }
  const badReh = planWindow(now, { PILOT_COMPARE_REHEARSAL_START: "yesterday" });
  assert(!badReh.ok && badReh.exit === PILOT_COMPARE_EXIT.inputUnreadable, "an unreadable rehearsal start is refused");

  // #2976: after the window opens and before the first span closes, a PARTIAL look.
  eq(w.ok && w.window.partial, false, "once a span has closed the run is never partial");
  const midway = Date.parse("2026-10-05T16:00:00Z");
  const part = planWindow(midway, {});
  assert(part.ok && part.window.partial, "between the window opening and the first closed span the run is partial, not refused");
  if (part.ok) {
    eq(part.window.startMs, WINDOW_START, "a partial cohort starts at the window");
    eq([part.window.cohortEndMs, part.window.readEndMs], [midway, midway], "and takes every application made up to now, with bookings and calls read to now");
    eq(part.window.readout, { date: null, reached: false }, "and is never a readout, even with a date fixed");
  }
  const partFixed = planWindow(midway, {}, "2026-10-20");
  eq(partFixed.ok && partFixed.window.readout.reached, false, "a fixed readout date does not make a partial run reached");
  eq(reh.ok && reh.window.partial, false, "a rehearsal is never partial");
}

// The committed readout date (rule 8), fixed on 2026-10-12 from the first provisional
// run's proposal: the window start plus the 22 day show rate estimate.
{
  eq(READOUT_DATE, "2026-10-24", "the readout date is fixed at 2026-10-24");
  const before = planWindow(Date.parse("2026-10-12T12:00:00Z"), {});
  assert(before.ok && before.window.readout.date === "2026-10-24" && !before.window.readout.reached, "a run before it reads the committed date and is provisional");
  // 2026-10-24 ET plus the 7 day span plus the 3 hour grace has passed by 2026-11-01.
  const after = planWindow(Date.parse("2026-11-01T12:00:00Z"), {});
  assert(after.ok && after.window.readout.reached, "once its span has closed the readout is reached");
  if (after.ok) eq(iso(after.window.cohortEndMs), "2026-10-24T04:00:00.000Z", "and the cohort stops at midnight Eastern on 2026-10-24");
}

// --- 3. cal.com reschedule chains -------------------------------------------------------------
{
  // Measured 2026-10-01: the old half reads cancelled with rescheduledToUid set.
  const old = calRow({ uid: "c1", status: "cancelled", rescheduledToUid: "c2", createdAt: iso(WINDOW_START + D), start: iso(WINDOW_START + 2 * D) });
  const mid = calRow({ uid: "c2", status: "cancelled", rescheduledFromUid: "c1", rescheduledToUid: "c3", createdAt: iso(WINDOW_START + 1.5 * D) });
  const last = calRow({ uid: "c3", status: "accepted", rescheduledFromUid: "c2", createdAt: iso(WINDOW_START + 1.8 * D), start: iso(WINDOW_START + 4 * D), hostEmail: "final@pennie.test" });
  const set = calcomChains([last, old, mid]);
  eq(set.chains.length, 1, "a twice rescheduled booking is one chain");
  const ch = set.chains[0];
  eq(ch.cancelled, false, "a reschedule is not a cancellation");
  eq(ch.createdMs, WINDOW_START + D, "the chain was made when its first link was made");
  eq(ch.finalStartMs, WINDOW_START + 4 * D, "and is judged at its last link's start");
  eq(ch.advisor, "final@pennie.test", "by the advisor on the last link");

  const cancelled = calcomChains([calRow({ status: "cancelled" })]);
  eq(cancelled.chains[0].cancelled, true, "a cancelled booking with no forward link is a cancellation");

  const before = calcomChains([calRow({ rescheduledFromUid: "made-before-window" })]);
  eq([before.chains.length, before.beganBeforeWindow], [0, 1], "a reschedule of a booking made before the window is left out and counted");

  const broken = calcomChains([calRow({ uid: "x1", status: "cancelled", rescheduledToUid: "never-read" })]);
  eq(broken.unresolved, 1, "a reschedule whose new booking was not read is counted");
  eq(broken.chains[0].finalStartMs, null, "and its final start is unknown, never the old one's");
  eq(broken.chains[0].cancelled, false, "and it is not read as a cancellation");

  const other = calcomChains([calRow({ eventTypeId: 3680269 }), calRow({ eventTypeId: 3234190 })]);
  eq(other.chains.length, 1, "a Client Sync booking is not a lead booking");
  eq(other.otherEventTypes, { "3680269": 1 }, "and is counted by its event type id");
}

// --- 4. matching ---------------------------------------------------------------------------------
{
  const w = windowAt();
  const s1 = app("slate");
  const k1 = app("calcom");
  const k2 = app("calcom");
  // k3 and k3b: one person, two applications on ONE Lead; the booking goes to the latest prior.
  const k3old = app("calcom", { createdAt: iso(WINDOW_START + D) });
  const k3 = app("slate", { createdAt: iso(WINDOW_START + 2 * D), leadId: k3old.leadId, email: k3old.email, phone10: k3old.phone10 });
  // Two applications on DIFFERENT Leads sharing an address and phone: ambiguous.
  const amb1 = app("calcom");
  const amb2 = app("calcom", { email: amb1.email, phone10: amb1.phone10 });
  // An application in tier 0 (outside the pilot) and one with no XBC.
  const tier0 = app("slate", { xbc: "012" });
  const noXbc = app("slate", { xbc: null });
  // Made before the window: only known through the contact read.
  const older = app("calcom", { createdAt: iso(WINDOW_START - 3 * D) });
  const apps = [s1, k1, k2, k3old, k3, amb1, amb2, tier0, noXbc];
  const m = matchBookings({
    window: w,
    applications: apps,
    contactApplications: [older],
    slate: [slateRow(s1), slateRow(k1, { source: "booking-agent-eligible" }), slateRow(s1, { id: "api", submissionId: null, source: "not-given" })],
    calcom: [
      calRow({ submissionId: k2.id }),
      calRow({ attendeeEmails: [k3.email as string], attendeePhone10: k3.phone10, createdAt: iso(WINDOW_START + 2 * D + H) }),
      calRow({ attendeeEmails: [amb1.email as string], attendeePhone10: amb1.phone10 }),
      calRow({ attendeeEmails: ["nobody@example.test"], attendeePhone10: "5550000000" }),
      calRow({ attendeeEmails: [older.email as string], attendeePhone10: older.phone10 }),
      // Made after its application's span closed.
      calRow({ submissionId: k1.id, createdAt: iso(Date.parse(k1.createdAt) + SPAN_DAYS * D + H) }),
    ],
  });
  eq(m.apps.length, 7, "every application made in the cohort in a pilot tier is in it");
  eq([m.outsideTiers, m.noTier], [1, 1], "tier 0 and a missing XBC are counted out, never guessed into a tier");
  const byKey = new Map(m.apps.map((a) => [a.key, a]));
  eq(byKey.get(s1.id.slice(0, 15))?.side, "slate", "a side comes from the hash of the first 15 characters");
  eq(byKey.get(k1.id.slice(0, 15))?.side, "calcom", "on both sides");
  eq(byKey.get(s1.id.slice(0, 15))?.chains.length, 1, "a Slate booking ties to the application id it carries");
  eq(byKey.get(k1.id.slice(0, 15))?.chains.map((c) => c.system), ["slate"], "a cal.com side application can book on Slate (leakage), and the late cal.com booking is not counted");
  eq(byKey.get(k2.id.slice(0, 15))?.chains.map((c) => c.system), ["calcom"], "a cal.com booking ties by the id it carries");
  eq(byKey.get(k3.id.slice(0, 15))?.chains.length, 1, "with no id, email AND phone tie it to the LATEST prior application");
  eq(byKey.get(k3old.id.slice(0, 15))?.chains.length, 0, "and not to the older one of the same person");
  eq(m.counts.slateWithoutId, 1, "a Slate API booking with no id is counted, not matched");
  eq(m.counts.ambiguous, 1, "applications on two Leads behind one address and phone are ambiguous, never a pick");
  eq(m.counts.unmatched, 1, "an address and phone with no application is unmatched");
  eq(m.counts.outsideCohort, 1, "a booking by an application made before the window is outside the cohort, not unmatched");
  eq(m.counts.afterSpan, 1, "a booking made after the span closed is counted and left out");
  eq(m.counts.needingContact, 4, "four cal.com bookings needed a contact match");
  eq(leadKeysToRead(m).length, 4, "the calls read are for booked applications' Leads only");
}

// --- 5. what a show is ------------------------------------------------------------------------
{
  const a = app("slate");
  const start = WINDOW_START + 3 * D;
  const outcome = (chains: Partial<Chain>[], leadKey: string | null = (a.leadId as string).slice(0, 15)): AppOutcome => ({
    key: a.id.slice(0, 15),
    tier: "1",
    side: "slate",
    createdMs: Date.parse(a.createdAt),
    leadKey,
    chains: chains.map((c) => ({
      system: "slate",
      createdMs: Date.parse(a.createdAt) + H,
      finalStartMs: start,
      cancelled: false,
      advisor: "adv@pennie.test",
      submissionKey: a.id.slice(0, 15),
      email: null,
      phone10: null,
      label: "Slate booking",
      ...c,
    })),
  });
  const judge = (calls: RegalCall[], chains: Partial<Chain>[] = [{}], leadKey?: string | null) =>
    judgeApplication(outcome(chains, leadKey === undefined ? (a.leadId as string).slice(0, 15) : leadKey), SPAN_DAYS * D, new Map([[(a.leadId as string).slice(0, 15), calls]]));

  eq(judge([showCall(a, start + 5 * 60_000)]).held, true, "a human call of 600 s just after the start is a show");
  eq(judge([showCall(a, start, { talkTimeS: 300 })]).held, true, "exactly 300 s is a show");
  eq(judge([showCall(a, start, { talkTimeS: 299 })]).held, false, "299 s is not");
  eq(judge([showCall(a, start, { isAiAgent: true })]).held, false, "the AI agent's call is never a show");
  eq(judge([showCall(a, start - 15 * 60_000)]).held, true, "a call starting 15 minutes early counts");
  eq(judge([showCall(a, start - 15 * 60_000 - 1)]).held, false, "a moment earlier does not");
  eq(judge([showCall(a, start + 60 * 60_000)]).held, true, "a call starting 60 minutes late counts");
  eq(judge([showCall(a, start + 60 * 60_000 + 1)]).held, false, "a moment later does not");
  eq(
    judge([showCall(a, start, { talkTimeS: 200 }), showCall(a, start + 10 * 60_000, { talkTimeS: 200 })]).held,
    false,
    "two short calls are NOT summed (Dan, 2026-10-01 on #2945)",
  );
  eq(judge([showCall(a, start)], [{ cancelled: true }]).held, false, "a cancelled booking is not held, whatever the calls");
  const late = judge([showCall(a, start + 8 * D)], [{ finalStartMs: start + 8 * D }]);
  eq([late.booked, late.judgeable, late.held], [true, false, false], "a final start after the span is booked and not judged");
  const noLead = judge([showCall(a, start)], [{}], null);
  eq([noLead.booked, noLead.judgeable, noLead.noLead], [true, false, true], "an application with no Lead cannot be tied to a call, and says so");
  eq(judge([]).advisor, "adv@pennie.test", "the show is clustered by the advisor of the booking");
  eq(judge([], [{ advisor: null }]).advisor, `unknown:${a.id.slice(0, 15)}`, "no advisor is its own cluster, never one pooled unknown");

  // #2976: a partial run judges a show only once its call can have happened and reached the store.
  const dueAt = (dueByMs: number) =>
    judgeApplication(outcome([{}]), SPAN_DAYS * D, new Map([[(a.leadId as string).slice(0, 15), [] as RegalCall[]]]), dueByMs);
  const notYet = dueAt(start + 60 * 60_000 - 1);
  eq([notYet.booked, notYet.judgeable, notYet.held], [true, false, false], "a booking whose show window is still open is booked and not judged, never a no show");
  eq(dueAt(start + 60 * 60_000).judgeable, true, "once its show window has closed it is judged");
  // Only a call still AHEAD is set aside in a partial look; a booking for after the
  // span, or one with no Lead, is not waiting on anything and counts as not held.
  eq(notYet.callAhead, true, "a booking whose show window is still open is waiting on its call");
  eq(dueAt(start + 60 * 60_000).callAhead, false, "once the window has closed it is not");
  const lateAhead = judgeApplication(outcome([{ finalStartMs: start + 8 * D }]), SPAN_DAYS * D, new Map(), start);
  eq(lateAhead.callAhead, false, "a final start after the span is not a call ahead, however far off it is");
  const noLeadAhead = judgeApplication(outcome([{}], null), SPAN_DAYS * D, new Map(), start);
  eq(noLeadAhead.callAhead, false, "an application with no Lead is never waiting on a call it could be tied to");
}

// --- 6. the clustered interval -----------------------------------------------------------------
{
  // Every unit its own cluster: the interval is the plain two proportion one, times
  // sqrt(G/(G-1)) for the small sample correction.
  const units: { side: "slate" | "calcom"; cluster: string; y: boolean }[] = [];
  for (let i = 0; i < 200; i++) units.push({ side: "slate", cluster: `s${i}`, y: i < 120 });
  for (let i = 0; i < 200; i++) units.push({ side: "calcom", cluster: `c${i}`, y: i < 100 });
  const solo = clusteredDifference(units);
  const plain = compareHalves({ leads: 200, bookings: 120 }, { leads: 200, bookings: 100 });
  const ratio = ((solo.high as number) - (solo.low as number)) / ((plain.high as number) - (plain.low as number));
  assert(Math.abs(ratio - Math.sqrt(400 / 399)) < 1e-9, `with one unit per cluster it matches the unclustered interval (ratio ${ratio})`);
  assert(Math.abs((solo.difference as number) - 0.1) < 1e-12, "the difference is Slate minus cal.com");

  // Ten advisors whose outcomes move together: the same counts, a much wider interval.
  const grouped = units.map((u, i) => ({ ...u, cluster: `adv${Math.floor((i % 200) / 20)}` }));
  const together = clusteredDifference(grouped);
  assert(
    (together.high as number) - (together.low as number) > 2 * ((plain.high as number) - (plain.low as number)),
    "outcomes that move together by advisor widen the interval",
  );
  const one = clusteredDifference(units.map((u) => ({ ...u, cluster: "only" })));
  eq([one.low, one.high, one.p], [null, null, null], "one cluster has no interval, never NaN");
  eq(clusteredDifference([{ side: "slate", cluster: "a", y: true }]).difference, null, "an empty side has no difference");
}

// --- 7. the whole judgement ----------------------------------------------------------------------
/** A realistic cohort: `n` applications a side, with booking and show rates given. */
function cohort(n: number, rates: { slate: [number, number]; calcom: [number, number] }, source: string | null = "trypennie.com") {
  const apps: Application[] = [];
  const slate: SlateBookingRow[] = [];
  const cal: CalcomListedBooking[] = [];
  const calls: RegalCall[] = [];
  for (const side of ["slate", "calcom"] as const) {
    const [book, show] = rates[side];
    for (let i = 0; i < n; i++) {
      const a = app(side, { createdAt: iso(WINDOW_START + (i % 10) * D + H), xbc: `${(i % 5) + 1}12`, source });
      apps.push(a);
      if (i >= n * book) continue;
      const start = Date.parse(a.createdAt) + 2 * D;
      const advisor = `adv${i % 12}@pennie.test`;
      if (side === "slate") slate.push(slateRow(a, { startsAt: iso(start), agentEmail: advisor }));
      else cal.push(calRow({ submissionId: a.id, createdAt: iso(Date.parse(a.createdAt) + H), start: iso(start), hostEmail: advisor }));
      if (i < n * book * show) calls.push(showCall(a, start + 2 * 60_000));
    }
  }
  return { apps, slate, cal, calls };
}

function run(
  c: ReturnType<typeof cohort>,
  over: {
    window?: Partial<PilotWindow>;
    settings?: PilotSettings;
    storedInSpan?: number;
    storeBeganMs?: number | null;
    contact?: Application[];
    readings?: PilotSettingsRow[];
    reference?: ReturnType<typeof matchBookings> | null;
  } = {},
) {
  const window = windowAt(over.window);
  const matched = matchBookings({ window, applications: c.apps, contactApplications: over.contact ?? [], slate: c.slate, calcom: c.cal });
  return judgePilotCompare({
    window,
    settings: over.settings ?? settingsOk,
    readings: over.readings ?? [],
    matched,
    calls: {
      calls: c.calls,
      storedInSpan: over.storedInSpan ?? 5000,
      storeBeganMs: over.storeBeganMs === undefined ? Date.parse("2026-10-01T17:12:00Z") : over.storeBeganMs,
    },
    reference: over.reference ?? null,
  });
}

{
  const healthy = cohort(300, { slate: [0.4, 0.6], calcom: [0.3, 0.5] });
  const r = run(healthy);
  eq(r.exit, PILOT_COMPARE_EXIT.tooFewToRead, "a booking rate readable without its show rate is still too few to read");
  assert(hasAssumption(r.lines), "the assumed split is printed on the run");
  assert(r.lines.some((l) => /^Compared: 600 applications \(Slate side 300, cal.com side 300\), 210 booked applications/.test(l)), "and how many it compared");
  assert(r.lines.some((l) => /booking rate  Slate 120\/300 \(40\.0%\), cal\.com 90\/300 \(30\.0%\); \+10\.0 points/.test(l)), "the headline booking rate per side and the difference");
  assert(r.lines.some((l) => /show rate \(held over booked\)  Slate 72\/120 \(60\.0%\), cal\.com 45\/90 \(50\.0%\), 12 advisors/.test(l)), "the show rate, clustered by advisor");
  assert(r.lines.some((l) => /^Tier 3 \(High\):/.test(l)), "every tier has its own block");
  assert(r.lines.some((l) => /days needed to see \+2\.0 points/.test(l)), "with days needed");
  assert(r.proposedReadout !== null && r.lines.some((l) => l.includes(`proposes ${r.proposedReadout}`)), "and proposes a readout date to fix");
  assert(r.lines.some((l) => /^Leakage: 0 booked applications/.test(l)), "no leakage when every application booked on its own side");
  assert(clean(r.lines), "nothing renders undefined or NaN");

  // Large enough that BOTH the booking rate and the show rate are readable.
  const full = cohort(400, { slate: [0.4, 0.6], calcom: [0.3, 0.5] });
  const done = run(full, { window: { readout: { date: "2026-10-16", reached: true } } });
  eq(done.exit, PILOT_COMPARE_EXIT.compared, "on the fixed readout date a run readable on both rates is the readout");
  assert(done.lines.some((l) => l.startsWith("READOUT:")), "and says so");
  // The healthy cohort reads its booking rate and not its show rate (90 judgeable on cal.com).
  const bookingOnly = run(healthy, { window: { readout: { date: "2026-10-16", reached: true } } });
  eq(bookingOnly.exit, PILOT_COMPARE_EXIT.tooFewToRead, "a readout whose show rate is not yet readable is not a readout");
  assert(bookingOnly.lines.some((l) => /^Not yet readable: the show rate/.test(l)), `and says which rate is short (${bookingOnly.lines.slice(-2).join(" | ")})`);
  const interim = run(full, { window: { readout: { date: "2026-10-30", reached: false } } });
  eq(interim.exit, PILOT_COMPARE_EXIT.provisional, "before the fixed date it is an interim look");
  eq(run(full).exit, PILOT_COMPARE_EXIT.provisional, "with no readout date fixed, a run readable on both rates is provisional");

  // Precedence (documented in the exit table): rehearsal 13 first, since a rehearsal
  // is never a result; then a settings disagreement 14; then too few 11; then provisional 12.
  const rehChanged = run(full, { settings: { ...settingsOk, percent: 70 }, window: { rehearsal: true } });
  eq(rehChanged.exit, PILOT_COMPARE_EXIT.rehearsal, "a rehearsal stays a rehearsal when the settings now differ");
  assert(rehChanged.lines.some((l) => /^SETTINGS NOW DIFFER/.test(l)), "and the disagreement is still reported");

  const changed = run(healthy, { settings: { ...settingsOk, percent: 70 }, window: { readout: { date: "2026-10-16", reached: true } } });
  eq(changed.exit, PILOT_COMPARE_EXIT.settingsNowDiffer, "settings that contradict the assumption NOW have their own exit");
  assert(changed.lines.some((l) => /SlatePilotPercent__c is 70/.test(l)), "and name the field");
  assert(changed.lines.some((l) => /^booking rate|  booking rate/.test(l)), "while the comparison is still printed");
  eq(settingsDisagreement({ ...settingsOk, tiers: "5;4;3;2;1" }), null, "tiers in another order agree");
  assert(settingsDisagreement({ ...settingsOk, active: false }) !== null, "an inactive pilot disagrees");

  const reh = run(healthy, { window: { rehearsal: true } });
  eq(reh.exit, PILOT_COMPARE_EXIT.rehearsal, "a rehearsal exits on its own code");
  assert(reh.lines[0].startsWith("REHEARSAL"), "and says so first");
}
{
  const thin = run(cohort(40, { slate: [0.4, 0.6], calcom: [0.3, 0.5] }), { window: { readout: { date: "2026-10-16", reached: true } } });
  eq(thin.exit, PILOT_COMPARE_EXIT.tooFewToRead, "under the minimum sample nothing is a finding");
  assert(thin.lines.some((l) => /not yet readable/.test(l)), "and every rate says not yet readable");
}
{
  const empty = run({ apps: [], slate: [], cal: [], calls: [] });
  eq(empty.exit, PILOT_COMPARE_EXIT.noApplications, "no application in the cohort is a refusal, never a quiet zero");
  assert(hasAssumption(empty.lines) && hasCompared(empty.lines), "and still states the assumption and the count");

  const oneSide = cohort(50, { slate: [0.4, 0.6], calcom: [0.3, 0.5] });
  oneSide.apps = oneSide.apps.filter((a) => slateBucket(a.id) < 50);
  eq(run(oneSide).exit, PILOT_COMPARE_EXIT.emptyHalf, "one side empty is its own refusal");

  const noCalls = run(cohort(150, { slate: [0.4, 0.6], calcom: [0.3, 0.5] }), { storedInSpan: 0 });
  eq(noCalls.exit, PILOT_COMPARE_EXIT.noCallsStored, "an empty call store refuses: every booking would read as a no show");

  // Measured in the first live rehearsal: calls stored over the span, but the store
  // began AFTER the bookings it was asked about were due, so every one read as a no
  // show while the count looked healthy.
  const late = run(cohort(150, { slate: [0.4, 0.6], calcom: [0.3, 0.5] }), { storeBeganMs: WINDOW_START + 5 * D });
  eq(late.exit, PILOT_COMPARE_EXIT.noCallsStored, "a store that began after some shows were due refuses");
  assert(late.lines.some((l) => /began at/.test(l) && /were due before it/.test(l)), `and says when it began and how many were due before (${late.lines[0]})`);
  const never = run(cohort(150, { slate: [0.4, 0.6], calcom: [0.3, 0.5] }), { storeBeganMs: null });
  eq(never.exit, PILOT_COMPARE_EXIT.noCallsStored, "a store with no call at all refuses");
}
{
  // The unmatched threshold, both sides of it.
  const base = cohort(150, { slate: [0.4, 0.6], calcom: [0.3, 0.5] });
  const withStrays = (strays: number, matchedByContact: number) => {
    const c = { ...base, cal: [...base.cal] };
    const contactApps = c.apps.filter((a) => slateBucket(a.id) >= 50).slice(100, 100 + matchedByContact);
    for (const a of contactApps) c.cal.push(calRow({ attendeeEmails: [a.email as string], attendeePhone10: a.phone10, createdAt: iso(Date.parse(a.createdAt) + H) }));
    for (let i = 0; i < strays; i++) c.cal.push(calRow({ attendeeEmails: [`stray${i}@example.test`], attendeePhone10: `55599${String(i).padStart(5, "0")}` }));
    return run(c);
  };
  // 4 of 40 is exactly 10%: allowed. 5 of 41 is over it: refused.
  assert(withStrays(4, 36).exit !== PILOT_COMPARE_EXIT.tooManyUnmatched, `exactly ${MAX_UNMATCHED_SHARE * 100}% unmatched is allowed`);
  const over = withStrays(5, 36);
  eq(over.exit, PILOT_COMPARE_EXIT.tooManyUnmatched, "over the threshold the run refuses");
  assert(over.lines.some((l) => /5 unmatched and 0 ambiguous of 41/.test(l)), "and says how many of how many");
}
{
  // Leakage: Slate side applications booked on cal.com, by the cause that is measurable.
  const c = cohort(150, { slate: [0.4, 0.6], calcom: [0.3, 0.5] });
  const slateSide = c.apps.filter((a) => slateBucket(a.id) < 50).slice(100, 103);
  c.cal.push(calRow({ submissionId: slateSide[0].id, createdAt: iso(Date.parse(slateSide[0].createdAt) + H) }));
  c.cal.push(calRow({ attendeeEmails: [slateSide[1].email as string], attendeePhone10: slateSide[1].phone10, createdAt: iso(Date.parse(slateSide[1].createdAt) + H) }));
  const r = run(c);
  assert(r.lines.some((l) => /^Leakage: 2 booked applications/.test(l)), "leakage counts applications that booked on the other side's system");
  assert(r.lines.some((l) => /1  Slate side booked on cal\.com review, carried this application's id/.test(l)), "by the id they carried");
  assert(r.lines.some((l) => /1  Slate side booked on cal\.com review, matched by email and phone/.test(l)), "or by a contact match");
  assert(r.lines.some((l) => /^By the system that took the booking \(NOT randomised/.test(l)), "and the by system row is labelled as not randomised");
}

// --- 7a. a partial look before the first full window (#2976) ------------------------------------
{
  const now = WINDOW_START + 5 * D;
  const c = cohort(300, { slate: [0.4, 0.6], calcom: [0.3, 0.5] });
  // Calls cannot have happened yet past now.
  const sofar = { ...c, calls: c.calls.filter((call) => Date.parse(call.startedAt) < now) };
  const partialWindow = { partial: true, cohortEndMs: now, readEndMs: now };
  const r = run(sofar, { window: partialWindow });
  eq(r.exit, PILOT_COMPARE_EXIT.partial, "a partial look exits on its own code");
  assert(
    ![PILOT_COMPARE_EXIT.compared, PILOT_COMPARE_EXIT.provisional, PILOT_COMPARE_EXIT.tooFewToRead].includes(r.exit as 0 | 11 | 12),
    "never the readout, provisional or too few codes",
  );
  assert(r.lines.length > 0 && r.lines.every((l) => l.startsWith("[PARTIAL] ")), `every line is labelled partial (${r.lines.find((l) => !l.startsWith("[PARTIAL] "))})`);
  // 150 applications a side were made by day 5; booked: Slate i < 120, cal.com i < 90, of i % 10 under 5.
  assert(r.lines.some((l) => /booking rate  Slate 60\/150 \(40\.0%\), cal\.com 45\/150 \(30\.0%\)/.test(l)), "the booking rate so far per side");
  // Only bookings whose call is due count toward the show rate: days 0 to 2 (start two days on).
  assert(r.lines.some((l) => /show rate \(held over booked\)  Slate 23\/36 \(63\.9%\), cal\.com 15\/27 \(55\.6%\)/.test(l)), `the show rate over calls already due (${r.lines.filter((l) => /show rate/.test(l))[0]})`);
  // Held per application leaves out a booking whose call is still ahead, as the show rate
  // does: 60 booked less 36 due on the Slate side, 45 less 27 on the cal.com side.
  assert(
    r.lines.some((l) => /held per application  Slate 23\/126 \(18\.3%\), cal\.com 15\/132 \(11\.4%\)/.test(l)),
    `held per application leaves out calls still ahead (${r.lines.filter((l) => /held per application/.test(l))[0]})`,
  );
  assert(r.lines.some((l) => /biased low/.test(l) && /less than its 7 days/.test(l)), "says the booking rate is biased low beside the numbers");
  assert(r.lines.some((l) => /call is still ahead/.test(l)), "and how the show rate treats calls not yet due");
  assert(r.lines.some((l) => /61\.5% of the way/.test(l) && /2026-10-10 03:00 ET/.test(l)), `says how much of the first full window is covered (${r.lines.filter((l) => /Coverage/.test(l))[0]})`);
  assert(r.lines.some((l) => /oldest application here has had 4\.96 of its 7 days/.test(l)), "and how long the oldest application has had");
  // #3073 (Dan, 2026-10-03): the partial look shows an early interval, worded as biased
  // low and never a result, so it carries no verdict, readout or days needed.
  assert(
    r.lines.some((l) => /booking rate/.test(l) && /early 95% interval/.test(l) && /biased low, not a result/.test(l)),
    `the booking rate carries an early interval worded as not a result (${r.lines.find((l) => /booking rate/.test(l))})`,
  );
  assert(
    r.lines.some((l) => /show rate \(held over booked\)/.test(l) && /early 95% interval|too few to estimate/.test(l)),
    `the show rate carries one too, or says it is too few (${r.lines.find((l) => /show rate \(held over booked\)/.test(l))})`,
  );
  assert(!r.lines.some((l) => /days needed|READOUT|PROVISIONAL|Slate higher|Slate lower|cannot be told apart/.test(l)), "and never a verdict, readout or days needed");
  // A show rate is not biased low (calls still ahead are left out, not counted as
  // missed), so its early interval says early, not biased low. A cohort big enough
  // that the show rate is readable proves the branch that prints one.
  const big = cohort(1500, { slate: [0.4, 0.6], calcom: [0.3, 0.5] });
  const bigSoFar = { ...big, calls: big.calls.filter((call) => Date.parse(call.startedAt) < now) };
  const bigRun = run(bigSoFar, { window: partialWindow });
  const showLine = bigRun.lines.find((l) => /show rate \(held over booked\)/.test(l)) ?? "";
  assert(/early 95% interval/.test(showLine) && /early, not a result/.test(showLine) && !/biased low/.test(showLine), `the show rate's early interval is not called biased low (${showLine})`);
  const bookLine = bigRun.lines.find((l) => /booking rate/.test(l)) ?? "";
  assert(/biased low, not a result/.test(bookLine), `while the booking rate's still is (${bookLine})`);
  eq(r.proposedReadout, null, "and never proposes a readout date");
  assert(r.lines.some((l) => /ASSUMED, NOT CHECKED/.test(l)) && r.lines.some((l) => /Compared:/.test(l)), "still states the assumption and the count");
  assert(clean(r.lines), "nothing renders undefined or NaN");

  const changed = run(sofar, { window: partialWindow, settings: { ...settingsOk, percent: 70 } });
  eq(changed.exit, PILOT_COMPARE_EXIT.partial, "a partial look stays partial when the settings now differ");
  assert(changed.lines.some((l) => /SETTINGS NOW DIFFER/.test(l)), "and the disagreement is still reported");

  const empty = run({ apps: [], slate: [], cal: [], calls: [] }, { window: partialWindow });
  eq(empty.exit, PILOT_COMPARE_EXIT.noApplications, "a partial look that found no application still refuses");
  // The refusal is decided on the exit code, so it holds whatever the wording says.
  for (const code of [PILOT_COMPARE_EXIT.compared, PILOT_COMPARE_EXIT.partial, PILOT_COMPARE_EXIT.provisional, PILOT_COMPARE_EXIT.tooFewToRead]) {
    eq(JUDGED_EXITS.has(code), true, `exit ${code} is a judgement, so a partial look relabels it partial`);
  }
  for (const code of [PILOT_COMPARE_EXIT.noApplications, PILOT_COMPARE_EXIT.emptyHalf, PILOT_COMPARE_EXIT.tooManyUnmatched, PILOT_COMPARE_EXIT.noCallsStored, PILOT_COMPARE_EXIT.inputUnreadable]) {
    eq(JUDGED_EXITS.has(code), false, `exit ${code} is a refusal, so a partial look keeps it`);
  }
}

// --- 7c. the split readings (#3641) -----------------------------------------------------------
// Every quarter hour the monitor lane stores what Salesforce held for the split, when it
// was read, and when the record holding it was last edited. The edit time is what lets a
// span with no readings be checked: a record not edited since the previous reading cannot
// have changed in between, however long the gap.
const reading = (readAt: number, over: Partial<PilotSettingsRow> = {}): PilotSettingsRow => ({
  sampled_at: iso(readAt),
  ok: true,
  read_at: iso(readAt),
  active: true,
  percent: 50,
  tiers: "1;2;3;4;5",
  record_modified_at: iso(WINDOW_START - 2 * D),
  error: null,
  ...over,
});
const failedReading = (at: number): PilotSettingsRow => ({
  sampled_at: iso(at),
  ok: false,
  read_at: null,
  active: null,
  percent: null,
  tiers: null,
  record_modified_at: null,
  error: "Salesforce answered 503",
});
const FROM = WINDOW_START;
const TO = WINDOW_START + 22 * D;
{
  // No readings: exactly the old assumption, so nothing claims a look that never happened.
  const none = checkSplitReadings([], FROM, TO);
  eq(none.status, "unchecked", "with no readings the split is unchecked");
  assert(hasAssumption(none.lines), "and the assumption is stated as before");

  // Every reading failed: still unchecked, and it says the readings failed.
  const allFailed = checkSplitReadings([failedReading(FROM + D), failedReading(FROM + 2 * D)], FROM, TO);
  eq(allFailed.status, "unchecked", "readings that all failed check nothing");
  assert(allFailed.lines.some((l) => /2 readings/.test(l) && /failed/.test(l)), "and say so rather than reading as no readings");

  // Readings start late, but the record was last edited before the window opened: the
  // whole window up to the last reading is checked, including the days before readings.
  const late = checkSplitReadings([reading(FROM + 11 * D), reading(FROM + 11 * D + 15 * 60_000), reading(FROM + 12 * D)], FROM, TO);
  eq(late.status, "checked", "readings that agree, with no edit inside the window, check the split");
  assert(late.lines.some((l) => /^CHECKED:/.test(l) && /3 readings/.test(l)), "and say how many readings");
  assert(late.lines.some((l) => l.includes("2026-10-02 00:00 ET") && l.includes("2026-10-14 00:00 ET")), "and that it held from the window's opening to the last reading");
  assert(late.lines.some((l) => /after .*assumed/i.test(l)), "and that after the last reading it is assumed");
  assert(!late.lines.some((l) => /ASSUMED, NOT CHECKED/.test(l)), "and the old assumption line is gone");

  // The 2026-10-12 shape: the record was edited inside the window before readings
  // began, and the readings agree. A change undone before that edit cannot be ruled
  // out, from the window's opening to the edit.
  const edit = FROM + 10 * D + 11 * H;
  const before = checkSplitReadings([reading(FROM + 11 * D, { record_modified_at: iso(edit) }), reading(FROM + 12 * D, { record_modified_at: iso(edit) })], FROM, TO);
  eq(before.status, "checked", "an edit with the split the same after it is not a change");
  assert(before.lines.some((l) => /^CHECKED IN PART:/.test(l)), "but the check is partial");
  assert(
    before.lines.some((l) => l.includes(`edited at ${"2026-10-12 11:00 ET"}`) && l.includes("unverified from 2026-10-02 00:00 ET to 2026-10-12 11:00 ET")),
    `and names the edit and the span it leaves unverified (${before.lines.join(" | ")})`,
  );

  // An edit between two readings that both agree: unverified only between the earlier
  // reading and the edit, and a gap with NO edit across it is checked however long.
  const a = FROM + 3 * D;
  const m = FROM + 5 * D;
  const between = checkSplitReadings(
    [reading(FROM + D), reading(a), failedReading(a + D), reading(FROM + 6 * D, { record_modified_at: iso(m) }), reading(FROM + 7 * D, { record_modified_at: iso(m) })],
    FROM,
    TO,
  );
  const unverified = between.lines.filter((l) => /unverified from/.test(l));
  eq(unverified.length, 1, `one edit, one unverified span (${between.lines.join(" | ")})`);
  assert(unverified[0]!.includes("unverified from 2026-10-05 00:00 ET to 2026-10-07 00:00 ET"), `from the reading before it to the edit (${unverified[0]})`);
  assert(between.lines.some((l) => /1 reading failed/.test(l)), "a failed reading is counted, not read as a split");

  // Two readings of one cached Salesforce read are one reading.
  const cached = checkSplitReadings([reading(FROM + D), { ...reading(FROM + D), sampled_at: iso(FROM + D + 15 * 60_000) }], FROM, TO);
  assert(cached.lines.some((l) => /^CHECKED:/.test(l) && /1 reading /.test(l)), `a reading served twice from the cache counts once (${cached.lines.join(" | ")})`);

  // A reading that disagrees is a change inside the window, named with when.
  const changed = checkSplitReadings(
    [reading(FROM + D), reading(FROM + 2 * D, { percent: 70, record_modified_at: iso(FROM + 2 * D - H) }), reading(FROM + 3 * D, { percent: 70, record_modified_at: iso(FROM + 2 * D - H) }), reading(FROM + 4 * D, { record_modified_at: iso(FROM + 4 * D - H) })],
    FROM,
    TO,
  );
  eq(changed.status, "changed", "a reading off the assumed split is a change");
  assert(
    changed.lines.some((l) => /^THE SPLIT CHANGED/.test(l) && /SlatePilotPercent__c is 70/.test(l) && l.includes("2026-10-04 00:00 ET") && l.includes("2026-10-05 00:00 ET")),
    `naming the field and the readings that saw it (${changed.lines.join(" | ")})`,
  );
  const off = checkSplitReadings([reading(FROM + D, { active: false })], FROM, TO);
  eq(off.status, "changed", "the pilot switched off is a change");
  const unreadablePercent = checkSplitReadings([reading(FROM + D, { percent: null })], FROM, TO);
  eq(unreadablePercent.status, "changed", "a percent Salesforce sent unreadable is not the assumed split");

  // An unreadable stamp is counted, never compared (L50).
  eq(checkSplitReadings([reading(FROM + D, { read_at: "soon" })], FROM, TO).unreadable, 1, "an unreadable read time is counted as unreadable");
  for (const r of [none, allFailed, late, before, between, cached, changed]) assert(clean(r.lines), "nothing renders undefined or NaN");
}
{
  // Through the whole judgement: a change has its own exit, after a rehearsal and before
  // the settings now differing, with the comparison still printed.
  const full = cohort(400, { slate: [0.4, 0.6], calcom: [0.3, 0.5] });
  const changedReadings = [reading(FROM + D), reading(FROM + 2 * D, { percent: 70, record_modified_at: iso(FROM + 2 * D - H) })];
  const readout = { readout: { date: "2026-10-16", reached: true } };
  const r = run(full, { window: readout, readings: changedReadings });
  eq(r.exit, PILOT_COMPARE_EXIT.splitChanged, "a change inside the window has its own exit");
  assert(r.lines.some((l) => /^THE SPLIT CHANGED/.test(l)) && r.lines.some((l) => /  booking rate/.test(l)), "and the comparison is still printed beside it");
  eq(run(full, { window: readout, readings: changedReadings, settings: { ...settingsOk, percent: 70 } }).exit, PILOT_COMPARE_EXIT.splitChanged, "it outranks the settings differing now");
  eq(run(full, { window: { ...readout, rehearsal: true }, readings: changedReadings }).exit, PILOT_COMPARE_EXIT.rehearsal, "a rehearsal stays a rehearsal");
  eq(JUDGED_EXITS.has(PILOT_COMPARE_EXIT.splitChanged), true, "it is a judgement, not a refusal");

  const ok = run(full, { window: readout, readings: [reading(FROM + D), reading(FROM + 20 * D)] });
  eq(ok.exit, PILOT_COMPARE_EXIT.compared, "readings that agree leave the readout a readout");
  assert(ok.lines.some((l) => /^CHECKED:/.test(l)) && !hasAssumption(ok.lines), "and the run says the split was checked, not assumed");

  const reh = run(full, { window: { rehearsal: true }, readings: [reading(FROM + D)] });
  assert(hasAssumption(reh.lines) && !reh.lines.some((l) => /^CHECKED/.test(l)), "a rehearsal's days are before any reading, so it keeps the assumption");

  const bad = run(full, { window: readout, readings: [reading(FROM + D, { record_modified_at: "never" })] });
  eq(bad.exit, PILOT_COMPARE_EXIT.inputUnreadable, "an unreadable reading refuses the run like any unreadable time");
}

{
  // The command's read of the stored readings (#3641): the rows pass through as read,
  // and a failed read REFUSES on exit 5, never an empty list, because no readings is the
  // old assumption and an unreadable table must not pass for one holding nothing.
  const rows = [reading(FROM + D)];
  const got = await readSplitReadings(async () => rows);
  eq(got, { ok: true, rows }, "readings that can be read pass through");
  const failedRead = await readSplitReadings(async () => {
    throw new Error("relation pilot_settings_samples does not exist");
  });
  assert(!failedRead.ok, "a failed read is not a list");
  if (!failedRead.ok) {
    eq(failedRead.exit, PILOT_COMPARE_EXIT.slateUnreadable, "it refuses on exit 5");
    assert(failedRead.lines[0]!.includes("stored readings of the split could not be read") && failedRead.lines[0]!.includes("does not exist"), "naming what could not be read and why");
    assert(failedRead.lines.some((l) => /^Compared: nothing/.test(l)), "and that nothing was compared");
  }
}

// --- 7b. an unreadable instant is refused, never compared (L50) ---------------------------------
{
  // A NaN compares false against everything: an application would silently leave the
  // cohort, a booking would attach to any span, a call would quietly be no show.
  const c = cohort(150, { slate: [0.4, 0.6], calcom: [0.3, 0.5] });
  const badApp = run({ ...c, apps: [...c.apps, app("slate", { createdAt: "not a date" })] });
  eq(badApp.exit, PILOT_COMPARE_EXIT.inputUnreadable, "an application whose creation time cannot be read refuses the run");
  assert(badApp.lines.some((l) => /1 row/.test(l) && /could not be read/.test(l)), `and counts it (${badApp.lines[0]})`);
  const badBooking = run({ ...c, slate: [...c.slate, slateRow(c.apps[0], { startsAt: "soon" })] });
  eq(badBooking.exit, PILOT_COMPARE_EXIT.inputUnreadable, "a booking whose start cannot be read refuses the run");
  // An application read only by email (made before the window) is matched on its
  // creation time too, so an unreadable one would drop a contact match in silence.
  const badContact = run(c, { contact: [app("calcom", { createdAt: "yesterday-ish" })] });
  eq(badContact.exit, PILOT_COMPARE_EXIT.inputUnreadable, "an application read by email whose creation time cannot be read refuses the run");
  const dupBad = app("slate", { createdAt: "not a date" });
  const once = run({ ...c, apps: [...c.apps, dupBad] }, { contact: [dupBad] });
  assert(once.lines.some((l) => /FAILED \(input-unreadable\): 1 row /.test(l)), `one application in both lists is counted once (${once.lines[0]})`);
  const badCall = run({ ...c, calls: [...c.calls, { ...c.calls[0], startedAt: "later" }] });
  eq(badCall.exit, PILOT_COMPARE_EXIT.inputUnreadable, "a call whose start cannot be read refuses the run");
}

// --- 8. the Salesforce reads refuse a short answer ----------------------------------------------
{
  const pages = (list: SoqlPage<{ Id: string }>[]) => {
    let i = 0;
    const asked: (string | null)[] = [];
    return {
      asked,
      get: async (path: string | null) => {
        asked.push(path);
        return list[i++];
      },
    };
  };
  const two = pages([
    { totalSize: 3, done: false, nextRecordsUrl: "/next/1", records: [{ Id: "a" }, { Id: "b" }] },
    { done: true, records: [{ Id: "c" }] },
  ]);
  eq((await collectSoqlComplete(two.get)).map((r) => r.Id), ["a", "b", "c"], "every page is followed to the end");
  eq(two.asked, [null, "/next/1"], "by the next records path Salesforce gives");

  const rejects = async (list: SoqlPage<{ Id: string }>[]) => {
    try {
      await collectSoqlComplete(pages(list).get);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };
  const shortRead = await rejects([{ totalSize: 5, done: true, records: [{ Id: "a" }] }]);
  assert(shortRead !== null && /1 records of the 5/.test(shortRead), `a read that ends short of its totalSize is refused, never returned (${shortRead})`);
  const noTotal = await rejects([{ done: true, records: [] }]);
  assert(noTotal !== null && /totalSize/.test(noTotal), "an answer with no totalSize is refused: a short read could not be seen");
  eq(await rejects([{ totalSize: 0, done: true, records: [] }]), null, "an answer that promised none and gave none is a real empty");

  eq(
    settingsFromRecords([{ SlatePilotActive__c: true, SlatePilotPercent__c: 50, SlatePilotTiers__c: "1;2;3;4;5", LastModifiedDate: "2026-10-01T15:41:16.000+0000" }]),
    { active: true, percent: 50, tiers: "1;2;3;4;5", lastModified: "2026-10-01T15:41:16.000+0000" },
    "the one configuration record reads as it is",
  );
  eq(settingsFromRecords([{ SlatePilotPercent__c: "50" }]).percent, null, "a value of the wrong type is unknown, never coerced");
  let threw = 0;
  for (const records of [[], [{}, {}]]) {
    try {
      settingsFromRecords(records);
    } catch {
      threw++;
    }
  }
  eq(threw, 2, "no record, or two, is refused: the settings are read from exactly one");
}

// --- #3695: the contact read has its own time limit, and says how far it got -------------
{
  // The contact read filters on Email_SO__c, which is not selective, so one batch can
  // run past the 10 s each Salesforce attempt is given by default; on 2026-10-13 two
  // runs died that way. The limit passed to querySoqlComplete must be the one used: a
  // hung Salesforce given 5 ms fails at once, where the default would hold this suite.
  const hung: typeof fetch = (_url, init) =>
    new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
  let caught: unknown = null;
  const startedAt = Date.now();
  // AbortSignal.timeout's timer does not hold the process open, so without a timer
  // that does, node would exit on an empty loop before the limit ever fired.
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    await querySoqlComplete("https://sf.example", "token", "SELECT Id FROM Submission__c", {
      timeoutMs: 5,
      maxAttempts: 1,
      fetchImpl: hung,
      sleep: async () => {},
    });
  } catch (err) {
    caught = err;
  } finally {
    clearInterval(keepAlive);
  }
  eq((caught as { name?: unknown } | null)?.name, "TimeoutError", "a hung read ends on the time limit it was given");
  assert(Date.now() - startedAt < SF_TIMEOUT_MS, "the limit passed in is the one used, not the 10 s default");
  assert(CONTACT_READ_TIMEOUT_MS > SF_TIMEOUT_MS, "the contact read is given longer than an ordinary Salesforce attempt");

  // Every batch read: the records come back in batch order.
  const all = await readEveryBatch(["a", "b", "c"], async (b) => [`${b}1`, `${b}2`]);
  eq(all, ["a1", "a2", "b1", "b2", "c1", "c2"], "every batch's records are returned, in order");

  // A batch that fails refuses the whole read, never a short one, and says how far it got.
  const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  let refused: unknown = null;
  const readCalls: string[] = [];
  try {
    await readEveryBatch(["a", "b", "c", "d"], async (b) => {
      readCalls.push(b);
      if (b === "c") throw timeout;
      return [b];
    });
  } catch (err) {
    refused = err;
  }
  const message = refused instanceof Error ? refused.message : "";
  assert(message.includes("batch 3 of 4"), `the refusal names the batch that failed: ${message}`);
  assert(message.includes("2 of 4 batches were read"), `the refusal says how many were read first: ${message}`);
  assert(message.includes("aborted due to timeout"), `the refusal keeps Salesforce's own reason: ${message}`);
  eq(readCalls, ["a", "b", "c"], "nothing after the failed batch is read");
}

// --- #3701: results by where the application came from -----------------------------------
{
  eq(sourceGroup("trypennie.com"), "form", "an application made on the trypennie.com form is a form application");
  eq(sourceGroup("Engine"), "partner", "an application a partner sent in is a partner application");
  eq(sourceGroup(null), "partner", "one with no source is counted with partners and other sources, never dropped");
  eq(new Date(PORTAL_FIX_MS).toISOString(), "2026-10-04T20:03:19.000Z", "the offer portal fix is pinned to its production deploy (trypennie #522)");

  // A window that opens before the fix reports partners both ways (Dan, 2026-10-13);
  // one that opens after it has only one partner cut, and says nothing about the fix.
  const before = sourceCuts(windowAt()).map((c) => c.label);
  eq(before.length, 3, `a window opening before the fix has three cuts: ${before.join(" | ")}`);
  assert(before[0] === "trypennie.com form applications", `the form cut comes first: ${before[0]}`);
  assert(/^Partner and other applications, from 2026-10-02 00:00 ET/.test(before[1] ?? ""), `partners from the window start: ${before[1]}`);
  assert(/^Partner and other applications, from the offer portal fix at 2026-10-04 16:03 ET/.test(before[2] ?? ""), `partners from the fix: ${before[2]}`);
  const after = sourceCuts(windowAt({ startMs: Date.parse("2026-10-05T04:00:00Z") })).map((c) => c.label);
  eq(after.length, 2, `a window opening after the fix has one partner cut: ${after.join(" | ")}`);
  assert(!after.some((l) => /fix/.test(l)), "and does not mention the fix");

  // The whole judgement: form applications favour Slate, partner ones favour cal.com.
  // Partner applications made on days 0 to 2 (Oct 2 to Oct 4 01:00 ET) are before the
  // fix, so the cut from the fix keeps the 210 a side made from day 3.
  const form = cohort(300, { slate: [0.45, 0.6], calcom: [0.3, 0.6] });
  const partner = cohort(300, { slate: [0.2, 0.6], calcom: [0.25, 0.6] }, "Engine");
  const both = { apps: [...form.apps, ...partner.apps], slate: [...form.slate, ...partner.slate], cal: [...form.cal, ...partner.cal], calls: [...form.calls, ...partner.calls] };
  const r = run(both);
  const at = r.lines.findIndex((l) => l.startsWith("By where the application came from"));
  assert(at > 0, "the run reports by where the application came from");
  const blockAfter = (label: RegExp) => {
    const i = r.lines.findIndex((l, n) => n > at && label.test(l));
    return i < 0 ? "" : (r.lines[i + 2] ?? "");
  };
  const formRate = blockAfter(/^trypennie\.com form applications:/);
  assert(/Slate 135\/300 .*cal\.com 90\/300/.test(formRate), `form booking rate: ${formRate}`);
  const partnerAll = blockAfter(/^Partner and other applications, from 2026-10-02 00:00 ET/);
  assert(/Slate 60\/300 .*cal\.com 75\/300/.test(partnerAll), `partners from the window start: ${partnerAll}`);
  const partnerFix = blockAfter(/^Partner and other applications, from the offer portal fix/);
  assert(/Slate 42\/210 .*cal\.com 51\/210/.test(partnerFix), `partners from the fix: ${partnerFix}`);
  assert(r.lines.some((l) => /showed cal\.com to partner leads on Slate's side/.test(l)), "the run says why partners are also reported from the fix");
  assert(clean(r.lines), "no undefined or NaN in the by source lines");
  eq(r.exit, run({ apps: both.apps.map((a) => ({ ...a, source: null })), slate: both.slate, cal: both.cal, calls: both.calls }).exit, "the source cuts never change how the run exits");
}

// --- #3698: a booking update through yesterday --------------------------------------------
{
  const UPDATE = { PILOT_COMPARE_BOOKING_UPDATE: "1" };
  const now = WINDOW_START + 11 * D + 15 * H;
  const u = planWindow(now, UPDATE);
  assert(u.ok, "an update plans a window");
  if (u.ok) {
    eq(u.window.spanMs, D, "an update counts bookings made within 24 hours of the application");
    eq(u.window.cohortEndMs, now - D - JUDGE_GRACE_MS, "its cohort runs to the last application whose 24 hours and grace have passed");
    eq(u.window.update?.referenceEndMs ?? null, etDayFloorMs(now - SPAN_DAYS * D - JUDGE_GRACE_MS), "it measures the 24 hour window against the newest closed 7 day cohort");
    eq(u.window.readout.date, null, "an update is never a readout");
    eq(u.window.rehearsal || u.window.partial, false, "nor a rehearsal or a partial look");
  }
  const early = planWindow(WINDOW_START + 3 * D, UPDATE);
  eq(early.ok ? early.window.update?.referenceEndMs ?? null : "refused", null, "before any 7 day cohort has closed there is nothing to measure the window against");
  const tooSoon = planWindow(WINDOW_START + 20 * H, UPDATE);
  eq(tooSoon.ok ? "planned" : tooSoon.exit, PILOT_COMPARE_EXIT.windowNotOpen, "before any 24 hours have passed an update refuses, never a partial look");
  const typo = planWindow(now, { PILOT_COMPARE_BOOKING_UPDATE: "yes" });
  eq(typo.ok ? "planned" : typo.exit, PILOT_COMPARE_EXIT.inputUnreadable, "anything but 1 is refused rather than read as off");
  const both = planWindow(now, { ...UPDATE, PILOT_COMPARE_REHEARSAL_START: "2026-09-30" });
  eq(both.ok ? "planned" : both.exit, PILOT_COMPARE_EXIT.inputUnreadable, "an update and a rehearsal cannot be combined");

  // How much a 24 hour window misses, measured where 7 days have closed. Slate's side
  // books 40 of 100, ten of them after the first day; cal.com's 30, three after it.
  const apps: Application[] = [];
  const slate: SlateBookingRow[] = [];
  const cal: CalcomListedBooking[] = [];
  for (const side of ["slate", "calcom"] as const) {
    for (let i = 0; i < 100; i++) {
      const a = app(side, { createdAt: iso(WINDOW_START + (i % 4) * D + H) });
      apps.push(a);
      const late = side === "slate" ? i >= 30 && i < 40 : i >= 27 && i < 30;
      const booked = side === "slate" ? i < 40 : i < 30;
      if (!booked) continue;
      const madeMs = Date.parse(a.createdAt) + (late ? 3 * D : H);
      if (side === "slate") slate.push(slateRow(a, { createdAt: iso(madeMs), startsAt: iso(madeMs + D) }));
      else cal.push(calRow({ submissionId: a.id, createdAt: iso(madeMs), start: iso(madeMs + D) }));
    }
  }
  const referenceWindow = windowAt({ cohortEndMs: WINDOW_START + 4 * D });
  const reference = matchBookings({ window: referenceWindow, applications: apps, contactApplications: [], slate, calcom: cal });
  const caught = bookingWindowCatch(reference, D);
  eq(caught.slate, { within: 30, booked: 40 }, "on Slate's side 30 of 40 bookings came within 24 hours");
  eq(caught.calcom, { within: 27, booked: 30 }, "on cal.com's side 27 of 30");

  // The judgement: bookings only, every line labelled, its own exit, and no call store
  // refusal, since an update reads no calls.
  const c = cohort(300, { slate: [0.4, 0.6], calcom: [0.3, 0.5] });
  const updateWindow = windowAt({ spanMs: D, update: { referenceEndMs: WINDOW_START + 4 * D } });
  const r = run(c, { window: updateWindow, storedInSpan: 0, storeBeganMs: null, reference: { ...reference, apps: reference.apps } });
  eq(r.exit, PILOT_COMPARE_EXIT.bookingUpdate, "an update exits on its own code");
  assert(r.lines.every((l) => l.startsWith("[UPDATE] ")), "every line says it is an update");
  assert(!r.lines.some((l) => /^\[UPDATE\] +(held per application|show rate)\b|A show is one/.test(l)), "no held call or show rate figures are printed");
  assert(r.lines.some((l) => /booking rate  Slate 120\/300 .*cal\.com 90\/300/.test(l)), "the booking rate is");
  assert(r.lines.some((l) => /A 24 hour window caught 30 of 40 bookings on Slate's side \(75\.0%\) and 27 of 30 on cal\.com's \(90\.0%\)/.test(l)), "and how much the 24 hour window misses");
  assert(r.lines.some((l) => /BOOKING UPDATE: not a readout/.test(l)), "and that it is not a readout");
  assert(clean(r.lines), "no undefined or NaN in an update");
  const unmeasured = run(c, { window: updateWindow, storedInSpan: 0, storeBeganMs: null, reference: null });
  assert(unmeasured.lines.some((l) => /not measured yet/.test(l)), "with no closed 7 day cohort the miss is said to be unmeasured, never zero");
  const changed = run(c, { window: updateWindow, storedInSpan: 0, storeBeganMs: null, readings: [reading(WINDOW_START + D, { percent: 70, record_modified_at: iso(WINDOW_START + D - H) })] });
  eq(changed.exit, PILOT_COMPARE_EXIT.splitChanged, "a split change inside the window still has its own exit in an update");
  eq(JUDGED_EXITS.has(PILOT_COMPARE_EXIT.bookingUpdate), true, "an update is a judgement, not a refusal");
}

// --- #3718: applications that booked through a landing page's inline card -----------------
// Those pages always offer Slate, so an application that booked on one is not part of the
// split. The WHOLE application leaves the cohort, on whichever side its hash put it, along
// with every booking it made: dropping only the booking row would leave a cal.com side
// application reading as one that never booked, understating cal.com's booking rate.
{
  const w = windowAt();
  const viaCardSlateSide = app("slate");
  const viaCardCalSide = app("calcom");
  const plain = app("slate");
  const m = matchBookings({
    window: w,
    applications: [viaCardSlateSide, viaCardCalSide, plain],
    contactApplications: [],
    slate: [
      slateRow(viaCardSlateSide, { inlineCard: true }),
      slateRow(viaCardCalSide, { inlineCard: true }),
      slateRow(plain),
    ],
    calcom: [calRow({ submissionId: viaCardCalSide.id })],
  });
  eq(m.apps.map((a) => a.key), [plain.id.slice(0, 15)], "an application that booked through the inline card leaves the cohort, on either side");
  eq(m.counts.inlineCardApps, 2, "and how many left is counted");
  eq(m.counts.outsideCohort, 0, "its bookings, the cal.com one included, are not then read as bookings by an application outside the cohort");
  // One made before the window was never in the cohort, so nothing left it: its
  // booking is outside the cohort as any other, and is not silently dropped.
  const older = app("slate", { createdAt: iso(WINDOW_START - 3 * D) });
  const m2 = matchBookings({ window: w, applications: [older, plain], contactApplications: [], slate: [slateRow(older, { inlineCard: true }), slateRow(plain)], calcom: [] });
  eq([m2.counts.inlineCardApps, m2.counts.outsideCohort], [0, 1], "an inline card booking by an application outside the cohort is counted outside it, never dropped");
  // On a realistic cohort, so the run judges rather than refusing for an empty side.
  const c = cohort(60, { slate: [0.5, 0.6], calcom: [0.5, 0.6] });
  c.apps.push(viaCardSlateSide, viaCardCalSide);
  c.slate.push(slateRow(viaCardSlateSide, { inlineCard: true }), slateRow(viaCardCalSide, { inlineCard: true }));
  c.cal.push(calRow({ submissionId: viaCardCalSide.id }));
  const out = run(c);
  assert(
    out.lines.some((l) => /2 applications that booked through a landing page's inline card/.test(l)),
    "the readout says how many it left out, so the exclusion is visible",
  );
}

// #2974: a Slate booking made from a development host (a localhost page,
// dev.trypennie.com) on a real bucket is test traffic, judged by the shared predicate
// when the report reads it. It is left out as a BOOKING (the application it names is
// judged as if it never booked on Slate), and the readout counts it, so a real page
// misclassified as a development host is visible rather than silently dropped.
{
  const w = windowAt();
  const tested = app("slate");
  const plain = app("slate");
  const m = matchBookings({
    window: w,
    applications: [tested, plain],
    contactApplications: [],
    slate: [slateRow(tested, { testSource: true }), slateRow(plain)],
    calcom: [],
  });
  eq(m.counts.testSourceBookings, 1, "a development host's booking is counted as left out");
  eq(m.counts.byId, 1, "and is never tied to its application");
  const testedApp = m.apps.find((a) => a.key === tested.id.slice(0, 15));
  eq(testedApp?.chains.length ?? -1, 0, "its application reads as one that did not book on Slate");
  // A development host booking through the inline card is test traffic first: it never
  // takes its application out of the cohort as an inline card booking would.
  const viaDevCard = app("slate");
  const m3 = matchBookings({
    window: w,
    applications: [viaDevCard, plain],
    contactApplications: [],
    slate: [slateRow(viaDevCard, { testSource: true, inlineCard: true }), slateRow(plain)],
    calcom: [],
  });
  eq([m3.counts.testSourceBookings, m3.counts.inlineCardApps], [1, 0], "a development host booking never removes its application as an inline card one");
  assert(m3.apps.some((a) => a.key === viaDevCard.id.slice(0, 15)), "and that application stays in the cohort");
  const c = cohort(60, { slate: [0.5, 0.6], calcom: [0.5, 0.6] });
  c.slate.push(slateRow(c.apps[0], { id: "dev-host", testSource: true }));
  const out = run(c);
  assert(
    out.lines.some((l) => /1 Slate booking made from a development host/.test(l)),
    "the readout says how many development host bookings it left out",
  );
}

finish();
