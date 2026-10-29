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

// Moves the lead's call to the first time offered NOW. The offer leaves out the time the
// lead holds, so every call is a real move, however many the cap allows.
async function moveToNextOfferedTime(fake: ReturnType<typeof makeMarciaFake>): Promise<MarciaAnswer> {
  return runMarciaOperation("move", { slot_id: await firstSlot(fake) }, claims(), fake.deps);
}

// The changes one lead has made in the rolling day, read through the fake's own count.
const changesToday = (fake: ReturnType<typeof makeMarciaFake>) =>
  fake.deps.recentChanges(claims().salesforce_id, fake.deps.nowMs() - 24 * 60 * 60 * 1000);

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

// --- find_times honours `from` (live 2026-10-21: "from tomorrow" was offered today) -------
// The fake slot read ignores `from` (the real one judges its tier and days from it,
// #4014), so this pins the floor the offer itself applies. NOW is 07:00 CDT on 1 June.
{
  const TWO_DAYS = [
    "2026-06-01T13:00:00.000Z", // 1 June 08:00 CDT
    "2026-06-01T18:00:00.000Z", // 1 June 13:00 CDT
    "2026-06-02T00:30:00.000Z", // 1 June 19:30 CDT: 2 June in UTC, still 1 June for the lead
    "2026-06-02T14:00:00.000Z", // 2 June 09:00 CDT
    "2026-06-02T15:00:00.000Z", // 2 June 10:00 CDT
  ];
  const fake = makeMarciaFake({ nowMs: NOW, slots: TWO_DAYS });
  const tomorrow = await runMarciaOperation("find_times", { from: "2026-06-02" }, claims(), fake.deps);
  assert(tomorrow.ok, "find_times answers with a from date");
  eq(
    ((okData(tomorrow)?.times as Times) ?? []).map((t) => t.starts_at),
    ["2026-06-02T14:00:00.000Z", "2026-06-02T15:00:00.000Z"],
    "a from date offers only times on or after it, the day read in the lead's zone",
  );

  const none = await runMarciaOperation("find_times", {}, claims(), fake.deps);
  eq(
    ((okData(none)?.times as Times) ?? []).map((t) => t.starts_at),
    TWO_DAYS,
    "with no from date, every open time from now is offered as before",
  );

  const noticed = makeMarciaFake({ nowMs: NOW, slots: TWO_DAYS, minNoticeMin: 6 * 60 + 30 });
  const past = await runMarciaOperation("find_times", { from: "2026-05-20" }, claims(), noticed.deps);
  eq(
    ((okData(past)?.times as Times) ?? []).map((t) => t.starts_at),
    TWO_DAYS.slice(2),
    "a from date in the past still offers nothing before now plus the minimum notice",
  );
}

// --- find_times states today's date in the lead's zone (lesson L820, #4327) ------------
// The model writes `from` itself, so "next Tuesday" becomes a date only from what is in
// its context. Every answer carries today, as the lead's calendar reads it, and a from
// date already past says so rather than being read as now in silence.
{
  const fake = makeMarciaFake({ nowMs: NOW, slots: SLOTS });
  const plain = await runMarciaOperation("find_times", {}, claims(), fake.deps);
  eq(okData(plain)?.today, "Monday, June 1, 2026", "the answer names today in the lead's zone");
  eq(okData(plain)?.from_note, undefined, "no from date, no note");

  // 22:00 CDT on 1 June is already 2 June in UTC: today is the lead's day, not the server's.
  const late = makeMarciaFake({ nowMs: Date.parse("2026-06-02T03:00:00.000Z"), slots: SLOTS });
  const lateAnswer = await runMarciaOperation("find_times", {}, claims(), late.deps);
  eq(okData(lateAnswer)?.today, "Monday, June 1, 2026", "today is read in the lead's zone, never UTC");
  const eastern = await runMarciaOperation("find_times", { time_zone: "America/New_York" }, claims(), late.deps);
  eq(okData(eastern)?.today, "Monday, June 1, 2026", "23:00 in New York is still 1 June there");
  const tokyo = await runMarciaOperation("find_times", { time_zone: "Asia/Tokyo" }, claims(), late.deps);
  eq(okData(tokyo)?.today, "Tuesday, June 2, 2026", "a zone already past midnight reads the next day");

  const past = await runMarciaOperation("find_times", { from: "2025-06-03" }, claims(), fake.deps);
  assert(past.ok, "a past from date still answers");
  eq(
    okData(past)?.from_note,
    "The from date 2025-06-03 is before today (Monday, June 1, 2026 for the lead), so these times start from now. Check the date the lead meant.",
    "a from date already past is named as such, never read as now in silence",
  );
  const sameDay = await runMarciaOperation("find_times", { from: "2026-06-01" }, claims(), fake.deps);
  eq(okData(sameDay)?.from_note, undefined, "today itself is not a past date");
  const ahead = await runMarciaOperation("find_times", { from: "2026-06-02" }, claims(), fake.deps);
  eq(okData(ahead)?.from_note, undefined, "a future from date carries no note");
  eq(okData(ahead)?.today, "Monday, June 1, 2026", "today is stated whatever from asked for");
}

