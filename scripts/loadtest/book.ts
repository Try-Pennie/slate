// Drives the booking API against a seeded (isolated) branch at ten times the
// booking path's peak (#2243).
//
// The July soak (#440) drove the cron lanes and never confirmed a single booking,
// so the path a lead actually takes has never been under load. This is the driver
// that does it: four of these run together, each reading availability, picking a
// time at random from what was offered, and posting a booking.
//
// It refuses to touch production, and that is the first thing it checks.
//
// Run (one driver, from the workflow or by hand):
//   SLATE_BASE=https://<loadtest>.workers.dev BOOKING_API_KEY=<key> \
//   RUN_ID=<run> DRIVER=0 OUT=results/driver-0.json \
//   node --experimental-strip-types scripts/loadtest/book.ts
//
// Burst mode adds BURST_PLAN: the two sibling codes, and each of the run's bursts'
// slot and moment, all chosen ONCE by the setup step and handed to every driver,
// because a burst whose drivers each chose their own time is not a burst (#3325).
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  requestSchedule,
  availabilityRefreshMs,
  offeredSlots,
  shownTierOf,
  burstReadiness,
  waitForBurstMoment,
  attemptIdentity,
  type LoadtestLead,
  pickSlot,
  driverDeadlineMs,
  effectiveDeadlineMs,
  deadlineReached,
  requestAbortMs,
  faultMinutesFrom,
  readBurstPlan,
  burstCodeFor,
  burstLegOut,
  burstRequestNumbers,
  burstSettleAtMs,
  readDriverMode,
  readBurstGraceMs,
  settleLater,
  bookingRequestHeaders,
  bookingBody,
  BURST_PROBE_TIMEOUT_MS,
  DRIVERS,
  PER_DRIVER_PER_MINUTE,
  REQUEST_TIMEOUT_MS,
  RUN_MINUTES,
  type BookingAttempt,
  type BurstLegRecord,
  type DriverResult,
  type PlannedBurst,
  slotViewIsFresh,
  slotViewAfterRead,
  type SlotView,
} from "./book-plan.ts";
import { readBurstProbe, readCrowdRule, type BurstProbe, type CrowdRuleReading } from "./burst-probe.ts";
import { AVAILABILITY_UNREAD, NO_SLOTS_OFFERED, TIMED_OUT } from "./outcomes.ts";
import {
  faultModeVerdict,
  faultPollStep,
  FAULT_PROPAGATION_DEADLINE_MS,
  type FaultModeVerdict,
} from "./preflight-checks.ts";
import { parseFaultTargets } from "../../src/lib/loadtest-fault.ts";
import { BASELINE_BOOKINGS, BASELINE_PER_MINUTE } from "./latency-bar.ts";
import { readLoadtestEcho, type LoadtestEcho } from "../../src/lib/loadtest-echo.ts";

const PROD_HOSTS = ["slate.trypennie.app", "drukfvgaynzrralbzkzj.supabase.co"];

function need(name: string): string {
  const v = (process.env[name] ?? "").trim();
  if (!v) {
    console.error(`FAILED: ${name} is not set, so nothing was attempted.`);
    process.exit(1);
  }
  return v;
}

