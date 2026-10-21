// #3251: rerouting a booking into a corrected bucket, proved LIVE on the test
// advisors (phase 5 of #3244).
//
// Every reroute decision is pinned offline, and the hold itself in a real Postgres
// (`pnpm verify:reroute-holds-sql`). What neither can see is the production
// database's applied functions and trigger, Google moving a real calendar event, the
// hold's busy block appearing and going, and a real daily cap count, because a fake
// agrees with whatever it is told (L52). This drives the real service code against
// all of them, ONLY in the test world: SMOKE (smoketest@ and smoketest2@) and SMOKE2
// (smoketest@ only), which share the event type every real bucket uses, and the
// public test bucket (smoketest@, its own event type, daily cap 8). No real
// advisor's calendar or pool is touched, and a test bucket's webhooks are
// suppressed where every webhook is sent.
//
// The run, at a start T where Google says both test advisors are clear:
//   1. B0 on SMOKE2 at T takes smoketest@, so B1 on SMOKE at T lands on smoketest2@;
//   2. B1 into SMOKE2: smoketest2@ is not in its pool and smoketest@ is busy, so the
//      LAST RESORT keeps smoketest2@ and changes only the bucket;
//   3. B0 is cancelled, and B1 into SMOKE2 again HOLDS smoketest@. While held, the
//      booker's own candidate list leaves them out and their hold busy block exists;
//   4. the confirm MOVES B1 to smoketest@, the event moves on Google, the hold is
//      consumed and its block is gone; a second confirm answers the same;
//   5. B1 into SMOKE KEEPS smoketest@, who is in its pool and free;
//   6. B3 on the public test bucket at T+60, corrected to that same bucket, keeps
//      smoketest@ against its REAL
//      daily cap of 8, with B3 itself left out of the count;
//   7. B3 into 512, a real bucket, is refused before any search, with nobody held.
// Then, always: every call it made is cancelled, and nothing is left behind.
//
// It WRITES to production (three test calls, their calendar events and holds, all
// removed), so it needs `REROUTE_LIVE_APPLY=1`, and the admin it acts as, by
// address, in `REROUTE_LIVE_ACTOR_EMAIL` (recorded on the hold and the history).
// Not named test-*.ts, because that glob is the offline suite.
//
// Run, from a checkout of current main with the production credentials beside it:
//   REROUTE_LIVE_APPLY=1 REROUTE_LIVE_ACTOR_EMAIL=<admin address> pnpm verify:reroute-live
import { loadEnvFiles } from "./smoke-env.ts";
import { liveTestWorldPreflight } from "./lib/live-test-world-preflight.ts";
import { PUBLIC_TEST_BUCKET_CODES } from "../src/lib/embed/public-test-bucket.ts";
import {
  REROUTE_LIVE_OUTCOMES,
  candidateStarts,
  attemptEach,
  cleanupVerdict,
  eventLedger,
  publicBucketWindowProblem,
  rerouteLostEvent,
  residue,
  testCallIdentity,
  startIsClear,
  type ResidueCheck,
  type RerouteLiveOutcome,
} from "./lib/reroute-live-check.ts";

loadEnvFiles([".env.local", ".dev.vars"]);
/** When this run started; with the call's start it makes every run's booking identity new. */
const RUN_STARTED_MS = Date.now();
const PUBLIC_TEST = PUBLIC_TEST_BUCKET_CODES[0];

function exit(outcome: RerouteLiveOutcome, detail?: string): never {
  const o = REROUTE_LIVE_OUTCOMES[outcome];
  const line = `${outcome === "proven" ? "PROVEN" : "FAIL"} (${o.exit}): ${o.says}${detail ? `. ${detail}` : ""}`;
  (outcome === "proven" ? console.log : console.error)(line);
  process.exit(o.exit);
}

