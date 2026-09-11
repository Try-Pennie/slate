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
// Burst mode adds START_AT (epoch ms) and BURST_SLOT, both chosen ONCE by the
// setup step and handed to every driver, because a burst whose drivers each chose
// their own time is not a burst.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  requestSchedule,
  availabilityRefreshMs,
  offeredSlots,
  loadtestPhone,
  idPrefix,
  burstReadiness,
  externalIdFor,
  pickSlot,
  DRIVERS,
  PER_DRIVER_PER_MINUTE,
  RUN_MINUTES,
  type BookingAttempt,
  type DriverResult,
} from "./book-plan.ts";
import { BURST_CODE } from "./code-mix.ts";
import { faultModeVerdict, faultPollStep, FAULT_PROPAGATION_DEADLINE_MS } from "./preflight-checks.ts";

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
// env-ok: MODE (optional; defaults to steady; only the burst and fault jobs set it)
const MODE = (process.env.MODE ?? "steady") as "steady" | "burst" | "fault";
// env-ok: BURST_REQUESTS (optional; defaults to 25, which is what one burst driver fires)
const BURST_REQUESTS = Number(process.env.BURST_REQUESTS ?? "25");
// env-ok: BURST_GRACE_MS (optional; defaults to 2000, how late a driver may be and
// still be part of the same burst)
const BURST_GRACE_MS = Number(process.env.BURST_GRACE_MS ?? "2000");
// env-ok: BURST_CODE_OVERRIDE (optional; defaults to the measured one agent pool,
// and only a deliberate experiment would point the burst at a different code)
// env-ok: FAULT_PCT (required in fault mode only; the percentage the deployment
// was redeployed with, which the driver then CONFIRMS with the deployment itself)
// env-ok: FAULT_MINUTES (optional; defaults to 2, long enough for the bar to have
// a real sample and short enough that a faulted deployment is not live for long)
// env-ok: FAULT_COMMIT (optional; the commit the fault leg deployed, checked
// against what the deployment reports so a redeploy that did not take is caught)
// env-ok: TZ_NAME (optional; defaults to America/New_York, the zone the seeded
// roster's largest group keeps)
const TIMEZONE = process.env.TZ_NAME ?? "America/New_York";

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

interface SlotView {
  fetchedAtMs: number;
  slots: string[];
}
const slotCache = new Map<string, SlotView>();
const REFRESH_MS = availabilityRefreshMs(DRIVERS);

/**
 * The times a bucket is offering, cached per code.
 *
 * Cached because the availability ceiling is 30 a minute PER ADDRESS and four
 * drivers share one, so a read before every booking would spend four times the
 * budget and the run would be measuring the limiter. The cache is refreshed on a
 * pace derived from that same ceiling.
 */