const SLATE_BASE = need("SLATE_BASE").replace(/\/$/, "");
const API_KEY = need("BOOKING_API_KEY");
const RUN_ID = need("RUN_ID");
const DRIVER = Number(process.env.DRIVER ?? "0");
const OUT = need("OUT");
// The burst settings are all optional and all default to what the run uses. They
// are declared rather than wired because the steady job never sets them: a step
// carrying five variables it does not use reads as configuration somebody chose.
// env-ok: MODE (optional; defaults to steady; only the burst, fault and baseline jobs set it)
const modeRead = readDriverMode(process.env.MODE);
if (!modeRead.ok) {
  console.error(`FAILED: ${modeRead.why}, so nothing was attempted.`);
  process.exit(1);
}
const MODE = modeRead.mode;
// env-ok: BURST_GRACE_MS (optional; defaults to 2000, how late a driver may be and
// still be part of the same burst)
const graceRead = readBurstGraceMs(process.env.BURST_GRACE_MS);
if (!graceRead.ok) {
  console.error(`FAILED: ${graceRead.why}, so nothing was attempted.`);
  process.exit(1);
}
const BURST_GRACE_MS = graceRead.ms;
// env-ok: BURST_SETTLE_MS (optional; a test seam that can only SHORTEN how long after a
// burst's moment the driver waits before probing its slot, #3429)
const BURST_SETTLE_OVERRIDE = process.env.BURST_SETTLE_MS;
// env-ok: FAULT_PCT (required in fault mode only; the percentage the deployment
// was redeployed with, which the driver then CONFIRMS with the deployment itself)
// env-ok: FAULT_MINUTES (optional; defaults to 2, long enough for the bar to have
// a real sample and short enough that a faulted deployment is not live for long)
// env-ok: FAULT_TARGETS (optional; the systems the fault leg asked the deployment
// to fail, defaulting to google-read like the deployment's own setting, and
// CONFIRMED with the deployment exactly as the percentage is, #3104)
// env-ok: FAULT_COMMIT (optional; the commit the fault leg deployed, checked
// against what the deployment reports so a redeploy that did not take is caught)
// env-ok: TZ_NAME (optional; defaults to America/New_York, the zone the seeded
// roster's largest group keeps)
const TIMEZONE = process.env.TZ_NAME ?? "America/New_York";
// env-ok: DRIVE_DEADLINE_MS (optional; a test seam that can only SHORTEN the
// deadline derived from the plan, never lengthen it past the job's timeout)
const DEADLINE_OVERRIDE = process.env.DRIVE_DEADLINE_MS;
// env-ok: DRIVE_REQUEST_TIMEOUT_MS (optional; a test seam that can only SHORTEN one
// request's abort bound, so a test can watch a hung request time out in milliseconds)
const REQUEST_TIMEOUT_OVERRIDE = process.env.DRIVE_REQUEST_TIMEOUT_MS;
// env-ok: DRIVE_AVAILABILITY_TIMEOUT_MS (optional; the same seam for the availability
// read alone, #3348, so a test shortening the booking request's bound does not also
// race the slot read against a loaded runner)
const AVAILABILITY_TIMEOUT_OVERRIDE = process.env.DRIVE_AVAILABILITY_TIMEOUT_MS;

/**
 * The abort signal for one request (#3222). Bounded by its own timeout and by the
 * driver's deadline plus the overrun, so a request that never answers cannot keep
 * the driver from writing its file before the job's timeout kills it.
 *
 * The override is REQUIRED, with no default: each request's own seam is passed
 * explicitly. A default parameter would replace the availability read's override with
 * the booking request's whenever the first is unset, because a default applies to an
 * argument passed as undefined (L394), and that put the slot read back on the booking's
 * 300ms test bound (#3348).
 */
function requestSignal(deadlineAtMs: number, override: string | undefined): AbortSignal {
  return AbortSignal.timeout(effectiveDeadlineMs(requestAbortMs({ nowMs: Date.now(), deadlineAtMs }), override));
}