if (process.env.REROUTE_LIVE_APPLY !== "1") exit("notConfigured", "set REROUTE_LIVE_APPLY=1 to let it book and cancel test calls");
const actorEmail = (process.env.REROUTE_LIVE_ACTOR_EMAIL ?? "").trim().toLowerCase();
if (!actorEmail) exit("notConfigured", "set REROUTE_LIVE_ACTOR_EMAIL to the admin this run acts as");
// The whole run, not only its start, must stay clear of the canary's window.
const preflight = liveTestWorldPreflight(process.env, Date.now());
if (preflight) exit(preflight.outcome, preflight.detail);

const { supabaseAdmin } = await import("@/lib/supabase/admin");
const { unwrap } = await import("@/lib/db/result");
const service = await import("@/lib/booking/service");
const { roundRobinCandidates, resolveBucketByCode } = await import("@/lib/availability/service");
const { freeBusy, getEventOnPrimary } = await import("@/lib/google/calendar");
const { RerouteRefusedError } = await import("@/lib/booking/reroute");
const { validateReason, CANCEL_REASONS } = await import("@/lib/booking/core");
const { atLeast } = await import("@/lib/auth/roles");
type Booking = import("@/lib/db/types").Booking;
type Bucket = import("@/lib/db/types").Bucket;
type EventType = import("@/lib/db/types").EventType;

const db = supabaseAdmin();
const step = (msg: string) => console.log(`  ${msg}`);

// --- who and what this run acts on -----------------------------------------------------------
const actorRow = unwrap(
  await db.from("users").select("id, role, is_test, deactivated_at").eq("email", actorEmail).maybeSingle(),
  "acting admin",
) as { id: string; role: string; is_test: boolean; deactivated_at: string | null } | null;
// The same rank test the admin routes apply, so a super admin is an admin too (L122).
if (!actorRow || !atLeast(actorRow.role as import("@/lib/db/types").Role, "admin") || actorRow.deactivated_at) {
  exit("notConfigured", `${actorEmail} is not an active admin`);
}
const actor = { userId: actorRow.id };

const TEST_ADVISORS = ["smoketest@trypennie.com", "smoketest2@trypennie.com"] as const;
const users = unwrap(
  await db.from("users").select("id, email, is_test, bookable, deactivated_at").in("email", [...TEST_ADVISORS]),
  "test advisors",
) as { id: string; email: string; is_test: boolean; bookable: boolean; deactivated_at: string | null }[];
const idOf = new Map(users.map((u) => [u.email, u.id]));
if (users.length !== 2 || users.some((u) => !u.is_test || !u.bookable || u.deactivated_at)) {
  exit("testWorldDiffers", "both test advisors must exist, be test users, bookable and active");
}
const ONE = idOf.get(TEST_ADVISORS[0])!;
const TWO = idOf.get(TEST_ADVISORS[1])!;

async function bucketWithMembers(code: string): Promise<{ bucket: Bucket; eventType: EventType; members: string[] }> {
  const resolved = await resolveBucketByCode(code);
  if (!resolved) exit("testWorldDiffers", `no ${code} bucket`);
  const members = (unwrap(
    await db.from("bucket_members").select("user_id").eq("bucket_id", resolved.bucket.id).eq("active", true),
    `${code} members`,
  ) as { user_id: string }[]).map((m) => m.user_id).sort();
  return { ...resolved, members };
}
const partner = await bucketWithMembers(PUBLIC_TEST);
const smoke = await bucketWithMembers("SMOKE");
const smoke2 = await bucketWithMembers("SMOKE2");
const expectMembers = (b: { bucket: Bucket; members: string[] }, ids: string[]) => {
  if (!b.bucket.is_test || JSON.stringify(b.members) !== JSON.stringify([...ids].sort())) {
    exit("testWorldDiffers", `${b.bucket.code} should be a test bucket holding exactly ${ids.length} test advisor(s)`);
  }
};
expectMembers(partner, [ONE]);
expectMembers(smoke, [ONE, TWO]);
expectMembers(smoke2, [ONE]);
if (partner.eventType.daily_cap == null) exit("testWorldDiffers", "the public test bucket has no daily cap, so the cap check would not run");
// The clear window `startIsClear` checks assumes the public test bucket's call carries
// no buffers (its own event type), so a buffer added there would make it too short.
const windowProblem = publicBucketWindowProblem(partner.eventType);
if (windowProblem) exit("testWorldDiffers", windowProblem);

