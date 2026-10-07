// #3495: reading `commit_fresh_booking`'s answer.
//
// The answer decides what a lead is told: a booking that committed, or a slot that
// was taken (and by whom, when it was the lead's own earlier request). A reader that
// guessed at a shape it could not read could tell a lead their booking failed when it
// exists, or the reverse, so an answer this cannot read is REFUSED by name. The
// committed fixture it is tested against is the one the real database suite holds the
// function's answers to (scripts/verify-commit-fresh-booking-sql.ts, L26).
//
// Run: node --experimental-strip-types scripts/test-commit-answer.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readCommitAnswer } from "../src/lib/booking/commit-answer.ts";
import { WEBHOOK_FORMATS } from "../src/lib/webhooks/formats.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const FORMATS = Object.keys(WEBHOOK_FORMATS);
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "commit-fresh-booking-answer.json"), "utf8"));

// --- a commit is read whole -------------------------------------------------------------
{
  const read = readCommitAnswer(fixture.committed, FORMATS);
  assert(read.status === "committed", "a committed answer reads as committed");
  if (read.status === "committed") {
    eq(read.booking.id, "10000000-0000-4000-8000-000000000001", "with the booking row");
    eq(read.booking.manage_token, "tok-fixture", "carrying every column");
    eq(read.enqueue?.deliveries.length, 1, "the webhook's deliveries, through the enqueue reader");
    eq(read.failed, {}, "nothing failed");
    eq(read.reservationDeleted, true, "and whether the reservation was deleted");
  }
}

// --- a step that failed is named, and a webhook that failed carries no deliveries --------
{
  const read = readCommitAnswer({ ...fixture.committed, enqueue: null, failed: { webhook: "planted" }, reservation_deleted: false }, FORMATS);
  assert(read.status === "committed" && read.enqueue === null && read.failed.webhook === "planted" && !read.reservationDeleted,
    `a failed webhook reads as committed, no deliveries, the reservation kept (got ${JSON.stringify(read)})`);
}

// --- a conflict, with and without a winner -----------------------------------------------
{
  const none = readCommitAnswer(fixture.conflict, FORMATS);
  assert(none.status === "conflict" && none.winner === null, "a conflict with no winner of the lead's own key");
  const won = readCommitAnswer({ status: "conflict", winner: fixture.committed.booking }, FORMATS);
  assert(won.status === "conflict" && won.winner?.id === fixture.committed.booking.id, "a conflict naming the booking that holds the lead's key");
}

// --- an answer that cannot be read is refused, naming what was wrong ---------------------
const broken: [string, unknown, RegExp][] = [
  ["no answer at all", null, /answer/],
  ["a status this does not know", { status: "maybe" }, /status/],
  ["a commit with no booking", { ...fixture.committed, booking: null }, /booking/],
  ["a booking with no id", { ...fixture.committed, booking: { ...fixture.committed.booking, id: undefined } }, /id/],
  ["a booking with no manage token", { ...fixture.committed, booking: { ...fixture.committed.booking, manage_token: undefined } }, /manage_token/],
  ["no failed map", { ...fixture.committed, failed: undefined }, /failed/],
  ["a failure that is not a reason", { ...fixture.committed, failed: { busy: 3 } }, /failed/],
  ["no word on the reservation", { ...fixture.committed, reservation_deleted: undefined }, /reservation/],
  ["an unreadable enqueue answer", { ...fixture.committed, enqueue: { subscribers: "one" } }, /subscribers/],
  ["a webhook that failed yet carries deliveries", { ...fixture.committed, failed: { webhook: "x" } }, /webhook/],
  ["a conflict whose winner has no id", { status: "conflict", winner: { status: "confirmed" } }, /id/],
];
for (const [label, answer, says] of broken) {
  let threw: unknown = null;
  try {
    readCommitAnswer(answer, FORMATS);
  } catch (err) {
    threw = err;
  }
  assert(threw instanceof Error && says.test(threw.message), `${label} is refused, naming it (got ${threw instanceof Error ? threw.message : "no refusal"})`);
}

finish();
