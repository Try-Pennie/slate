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
const MODE = (process.env.MODE ?? "steady") as "steady" | "burst";
const BURST_REQUESTS = Number(process.env.BURST_REQUESTS ?? "25");
const BURST_GRACE_MS = Number(process.env.BURST_GRACE_MS ?? "2000");
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
  try {
    const res = await fetch(`${SLATE_BASE}/api/availability?bucket=${encodeURIComponent(code)}`);
    if (res.ok) {
      const body = (await res.json()) as { slots?: { start?: string }[] };
      slots = (body.slots ?? [])
        .map((s) => (typeof s.start === "string" ? s.start : ""))
        .filter((s) => s !== "");
    }
    // A refused or unreadable read KEEPS the previous view rather than emptying it.
    // An empty list means "this bucket offers nothing", which is a real state the
    // run should be able to record; a 429 means "we asked too often", and turning
    // that into the same empty list would make the run report a dead bucket.
  } catch {
    // Same reasoning: a transport fault leaves the last known view in place.
  }
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
          phone: "+15555550100",
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

async function steady(): Promise<void> {
  const startedAtMs = Date.now();
  const plan = requestSchedule({
    total: PER_DRIVER_PER_MINUTE * RUN_MINUTES,
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
        externalId: externalIdFor(RUN_ID, DRIVER, req.n),
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
        externalId: externalIdFor(RUN_ID, DRIVER, req.n),
        n: req.n,
      }),
    );
  }
  write({
    runId: RUN_ID,
    driver: DRIVER,
    mode: "steady",
    planned: plan.length,
    startedAtMs,
    finishedAtMs: Date.now(),
    attempts,
  });
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
      book({ code, startIso, externalId: externalIdFor(RUN_ID, DRIVER, i), n: i }),
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

await (MODE === "burst" ? burst() : steady());
