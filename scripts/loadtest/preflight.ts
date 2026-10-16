// The positive control, run BEFORE a booking load run (#2243, #2244).
//
// WHY. Everything the judge concludes rests on two things it cannot check about
// itself: that a booking made through the API really leaves the rows it looks for,
// and that its overlap check really sees them. A judge whose database read is
// scoped wrongly, or whose overlap comparison is inverted, reports a clean run
// over a branch full of double bookings and nothing about the output says so
// (L1: a guard is only real once it has been seen to fail).
//
// So this makes ONE real booking and checks what it left behind, then PLANTS an
// overlapping pair that the judge's own predicate must go RED on, and removes it.
// Both halves, or it proves nothing: a judge hard wired to report no overlaps
// satisfies a check that only plants a clean pair.
//
// It writes to the BRANCH only and refuses production by name.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { overlaps, type JudgedBooking } from "./judge-booking-run.ts";
import {
  stubShapedEventId,
  faultModeVerdict,
  sharedLineSwitchVerdict,
  awaitRecomputeArm,
  awaitGoogleDelay,
  overlappingProbeWindow,
  warmupStep,
  WARMUP_HYDRATE_PAUSE_MS,
  WARMUP_RECOMPUTE_PAUSE_MS,
  type WarmupReading,
  type WarmupProgress,
} from "./preflight-checks.ts";
import { offeredSlots, loadtestPhone, leadExternalId } from "./book-plan.ts";
import { refreshAfterWarmup, readOfferedSlots, bookControlSlot } from "./preflight-control.ts";
import { PRODUCTION_SUPABASE_REF, PRODUCTION_HOST } from "../../src/lib/loadtest-guard.ts";

// ONE constant, shared with the app's own load test refusals (#2242). A second
// spelling beside each script is how one of them ends up naming a project that
// is not production (L2, L41).
const PROD_REF = PRODUCTION_SUPABASE_REF;
const PROD_HOST = PRODUCTION_HOST;

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
const SUPA_URL = need("SUPABASE_URL");
const SUPA_KEY = need("SUPABASE_SECRET_KEY");
const RUN_ID = need("RUN_ID");
// The preflight DRIVES the hydration and recompute lanes by hand rather than
// waiting for their cadence (#2347): hydration is every fifteen minutes at twelve
// calendars a tick, so a 93 agent roster is two hours away on its own schedule.
const CRON_SECRET = need("CRON_SECRET");
// env-ok: PREFLIGHT_CODE (optional; defaults to 112, the busiest real code, and a
// hand run would only change it to reach a different pool)
// env-ok: PREFLIGHT_OUT (optional; defaults to results/preflight.json, which is
// where the workflow uploads it from)
const CODE = process.env.PREFLIGHT_CODE ?? "112";

// This one WRITES, so both refusals are by name and neither is a flag somebody
// could set wrong at 2am.
if (SUPA_URL.includes(PROD_REF) || SLATE_BASE.includes(PROD_HOST)) {
  console.error("FAILED: this points at production. The preflight writes rows and plants a clash.");
  process.exit(1);
}

const SUPA = `${SUPA_URL.replace(/\/$/, "")}/rest/v1`;
const H = { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, "content-type": "application/json" };

async function rows(path: string): Promise<Record<string, unknown>[]> {
  const res = await fetch(`${SUPA}/${path}`, { headers: H });
  if (!res.ok) throw new Error(`read ${path} -> ${res.status} ${await res.text()}`);
  return (await res.json()) as Record<string, unknown>[];
}

function fail(why: string): never {
  console.error(`\nPREFLIGHT FAILED: ${why}`);
  process.exit(2);
}

