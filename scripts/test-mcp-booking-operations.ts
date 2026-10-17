// #3543: Marcia's five booking operations, driven end to end against a STATEFUL fake
// of the booking service (`scripts/lib/marcia-fake-service.ts`), plus the ties that
// keep that fake honest against the real orchestration.
//
// The plan's named tests (phase 4.2) are here, each by name:
//   - two calls of one attempt produce exactly one booking;
//   - book, cancel, then book the same slot with the same advisor four times with one
//     lead identity, each producing a live booking and a live calendar event, and the
//     SAME sequence FAILS when the key is derived from the lead and the slot (the
//     slate#3291 tombstone), so the test is seen to catch what it guards (L1);
//   - the same nonce twice acts once; two nonces are two attempts;
//   - the bucket's is_test is the one predicate: the Regal hold, the audit test mark
//     and the monitoring source all flip with it.
// And the decision 17 rules: at most five times, opaque slot ids bound to the lead,
// the nearest alternatives on a taken time, a conflict cancel only after a move was
// offered, no opt out or system reason, the per lead daily cap, and every failed
// write alerting with ids only.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-mcp-booking-operations.ts
import { runMarciaOperation, MAX_OFFERED_TIMES, MARCIA_LEAD_DAILY_CHANGE_CAP, MARCIA_REFUSALS, type MarciaAnswer } from "../src/lib/mcp-booking/operations.ts";
import { attemptKey } from "../src/lib/mcp-booking/attempt.ts";
import { issueSlotId } from "../src/lib/mcp-booking/slot-id.ts";
import type { MarciaLeadClaims } from "../src/lib/mcp-booking/token-shape.ts";
import { bookViaApi } from "../src/lib/booking/orchestration.ts";
import { deterministicEventId } from "../src/lib/booking/core.ts";
import { makeMarciaFake } from "./lib/marcia-fake-service.ts";
import { PARTNER_BUCKET_CODE } from "../src/lib/embed/public-test-bucket.ts";
import { makeDeps, input as fakeInput } from "./lib/booking-fakes.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const NOW = Date.parse("2026-06-01T12:00:00.000Z");
// 09:00 to 14:00 in Chicago on 2 June, plus one at 01:00 Chicago, outside the calling window.
const SLOTS = [
  "2026-06-02T06:00:00.000Z",
  "2026-06-02T14:00:00.000Z",
  "2026-06-02T15:00:00.000Z",
  "2026-06-02T16:00:00.000Z",
  "2026-06-02T17:00:00.000Z",
  "2026-06-02T18:00:00.000Z",
  "2026-06-02T19:00:00.000Z",
];

let nonceSeq = 0;
const claims = (over: Partial<MarciaLeadClaims> = {}): MarciaLeadClaims => ({
  iss: "marcia",
  aud: "slate-booking",
  iat: Math.floor(NOW / 1000),
  exp: Math.floor(NOW / 1000) + 600,
  nonce: `attempt-nonce-${String(++nonceSeq).padStart(8, "0")}`,
  salesforce_id: "00Q000000000000AAA",
  bucket_code: "411",
  name: "Fixture Lead",
  email: "fixture.lead@example.com",
  phone: "+15555550100",
  time_zone: "America/Chicago",
  test: false,
  ...over,
});

const okData = (a: MarciaAnswer) => (a.ok ? a.data : null);
type Times = { slot_id: string; starts_at: string; label: string }[];

async function firstSlot(fake: ReturnType<typeof makeMarciaFake>, c = claims()): Promise<string> {
  const a = await runMarciaOperation("find_times", {}, c, fake.deps);
  return ((okData(a)?.times as Times) ?? [])[0]!.slot_id;
}