/** Whether a fetch failed because its own abort bound fired. */
function timedOut(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

// A load run points at an isolated deployment and an isolated branch. Refusing
// production by NAME rather than by a flag, because the flag would be the thing
// somebody set wrong at 2am: this writes real bookings, sends real invites, and
// fires real webhooks.
for (const host of PROD_HOSTS) {
  if (SLATE_BASE.includes(host)) {
    console.error(
      `FAILED: SLATE_BASE points at production (${host}). This driver creates real bookings and ` +
        "webhooks; point it at the loadtest deployment.",
    );
    process.exit(1);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const slotCache = new Map<string, SlotView>();
/**
 * #3495: the tier each code's last answered availability read had on show, handed back
 * with its bookings as the booker does. Kept beside the slot view rather than in it, and
 * refreshed only by a read that answered, as the view is.
 */
const shownTiers = new Map<string, string | null>();
const REFRESH_MS = availabilityRefreshMs(DRIVERS);

/**
 * The times a bucket is offering, cached per code, or null when they could not be
 * read at all (#3348).
 *
 * Cached because the availability ceiling is 30 a minute PER ADDRESS and four
 * drivers share one, so a read before every booking would spend four times the
 * budget and the run would be measuring the limiter. The cache is refreshed on a
 * pace derived from that same ceiling.
 *
 * Null when no read has answered yet: a refused, timed out or failed FIRST read is not
 * a bucket offering nothing, and is recorded as its own outcome. That unread view is
 * cached and refreshed at the same pace as any other (`slotViewAfterRead`), so one 429
 * against the shared ceiling is not followed by a read on every request.
 */
async function slotsFor(code: string, nowMs: number, deadlineAtMs: number): Promise<string[] | null> {
  const cached = slotCache.get(code);
  if (slotViewIsFresh(cached, nowMs, REFRESH_MS)) return cached!.slots;
  // The PARSE is deliberately outside the catch below. A read that failed and a
  // response whose shape we cannot read are different facts: the first is a 429 or
  // a blip the run should ride out on its cached view, and the second is a defect
  // that would otherwise arrive as "this bucket offers nothing" on every request
  // for the whole run (#2261).
  let payload: unknown = null;
  try {
    const res = await fetch(`${SLATE_BASE}/api/availability?bucket=${encodeURIComponent(code)}`, {
      signal: requestSignal(deadlineAtMs, AVAILABILITY_TIMEOUT_OVERRIDE),
    });
    if (res.ok) payload = await res.json();
    if (payload !== null) shownTiers.set(code, shownTierOf(payload));
    // A refused or unreadable read KEEPS the previous view rather than emptying it.
    // An empty list means "this bucket offers nothing", which is a real state the
    // run should be able to record; a 429 means "we asked too often", and turning
    // that into the same empty list would make the run report a dead bucket.
  } catch {
    // Same reasoning: a transport fault leaves the last known view in place.
  }
  // Outside the catch ON PURPOSE: `offeredSlots` throws on a payload it cannot
  // read, and that must end the driver rather than resolve to the empty list every
  // caller treats as "this bucket offers nothing".
  const view = slotViewAfterRead(cached, payload !== null ? offeredSlots(payload) : null, nowMs);
  slotCache.set(code, view);
  return view.slots;
}

async function book(req: {
  code: string;
  startIso: string;
  /** The attempt, which its external id, address, number and `n` all come from (#3447). */
  lead: LoadtestLead;
  /** The driver's own deadline, or Infinity for the burst, which has none. */
  deadlineAtMs: number;
  /** #3495: the tier the code had on show, handed back; null leaves the confirm to read it. */
  shownTier: string | null;
}): Promise<BookingAttempt> {
  // Built before the try, as the ceiling control's is (#3447): a lead outside the
  // phone's digits stops the driver here, by name, rather than being recorded as a
  // request that failed in transit.
  const requestBody = JSON.stringify(
    bookingBody({ code: req.code, startIso: req.startIso, lead: req.lead, timezone: TIMEZONE, shownTier: req.shownTier }),
  );
  const sentAtMs = Date.now();
  const t0 = performance.now();
  let status = 0;
  let outcome: string | null = null;
  let seenIp: string | null = null;
  let echo: LoadtestEcho | null = null;
  // #3429: which rung took a 200, from the body's own `bucket.rungsDropped`.
  let rungsDropped: number | null | undefined;
  try {
    const res = await fetch(`${SLATE_BASE}/api/bookings`, {
      signal: requestSignal(req.deadlineAtMs, REQUEST_TIMEOUT_OVERRIDE),
      method: "POST",
      // #3354: the leg rides on every confirm, so the run can say where each cold one came from.
      headers: bookingRequestHeaders(API_KEY, MODE),
      body: requestBody,
    });
    status = res.status;
    // The address Slate SAW, echoed on the loadtest path only. Attributing a write
    // 429 needs the address the ceiling was applied to, not the one the runner
    // believes it has: a CI runner behind egress NAT shares an address with
    // everything else on it.
    seenIp = res.headers.get("x-loadtest-seen-ip");
    // Which confirm line served this, why, under which key, the time the line added,
    // and when the deployment built the answer (#3325), through the one parser the
    // deployment's own builders are tested against (L41). A header it does not know
    // is recorded as UNREADABLE with what was sent, never dropped and never a value.
    echo = readLoadtestEcho(res.headers);
    // An unreadable body is null, but an ABORT while reading it is not: the headers
    // arrived and the body never did, which is a timeout, never a 200 with no
    // outcome (#3222). Rethrown to the catch below, which records it as one.
    const body = (await res.json().catch((err: unknown) => {
      if (timedOut(err)) throw err;
      return null;
    })) as { outcome?: string; code?: string; bucket?: { rungsDropped?: unknown } } | null;
    outcome = body?.outcome ?? body?.code ?? null;
    // #3429: on a 200 only, and a figure the body does not carry is null, never 0: the
    // drop burst reads "dropped" from it, and a missing one must not read as either.
    if (status === 200) {
      const rd = body?.bucket?.rungsDropped;
      rungsDropped = typeof rd === "number" && Number.isInteger(rd) && rd >= 0 ? rd : null;
    }
  } catch (err) {
    // status stays 0, which the judge reads as "no reply at all" and keeps apart
    // from a 5xx: a driver that could not reach the deployment and one the
    // deployment answered badly are two different findings (L11).
    // A request the driver gave up on at its own bound is `timed-out`, its own
    // outcome, so the judge reports it apart from a reply that never came for any
    // other reason (#3222).
    outcome = timedOut(err) ? TIMED_OUT : `transport: ${(err as Error).name}`;
    // A body that stalled after its headers leaves the header status behind; the
    // request was not answered, so it carries no status either, and no echo.
    status = 0;
    echo = null;
    rungsDropped = undefined;
  }
  return {
    ...attemptIdentity(req.lead),
    code: req.code,
    sentAtMs,
    wallMs: Math.round(performance.now() - t0),
    status,
    outcome,
    startIso: req.startIso,
    seenIp,
    echo,
    ...(rungsDropped !== undefined ? { rungsDropped } : {}),
  };
}

function write(result: DriverResult, out: string = OUT): void {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(result, null, 2), "utf8");
  console.log(`driver ${DRIVER} (${MODE}): wrote ${result.attempts.length} attempts to ${out}`);
}

async function steady(
  mode: "steady" | "fault" | "baseline" = "steady",
  minutes = RUN_MINUTES,
  // #3258: the baseline paces itself, a dozen bookings at four a minute, so it
  // measures one booking at rest rather than a driver's share of the load.
  pace: { total: number; perMinute: number } = {
    total: PER_DRIVER_PER_MINUTE * minutes,
    perMinute: PER_DRIVER_PER_MINUTE,
  },
): Promise<void> {
  const startedAtMs = Date.now();
  const plan = requestSchedule({
    total: pace.total,
    perMinute: pace.perMinute,
    startAtMs: startedAtMs,
  });
  // Its OWN deadline, derived from the plan (#3222). The drivers send one request
  // at a time, so a slow deployment stretches the run; without this the job's
  // timeout killed the driver mid run, it wrote nothing, and a run that should have
  // FAILED on latency could only be called incomplete.
  const deadlineMs = effectiveDeadlineMs(
    driverDeadlineMs({ total: plan.length, perMinute: pace.perMinute }),
    DEADLINE_OVERRIDE,
  );
  const deadlineAtMs = startedAtMs + deadlineMs;
  let cutShort = false;
  const attempts: BookingAttempt[] = [];
  for (const req of plan) {
    if (deadlineReached({ nowMs: Date.now(), nextAtMs: req.atMs, deadlineAtMs })) {
      cutShort = true;
      console.error(
        `driver ${DRIVER}: stopped at its ${(deadlineMs / 60_000).toFixed(1)} minute deadline after ` +
          `${attempts.length} of ${plan.length} requests; writing what it ran for the judge`,
      );
      break;
    }
    const wait = req.atMs - Date.now();
    if (wait > 0) await sleep(wait);
    const now = Date.now();
    const slots = await slotsFor(req.code, now, deadlineAtMs);
    if (slots === null) {
      // #3348: the bucket's times could not be read at all (a refused, timed out or
      // failed first read). No booking was sent, and the bucket is not known to offer
      // nothing, so this has its own outcome rather than no-slots-offered (L11).
      attempts.push({
        ...attemptIdentity({ runId: RUN_ID, leg: mode, driver: DRIVER, n: req.n }),
        code: req.code,
        sentAtMs: now,
        wallMs: 0,
        status: 0,
        outcome: AVAILABILITY_UNREAD,
        startIso: null,
        seenIp: null,
        echo: null,
      });
      continue;
    }
    const startIso = pickSlot(slots);
    if (startIso === null) {
      // A bucket offering nothing is RECORDED rather than skipped in silence, with a
      // status of its own. An offered-nothing run and a run nobody drove produce the
      // same empty file otherwise, and the judge could not tell them apart (L98).
      attempts.push({
        ...attemptIdentity({ runId: RUN_ID, leg: mode, driver: DRIVER, n: req.n }),
        code: req.code,
        sentAtMs: now,
        wallMs: 0,
        status: 0,
        outcome: NO_SLOTS_OFFERED,
        startIso: null,
        seenIp: null,
        echo: null,
      });
      continue;
    }
    attempts.push(
      await book({
        code: req.code,
        startIso,
        lead: { runId: RUN_ID, leg: mode, driver: DRIVER, n: req.n },
        deadlineAtMs,
        shownTier: shownTiers.get(req.code) ?? null,
      }),
    );
  }
  write({
    runId: RUN_ID,
    driver: DRIVER,
    mode,
    planned: plan.length,
    startedAtMs,
    finishedAtMs: Date.now(),
    ...(mode === "fault" ? { faultPct: faultPctConfirmed, faultTargets: faultTargetsConfirmed } : {}),
    // Exit zero all the same: the judge grades a cut short run as a FAIL with its
    // figures, and a non-zero exit here would fail the drive job and skip the
    // ceiling check and the fault pass that wait on it.
    ...(cutShort ? { cutShort: { deadlineMs, attemptsMade: attempts.length } } : {}),
    attempts,
  });
}

/** The percentage the DEPLOYMENT reported, set by `fault()` before anything is driven. */
let faultPctConfirmed = 0;
/** The systems the DEPLOYMENT reported failing, set beside the percentage (#3104). */
let faultTargetsConfirmed: string[] = [];

/**
 * The fault pass: the same steady drive, against a deployment redeployed with
 * Google failing a percentage of its calendar reads (#2262).
 *
 * It CONFIRMS that percentage with the deployment before it sends one request. The
 * bar this feeds is "zero 5xx with Google failing ten percent of reads", and a
 * deployment that never received the setting fails no reads: it answers everything
 * perfectly and satisfies the bar with no fault having happened, which reads
 * exactly like a path that degraded well (L98). A run is too expensive to discover
 * that from afterwards.
 */
async function fault(): Promise<void> {
  const raw = need("FAULT_PCT");
  if (!/^\d+$/.test(raw.trim())) {
    console.error(`FAILED: FAULT_PCT is not a whole percentage: ${JSON.stringify(raw)}.`);
    process.exit(1);
  }
  const wantedPct = Number(raw.trim());
  if (wantedPct <= 0) {
    // Zero is not a fault pass, it is the steady pass under another name, and the
    // judge would score its bar as met having injected nothing.
    console.error("FAILED: FAULT_PCT is 0, so this would drive no faults and pass the bar anyway.");
    process.exit(1);
  }
  // Read through the deployment's own parser, so the driver and the deployment
  // cannot disagree about what a list means, and a typo stops here rather than after
  // a three minute wait for a deployment that will never report it (L41).
  const wantedTargets = parseFaultTargets(process.env.FAULT_TARGETS);
  if (wantedTargets.unknown.length > 0) {
    console.error(
      `FAILED: FAULT_TARGETS names ${wantedTargets.unknown.join(", ")}, which is no fault target.`,
    );
    process.exit(1);
  }
  const commit = (process.env.FAULT_COMMIT ?? "").trim();
  // POLLED, not asked once. A deploy does not take effect the instant wrangler
  // exits: this asked two seconds after its own deploy and was answered by the
  // version already serving, which reports no faults, and the commit could not
  // catch it because both builds come from the same commit. The ladder is pure and
  // lives in `preflight-checks.ts`; this is the clock and the request.
  const startedWaitingMs = Date.now();
  // Each check carries the same abort every driver request does (#3222), bounded by
  // the propagation deadline, so a version check that never answers is one more
  // reading to wait out rather than a driver hung until the job's timeout kills it.
  const pollDeadlineAtMs = startedWaitingMs + FAULT_PROPAGATION_DEADLINE_MS;
  for (;;) {
    let verdict: FaultModeVerdict;
    try {
      const res = await fetch(`${SLATE_BASE}/api/smoke/version`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
        signal: requestSignal(pollDeadlineAtMs, REQUEST_TIMEOUT_OVERRIDE),
      });
      const body = await res.json().catch((err: unknown) => {
        if (timedOut(err)) throw err;
        return {};
      });
      verdict = faultModeVerdict(res.status, body, {
        faultPct: wantedPct,
        commit: commit === "" ? undefined : commit,
        faultTargets: wantedTargets.targets,
      });
    } catch (err) {
      if (!timedOut(err)) throw err;
      verdict = {
        ok: false,
        why: "/api/smoke/version did not answer inside the driver's per request bound.",
        retriable: true,
      };
    }
    const step = faultPollStep(verdict, Date.now() - startedWaitingMs);
    if (step.action === "accept") {
      faultPctConfirmed = step.faultPct;
      faultTargetsConfirmed = step.faultTargets ?? [];
      break;
    }
    if (step.action === "give-up") {
      console.error(`FAILED: ${step.why}`);
      process.exit(1);
    }
    console.log(
      `waiting for the deploy to land (${Math.round((Date.now() - startedWaitingMs) / 1000)}s of ` +
        `${Math.round(FAULT_PROPAGATION_DEADLINE_MS / 1000)}s): ${step.why}`,
    );
    await sleep(step.waitMs);
  }
  // Read through the judge's own reader, so the plan the judge checks the file
  // against is the plan this ran (#3222).
  const minutes = faultMinutesFrom(process.env.FAULT_MINUTES);
  if (minutes === null) {
    console.error(`FAILED: FAULT_MINUTES is not a positive number of minutes.`);
    process.exit(1);
  }
  console.log(
    `driver ${DRIVER}: the deployment reports faultPct=${faultPctConfirmed} on ` +
      `${faultTargetsConfirmed.join(",")}; driving ${minutes}m`,
  );
  await steady("fault", minutes);
}

async function burst(): Promise<void> {
  // ONE value, chosen once by the setup step (#3325): the two sibling codes and each
  // burst's slot and moment. Read strictly and refused by name, because a half read
  // plan is a burst nobody configured (L50, L70). Never re-derived here: a constant
  // to fall back on is how the drivers and the setup end up firing at different codes
  // while each reads as correct, and it was the unmeasured constant #2278 removed.
  const read = readBurstPlan(need("BURST_PLAN"));
  if (!read.ok) {
    console.error(`FAILED: ${read.why}, so nothing was fired.`);
    process.exit(1);
  }
  const plan = read.plan;
  let missedAny = false;
  // #3429: each burst's share, so its request numbers start past every earlier one's.
  const shares = plan.bursts.map((b) => b.perDriver);
  // #3429: the confirm crowd rule, asked ONCE before the first burst and recorded on
  // every burst's file, so the judge holds each burst to the rule of the build it
  // measured. A read that fails is recorded as unreadable, never as a rule.
  const crowdRule = await readDeploymentCrowdRule();
  console.log(`driver ${DRIVER}: the deployment's crowd rule: ${JSON.stringify(crowdRule)}`);
  // #3429: the probes run beside the next burst's wait rather than before it, so a
  // probe can never make a driver late for the next moment.
  const probes: Promise<void>[] = [];
  // #3446 review (L749): a probe that cannot be recorded is held here, with its handler
  // attached when the probe starts, and reported once every burst has fired.
  const unrecordedProbes: string[] = [];

  for (const [index, leg] of plan.bursts.entries()) {
    const startedAtMs = Date.now();
    const burstLeg: BurstLegRecord = {
      index,
      of: plan.bursts.length,
      slot: leg.slot,
      codes: [...leg.codes],
      startAtMs: leg.startAtMs,
      kind: leg.kind,
      capacity: leg.capacity,
      // #3459 review: what this driver ran with, so the judge settles the burst on the
      // longest grace and bound its drivers had rather than on the defaults.
      graceMs: BURST_GRACE_MS,
      requestBoundMs: burstRequestBoundMs(),
    };
    const out = burstLegOut(OUT, index);

    // Wait for the shared moment, then check we actually made it. A driver that woke
    // late must NOT fire: its request meets an already taken slot and records a
    // SLOT_TAKEN indistinguishable from the contention the control is counting, so
    // the judge would be handed a staggered burst wearing a simultaneous one's
    // clothes. Looped, not one sleep: a timer can return a millisecond before the
    // wall clock reaches the moment, and that alone cost run 37162784607 its burst
    // (#3103).
    await waitForBurstMoment(leg.startAtMs, { now: Date.now, sleep });
    const readiness = burstReadiness({ startAtMs: leg.startAtMs, nowMs: Date.now(), graceMs: BURST_GRACE_MS });
    if (readiness !== "ready") {
      // This burst only. The others are still fired and still written, so one late
      // wake costs the run one burst rather than three (#3325).
      console.error(`driver ${DRIVER}: burst ${index + 1} of ${plan.bursts.length} missed (${readiness}), firing nothing`);
      write(
        {
          runId: RUN_ID,
          driver: DRIVER,
          mode: "burst",
          planned: leg.perDriver,
          startedAtMs,
          finishedAtMs: Date.now(),
          burstSkipped: readiness,
          burstLeg,
          crowdRule,
          attempts: [],
        },
        out,
      );
      missedAny = true;
      continue;
    }

    // All at once, with no pacing: contention on ONE slot is the whole point. Split
    // across the two sibling codes, so the shared confirm line is exercised ACROSS
    // codes whose ladders are the same pools rather than only within one (#3325).
    // Each burst's ids are numbered past the previous bursts', so no two of the run's
    // requests share an external id (#2261), whatever each burst's share (#3429).
    const attempts = await Promise.all(
      burstRequestNumbers(shares, index).map((n, i) => {
        const code = burstCodeFor(leg.codes, DRIVER, i);
        return book({
          code,
          startIso: leg.slot,
          lead: { runId: RUN_ID, leg: "burst", driver: DRIVER, n },
          deadlineAtMs: Number.POSITIVE_INFINITY,
          // #3495: the tier the setup read for this request's own code.
          shownTier: leg.shownTiers[leg.codes.indexOf(code)] ?? null,
        });
      }),
    );
    const result: DriverResult = {
      runId: RUN_ID,
      driver: DRIVER,
      mode: "burst",
      planned: leg.perDriver,
      startedAtMs,
      finishedAtMs: Date.now(),
      burstLeg,
      crowdRule,
      attempts,
    };
    // Written now, so a driver that dies before its probe still hands the judge the
    // burst, whose missing probe the judge reads as never recorded. Written again
    // with the probe once the slot has been asked.
    write(result, out);
    probes.push(
      settleLater(
        probeOnceSettled(leg).then((probe) => write({ ...result, probe }, out)),
        (err) =>
          unrecordedProbes.push(
            `burst ${index + 1} of ${plan.bursts.length}: ${err instanceof Error ? err.message : String(err)}`,
          ),
      ),
    );
  }
  await Promise.all(probes);
  for (const why of unrecordedProbes) {
    console.error(
      `driver ${DRIVER}: the probe of ${why}. Its burst's file was written without it, which the judge reads as a probe never recorded`,
    );
  }

  // Non-zero, so a missed burst is visible in the workflow rather than only in a file
  // the judge reads later. A missed burst names the run first; a probe that could not
  // be recorded has its own code, so the two are told apart.
  if (missedAny) process.exit(3);
  if (unrecordedProbes.length > 0) process.exit(4);
}

/**
 * #3429: the deployment's confirm crowd rule, from `/api/smoke/version`, through the
 * one reader the judge's fixtures use. A request that fails is recorded as unreadable
 * with why, never as a rule and never as a crash: the judge then says it cannot hold
 * the burst to either rule, which is what is true.
 */
async function readDeploymentCrowdRule(): Promise<CrowdRuleReading> {
  try {
    const res = await fetch(`${SLATE_BASE}/api/smoke/version`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      signal: AbortSignal.timeout(effectiveDeadlineMs(REQUEST_TIMEOUT_MS, REQUEST_TIMEOUT_OVERRIDE)),
    });
    return readCrowdRule(res.status, await res.json().catch(() => null));
  } catch (err) {
    return { state: "unreadable", why: `/api/smoke/version did not answer (${timedOut(err) ? "timed out" : (err as Error).name})` };
  }
}