async function slotsFor(code: string, nowMs: number): Promise<string[]> {
  const cached = slotCache.get(code);
  if (cached && nowMs - cached.fetchedAtMs < REFRESH_MS) return cached.slots;
  let slots: string[] = cached?.slots ?? [];
  // The PARSE is deliberately outside the catch below. A read that failed and a
  // response whose shape we cannot read are different facts: the first is a 429 or
  // a blip the run should ride out on its cached view, and the second is a defect
  // that would otherwise arrive as "this bucket offers nothing" on every request
  // for the whole run (#2261).
  let payload: unknown = null;
  try {
    const res = await fetch(`${SLATE_BASE}/api/availability?bucket=${encodeURIComponent(code)}`);
    if (res.ok) payload = await res.json();
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
  if (payload !== null) slots = offeredSlots(payload);
  slotCache.set(code, { fetchedAtMs: nowMs, slots });
  return slots;
}

async function book(req: {
  code: string;
  startIso: string;
  externalId: string;
  n: number;
}): Promise<BookingAttempt> {
  const sentAtMs = Date.now();
  const t0 = performance.now();
  let status = 0;
  let outcome: string | null = null;
  let seenIp: string | null = null;
  try {
    const res = await fetch(`${SLATE_BASE}/api/bookings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        bucketCode: req.code,
        start: req.startIso,
        timezone: TIMEZONE,
        externalId: req.externalId,
        attendee: {
          name: `Loadtest Lead ${req.externalId}`,
          email: `${req.externalId}@loadtest.local`,
          // Its OWN number (#2261). A weak dedupe match is email OR phone, so one
          // shared number makes every booking after the first a `confirm_required`
          // refusal of the same person calling again.
          phone: loadtestPhone(req.externalId),
        },
      }),
    });
    status = res.status;
    // The address Slate SAW, echoed on the loadtest path only. Attributing a write
    // 429 needs the address the ceiling was applied to, not the one the runner
    // believes it has: a CI runner behind egress NAT shares an address with
    // everything else on it.
    seenIp = res.headers.get("x-loadtest-seen-ip");
    const body = (await res.json().catch(() => null)) as
      | { outcome?: string; code?: string }
      | null;
    outcome = body?.outcome ?? body?.code ?? null;
  } catch (err) {
    // status stays 0, which the judge reads as "no reply at all" and keeps apart
    // from a 5xx: a driver that could not reach the deployment and one the
    // deployment answered badly are two different findings (L11).
    outcome = `transport: ${(err as Error).name}`;
  }
  return {
    driver: DRIVER,
    n: req.n,
    code: req.code,
    externalId: req.externalId,
    sentAtMs,
    wallMs: Math.round(performance.now() - t0),
    status,
    outcome,
    startIso: req.startIso,
    seenIp,
  };
}

function write(result: DriverResult): void {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(result, null, 2), "utf8");
  console.log(`driver ${DRIVER} (${MODE}): wrote ${result.attempts.length} attempts to ${OUT}`);
}

async function steady(mode: "steady" | "fault" = "steady", minutes = RUN_MINUTES): Promise<void> {
  const startedAtMs = Date.now();
  const plan = requestSchedule({
    total: PER_DRIVER_PER_MINUTE * minutes,
    perMinute: PER_DRIVER_PER_MINUTE,
    startAtMs: startedAtMs,
  });
  const attempts: BookingAttempt[] = [];
  for (const req of plan) {
    const wait = req.atMs - Date.now();
    if (wait > 0) await sleep(wait);
    const now = Date.now();
    const slots = await slotsFor(req.code, now);
    const startIso = pickSlot(slots);
    if (startIso === null) {
      // A bucket offering nothing is RECORDED rather than skipped in silence, with a
      // status of its own. An offered-nothing run and a run nobody drove produce the
      // same empty file otherwise, and the judge could not tell them apart (L98).
      attempts.push({
        driver: DRIVER,
        n: req.n,
        code: req.code,
        externalId: externalIdFor(idPrefix(RUN_ID, mode), DRIVER, req.n),
        sentAtMs: now,
        wallMs: 0,
        status: 0,
        outcome: "no-slots-offered",
        startIso: null,
        seenIp: null,
      });
      continue;
    }
    attempts.push(
      await book({
        code: req.code,
        startIso,
        externalId: externalIdFor(idPrefix(RUN_ID, mode), DRIVER, req.n),
        n: req.n,
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
    ...(mode === "fault" ? { faultPct: faultPctConfirmed } : {}),
    attempts,
  });
}

/** The percentage the DEPLOYMENT reported, set by `fault()` before anything is driven. */
let faultPctConfirmed = 0;

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
  const commit = (process.env.FAULT_COMMIT ?? "").trim();
  // POLLED, not asked once. A deploy does not take effect the instant wrangler
  // exits: this asked two seconds after its own deploy and was answered by the
  // version already serving, which reports no faults, and the commit could not
  // catch it because both builds come from the same commit. The ladder is pure and
  // lives in `preflight-checks.ts`; this is the clock and the request.
  const startedWaitingMs = Date.now();
  for (;;) {
    const res = await fetch(`${SLATE_BASE}/api/smoke/version`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    const verdict = faultModeVerdict(res.status, await res.json().catch(() => ({})), {
      faultPct: wantedPct,
      commit: commit === "" ? undefined : commit,
    });
    const step = faultPollStep(verdict, Date.now() - startedWaitingMs);
    if (step.action === "accept") {
      faultPctConfirmed = step.faultPct;
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
  const minutes = Number((process.env.FAULT_MINUTES ?? "2").trim());
  if (!Number.isFinite(minutes) || minutes <= 0) {
    console.error(`FAILED: FAULT_MINUTES is not a positive number of minutes.`);
    process.exit(1);
  }
  console.log(`driver ${DRIVER}: the deployment reports faultPct=${faultPctConfirmed}; driving ${minutes}m`);
  await steady("fault", minutes);
}

async function burst(): Promise<void> {
  // Refused by NAME rather than left as NaN. A NaN start does land safe here (every
  // comparison against it is false, so `burstReadiness` answers "missed" and the
  // driver fires nothing), but it lands there by accident: the run would report a
  // burst nobody attended and the reason would be a typo nothing named (L50).
  const rawStart = need("START_AT");
  if (!/^\d+$/.test(rawStart.trim())) {
    console.error(`FAILED: START_AT is not an epoch milliseconds value: ${JSON.stringify(rawStart)}`);
    process.exit(1);
  }
  const startAtMs = Number(rawStart.trim());
  const startIso = need("BURST_SLOT");
  const code = process.env.BURST_CODE_OVERRIDE ?? BURST_CODE;
  const startedAtMs = Date.now();

  // Wait for the shared moment, then check we actually made it. A driver that woke
  // late must NOT fire: its request meets an already taken slot and records a
  // SLOT_TAKEN indistinguishable from the contention the control is counting, so
  // the judge would be handed a staggered burst wearing a simultaneous one's
  // clothes.
  const wait = startAtMs - Date.now();
  if (wait > 0) await sleep(wait);
  const readiness = burstReadiness({ startAtMs, nowMs: Date.now(), graceMs: BURST_GRACE_MS });
  if (readiness !== "ready") {
    console.error(`driver ${DRIVER}: burst-missed (${readiness}), firing nothing`);
    write({
      runId: RUN_ID,
      driver: DRIVER,
      mode: "burst",
      planned: BURST_REQUESTS,
      startedAtMs,
      finishedAtMs: Date.now(),
      burstSkipped: readiness,
      attempts: [],
    });
    // Non-zero, so a missed driver is visible in the workflow rather than only in a
    // file the judge reads later.
    process.exit(3);
  }

  // All at once, with no pacing: contention on ONE slot is the whole point, and the
  // control is that exactly one of them wins.
  const attempts = await Promise.all(
    Array.from({ length: BURST_REQUESTS }, (_, i) =>
      book({ code, startIso, externalId: externalIdFor(idPrefix(RUN_ID, "burst"), DRIVER, i), n: i }),
    ),
  );
  write({
    runId: RUN_ID,
    driver: DRIVER,
    mode: "burst",
    planned: BURST_REQUESTS,
    startedAtMs,
    finishedAtMs: Date.now(),
    attempts,
  });
}

await (MODE === "burst" ? burst() : MODE === "fault" ? fault() : steady());