// --- find_times `near` a time of day (live 2026-10-21: "3pm tomorrow" was offered 8:00
// to 9:30am and moved to 9:30am, because only the first five times from `from` came back).
// NOW is 07:00 CDT on 1 June; every slot below is on the half hour, written in UTC.
{
  // Every half hour a lead may be called on 2 June (08:00 to 19:30 CDT), plus a morning
  // on 1 June and on 3 June, so a pick that ignores the day is caught.
  const halfHoursCdt = (day: string, fromHour: number, toHour: number, skip: string[] = []): string[] => {
    const out: string[] = [];
    for (let h = fromHour; h <= toHour; h++) {
      for (const m of [0, 30]) {
        const local = `${day}T${String(h).padStart(2, "0")}:${m === 0 ? "00" : "30"}`;
        if (skip.includes(local.slice(11))) continue;
        out.push(new Date(Date.parse(`${local}:00-05:00`)).toISOString());
      }
    }
    return out;
  };
  const cdt = (local: string) => new Date(Date.parse(`${local}:00-05:00`)).toISOString();
  const starts = (a: MarciaAnswer) => ((okData(a)?.times as Times) ?? []).map((t) => t.starts_at);

  const FULL = [...halfHoursCdt("2026-06-01", 8, 10), ...halfHoursCdt("2026-06-02", 8, 19), ...halfHoursCdt("2026-06-03", 8, 10)];
  const full = makeMarciaFake({ nowMs: NOW, slots: FULL });
  const at3 = await runMarciaOperation("find_times", { from: "2026-06-02", near: "15:00" }, claims(), full.deps);
  assert(at3.ok, "find_times answers with near");
  eq(
    starts(at3),
    ["2026-06-02T14:00", "2026-06-02T14:30", "2026-06-02T15:00", "2026-06-02T15:30", "2026-06-02T16:00"].map(cdt),
    "near 15:00 offers the five open times nearest 3pm that day, 3pm itself among them, in start order",
  );
  eq(((okData(at3)?.times as Times) ?? [])[2]?.label, "Tuesday, June 2 at 3:00pm CDT", "and each is still written out in the lead's zone");

  const unchanged = await runMarciaOperation("find_times", { from: "2026-06-02" }, claims(), full.deps);
  eq(starts(unchanged), halfHoursCdt("2026-06-02", 8, 10).slice(0, MAX_OFFERED_TIMES), "with no near, the first five times from the day are offered as before");

  // 3pm itself is taken: its neighbours come back, the tie at 90 minutes going to the earlier.
  const gap = makeMarciaFake({ nowMs: NOW, slots: [...halfHoursCdt("2026-06-02", 8, 19, ["15:00"]), ...halfHoursCdt("2026-06-03", 8, 19)] });
  eq(
    starts(await runMarciaOperation("find_times", { from: "2026-06-02", near: "15:00" }, claims(), gap.deps)),
    ["2026-06-02T13:30", "2026-06-02T14:00", "2026-06-02T14:30", "2026-06-02T15:30", "2026-06-02T16:00"].map(cdt),
    "with no time open at that exact minute, the nearest open neighbours are offered",
  );

  // A day with two open times offers those two, never a time from another day.
  const thin = makeMarciaFake({ nowMs: NOW, slots: [...halfHoursCdt("2026-06-02", 8, 19), cdt("2026-06-03T09:00"), cdt("2026-06-03T17:30"), ...halfHoursCdt("2026-06-04", 8, 19)] });
  eq(
    starts(await runMarciaOperation("find_times", { from: "2026-06-03", near: "15:00" }, claims(), thin.deps)),
    [cdt("2026-06-03T09:00"), cdt("2026-06-03T17:30")],
    "a day with fewer than five open times offers what it has",
  );

  // With no from, near is read on today in the lead's zone.
  eq(
    starts(await runMarciaOperation("find_times", { near: "09:00" }, claims(), full.deps)),
    halfHoursCdt("2026-06-01", 8, 10).slice(0, MAX_OFFERED_TIMES),
    "near with no from date is read on today, in the lead's zone",
  );
  eq(
    starts(await runMarciaOperation("find_times", { from: "2026-05-20", near: "09:00" }, claims(), full.deps)),
    halfHoursCdt("2026-06-01", 8, 10).slice(0, MAX_OFFERED_TIMES),
    "a from date in the past is read as today, as it is without near, never as an empty day",
  );

  // A slot at 19:30 CDT on 2 June is 00:30 UTC on 3 June, and is still 2 June to the lead.
  eq(
    starts(await runMarciaOperation("find_times", { from: "2026-06-02", near: "19:59" }, claims(), full.deps)),
    ["2026-06-02T17:30", "2026-06-02T18:00", "2026-06-02T18:30", "2026-06-02T19:00", "2026-06-02T19:30"].map(cdt),
    "the day is the lead's day, not the UTC one",
  );

  // The calling window and the minimum notice still apply: nothing before 08:00 for the lead.
  const early = makeMarciaFake({ nowMs: NOW, slots: [cdt("2026-06-02T06:00"), cdt("2026-06-02T07:30"), ...halfHoursCdt("2026-06-02", 8, 19)] });
  eq(
    starts(await runMarciaOperation("find_times", { from: "2026-06-02", near: "06:00" }, claims(), early.deps)),
    halfHoursCdt("2026-06-02", 8, 10).slice(0, MAX_OFFERED_TIMES),
    "near never offers a time outside the lead's calling window",
  );
  // 07:00 now plus 150 minutes' notice: nothing before 09:30 today, however near 09:00 is.
  const noticed = makeMarciaFake({ nowMs: NOW, slots: FULL, minNoticeMin: 150 });
  eq(
    starts(await runMarciaOperation("find_times", { near: "09:00" }, claims(), noticed.deps)),
    ["2026-06-01T09:30", "2026-06-01T10:00", "2026-06-01T10:30"].map(cdt),
    "near never offers a time inside the minimum notice",
  );

  for (const near of ["3pm", "15", "25:00", "15:60", "15:00:00", " 15:00", "", 1500, null]) {
    const r = await runMarciaOperation("find_times", { from: "2026-06-02", near }, claims(), full.deps);
    eq(r.ok ? null : r.code, "args_invalid", `a malformed near (${JSON.stringify(near)}) is refused, never guessed`);
  }
  const noDay = await runMarciaOperation("find_times", { from: "next tuesday", near: "15:00" }, claims(), full.deps);
  eq(noDay.ok ? null : noDay.code, "args_invalid", "near with a from that is not a date is refused");
}