// --- a start both advisors are clear for, by Google's own answer ------------------------------
const starts = candidateStarts(Date.now());
const windowFrom = new Date(starts[0] - 60 * 60_000).toISOString();
const windowTo = new Date(starts[starts.length - 1] + 2 * 60 * 60_000).toISOString();
/** One advisor's busy time over the week, read through the calendars Slate itself verifies against. */
async function busyFor(email: string) {
  const cals = await service.calendarIdsForEmail(email);
  const rows = cals.readFailed ? null : await freeBusy(email, windowFrom, windowTo, cals.ids.length > 0 ? cals.ids : ["primary"]);
  if (!rows) exit("calendarUnreadable", email);
  const periods = rows.map((r) => ({ startMs: Date.parse(r.start), endMs: Date.parse(r.end) }));
  // An unreadable bound would compare false against everything and read as free (L50).
  if (periods.some((p) => !Number.isFinite(p.startMs) || !Number.isFinite(p.endMs))) exit("calendarUnreadable", `${email} returned a period with no readable bound`);
  return periods;
}
const [busyOne, busyTwo] = await Promise.all([busyFor(TEST_ADVISORS[0]), busyFor(TEST_ADVISORS[1])]);
let T: number | null = null;
for (const s of starts) {
  if (!startIsClear(s, busyOne, busyTwo)) continue;
  // Slate's own judge must agree, or a booking or the search refuses for a reason
  // that is not the one under test: both in SMOKE's pool at T, and smoketest@ free
  // for the public test bucket at T+60.
  const [inSmoke, partnerLater] = await Promise.all([
    roundRobinCandidates(smoke.bucket, smoke.eventType, s, true),
    roundRobinCandidates(partner.bucket, partner.eventType, s + 60 * 60_000, true),
  ]);
  if (inSmoke.candidates.includes(ONE) && inSmoke.candidates.includes(TWO) && partnerLater.candidates.includes(ONE)) {
    T = s;
    break;
  }
}
if (T === null) exit("noClearTime", `tried ${starts.length} starts`);
const iso = (ms: number) => new Date(ms).toISOString();
console.log(`Rerouting live at ${iso(T)} on the test advisors.`);

// --- the run ------------------------------------------------------------------------------------
const made: string[] = [];
/** Every calendar event the run's calls hold, noted as each appears (see `eventLedger`). */
const ledger = eventLedger({ [ONE]: TEST_ADVISORS[0], [TWO]: TEST_ADVISORS[1] });
let failure: { outcome: RerouteLiveOutcome; detail: string } | null = null;
function differ(detail: string): never {
  throw Object.assign(new Error(detail), { outcome: "stepDiffered" as const });
}
const expectEq = (actual: unknown, expected: unknown, what: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) differ(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  step(`ok  ${what}`);
};

function noteEvent(b: Booking): void {
  ledger.note(b);
}

/** Notes the booking's event and fails the step when a reroute left it with none. */
async function noteEventAfter(bookingId: string, what: string): Promise<Booking> {
  const b = await load(bookingId);
  noteEvent(b);
  const lost = rerouteLostEvent(b, what);
  if (lost) differ(lost);
  return b;
}

type ConfirmInput = Parameters<typeof service.adminConfirmReroute>[1];
type Confirmed = { outcome: Awaited<ReturnType<typeof service.adminConfirmReroute>>; booking: Booking };

/**
 * Every confirm in the run goes through here, and only here, so none can skip
 * recording the calendar event it left (and failing when it left none).
 * `scripts/test-reroute-live-wiring.ts` holds the command to that.
 */