// --- find_times ------------------------------------------------------------------
{
  const fake = makeMarciaFake({ nowMs: NOW, slots: SLOTS });
  const a = await runMarciaOperation("find_times", {}, claims(), fake.deps);
  assert(a.ok, "find_times answers");
  const times = (okData(a)?.times as Times) ?? [];
  eq(times.length, MAX_OFFERED_TIMES, "at most five times are offered");
  assert(!times.some((t) => t.starts_at === SLOTS[0]), "a time outside the lead's calling window is never offered");
  eq(times[0]?.label, "Tuesday, June 2 at 9:00am CDT", "each time is preformatted in the lead's zone");
  assert(times.every((t) => !t.slot_id.includes("2026")), "a slot id is opaque: it does not spell the time");
  eq(okData(a)?.data_as_of, "2026-06-01T00:00:00.000Z", "the answer carries the slot cache's own time");
  const ny = await runMarciaOperation("find_times", { time_zone: "America/New_York" }, claims(), fake.deps);
  eq(((okData(ny)?.times as Times) ?? [])[0]?.label, "Tuesday, June 2 at 10:00am EDT", "the time zone is the one thing an argument may override");
  const bad = await runMarciaOperation("find_times", { time_zone: "Not/AZone" }, claims(), fake.deps);
  eq(bad.ok ? null : bad.code, "args_invalid", "an unknown zone is refused, never guessed");
}

// --- book, and the lead coming from the token only ----------------------------------
{
  const fake = makeMarciaFake({ nowMs: NOW, slots: SLOTS });
  const c = claims();
  const slot = await firstSlot(fake, c);
  const a = await runMarciaOperation("book", { slot_id: slot, salesforce_id: "00Q999999999999ZZZ", email: "someone@else.example" }, c, fake.deps);
  assert(a.ok && okData(a)?.outcome === "created", "book creates a booking");
  eq(fake.bookings.length, 1, "exactly one booking");
  eq(fake.bookings[0]?.salesforceId, c.salesforce_id, "the lead is the token's, whatever an argument names");
  eq(fake.bookings[0]?.source, "mcp-marcia", "the booking records the MCP channel as its source");
  eq(fake.audits.length, 1, "the write is audited once");
  const entry = fake.audits[0]!.entry;
  eq([entry.action, entry.channel, entry.actorId, entry.details?.salesforce_id, entry.details?.test], ["booking.created", "marcia", null, c.salesforce_id, false], "the audit row: created, channel marcia, null actor, the 00Q id, not a test");
  eq(entry.details?.attempt, attemptKey("book", c), "the audit row names the attempt");
  const again = await runMarciaOperation("book", { slot_id: slot }, claims(), fake.deps);
  eq(again.ok ? null : again.code, "lead_has_booking", "a second attempt to book while one is held is told to move instead");
}

// --- the plan's idempotency tests -----------------------------------------------------
{
  // Two calls of ONE attempt (a retry carries the same nonce) produce exactly one booking.
  const fake = makeMarciaFake({ nowMs: NOW, slots: SLOTS });
  const c = claims();
  const slot = await firstSlot(fake, c);
  const first = await runMarciaOperation("book", { slot_id: slot }, c, fake.deps);
  const retry = await runMarciaOperation("book", { slot_id: slot }, c, fake.deps);
  eq(fake.bookings.length, 1, "two calls of one attempt produce exactly one booking");
  eq(fake.events.size, 1, "and exactly one calendar event");
  eq(fake.audits.length, 1, "and one audit row: the retry records nothing new");
  eq((okData(retry)?.booking as { booking_id: string })?.booking_id, (okData(first)?.booking as { booking_id: string })?.booking_id, "the retry answers with the same booking");
  // A retry that arrives after its slot id expired is still the same attempt.
  fake.advance(31 * 60 * 1000);
  const late = await runMarciaOperation("book", { slot_id: slot }, c, fake.deps);
  assert(late.ok && okData(late)?.replay === true, "a retry after the slot id expired answers as a replay, not slot_invalid");
  eq(fake.bookings.length, 1, "and still books nothing new");
  // Two nonces are two attempts, whatever else they share.
  assert(attemptKey("book", claims({ nonce: "nonce-aaaaaaaaaaaaaaaa" })) !== attemptKey("book", claims({ nonce: "nonce-bbbbbbbbbbbbbbbb" })), "two nonces are two attempt keys");
  eq(attemptKey("book", c), attemptKey("book", { ...c }), "the same nonce is the same attempt key");
}