// --- half zero: the deployment says it is a load test -------------------------
//
// Asked BEFORE anything is written, and it costs one request. The behavioural
// proof further down (the event id carries the stub's shape) is the stronger of
// the two and stays, but it can only speak AFTER a booking has been made: if
// `SLATE_LOADTEST` is off, that booking was a real calendar event with a real
// invitation sent, and the preflight's own control has already done the thing it
// exists to prevent, once. This asks the deployment first.
//
// The decision is in `preflight-checks.ts` so every one of its refusals is driven
// offline; here there is only the request.
{
  const res = await fetch(`${SLATE_BASE}/api/smoke/version`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  // `faultModeVerdict` rather than `loadtestModeVerdict`, because it asks BOTH
  // questions and the second one matters here (#2262): a deployment left injecting
  // faults by an earlier run's fault leg (a run dispatched with teardown off does
  // exactly that) would have every one of this run's 5xx counted against the path
  // instead of against the faults somebody else asked for. Zero is what a steady
  // pass requires, and it is asserted rather than assumed.
  const verdict = faultModeVerdict(res.status, await res.json().catch(() => ({})), { faultPct: 0 });
  if (!verdict.ok) fail(verdict.why);
  console.log("ok: the deployment reports load test mode and is injecting no faults");
}

// --- the shared confirm line's switch is on (#3325) --------------------------------
//
// The run exists to prove the shared confirm line, and the branch's stored switch is
// what turns it on. Asked here, before anything is driven or written, so a branch the
// current seed did not finish is refused at no cost. The decision is in
// `preflight-checks.ts`, driven offline with the seed's own row.
{
  // cap-safe: booking_settings is a single row table pinned to id 1
  const res = await fetch(`${SUPA}/booking_settings?select=shared_confirm_line&id=eq.1`, { headers: H });
  const verdict = sharedLineSwitchVerdict(res.status, await res.json().catch(() => null));
  if (!verdict.ok) fail(verdict.why);
  console.log("ok: the branch has the shared confirm line switched on");
}

// --- the post confirm recompute arm (#3258) ------------------------------------
//
// A run dispatched for one arm and driven against another would publish the other
// arm's numbers under this one's name, and the comparison the arms exist for would
// read as an answer. The workflow redeploys a non default arm just before this, so
// a deployment still reporting `on` is waited out for a short while (the version
// being replaced answers first); every other mismatch refuses at once.
//
// env-ok: EXPECT_POST_CONFIRM_RECOMPUTE (optional; the workflow's
// post_confirm_recompute input. Unset, as on a hand run, means on, the only arm a
// deployment without the --var runs.)
{
  const wanted = process.env.EXPECT_POST_CONFIRM_RECOMPUTE;
  const verdict = await awaitRecomputeArm({
    wanted,
    fetchVersion: async () => {
      const res = await fetch(`${SLATE_BASE}/api/smoke/version`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    },
    sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    waitMs: 120_000,
    pauseMs: 5_000,
  });
  if (!verdict.ok) fail(verdict.why);
  console.log(`ok: the deployment runs the post confirm recompute arm "${wanted?.trim() || "on"}"`);
}

// --- the Google delay (#3490) ----------------------------------------------------
//
// The same question of the other per run setting: a run dispatched with the stand in
// taking production's Google time, and driven against a deployment answering at once,
// would report undelayed confirms under the delayed rig's name. The arm job redeploys
// with the delay just before this, so the version being replaced is waited out; an
// undelayed run against a deployment an earlier run left delayed refuses at once.
//
// env-ok: EXPECT_GOOGLE_DELAY (optional; the workflow's google_delay input. Unset, as on
// a hand run, means off, the only rig a deployment without the --var runs.)
{
  const wanted = process.env.EXPECT_GOOGLE_DELAY;
  const verdict = await awaitGoogleDelay({
    wanted,
    fetchVersion: async () => {
      const res = await fetch(`${SLATE_BASE}/api/smoke/version`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    },
    sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    waitMs: 120_000,
    pauseMs: 5_000,
  });
  if (!verdict.ok) fail(verdict.why);
  console.log(`ok: the deployment's Google stand in delay is ${wanted?.trim() || "off"}`);
}

// --- half half: the deployment is WARM before anything is measured (#2347) -----
//
// A Worker created ninety seconds ago is not the deployment the run wants to test:
// its crons have not been delivered yet, and the calendars the seed wrote have
// never been hydrated, so every bucket answers `emptyBecause: busy`. Failing there
// destroyed a whole environment on 2026-09-15, because teardown runs on
// `if: always()`.
//
// The LADDER is pure and lives in `preflight-checks.ts`; here there are only the
// reads and the two lanes it asks to be driven. Waiting is on the CONDITION rather
// than on a fixed delay (L290), and every way of giving up names what it measured.

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The every minute lanes whose stamp says the scheduled invocation is reaching
 * this Worker.
 *
 * Deliberately NOT `recompute`, which this preflight drives by hand a few lines
 * down: a stamp written by our own drive would answer the delivery question with
 * our own work (L58). Any of the three counts, so one lane erroring does not read
 * as a Worker receiving no crons.
 */
const DELIVERY_LANES = ["sync", "outbox", "selfheal"] as const;

function stampAgeMs(iso: unknown, nowMs: number): number | null {
  const ms = Date.parse(String(iso ?? ""));
  // A stamp that cannot be read answers null rather than NaN: every comparison
  // against NaN is false, so an unreadable stamp left alone would land on the
  // healthy side of the freshness bound and read as a Worker receiving its crons.
  return Number.isFinite(ms) ? nowMs - ms : null;
}

interface WarmupObservation {
  reading: WarmupReading;
  slots: string[];
}

async function observe(cronConfirmed: boolean): Promise<WarmupObservation> {
  // cap-safe: the branch roster is bounded by the seeded agent count (200 at the
  // design target), so this can never fill a PostgREST page
  const agents = await rows("users?select=id&bookable=is.true&deactivated_at=is.null");
  // cap-safe: one row per (agent, calendar) over that same bounded roster
  const cals = await rows("agent_calendars?select=user_id,sync_window_to");

  const byUser = new Map<string, { rows: number; hydrated: number }>();
  for (const c of cals) {
    const id = String(c.user_id);
    const e = byUser.get(id) ?? { rows: 0, hydrated: 0 };
    e.rows++;
    if (c.sync_window_to !== null && c.sync_window_to !== undefined) e.hydrated++;
    byUser.set(id, e);
  }
  let missing = 0;
  let fullyHydrated = 0;
  for (const a of agents) {
    const e = byUser.get(String(a.id));
    if (!e || e.rows === 0) missing++;
    // EVERY calendar, not any: an agent half read is an agent whose free time we
    // cannot state, and the run would offer them anyway.
    else if (e.hydrated === e.rows) fullyHydrated++;
  }

  let laneStampAgeMs: number | null = null;
  if (!cronConfirmed) {
    // cap-safe: three named lanes
    const stamps = await rows(
      `lane_heartbeats?select=lane,last_ran_at&lane=in.(${DELIVERY_LANES.join(",")})`,
    );
    const now = Date.now();
    for (const s of stamps) {
      const age = stampAgeMs(s.last_ran_at, now);
      if (age === null) continue;
      if (laneStampAgeMs === null || age < laneStampAgeMs) laneStampAgeMs = age;
    }
  }

  const res = await fetch(`${SLATE_BASE}/api/availability?bucket=${CODE}`);
  if (!res.ok) {
    fail(`availability for bucket ${CODE} answered ${res.status}, so no control booking could be made`);
  }
  const payload = (await res.json()) as { emptyBecause?: { kind?: unknown } | null };
  // Through the shared reader (#2261): all three readers of this payload declared it
  // as `{ start }` objects and it is a list of ISO strings, so every one of them saw
  // an empty list on a healthy response and this preflight could never have passed.
  const slots = offeredSlots(payload);
  const kind = payload.emptyBecause?.kind;
  return {
    slots,
    reading: {
      laneStampAgeMs,
      bookableAgents: agents.length,
      agentsMissingCalendarRow: missing,
      agentsFullyHydrated: fullyHydrated,
      offeredSlots: slots.length,
      emptyBecause: typeof kind === "string" ? kind : null,
    },
  };
}

async function driveLane(lane: string): Promise<string> {
  const res = await fetch(`${SLATE_BASE}/api/cron/${lane}`, {
    headers: { Authorization: `Bearer ${CRON_SECRET}` },
  });
  if (!res.ok) {
    // Its own refusal, because "the cron secret is wrong" and "the cache is still
    // cold" send two different people to two different places (L11).
    fail(
      `driving /api/cron/${lane} answered ${res.status}, so the preflight cannot warm this ` +
        `deployment: ${(await res.text()).slice(0, 200)}`,
    );
  }
  return JSON.stringify(await res.json().catch(() => ({}))).slice(0, 240);
}

const warmStartMs = Date.now();
const progress: WarmupProgress = {
  elapsedMs: 0,
  cronConfirmed: false,
  hydrationDrives: 0,
  drivesSinceHydrationProgress: 0,
  recomputeDrives: 0,
};
let bestHydrated = -1;
let slots: string[] = [];
// When the most recent hydration drive ANSWERED, on this runner's clock (#3236).
// The control waits for the bucket's stored slots to be computed after it.
let lastHydrationFinishedMs: number | null = null;

for (;;) {
  const { reading, slots: offered } = await observe(progress.cronConfirmed);
  slots = offered;
  progress.elapsedMs = Date.now() - warmStartMs;
  if (reading.agentsFullyHydrated > bestHydrated) {
    bestHydrated = reading.agentsFullyHydrated;
    progress.drivesSinceHydrationProgress = 0;
  }

  const step = warmupStep(reading, progress);
  if (step.action === "ready") {
    console.log(`ok: ${step.why}`);
    break;
  }
  if (step.action === "give-up") fail(step.why);
  if (step.action === "wait-for-cron") {
    console.log(`waiting for the crons: ${step.why}`);
    await sleep(step.waitMs);
    continue;
  }
  // Reaching a driving step means the delivery gate was satisfied on this reading,
  // and it is not asked again: from here the preflight stamps lanes itself.
  progress.cronConfirmed = true;
  if (step.action === "hydrate") {
    const answered = await driveLane("hydrate-calendars");
    lastHydrationFinishedMs = Date.now();
    progress.hydrationDrives++;
    progress.drivesSinceHydrationProgress++;
    console.log(`hydrate drive ${progress.hydrationDrives} (${step.why}): ${answered}`);
    await sleep(WARMUP_HYDRATE_PAUSE_MS);
  } else {
    const answered = await driveLane("recompute");
    progress.recomputeDrives++;
    console.log(`recompute ${progress.recomputeDrives} (${step.why}): ${answered}`);
    await sleep(WARMUP_RECOMPUTE_PAUSE_MS);
  }
}

// --- half one: one real booking leaves the rows the judge looks for ------------

// The list the warm up ended on can predate its own last hydration drive, which may
// have given the only free agent a stub meeting at the first offered time (#3236).
// A recompute drive alone is not proof of a refresh (it skips pools it judges fresh),
// so when any drive ran the preflight waits until the bucket's STORED row was
// computed after that drive, then re-reads. The decisions and the one SLOT_TAKEN
// retry live in `preflight-control.ts`, driven offline.
const readSlots = () => readOfferedSlots(fetch, SLATE_BASE, CODE);
async function readComputedAt(): Promise<string | null> {
  // cap-safe: bucket_code is the primary key, so this returns at most one row
  const found = await rows(`bucket_slots?select=computed_at&bucket_code=eq.${encodeURIComponent(CODE)}`);
  const stamp = found[0]?.computed_at;
  return typeof stamp === "string" ? stamp : null;
}
const freshRowDeps = {
  driveRecompute: () => driveLane("recompute"),
  readComputedAt,
  sleep,
  now: () => Date.now(),
  bucketCode: CODE,
  log: (line: string) => console.log(line),
};
try {
  const refreshed = await refreshAfterWarmup({ hydrationDrives: progress.hydrationDrives, lastHydrationFinishedMs }, slots, {
    ...freshRowDeps,
    readSlots,
  });
  if (!refreshed.ok) fail(refreshed.why);
  else slots = refreshed.slots;
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}

const lead = { runId: RUN_ID, leg: "preflight", driver: 0, n: 0 } as const;
const externalId = leadExternalId(lead);

let control: Awaited<ReturnType<typeof bookControlSlot>>;
try {
  control = await bookControlSlot(slots, {
    fetch,
    baseUrl: SLATE_BASE,
    apiKey: API_KEY,
    runId: RUN_ID,
    bodyFor: (start) => ({
      bucketCode: CODE,
      start,
      timezone: "America/New_York",
      externalId,
      attendee: {
        name: "Loadtest Preflight",
        email: `${externalId}@loadtest.local`,
        // Its OWN number, so the preflight can run more than once against one branch
        // (#2261). A weak dedupe match is email OR phone, and a fixed number made
        // the second preflight ever a `confirm_required` refusal naming the first
        // one's booking. A run gets retried; the branch outlives the attempt.
        phone: loadtestPhone(lead),
      },
    }),
    ...freshRowDeps,
  });
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
const booking = control!;
if (!booking.ok) fail(booking.why);
console.log(`ok: control booked in bucket ${CODE} at ${booking.start} (attempt ${booking.attempts})`);

// cap-safe: external_id is this control's own unique id, so this returns at most one row
const booked = await rows(
  `bookings?select=id,gcal_event_id,idempotency_key,assigned_user_id,starts_at,ends_at,status&external_id=eq.${externalId}`,
);
if (booked.length !== 1) fail(`the control booking left ${booked.length} rows, expected exactly one`);
const row = booked[0]!;

// The event id must be the STUB'S shape, not a real Google one. If it is not, the
// run is about to make six hundred real calendar events and send six hundred real
// invitations, which is the single most expensive way this can go wrong.
// The RULE lives in `preflight-checks.ts` and is pinned offline; this is the read.
const eventId = String(row.gcal_event_id ?? "");
if (!stubShapedEventId(eventId)) {
  fail(
    `the control booking's gcal_event_id is ${JSON.stringify(eventId)}, which is not the stub's ` +
      "shape. SLATE_LOADTEST is not on for this deployment, so the run would create real calendar " +
      "events and send real invitations.",
  );
}
if (!row.idempotency_key) fail("the control booking carries no idempotency key");

// cap-safe: one booking's blocks, and the assertion is only that there is at least one
const blocks = await rows(`busy_blocks?select=id&booking_id=eq.${row.id}`);
if (blocks.length === 0) fail("the control booking wrote no busy_blocks row, so its slot still reads free");

// The reservation is deleted on success, so its ABSENCE is the assertion. A row
// still sitting there means the confirm path did not complete its own cleanup.
// cap-safe: idempotency_key is unique, so this returns at most one row
const reservations = await rows(`booking_reservations?select=id&idempotency_key=eq.${row.idempotency_key}`);
if (reservations.length !== 0) {
  fail(`${reservations.length} booking_reservations rows survived a successful booking`);
}
console.log(`ok: one booking, stub shaped event id (${eventId.slice(0, 12)}...), busy block written, reservation gone`);

// --- half two: the judge's own overlap check really goes red -------------------

const clash: JudgedBooking = {
  id: "planted",
  external_id: `${RUN_ID}-planted`,
  idempotency_key: "planted",
  assigned_user_id: String(row.assigned_user_id),
  starts_at: String(row.starts_at),
  ends_at: String(row.ends_at),
  status: "confirmed",
};
const real: JudgedBooking = {
  id: String(row.id),
  external_id: externalId,
  idempotency_key: String(row.idempotency_key),
  assigned_user_id: String(row.assigned_user_id),
  starts_at: String(row.starts_at),
  ends_at: String(row.ends_at),
  status: "confirmed",
};
if (!overlaps(real, clash)) {
  fail("the judge's overlap predicate did NOT flag an identical window, so it can find nothing");
}
// And the other direction, or the predicate could simply be returning true (L1).
const after: JudgedBooking = {
  ...clash,
  starts_at: String(row.ends_at),
  ends_at: new Date(Date.parse(String(row.ends_at)) + 20 * 60_000).toISOString(),
};
if (overlaps(real, after)) {
  fail("the judge's overlap predicate flagged two back to back calls, so it would report every run red");
}
console.log("ok: the overlap predicate goes red on a clash and stays quiet on a back to back pair");

// --- and the database really refuses one, which is the thing being relied on ----

const planted = await fetch(`${SUPA}/bookings`, {
  method: "POST",
  headers: { ...H, Prefer: "return=representation" },
  body: JSON.stringify([
    {
      org_id: row.org_id ?? undefined,
      external_id: `${RUN_ID}-planted`,
      assigned_user_id: row.assigned_user_id,
      starts_at: row.starts_at,
      ends_at: row.ends_at,
      status: "confirmed",
    },
  ]),
});
const slotUniqueIndexEnforced = !planted.ok;
if (planted.ok) {
  const inserted = (await planted.json()) as { id: string }[];
  // It was ACCEPTED, which means `bookings_active_slot_uniq` is not doing its job
  // on this branch. Removed first so the run is not left with a planted clash, then
  // reported: the run that follows would otherwise report a double booking this
  // control created.
  for (const r of inserted) {
    await fetch(`${SUPA}/bookings?id=eq.${r.id}`, { method: "DELETE", headers: H });
  }
  fail(
    "the database ACCEPTED a second active booking on the same agent at the same time, so " +
      "bookings_active_slot_uniq is not enforcing on this branch and the run could prove nothing",
  );
}
console.log(`ok: the database refused a planted clash (${planted.status}), so the unique index is live`);

// --- and an OVERLAPPING one, which the unique index cannot see (#2274) ---------
//
// The plant above shares the winner's START, so `bookings_active_slot_uniq`
// refuses it and says nothing whatever about overlap. The booking that actually
// caused #2274 started TEN MINUTES LATER and ran over the top, because
// appointments are longer than the grid they are offered on. That is a different
// guarantee, from a different constraint, and it needs its own plant or the run's
// headline bar rests on something nobody checked (L1).
const probe = overlappingProbeWindow(String(row.starts_at), String(row.ends_at));
if (probe === null) {
  // Refused rather than skipped: a window this cannot shift is one the control
  // could not have been built from, and reporting the constraint unproven is the
  // honest answer (L98).
  fail(
    `the control booking's window (${String(row.starts_at)} to ${String(row.ends_at)}) cannot ` +
      "produce an overlapping probe, so bookings_active_no_overlap was never exercised",
  );
}
const plantedOverlap = await fetch(`${SUPA}/bookings`, {
  method: "POST",
  headers: { ...H, Prefer: "return=representation" },
  body: JSON.stringify([
    {
      org_id: row.org_id ?? undefined,
      external_id: `${RUN_ID}-planted-overlap`,
      assigned_user_id: row.assigned_user_id,
      starts_at: probe!.startIso,
      ends_at: probe!.endIso,
      status: "confirmed",
    },
  ]),
});
const overlapConstraintEnforced = !plantedOverlap.ok;
if (plantedOverlap.ok) {
  const inserted = (await plantedOverlap.json()) as { id: string }[];
  // Removed FIRST, like the clash above: a run left holding this row would report
  // a double booking its own control created.
  for (const r of inserted) {
    await fetch(`${SUPA}/bookings?id=eq.${r.id}`, { method: "DELETE", headers: H });
  }
  fail(
    "the database ACCEPTED a second active booking OVERLAPPING the first on the same agent " +
      `(${probe!.startIso} against ${String(row.starts_at)}), so bookings_active_no_overlap is ` +
      "not enforcing on this branch and the run could prove nothing about the case #2274 found",
  );
}
console.log(
  `ok: the database refused a planted OVERLAP (${plantedOverlap.status}), so the overlap ` +
    "constraint is live",
);

// The judge reads THIS rather than the catalogue, and that is the point.
//
// It used to ask PostgREST for `pg_indexes`, which PostgREST does not expose:
// measured 2026-09-11, that read answers 404 on every environment, so the bar
// reported "bookings_active_slot_uniq is NOT on the branch" on EVERY run. A
// permanently red check is one nobody reads by the second week (L36).
//
// Proving it by BEHAVIOUR is also the stronger proof (L63): an index present in
// the catalogue but not enforcing (invalid, or not the predicate anybody thinks it
// is) reads as fine to a name lookup, and the thing the run actually depends on is
// the database refusing a second active booking on one agent at one time. This
// control just asked it to, so its answer is the measurement.
const OUT = process.env.PREFLIGHT_OUT ?? "results/preflight.json";
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  JSON.stringify(
    {
      runId: RUN_ID,
      slotUniqueIndexEnforced,
      plantedStatus: planted.status,
      // Both guards, recorded separately, because the judge's headline bar rests
      // on both and they are different guarantees (#2274).
      overlapConstraintEnforced,
      plantedOverlapStatus: plantedOverlap.status,
    },
    null,
    2,
  ),
  "utf8",
);
console.log(`\nPREFLIGHT PASSED (wrote ${OUT})`);