async function confirmAndNote(bookingId: string, input: ConfirmInput, what: string): Promise<Confirmed> {
  let outcome: Confirmed["outcome"];
  try {
    outcome = await service.adminConfirmReroute(bookingId, input, actor);
  } catch (err) {
    // A confirm that fails partway may already have put a new event on the
    // booking, so record whatever it holds now for the cleanup before failing. A
    // read that also fails is left to the cleanup's own reads; the confirm's error
    // is the one that names the step.
    await load(bookingId).then(noteEvent, () => undefined);
    throw err;
  }
  const booking = await noteEventAfter(bookingId, what);
  return { outcome, booking };
}

async function book(code: string, startMs: number, n: number): Promise<Booking> {
  const identity = testCallIdentity(startMs, RUN_STARTED_MS, n);
  try {
    const r = await service.createBooking({
      bucketCode: code,
      startIso: iso(startMs),
      timezone: "America/New_York",
      attendee: { name: "Reroute Live Check", firstName: "Reroute", email: "smoke@trypennie.com", phone: "+12125550123" },
      prefill: {},
      externalId: identity.externalId,
      idempotencyKey: identity.idempotencyKey,
      salesforceId: null,
      allowTestBuckets: true,
    });
    made.push(r.booking.id);
    noteEvent(r.booking);
    return r.booking;
  } catch (err) {
    throw Object.assign(new Error(`booking ${n} on ${code} at ${iso(startMs)}: ${err instanceof Error ? err.message : String(err)}`), {
      outcome: "bookingRefused" as const,
    });
  }
}

async function load(id: string): Promise<Booking> {
  return unwrap(await db.from("bookings").select("*").eq("id", id).single(), "booking") as Booking;
}

async function liveHold(bookingId: string) {
  return unwrap(
    await db
      // cap-safe: booking_id is unique on reroute_holds, so at most one row.
      .from("reroute_holds")
      .select("id, agent_user_id, consumed_at, result")
      .eq("booking_id", bookingId)
      .maybeSingle(),
    "reroute hold",
  ) as { id: string; agent_user_id: string; consumed_at: string | null; result: unknown } | null;
}

/**
 * Whether an event is gone from an advisor's calendar. Google answers a read of a
 * DELETED event with 200 and status cancelled, which Slate's own `eventExists` reads
 * as present (#3281), so this judges the status itself until that is fixed.
 */
async function eventGone(email: string, eventId: string | null): Promise<boolean> {
  if (!eventId) return true;
  const event = await getEventOnPrimary(email, eventId);
  return event === null || event.status === "cancelled";
}

async function holdBlocks(userId: string): Promise<number> {
  const rows = unwrap(
    await db
      // cap-safe: one test advisor's hold blocks inside a two hour window.
      .from("busy_blocks")
      .select("id")
      .eq("user_id", userId)
      .eq("source", "hold")
      .lt("starts_at", iso(T! + 60 * 60_000))
      .gt("ends_at", iso(T! - 60 * 60_000)),
    "hold busy blocks",
  ) as { id: string }[];
  return rows.length;
}