// --- book, and the lead coming from the token only ----------------------------------
{
  const fake = makeMarciaFake({ nowMs: NOW, slots: SLOTS });
  const c = claims();
  const slot = await firstSlot(fake, c);
  // A model naming another lead in an argument reaches nobody: no tool takes a lead,
  // so the argument is refused by name (#4013) and nothing is booked for anyone.
  const named = await runMarciaOperation("book", { slot_id: slot, salesforce_id: "00Q999999999999ZZZ", email: "someone@else.example" }, c, fake.deps);
  eq(named.ok ? null : [named.code, named.invalid_argument], ["args_invalid", "salesforce_id"], "a lead id passed as an argument is refused by name, never read");
  eq(fake.bookings.length, 0, "and nothing is booked");
  const a = await runMarciaOperation("book", { slot_id: slot }, c, fake.deps);
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
  // A retry of a write that was the lead's LAST allowed change is a replay, not one change
  // past the cap: it is not refused by the cap its own first call used up.
  const fake = makeMarciaFake({ nowMs: NOW, slots: SLOTS });
  const c = claims();
  await runMarciaOperation("book", { slot_id: await firstSlot(fake, c) }, c, fake.deps);
  for (let i = 1; i < MARCIA_LEAD_DAILY_CHANGE_CAP; i++) {
    eq(okData(await moveToNextOfferedTime(fake))?.outcome, "rescheduled", `move ${i} before the last allowed change goes through`);
  }
  const last = claims();
  const lastAllowed = await runMarciaOperation("cancel", { reason_code: "no_longer_interested" }, last, fake.deps);
  eq(okData(lastAllowed)?.outcome, "cancelled", "the last change the cap allows goes through");
  eq(await changesToday(fake), MARCIA_LEAD_DAILY_CHANGE_CAP, "so the retry below arrives with the cap used up");
  const alertsBefore = fake.alerts.length;
  const retried = await runMarciaOperation("cancel", { reason_code: "no_longer_interested" }, last, fake.deps);
  eq(okData(retried)?.outcome, "already_cancelled", "its retry, naming no booking, answers already cancelled rather than no booking or the cap");
  eq(fake.alerts.length, alertsBefore, "and pages nobody");
  eq(fake.audits.filter((a) => a.entry.action === "booking.cancelled").length, 1, "with one cancel recorded");
}