async function rebookFourTimes(keyFrom: "input" | "lead-and-slot") {
  const fake = makeMarciaFake({ nowMs: NOW, slots: SLOTS, keyFrom });
  const startOf = async (c: MarciaLeadClaims) => issueSlotId({ startIso: SLOTS[1]!, bucketCode: "411", salesforceId: c.salesforce_id }, fake.deps.slotSecret, NOW);
  const answers: MarciaAnswer[] = [];
  for (let i = 0; i < 4; i++) {
    const c = claims();
    answers.push(await runMarciaOperation("book", { slot_id: await startOf(c) }, c, fake.deps));
    if (i < 3) {
      const cancel = await runMarciaOperation("cancel", { reason_code: "no_longer_interested" }, claims(), fake.deps);
      answers.push(cancel);
    }
  }
  return { fake, answers };
}

{
  const { fake, answers } = await rebookFourTimes("input");
  const books = answers.filter((a) => a.operation === "book");
  eq(books.filter((a) => a.ok).length, 4, "book, cancel, then book the same slot with the same advisor: all four books succeed");
  eq(fake.bookings.filter((b) => b.status === "confirmed").length, 1, "the last one is live");
  eq(new Set(fake.bookings.map((b) => b.eventId)).size, 4, "each of the four got its own calendar event id");
  eq([...fake.events.values()].filter((s) => s === "live").length, 1, "and the live booking's event is live");
  eq(fake.audits.map((a) => a.entry.action).join(","), "booking.created,booking.cancelled,booking.created,booking.cancelled,booking.created,booking.cancelled,booking.created", "every write audited once, in order");

  // Positive control: the same sequence with the key derived from the lead and the slot
  // reaches the deleted event's id on the second book and is refused.
  const control = await rebookFourTimes("lead-and-slot");
  const controlBooks = control.answers.filter((a) => a.operation === "book");
  eq(controlBooks.filter((a) => a.ok).length, 1, "control: a lead and slot key books once, then every rebook meets the tombstone");
  assert(controlBooks.slice(1).every((a) => !a.ok && a.code === "internal"), "control: each rebook fails as an internal fault");
  assert(control.fake.alerts.some((f) => f.operation === "book" && f.code === "internal"), "control: and each failed rebook alerts");
}

// --- the same nonce twice acts once, for a cancel too ----------------------------------
{
  const fake = makeMarciaFake({ nowMs: NOW, slots: SLOTS });
  const c = claims();
  await runMarciaOperation("book", { slot_id: await firstSlot(fake, c) }, c, fake.deps);
  const cancel = claims();
  const one = await runMarciaOperation("cancel", { reason_code: "booked_by_mistake" }, cancel, fake.deps);
  const id = (okData(one)?.booking as { booking_id: string }).booking_id;
  const two = await runMarciaOperation("cancel", { reason_code: "booked_by_mistake", booking_id: id }, cancel, fake.deps);
  eq(okData(one)?.outcome, "cancelled", "the first cancel cancels");
  eq(okData(two)?.outcome, "already_cancelled", "the retry of that cancel answers already cancelled");
  eq(fake.audits.filter((a) => a.entry.action === "booking.cancelled").length, 1, "and records one cancel");
}

// --- slot ids ---------------------------------------------------------------------------
{
  const fake = makeMarciaFake({ nowMs: NOW, slots: SLOTS });
  const otherLead = claims({ salesforce_id: "00Q111111111111BBB" });
  const theirs = await firstSlot(fake, otherLead);
  const a = await runMarciaOperation("book", { slot_id: theirs }, claims(), fake.deps);
  eq(a.ok ? null : a.code, "slot_invalid", "a slot id offered to another lead is refused");
  const forged = await runMarciaOperation("book", { slot_id: `${theirs.split(".")[0]}.AAAA` }, claims(), fake.deps);
  eq(forged.ok ? null : forged.code, "slot_invalid", "a slot id with a forged MAC is refused");
  const raw = await runMarciaOperation("book", { slot_id: SLOTS[1] }, claims(), fake.deps);
  eq(raw.ok ? null : raw.code, "slot_invalid", "a bare time is not a slot id");
  const c = claims();
  const late = await firstSlot(fake, c);
  fake.advance(31 * 60 * 1000);
  const stale = await runMarciaOperation("book", { slot_id: late }, c, fake.deps);
  eq(stale.ok ? null : stale.code, "slot_invalid", "a slot id older than half an hour is refused");
  eq(fake.bookings.length, 0, "and none of them booked");
}