/** The abort bound a burst request carries: the one figure the record and the settle share. */
function burstRequestBoundMs(): number {
  return effectiveDeadlineMs(REQUEST_TIMEOUT_MS, REQUEST_TIMEOUT_OVERRIDE);
}

/**
 * #3429: wait until every confirm of the burst is over, then ask the deployment whether
 * its slot is still bookable. Settled is the latest this driver may have fired plus a
 * request's own abort bound (`burstSettleAtMs`), so no burst request is in flight on
 * any driver; `BURST_SETTLE_MS` can only shorten it, for a test. Asked of the code this
 * driver opened on, so across four drivers both sibling codes are asked.
 */
async function probeOnceSettled(leg: PlannedBurst): Promise<BurstProbe> {
  const requestBoundMs = burstRequestBoundMs();
  const settleAfterMs = effectiveDeadlineMs(burstSettleAtMs(0, BURST_GRACE_MS, requestBoundMs), BURST_SETTLE_OVERRIDE);
  // Looped until the WALL clock reads the settle, like the moment itself (#3103): one
  // sleep can return a millisecond early, and the judge cannot use a probe sent before
  // the burst settled (run 37568349592 sent one at 599ms against a 600ms settle).
  await waitForBurstMoment(leg.startAtMs + settleAfterMs, { now: Date.now, sleep });
  const code = burstCodeFor(leg.codes, DRIVER, 0);
  const sentAtMs = Date.now();
  try {
    const q = new URLSearchParams({ bucketCode: code, startIso: leg.slot });
    const res = await fetch(`${SLATE_BASE}/api/bookings/bookable?${q.toString()}`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      signal: AbortSignal.timeout(effectiveDeadlineMs(BURST_PROBE_TIMEOUT_MS, REQUEST_TIMEOUT_OVERRIDE)),
    });
    return readBurstProbe({ code, sentAtMs, status: res.status, body: await res.json().catch(() => null) });
  } catch (err) {
    return {
      kind: "unreadable",
      code,
      sentAtMs,
      why: `the bookable check did not answer (${timedOut(err) ? "timed out" : (err as Error).name})`,
    };
  }
}

await (MODE === "burst"
  ? burst()
  : MODE === "fault"
    ? fault()
    : MODE === "baseline"
      ? steady("baseline", 0, { total: BASELINE_BOOKINGS, perMinute: BASELINE_PER_MINUTE })
      : steady());