// --- the per lead daily cap ----------------------------------------------------------------
{
  // Dan set the cap to 7 on 2026-10-21, after 3 refused a live test lead three moves into
  // one afternoon. Pinned here so a change to it is a decision, never an accident.
  eq(MARCIA_LEAD_DAILY_CHANGE_CAP, 7, "a lead may make 7 moves plus cancels in a rolling day");
  const fake = makeMarciaFake({ nowMs: NOW, slots: SLOTS });
  const c = claims();
  await runMarciaOperation("book", { slot_id: await firstSlot(fake, c) }, c, fake.deps);
  for (let i = 1; i <= MARCIA_LEAD_DAILY_CHANGE_CAP; i++) {
    const m = await moveToNextOfferedTime(fake);
    eq(okData(m)?.outcome, "rescheduled", `move ${i} of ${MARCIA_LEAD_DAILY_CHANGE_CAP} goes through`);
  }
  eq(await changesToday(fake), MARCIA_LEAD_DAILY_CHANGE_CAP, "every allowed change was counted");
  const over = await moveToNextOfferedTime(fake);
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

// --- a token with no time zone (Dan, 2026-10-20) ---------------------------------------------------
// Regal may not hold the lead's zone. Times are then judged and written in Eastern,
// and every answer SAYS so, so the model can confirm the zone with the lead.
const withoutClaims = (c: MarciaLeadClaims, ...drop: ("name" | "email" | "phone" | "time_zone")[]): MarciaLeadClaims => {
  const out = { ...c };
  for (const k of drop) delete out[k];
  return out;
};
{
  const fake = makeMarciaFake({ nowMs: NOW, slots: SLOTS });
  const noZone = withoutClaims(claims(), "time_zone");
  const a = await runMarciaOperation("find_times", {}, noZone, fake.deps);
  assert(a.ok, "find_times answers with no zone signed");
  eq(okData(a)?.time_zone, "America/New_York", "it uses Eastern");
  eq(((okData(a)?.times as Times) ?? [])[0]?.label, "Tuesday, June 2 at 10:00am EDT", "and writes the times in it");
  const note = okData(a)?.time_zone_note;
  assert(typeof note === "string" && note.includes("America/New_York") && /confirm/i.test(note), "and says so in the answer, asking the model to confirm the zone with the lead");
  const passed = await runMarciaOperation("find_times", { time_zone: "America/Chicago" }, noZone, fake.deps);
  eq(((okData(passed)?.times as Times) ?? [])[0]?.label, "Tuesday, June 2 at 9:00am CDT", "a zone the model passes is used instead");
  assert(passed.ok && !("time_zone_note" in passed.data), "and then nothing is said about a guess");
  const signed = await runMarciaOperation("find_times", {}, claims(), fake.deps);
  assert(signed.ok && !("time_zone_note" in signed.data), "nor when the token signed a zone");

  const slot = ((okData(a)?.times as Times) ?? [])[0]!.slot_id;
  const booked = await runMarciaOperation("book", { slot_id: slot }, noZone, fake.deps);
  assert(booked.ok && okData(booked)?.outcome === "created", "book books with no zone signed");
  eq(fake.bookings[0]?.timezone, "America/New_York", "in Eastern");
  eq((okData(booked)?.booking as { label: string })?.label, "Tuesday, June 2 at 10:00am EDT", "its answer writes the time in Eastern");
  assert(typeof okData(booked)?.time_zone_note === "string", "and says it assumed the zone");
  const moveTo = ((okData(a)?.times as Times) ?? [])[1]!.slot_id;
  const moved = await runMarciaOperation("move", { slot_id: moveTo }, withoutClaims(claims(), "time_zone"), fake.deps);
  assert(moved.ok && okData(moved)?.outcome === "rescheduled", "move moves with no zone signed");
  eq(fake.bookings[0]?.timezone, "America/New_York", "in Eastern");
  assert(typeof okData(moved)?.time_zone_note === "string", "and says it assumed the zone");
  const looked = await runMarciaOperation("lookup", {}, withoutClaims(claims(), "time_zone"), fake.deps);
  assert(looked.ok && typeof looked.data.time_zone_note === "string", "lookup says so too, since its times are written in the same zone");
}

{
  // A taken time's alternatives are written in the assumed zone, and the refusal says so.
  const fake = makeMarciaFake({ nowMs: NOW, slots: SLOTS, takenByOthers: new Set([SLOTS[3]!]) });
  const c = withoutClaims(claims(), "time_zone");
  const slot = await issueSlotId({ startIso: SLOTS[3]!, bucketCode: "411", salesforceId: c.salesforce_id }, fake.deps.slotSecret, NOW);
  const a = await runMarciaOperation("book", { slot_id: slot }, c, fake.deps);
  assert(!a.ok && a.code === "slot_taken" && (a.alternatives ?? []).every((t) => t.label.endsWith("EDT")), "a taken time's alternatives are in Eastern");
  assert(!a.ok && typeof a.time_zone_note === "string", "and the refusal says the zone was assumed");
}

// --- name, email and phone: required for a net new booking, optional otherwise -----------------------
// Dan, 2026-10-21: a NET NEW booking (a book while the lead holds no active call in
// that world) needs all three on the token, and is refused naming which are missing.
// Everywhere else they are optional: move, and a book that lands on the call the lead
// already holds, fill each missing field from what Slate knows about the salesforce_id
// (the lead's earlier Slate bookings, then the Salesforce Lead). The token's own value
// always wins, a failed lookup never refuses, and nothing looked up is logged.
{
  for (const missing of [["email"], ["name", "phone"], ["name", "email", "phone"]] as const) {
    const fake = makeMarciaFake({ nowMs: NOW, slots: SLOTS, knownContact: earlierContact(), leadContact: sfLeadContact() });
    const c = withoutClaims(claims(), ...missing);
    const a = await runMarciaOperation("book", { slot_id: await firstSlot(fake, c) }, c, fake.deps);
    const what = missing.join(" and ");
    assert(!a.ok && a.code === "lead_contact_missing", `a net new book with no ${what} is refused lead_contact_missing`);
    eq(!a.ok ? a.missing_fields : null, [...missing], `naming exactly the missing ${what}, so Marcia can ask the lead`);
    eq(fake.bookings.length, 0, `and books nothing (${what})`);
    eq(fake.contactReads.length, 0, `judged on the token alone, with no lookup (${what})`);
    const text = JSON.stringify(a);
    assert(![c.name, c.email, c.phone].some((v) => typeof v === "string" && text.includes(v)), `and its answer echoes no value the token did carry (${what})`);
  }
  const fake = makeMarciaFake({ nowMs: NOW, slots: SLOTS });
  const a = await runMarciaOperation("book", { slot_id: await firstSlot(fake) }, claims(), fake.deps);
  assert(a.ok && okData(a)?.outcome === "created", "a net new book with all three books");
  eq(MARCIA_REFUSALS.lead_contact_missing.class, "expected", "a missing contact field is an expected refusal: Marcia asks the lead");
}

/** Seed the call the lead already holds, then move it: the path the fill serves. */
const moveOnce = async (fake: ReturnType<typeof makeMarciaFake>, c: MarciaLeadClaims) => {
  fake.seedBooking({ salesforceId: c.salesforce_id, externalId: c.salesforce_id, startsAt: SLOTS[1]!, bucketCode: c.test ? PARTNER_BUCKET_CODE : "411" });
  return runMarciaOperation("move", { slot_id: await firstSlot(fake, c) }, c, fake.deps);
};
function earlierContact() {
  return { name: "Earlier Booking Name", firstName: "Earlier", email: "earlier.booking@example.com", phone: "+15555550122" };
}
function sfLeadContact() {
  return { name: "Salesforce Lead Name", firstName: "Salesforce", email: "salesforce.lead@example.com", phone: "+15555550133" };
}
const earlier = earlierContact();
const sfLead = sfLeadContact();
{
  // Nothing anywhere: a move with all three missing still moves, with the fields left
  // out rather than "".
  const fake = makeMarciaFake({ nowMs: NOW, slots: SLOTS });
  const bare = withoutClaims(claims(), "name", "email", "phone");
  const a = await moveOnce(fake, bare);
  assert(a.ok && okData(a)?.outcome === "rescheduled", "a move with no name, email or phone still moves");
  eq(fake.bookings[0]?.attendee, {}, "with no attendee field at all, never an empty string");
  eq(fake.contactReads.map((r) => r.source), ["bookings", "salesforce"], "having asked the earlier bookings, then Salesforce");
  assert(fake.contactReads[0]?.salesforceIds.includes(bare.salesforce_id) === true, "about the token's lead");
}
{
  // Absent email filled from a prior booking; the token's name and phone win over it.
  const fake = makeMarciaFake({ nowMs: NOW, slots: SLOTS, knownContact: earlier, leadContact: sfLead });
  const c = withoutClaims(claims(), "email");
  const a = await moveOnce(fake, c);
  assert(a.ok, "a move with no email moves");
  eq(fake.bookings[0]?.attendee, { name: c.name, email: earlier.email, phone: c.phone }, "the email comes from the earlier booking, the name and phone from the token");
  eq(fake.contactReads.map((r) => r.source), ["bookings"], "and Salesforce is not asked once nothing is missing");
}
{
  // Absent from both the token and the bookings: filled from the Salesforce Lead.
  const fake = makeMarciaFake({ nowMs: NOW, slots: SLOTS, knownContact: null, leadContact: sfLead });
  const a = await moveOnce(fake, withoutClaims(claims(), "name", "email", "phone"));
  assert(a.ok, "a move whose earlier bookings hold no details moves");
  eq(fake.bookings[0]?.attendee, { name: sfLead.name, firstName: sfLead.firstName, email: sfLead.email, phone: sfLead.phone }, "with the name, first name, email and phone from the Salesforce Lead");
}
{
  // Per field: what the bookings hold is used, and only the rest is asked of Salesforce.
  const fake = makeMarciaFake({ nowMs: NOW, slots: SLOTS, knownContact: { name: null, firstName: null, email: earlier.email, phone: null }, leadContact: sfLead });
  await moveOnce(fake, withoutClaims(claims(), "name", "email", "phone"));
  eq(fake.bookings[0]?.attendee, { name: sfLead.name, firstName: sfLead.firstName, email: earlier.email, phone: sfLead.phone }, "each field from the first source holding it, bookings before Salesforce");
  // #4006: where each field came from is reported, by name, so the log can show it.
  eq(fake.contactFills, [{ bookings: ["email"], salesforce: ["name", "phone"], missing: [] }], "and which source filled which field is reported, by field name");
  assert(!JSON.stringify(fake.contactFills).includes("@"), "never with a value");
}
{
  // #4006: a field nobody holds is reported as still missing, beside what was filled.
  const fake = makeMarciaFake({ nowMs: NOW, slots: SLOTS, knownContact: null, leadContact: { name: null, firstName: null, email: sfLead.email, phone: null } });
  await moveOnce(fake, withoutClaims(claims(), "email", "phone"));
  eq(fake.contactFills, [{ bookings: [], salesforce: ["email"], missing: ["phone"] }], "a field no source held is reported as missing");
}
{
  // #4006: a report that cannot be made never stops the move.
  const fake = makeMarciaFake({ nowMs: NOW, slots: SLOTS, knownContact: null, leadContact: sfLead, contactFilledThrows: true });
  const a = await moveOnce(fake, withoutClaims(claims(), "email"));
  assert(a.ok && okData(a)?.outcome === "rescheduled", "a fill report that throws does not stop the move");
  eq(fake.bookings[0]?.attendee.email, sfLead.email, "and the fill it would have reported still lands");
}
{
  // Both lookups fail: moves anyway, logs each failure by source, pages nobody.
  const fake = makeMarciaFake({ nowMs: NOW, slots: SLOTS, knownContact: new Error("bookings read failed"), leadContact: new Error("SF query failed: 503") });
  const a = await moveOnce(fake, withoutClaims(claims(), "name", "email", "phone"));
  assert(a.ok && okData(a)?.outcome === "rescheduled", "a failed contact lookup is not a refusal: it moves");
  eq(fake.bookings[0]?.attendee, {}, "with what it has");
  eq(fake.contactFailures.map((f) => f.source), ["bookings", "salesforce"], "and reports each failed lookup by its source");
  eq(fake.alerts.length, 0, "without paging anybody");
  eq(fake.contactFills, [{ bookings: [], salesforce: [], missing: ["name", "email", "phone"] }], "and reports that nothing was filled");
}
{
  // A lookup that answers in a throw from the very first read still reaches Salesforce.
  const fake = makeMarciaFake({ nowMs: NOW, slots: SLOTS, knownContact: new Error("bookings read failed"), leadContact: sfLead });
  await moveOnce(fake, withoutClaims(claims(), "email"));
  eq(fake.bookings[0]?.attendee?.email, sfLead.email, "a failed bookings read falls through to Salesforce");
}
{
  // The token's values always win, and with all three present nothing is looked up.
  const fake = makeMarciaFake({ nowMs: NOW, slots: SLOTS, knownContact: earlier, leadContact: sfLead });
  const c = claims();
  await moveOnce(fake, c);
  eq(fake.bookings[0]?.attendee, { name: c.name, email: c.email, phone: c.phone }, "a token value always wins over a looked up one");
  eq(fake.contactReads.length, 0, "and a token carrying all three costs no lookup");
  eq(fake.contactFills.length, 0, "and reports no fill, since nothing was looked up");
}
{
  // A looked up value the token rule would refuse is not used.
  const fake = makeMarciaFake({ nowMs: NOW, slots: SLOTS, knownContact: null, leadContact: { name: "   ", firstName: null, email: "no at sign", phone: "+15555550133" } });
  await moveOnce(fake, withoutClaims(claims(), "name", "email", "phone"));
  eq(fake.bookings[0]?.attendee, { phone: "+15555550133" }, "a looked up blank name or broken email is left out, as the token's would have been refused");
}
{
  // A test token fills like a real one (Dan, 2026-10-21): the test world's bookings
  // first, then the Salesforce Lead.
  const fake = makeMarciaFake({ nowMs: NOW, slots: SLOTS, knownContact: null, leadContact: sfLead });
  const t = withoutClaims(claims({ test: true }), "name", "email", "phone");
  const a = await moveOnce(fake, t);
  assert(a.ok, "a test token with no contact moves");
  eq(fake.contactReads.map((r) => [r.source, r.isTest]), [["bookings", true], ["salesforce", null]], "it asks the test world's bookings, then the Salesforce Lead");
  eq(fake.bookings[0]?.attendee, { name: sfLead.name, firstName: sfLead.firstName, email: sfLead.email, phone: sfLead.phone }, "and fills from the Lead");
}
{
  // A book that lands on the call the lead already holds is not net new, so missing
  // fields do not refuse it: it is answered about that call (the fake asks the lead
  // to confirm, `confirm_required`, which Marcia hears as lead_has_booking).
  const fake = makeMarciaFake({ nowMs: NOW, slots: SLOTS, knownContact: earlier });
  const c = withoutClaims(claims(), "name", "email", "phone");
  fake.seedBooking({ salesforceId: c.salesforce_id, externalId: c.salesforce_id, startsAt: SLOTS[1]! });
  const a = await runMarciaOperation("book", { slot_id: await firstSlot(fake, c) }, c, fake.deps);
  eq(a.ok ? "ok" : a.code, "lead_has_booking", "a book while the lead holds a call, with no name, email or phone, is answered about that call, never lead_contact_missing");
  eq(fake.bookings.length, 1, "and adds no booking");
  eq(fake.contactReads.map((r) => r.source), ["bookings"], "having filled from the held call's details");
  // A real token's test world call does not make a real book anything but net new.
  const other = makeMarciaFake({ nowMs: NOW, slots: SLOTS });
  other.seedBooking({ salesforceId: c.salesforce_id, externalId: c.salesforce_id, startsAt: SLOTS[2]!, bucketCode: PARTNER_BUCKET_CODE });
  const b = await runMarciaOperation("book", { slot_id: await firstSlot(other, c) }, c, other.deps);
  eq(b.ok ? null : b.code, "lead_contact_missing", "a call held only in the test world leaves a real book net new");
}
{
  // Nothing looked up reaches an alert: a failed write after a fill carries ids only.
  const fake = makeMarciaFake({ nowMs: NOW, slots: SLOTS, knownContact: earlier, leadContact: sfLead });
  const c = withoutClaims(claims(), "name", "email", "phone");
  await moveOnce(fake, c);
  await runMarciaOperation("move", { slot_id: "garbage" }, withoutClaims(claims(), "name", "email", "phone"), fake.deps);
  const stranger = withoutClaims(claims({ salesforce_id: "00Q111111111111BBB" }), "email");
  await runMarciaOperation("book", { slot_id: await firstSlot(fake, stranger) }, stranger, fake.deps);
  const text = JSON.stringify(fake.alerts.map(({ cause: _c, ...rest }) => rest));
  assert(fake.alerts.length === 2, "the bad slot and the refused net new book each alerted");
  assert(![earlier.email, earlier.phone, earlier.name, sfLead.email, sfLead.phone, sfLead.name].some((v) => text.includes(v)), "and carry no looked up name, email or phone");
}

// --- a lead id in either spelling finds the same bookings --------------------------------------------
// A booking stores whichever spelling its channel sent (15 or 18 characters), and the
// token accepts either, so a token signed with one finds, moves and cancels a booking
// stored with the other, and the contact fill asks for both.
{
  const ID15 = "00Q5f00000AbCdE";
  // Blocks 00Q5f (Q: 4, E), 00000 (A), AbCdE (A, C, E: 1 + 4 + 16 = 21, V).
  const ID18 = "00Q5f00000AbCdEEAV";
  for (const [stored, signed] of [
    [ID18, ID15],
    [ID15, ID18],
  ] as const) {
    const fake = makeMarciaFake({ nowMs: NOW, slots: SLOTS, knownContact: null });
    // The embed's shape: the lead id in salesforce_id alone.
    fake.seedBooking({ salesforceId: stored, externalId: null, startsAt: SLOTS[1]! });
    const c = () => claims({ salesforce_id: signed });
    const what = `stored as ${stored.length}, signed as ${signed.length}`;
    const looked = await runMarciaOperation("lookup", {}, c(), fake.deps);
    eq(((okData(looked)?.bookings as unknown[]) ?? []).length, 1, `${what}: lookup finds the booking`);
    // No email signed, so this call also runs the contact fill.
    const noEmail = withoutClaims(c(), "email");
    const again = await runMarciaOperation("book", { slot_id: await firstSlot(fake, noEmail) }, noEmail, fake.deps);
    eq(again.ok ? null : again.code, "lead_has_booking", `${what}: a book sees the lead already holds it`);
    const times = ((okData(await runMarciaOperation("find_times", {}, c(), fake.deps))?.times as Times) ?? []);
    const moved = await runMarciaOperation("move", { slot_id: times.find((t) => t.starts_at === SLOTS[3])!.slot_id }, c(), fake.deps);
    eq(okData(moved)?.outcome, "rescheduled", `${what}: move moves it`);
    eq([fake.bookings.length, fake.bookings[0]?.startsAt], [1, SLOTS[3]], `${what}: the same booking, at the new time, and no second one`);
    const cancelled = await runMarciaOperation("cancel", { reason_code: "no_longer_interested" }, c(), fake.deps);
    eq(okData(cancelled)?.outcome, "cancelled", `${what}: cancel cancels it`);
    eq(fake.bookings[0]?.status, "cancelled", `${what}: and the booking is cancelled`);
    eq([...(fake.contactReads[0]?.salesforceIds ?? [])].sort(), [ID15, ID18].sort(), `${what}: the contact fill asks the bookings for both spellings`);
    eq([fake.bookings[0]?.salesforceId, fake.bookings[0]?.externalId], [stored, null], `${what}: and the booking keeps the ids it was written with`);
  }
  {
    // The held call read that picks the spelling cannot be read: book refuses rather
    // than risk booking a second call for a lead whose first it could not see.
    const fake = makeMarciaFake({ nowMs: NOW, slots: SLOTS });
    const c = claims({ salesforce_id: ID15 });
    const slot = await firstSlot(fake, c);
    fake.deps.lookup = async () => {
      throw new Error("bookings read failed");
    };
    const a = await runMarciaOperation("book", { slot_id: slot }, c, fake.deps);
    assert(!a.ok && a.class === "unexpected", "a book whose held call read fails is refused as unexpected");
    eq(fake.bookings.length, 0, "and books nothing");
    assert(fake.alerts.some((f) => f.operation === "book"), "and alerts, as every failed write does");
  }
  // A NEW booking stores exactly the spelling the token carried, in both id columns,
  // as every other channel stores its caller's: webhook consumers may key on it.
  for (const signed of [ID15, ID18]) {
    const fake = makeMarciaFake({ nowMs: NOW, slots: SLOTS });
    const c = claims({ salesforce_id: signed });
    const a = await runMarciaOperation("book", { slot_id: await firstSlot(fake, c) }, c, fake.deps);
    assert(a.ok && okData(a)?.outcome === "created", `a ${signed.length} character token books`);
    eq([fake.bookings[0]?.salesforceId, fake.bookings[0]?.externalId], [signed, signed], `and stores its ${signed.length} character id as both salesforce_id and external_id`);
  }
}

// --- every refusal is classified once ------------------------------------------------------------
{
  const classes = new Set(Object.values(MARCIA_REFUSALS).map((r) => r.class));
  eq([...classes].sort(), ["expected", "unexpected"], "every refusal is one of two classes");
  eq(
    Object.entries(MARCIA_REFUSALS).filter(([, r]) => r.class === "expected").map(([c]) => c).sort(),
    ["lead_contact_missing", "lead_daily_cap", "lead_has_booking", "move_not_offered", "slot_taken"],
    "the expected refusals are the plan's three, the told-to-move answer and the ask-the-lead one",
  );
}

finish();