// --- a taken time offers the nearest one or two ------------------------------------------
{
  const fake = makeMarciaFake({ nowMs: NOW, slots: SLOTS, takenByOthers: new Set([SLOTS[3]!]) });
  const c = claims();
  const slot = await issueSlotId({ startIso: SLOTS[3]!, bucketCode: "411", salesforceId: c.salesforce_id }, fake.deps.slotSecret, NOW);
  const a = await runMarciaOperation("book", { slot_id: slot }, c, fake.deps);
  assert(!a.ok && a.code === "slot_taken" && a.class === "expected", "a taken time is an expected refusal");
  const alts = !a.ok ? (a.alternatives ?? []) : [];
  eq(alts.map((t) => t.starts_at).sort(), [SLOTS[2], SLOTS[4]].sort(), "with the nearest two times offered instead");
  const alert = fake.alerts.find((f) => f.code === "slot_taken");
  assert(alert !== undefined && alert.class === "expected", "and, a failed write, it alerts (decision 11)");
  eq(fake.outcomes.at(-1), { outcome: "error", bucketCode: "411", errorCode: "SLOT_TAKEN" }, "and is counted as the #250 API counts it");
}

// --- cancel rules (decision 17) -----------------------------------------------------------
{
  const fake = makeMarciaFake({ nowMs: NOW, slots: SLOTS });
  const c = claims();
  await runMarciaOperation("book", { slot_id: await firstSlot(fake, c) }, c, fake.deps);
  const conflict = await runMarciaOperation("cancel", { reason_code: "schedule_conflict" }, claims(), fake.deps);
  assert(!conflict.ok && conflict.code === "move_not_offered" && conflict.class === "expected", "a conflict cancel before a move was offered is refused, as expected");
  const madeUp = await runMarciaOperation("cancel", { reason_code: "schedule_conflict", declined_slot_ids: ["anything"] }, claims(), fake.deps);
  eq(madeUp.ok ? null : madeUp.code, "move_not_offered", "a slot id the model made up proves nothing was offered");
  const optOut = await runMarciaOperation("cancel", { reason_code: "text_opt_out" }, claims(), fake.deps);
  eq(optOut.ok ? null : optOut.code, "reason_not_allowed", "an opt out never reaches Slate through Marcia");
  const unknown = await runMarciaOperation("cancel", { reason_code: "because" }, claims(), fake.deps);
  eq(unknown.ok ? null : unknown.code, "reason_invalid", "a reason outside Slate's list is refused");
  eq(fake.bookings[0]?.status, "confirmed", "none of those cancelled anything");
  const offered = ((okData(await runMarciaOperation("find_times", {}, c, fake.deps))?.times as Times) ?? []).map((t) => t.slot_id);
  const declinedClaims = claims();
  const declined = await runMarciaOperation("cancel", { reason_code: "schedule_conflict", declined_slot_ids: offered }, declinedClaims, fake.deps);
  eq(okData(declined)?.outcome, "cancelled", "a conflict cancel after the offered times were declined cancels");
  // Its retry, after the offered slot ids have expired, answers as the first call did.
  fake.advance(31 * 60 * 1000);
  const retry = await runMarciaOperation("cancel", { reason_code: "schedule_conflict", declined_slot_ids: offered }, declinedClaims, fake.deps);
  eq(okData(retry)?.outcome, "already_cancelled", "a retry of a conflict cancel whose proof has expired is a replay, not move_not_offered");
}

{
  // A move moves a call the lead holds; with none it is refused, never a quiet create.
  const fake = makeMarciaFake({ nowMs: NOW, slots: SLOTS });
  const c = claims();
  const m = await runMarciaOperation("move", { slot_id: await firstSlot(fake, c) }, c, fake.deps);
  eq(m.ok ? null : m.code, "no_booking", "a move with no booking held is refused");
  eq(fake.bookings.length, 0, "and creates nothing");
}