try {
  const keepInput = (code: string) => ({ holdId: null, bucketCode: code, requestedBucketCode: code, note: "reroute live check" });

  // 1. B0 takes smoketest@ at T, so B1 in the shared pool lands on smoketest2@
  const b0 = await book("SMOKE2", T, 0);
  const b1 = await book("SMOKE", T, 1);
  expectEq([b0.assigned_user_id, b1.assigned_user_id], [ONE, TWO], "B0 takes smoketest@, so B1 lands on smoketest2@");
  expectEq([b0.gcal_event_id != null, b1.gcal_event_id != null], [true, true], "each holds a calendar event");

  // 2. B1 into SMOKE2: nobody else free, so the last resort keeps the advisor
  const p1 = await service.adminStartReroute(b1.id, "SMOKE2", actor);
  expectEq(p1.kind === "keep" ? [p1.kind, p1.lastResort, p1.advisor.email] : [p1.kind], ["keep", true, TEST_ADVISORS[1]],
    "SMOKE2's only advisor is busy, so smoketest2@ stays as the last resort");
  expectEq(await liveHold(b1.id), null, "a keep places no hold");
  const { outcome: kept1 } = await confirmAndNote(b1.id, keepInput("SMOKE2"), "the last resort keep");
  expectEq(kept1.kind === "kept" ? kept1.bucket.code : kept1.kind, "SMOKE2", "the keep changes the bucket");
  expectEq([(await load(b1.id)).assigned_user_id, (await load(b1.id)).bucket_id], [TWO, smoke2.bucket.id], "and leaves the advisor");

  // 3. with smoketest@ free again, the same correction holds them
  const reason = validateReason({ code: "other", detail: "reroute live check" }, CANCEL_REASONS);
  if (!reason.ok) differ("the cancel reason did not validate");
  await service.adminCancelBooking(b0.id, reason.reason, actor);
  const p2 = await service.adminStartReroute(b1.id, "SMOKE2", actor);
  expectEq(p2.kind === "move" ? [p2.kind, p2.advisor.email, p2.rungsDropped] : [p2.kind], ["move", TEST_ADVISORS[0], 0],
    "SMOKE2 now finds smoketest@, free, and holds them");
  if (p2.kind !== "move") differ("no hold to confirm");
  const h2 = await liveHold(b1.id);
  expectEq([h2?.agent_user_id, h2?.consumed_at ?? null], [ONE, null], "a live hold names smoketest@");
  expectEq((await holdBlocks(ONE)) > 0, true, "the hold writes smoketest@'s busy block");
  const whileHeld = await roundRobinCandidates(smoke2.bucket, smoke2.eventType, T, true);
  expectEq(whileHeld.candidates.includes(ONE), false, "the booker's own candidate list for SMOKE2 at T leaves the held advisor out");

  // 4. the move
  const oldEvent = (await load(b1.id)).gcal_event_id;
  const { outcome: moved, booking: b1Moved } = await confirmAndNote(
    b1.id,
    { holdId: p2.holdId, bucketCode: null, requestedBucketCode: null, note: "reroute live check" },
    "the move",
  );
  const summary = (o: typeof moved) => (o.kind === "moved" ? [o.kind, o.advisor.email, o.bucket.code] : [o.kind]);
  expectEq(summary(moved), ["moved", TEST_ADVISORS[0], "SMOKE2"], "the confirm moves B1 to smoketest@ in SMOKE2");

  expectEq([b1Moved.assigned_user_id, b1Moved.bucket_id], [ONE, smoke2.bucket.id], "the stored booking agrees");
  expectEq((await liveHold(b1.id))?.consumed_at != null, true, "the hold is consumed");
  expectEq(await holdBlocks(ONE), 0, "and its busy block is gone");
  const event = b1Moved.gcal_event_id ? await getEventOnPrimary(TEST_ADVISORS[0], b1Moved.gcal_event_id) : null;
  expectEq(event && event.status !== "cancelled" ? Date.parse(event.start?.dateTime ?? "") : null, T,
    "Google holds the call on smoketest@'s calendar at T");
  expectEq(await eventGone(TEST_ADVISORS[1], oldEvent), true, "and smoketest2@'s event is gone");
  const { outcome: again } = await confirmAndNote(
    b1.id,
    { holdId: p2.holdId, bucketCode: null, requestedBucketCode: null, note: null },
    "a second confirm of the same hold",
  );
  expectEq(summary(again), summary(moved), "a second confirm of the same hold answers with the first result");

  // 5. into SMOKE, where smoketest@ belongs and is free: a plain keep
  const p3 = await service.adminStartReroute(b1.id, "SMOKE", actor);
  expectEq(p3.kind === "keep" ? [p3.kind, p3.lastResort, p3.advisor.email] : [p3.kind], ["keep", false, TEST_ADVISORS[0]],
    "SMOKE keeps smoketest@, who is in its pool and free");
  const { outcome: kept3 } = await confirmAndNote(b1.id, keepInput("SMOKE"), "the keep into SMOKE");
  expectEq(kept3.kind === "kept" ? kept3.bucket.code : kept3.kind, "SMOKE", "and the keep lands");

  // 6. the public test bucket, against its real daily cap
  const b3 = await book(PUBLIC_TEST, T + 60 * 60_000, 3);
  expectEq(b3.assigned_user_id, ONE, "B3 lands on smoketest@ in the public test bucket");
  const p4 = await service.adminStartReroute(b3.id, PUBLIC_TEST, actor);
  expectEq(p4.kind === "keep" ? [p4.kind, p4.lastResort, p4.advisor.email] : [p4.kind], ["keep", false, TEST_ADVISORS[0]],
    "the public test bucket keeps smoketest@ within its daily cap of 8, B3 itself left out of the count");
  const { outcome: kept4 } = await confirmAndNote(b3.id, keepInput(PUBLIC_TEST), "the keep against the daily cap");
  expectEq(kept4.kind, "kept", "and the keep lands");

  // 7. a real bucket is refused, before any search or hold
  let refused: string | null = null;
  try {
    await service.adminStartReroute(b3.id, "512", actor);
  } catch (err) {
    refused = err instanceof RerouteRefusedError ? err.code : String(err);
  }
  expectEq(refused, "across_worlds", "a test call cannot be rerouted into a real bucket");
  expectEq(await liveHold(b3.id), null, "and nobody was held");
} catch (err) {
  const outcome = (err as { outcome?: RerouteLiveOutcome }).outcome ?? "stepDiffered";
  failure = { outcome, detail: err instanceof Error ? err.message : String(err) };
} finally {
  // --- always: cancel what this run made, and prove nothing is left -------------------------
  const cancelReason = validateReason({ code: "other", detail: "reroute live check" }, CANCEL_REASONS);
  // The release and the cancel each get their own attempt (`attemptEach`): a release
  // that fails must not stop the cancel, or the call itself stays on production.
  const failedSteps = await attemptEach(
    made.flatMap((id) => [
      { what: `release the hold on ${id}`, run: () => service.adminReleaseReroute(id, actor) },
      {
        what: `cancel ${id}`,
        run: async () => {
          if ((await load(id)).status !== "cancelled" && cancelReason.ok) await service.adminCancelBooking(id, cancelReason.reason, actor);
        },
      },
    ]),
  );
  for (const f of failedSteps) console.error(`  ${f}`);
  const checks: ResidueCheck[] = [
    ...made.flatMap((id): ResidueCheck[] => [
      { label: `${id}'s status`, leftOver: async () => ((await load(id)).status === "cancelled" ? null : `${id} is not cancelled`) },
      {
        label: `${id}'s hold`,
        leftOver: async () => {
          const h = await liveHold(id);
          return h && !h.consumed_at ? `${id} still has an unconsumed hold` : null;
        },
      },
    ]),
    ...[...ledger.events()].map(([eventId, email]): ResidueCheck => ({
      label: `event ${eventId.slice(0, 16)} on ${email || "an advisor outside the test world"}`,
      leftOver: async () => {
        if (!email) return `event ${eventId.slice(0, 16)} was on an advisor outside the test world`;
        return (await eventGone(email, eventId)) ? null : `event ${eventId.slice(0, 16)} is still on ${email}`;
      },
    })),
    ...[ONE, TWO].map((userId, i): ResidueCheck => ({
      label: `${TEST_ADVISORS[i]}'s hold blocks`,
      leftOver: async () => ((await holdBlocks(userId)) > 0 ? `a hold busy block is still on ${TEST_ADVISORS[i]}` : null),
    })),
  ];
  const verdict = cleanupVerdict(await residue(checks));
  if (verdict) {
    if (failure) console.error(`  (and before cleanup: ${failure.detail})`);
    exit(verdict.outcome, verdict.detail);
  }
}
if (failure) exit(failure.outcome, failure.detail);
exit("proven", `${made.length} test calls through a last resort keep, a held move, a plain keep, a keep against a real daily cap and the cross world refusal, then cancelled`);