{
  // A retry of a write that was the lead's LAST allowed change is a replay, not a fourth
  // change: it is not refused by the cap its own first call used up.
  const fake = makeMarciaFake({ nowMs: NOW, slots: SLOTS });
  const c = claims();
  const times = ((okData(await runMarciaOperation("find_times", {}, c, fake.deps))?.times as Times) ?? []);
  await runMarciaOperation("book", { slot_id: times[0]!.slot_id }, c, fake.deps);
  await runMarciaOperation("move", { slot_id: times[1]!.slot_id }, claims(), fake.deps);
  await runMarciaOperation("move", { slot_id: times[2]!.slot_id }, claims(), fake.deps);
  const last = claims();
  const third = await runMarciaOperation("cancel", { reason_code: "no_longer_interested" }, last, fake.deps);
  eq(okData(third)?.outcome, "cancelled", "the third change of the day goes through");
  const alertsBefore = fake.alerts.length;
  const retried = await runMarciaOperation("cancel", { reason_code: "no_longer_interested" }, last, fake.deps);
  eq(okData(retried)?.outcome, "already_cancelled", "its retry, naming no booking, answers already cancelled rather than no booking or the cap");
  eq(fake.alerts.length, alertsBefore, "and pages nobody");
  eq(fake.audits.filter((a) => a.entry.action === "booking.cancelled").length, 1, "with one cancel recorded");
}

// --- the per lead daily cap ----------------------------------------------------------------
{
  const fake = makeMarciaFake({ nowMs: NOW, slots: SLOTS });
  const c = claims();
  const times = ((okData(await runMarciaOperation("find_times", {}, c, fake.deps))?.times as Times) ?? []);
  await runMarciaOperation("book", { slot_id: times[0]!.slot_id }, c, fake.deps);
  for (let i = 1; i <= MARCIA_LEAD_DAILY_CHANGE_CAP; i++) {
    const m = await runMarciaOperation("move", { slot_id: times[i]!.slot_id }, claims(), fake.deps);
    eq(okData(m)?.outcome, "rescheduled", `move ${i} of ${MARCIA_LEAD_DAILY_CHANGE_CAP} goes through`);
  }
  const over = await runMarciaOperation("move", { slot_id: times[4]!.slot_id }, claims(), fake.deps);
  assert(!over.ok && over.code === "lead_daily_cap" && over.class === "expected", "the next change is refused by the daily cap, as expected");
  const cancelOver = await runMarciaOperation("cancel", { reason_code: "no_longer_interested" }, claims(), fake.deps);
  eq(cancelOver.ok ? null : cancelOver.code, "lead_daily_cap", "a cancel counts toward the same cap");
  fake.advance(24 * 60 * 60 * 1000 + 1);
  const tomorrow = await runMarciaOperation("cancel", { reason_code: "no_longer_interested" }, claims(), fake.deps);
  eq(okData(tomorrow)?.outcome, "cancelled", "a day later the lead may change again");
}

{
  // A count that cannot be read refuses under its own name, never as the cap reached.
  const fake = makeMarciaFake({ nowMs: NOW, slots: SLOTS });
  const c = claims();
  await runMarciaOperation("book", { slot_id: await firstSlot(fake, c) }, c, fake.deps);
  fake.deps.recentChanges = async () => {
    throw new Error("audit_log read failed");
  };
  const blind = await runMarciaOperation("cancel", { reason_code: "no_longer_interested" }, claims(), fake.deps);
  assert(!blind.ok && blind.code === "cap_unreadable" && blind.class === "unexpected", "an unreadable count refuses as cap_unreadable, never as lead_daily_cap");
  eq(fake.bookings[0]?.status, "confirmed", "and cancels nothing: the cap fails closed");
}

// --- test mode: the bucket's is_test is the one predicate -----------------------------------
{
  const fake = makeMarciaFake({ nowMs: NOW, slots: SLOTS });
  const t = claims({ test: true });
  const slot = await firstSlot(fake, t);
  const a = await runMarciaOperation("book", { slot_id: slot }, t, fake.deps);
  assert(a.ok, "a test flagged token books");
  eq(fake.bookings[0]?.bucketCode, PARTNER_BUCKET_CODE, "into the partner test bucket, whatever bucket the token names");
  eq(fake.audits[0]?.entry.details?.test, true, "the audit test mark is read off the booked bucket");
  eq(fake.outcomes.at(-1)?.bucketCode, PARTNER_BUCKET_CODE, "the outcome is counted under the test bucket, which the monitoring exclusion reads");

  // A real token naming a test bucket meets the same refusal a typo does.
  const sneaky = claims({ bucket_code: PARTNER_BUCKET_CODE, test: false });
  const found = await runMarciaOperation("find_times", {}, sneaky, fake.deps);
  eq(found.ok ? null : found.code, "unknown_bucket", "a real token cannot read a test bucket's times");
  const s2 = await issueSlotId({ startIso: SLOTS[2]!, bucketCode: PARTNER_BUCKET_CODE, salesforceId: sneaky.salesforce_id }, fake.deps.slotSecret, NOW);
  const booked = await runMarciaOperation("book", { slot_id: s2 }, sneaky, fake.deps);
  eq(booked.ok ? null : booked.code, "unknown_bucket", "nor book one");
}

// The same flag, read by the REAL orchestration: the Regal hold (#459/0066) is the
// booked bucket's is_test, so flipping the bucket flips the suppression with it.
for (const testBucket of [false, true]) {
  const { deps, calls } = makeDeps({ personBookings: [], candidates: ["a"], freeEmails: new Set(["a@x.com"]), testBucket });
  await bookViaApi({ ...fakeInput, externalId: "00Q000000000000AAA", confirmReschedule: false, allowTestBuckets: true, idempotencyKey: "mcp-marcia:book:00Q000000000000AAA:n1", mcpChannel: "marcia" }, deps);
  const created = calls.webhooks.find((w) => w.event === "booking.created");
  eq(created?.suppressed, testBucket, `the Regal webhook is held exactly when the bucket is a test one (is_test ${testBucket})`);
  if (!testBucket) {
    eq(calls.createEvent[0]?.clientId, await deterministicEventId("mcp-marcia:book:00Q000000000000AAA:n1", "a"), "the real orchestration names the event by the attempt key and the advisor, which is what the fake models");
    eq(calls.insertBooking[0]?.source ?? (calls.insertBooking[0] as { booking?: { source?: string } } | undefined)?.booking?.source, "mcp-marcia", "and records the MCP source on the row");
  }
}

// --- alerts carry ids only ---------------------------------------------------------------------
{
  const fake = makeMarciaFake({ nowMs: NOW, slots: SLOTS });
  const c = claims();
  await runMarciaOperation("book", { slot_id: "garbage" }, c, fake.deps);
  await runMarciaOperation("cancel", { reason_code: "schedule_conflict" }, c, fake.deps);
  const text = JSON.stringify(fake.alerts.map(({ cause: _c, ...rest }) => rest));
  assert(fake.alerts.length === 2, "each failed write alerted");
  assert(!text.includes(c.email) && !text.includes(c.phone) && !text.includes(c.name), "no alert carries the lead's name, email or phone");
  // A read that fails as expected does not alert; one that goes wrong does.
  const before = fake.alerts.length;
  await runMarciaOperation("find_times", { time_zone: "Nope/Nope" }, c, fake.deps);
  eq(fake.alerts.length, before + 1, "an unexpected read failure alerts");
}

// --- every refusal is classified once ------------------------------------------------------------
{
  const classes = new Set(Object.values(MARCIA_REFUSALS).map((r) => r.class));
  eq([...classes].sort(), ["expected", "unexpected"], "every refusal is one of two classes");
  eq(
    Object.entries(MARCIA_REFUSALS).filter(([, r]) => r.class === "expected").map(([c]) => c).sort(),
    ["lead_daily_cap", "lead_has_booking", "move_not_offered", "slot_taken"],
    "the expected refusals are the plan's three plus the told-to-move answer",
  );
}

finish();
