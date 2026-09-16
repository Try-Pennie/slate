// #2372: the sales side is told when a lead's call goes to the advisor who owns them.
//
// This is the last of the Pipedream owner reassign flow's five steps to move into
// Slate. The flow finished by posting the owner's email, the start time in Eastern and
// the lead's email to a Slack Workflow; this posts a written notice to the handoff
// channel (#2367) instead, from Slate's own app.
//
// It is its OWN outbox step rather than a few lines inside `reassign:notify`, and the
// tests below are what that separation buys: a Slack refusal leaves the step to retry
// while the `booking.reassigned` webhook has already gone (L73), and a step already run
// is skipped on a resume rather than posting a second time.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-owner-reassign-notice.ts
import { OUTBOX_HANDLERS, reassignOutboxSteps } from "../src/lib/booking/orchestration.ts";
import { runOutboxSteps } from "../src/lib/booking/outbox.ts";
import { OWNER_ALERT_REASON_CODE } from "../src/lib/booking/owner-alert.ts";
import { formatOwnerReassignNotice } from "../src/lib/booking/owner-notice-copy.ts";
import type { BookingOutbox, OutboxPayload } from "../src/lib/db/types.ts";
import { assert, eq, finish } from "./lib/harness.ts";
import { makeDeps, makeBooking, bucket, eventType } from "./lib/booking-fakes.ts";

const OWNER_PAYLOAD: OutboxPayload = {
  reasonCode: OWNER_ALERT_REASON_CODE,
  reasonDetail: null,
  initiator: "system",
  fromAgentUserId: "a",
};

const NOTICE_STEP = "reassign:owner_notice";
const WEBHOOK_STEP = "reassign:notify";

/** A booking already moved onto owner "b", as the swap leaves it. */
function ownedBooking(over: Record<string, unknown> = {}) {
  return {
    booking: makeBooking({
      assigned_user_id: "b",
      agent_email: "b@x.com",
      agent_name: "Owner B",
      status: "rescheduled",
      ...over,
    }),
    bucket,
    eventType,
  };
}

function row(payload: OutboxPayload, id = "ob-reassign"): BookingOutbox {
  return {
    id,
    booking_id: "bk1",
    action: "reassign",
    status: "pending",
    steps: reassignOutboxSteps(),
    payload,
    lease_until: null,
    attempts: 0,
    last_error: null,
    next_attempt_at: null,
    created_at: "",
    updated_at: "",
  } as unknown as BookingOutbox;
}

const run = (deps: unknown, r: BookingOutbox) =>
  runOutboxSteps(deps as never, r, OUTBOX_HANDLERS, "lease-tok");

const stateOf = (r: BookingOutbox, name: string) =>
  r.steps.find((s) => s.name === name)?.state ?? "missing";

async function main() {
  // --- the step exists at all, and is not folded into the webhook step -------
  {
    const names = reassignOutboxSteps().map((s) => s.name);
    assert(
      names.includes(NOTICE_STEP),
      "a reassign carries its own owner notice step, so a Slack refusal cannot fail the webhook",
    );
    assert(
      names.indexOf(NOTICE_STEP) > names.indexOf(WEBHOOK_STEP),
      "and it runs after the webhook, which is the step a lead's journey depends on",
    );
  }

  // --- the gate: only the MACHINE owner move ---------------------------------
  // The same two halves the calendar alert is gated on (#2371). An ADMIN picking
  // "Owner reassignment" from the reason picker is making a coverage move by hand,
  // and announcing it as a lead going back to their owner would be a claim about
  // history that nothing measured.
  for (const [payload, why] of [
    [{ initiator: "admin", reasonCode: OWNER_ALERT_REASON_CODE }, "an ADMIN choosing the owner reason"],
    [{ initiator: "system", reasonCode: "coverage" }, "a system reassign for another reason"],
    [{ initiator: "admin", reasonCode: "offboarding" }, "an offboarding sweep"],
  ] as [OutboxPayload, string][]) {
    const ctx = ownedBooking();
    const { deps, calls } = makeDeps({ existing: ctx, bookingById: ctx });
    const r = row(payload);
    const res = await run(deps, r);
    assert(res.delivered === true, `gate (${why}): the row still completes`);
    eq(calls.handoffNoticePosts.length, 0, `gate (${why}): nothing is posted`);
  }

  // --- the happy path --------------------------------------------------------
  {
    const ctx = ownedBooking();
    const { deps, calls } = makeDeps({
      existing: ctx,
      bookingById: ctx,
      handoffChannel: "C-SALES",
      advisorTimezones: { b: "America/Denver" },
    });
    const res = await run(deps, row(OWNER_PAYLOAD));

    assert(res.delivered === true, "post: the row reaches delivered");
    eq(calls.handoffNoticePosts.length, 1, "post: exactly one Slack post");
    const post = calls.handoffNoticePosts[0];
    eq(post.channel, "C-SALES", "post: to the handoff channel, never the alerts channel");

    // Everything the notice is FOR, asserted on the text that actually shipped
    // rather than on a builder called in isolation: the step is what supplies the
    // advisor, the lead, the zone and the link.
    assert(post.text.includes("Owner B"), "post: names the advisor now holding the call");
    assert(post.text.includes("Kris"), "post: names the lead");
    assert(post.text.includes("Eastern"), "post: gives the time the sales side works in");
    assert(
      post.text.includes("where Owner B is"),
      "post: and the same time on the advisor's own clock, which Eastern alone is not",
    );
    assert(
      post.text.includes("9:00am") && post.text.includes("7:00am"),
      `post: the two clocks are the two real readings of one instant: ${JSON.stringify(post.text)}`,
    );
    assert(
      post.text.includes("https://slate.test/admin/bookings/bk1"),
      "post: links the admin booking page, which is where the move can be undone",
    );

    // The one thing that must NEVER be in a channel. The manage token is the lead's
    // only key to their own call and it can reschedule or cancel it (#1340).
    assert(!post.text.includes("tok1"), "post: carries no manage token");
    assert(!post.text.includes("/booking/manage"), "post: and no manage link");
    assert(!post.text.includes("k@x.com"), "post: and no lead address");
    assert(!post.text.includes("+12035615295"), "post: and no lead phone number");
    assert(!post.text.includes("undefined"), "post: and nothing half built");

    eq(calls.advisorTimezoneReads[0], "b", "post: the zone read is the NEW advisor's");
  }

  // --- exactly once across an inline run and a drain resume ------------------
  // The inline reassign runs the steps and persists them; a later drain loads the
  // same row and must skip what already ran. One row object, run twice, is that.
  {
    const ctx = ownedBooking();
    const { deps, calls } = makeDeps({
      existing: ctx,
      bookingById: ctx,
      handoffChannel: "C-SALES",
    });
    const r = row(OWNER_PAYLOAD, "ob-resume");
    await run(deps, r);
    eq(stateOf(r, NOTICE_STEP), "done", "resume: the inline run marks the step done");
    await run(deps, r);
    eq(calls.handoffNoticePosts.length, 1, "resume: the drain posts nothing a second time");
    eq(calls.webhooks.length, 1, "resume: and the webhook still fired exactly once");
  }

  // --- a failed post is RETRIED, and takes nothing else down with it ---------
  {
    const ctx = ownedBooking();
    const fake = makeDeps({
      existing: ctx,
      bookingById: ctx,
      handoffChannel: "C-SALES",
      handoffNoticePostFails: "not_in_channel",
    });
    const r = row(OWNER_PAYLOAD, "ob-retry");
    const first = await run(fake.deps, r);

    assert(first.delivered === false, "failed post: the row stays pending, so the drain comes back");
    eq(stateOf(r, NOTICE_STEP), "failed", "failed post: the step is NOT marked done");
    assert(
      first.failed.length === 1 && first.failed[0] === NOTICE_STEP,
      "failed post: and it is the only step that failed",
    );

    // The whole reason this is a separate step (L73): the webhook is what a lead's
    // Regal journey runs on, and Slack being unreachable must not touch it.
    eq(stateOf(r, WEBHOOK_STEP), "done", "failed post: the webhook step completed");
    eq(fake.calls.webhooks.length, 1, "failed post: booking.reassigned went out");
    eq(fake.calls.webhooks[0].event, "booking.reassigned", "failed post: as a reassign, not a reschedule");

    eq(fake.calls.handoffNoticePosts.length, 1, "failed post: one attempt, which Slack refused");

    // And the retry lands once Slack answers.
    fake.setHandoffNoticePostFails(null);
    const second = await run(fake.deps, r);
    assert(second.delivered === true, "failed post: the next drain pass delivers the row");
    eq(fake.calls.handoffNoticePosts.length, 2, "failed post: a second attempt, and this one landed");
    eq(fake.calls.webhooks.length, 1, "failed post: and the webhook was not fired a second time");
  }

  // --- the channel setting could not be READ, which is not the same as unset --
  {
    const ctx = ownedBooking();
    const { deps, calls } = makeDeps({
      existing: ctx,
      bookingById: ctx,
      handoffChannelThrows: true,
    });
    const r = row(OWNER_PAYLOAD, "ob-unreadable");
    const res = await run(deps, r);
    assert(res.delivered === false, "unreadable channel: the row stays pending");
    eq(stateOf(r, NOTICE_STEP), "failed", "unreadable channel: the step retries rather than dropping the notice");
    eq(calls.handoffNoticePosts.length, 0, "unreadable channel: nothing was posted");
  }

  // --- NO handoff channel is set: silent, and not an error --------------------
  // The monitor lane already pages when a booking HANDOFF is open with no channel
  // set (#2367). A reassign notice is not a handoff, so this must not invent one,
  // and it must not wedge the outbox row either.
  {
    const ctx = ownedBooking();
    const { deps, calls } = makeDeps({
      existing: ctx,
      bookingById: ctx,
      handoffChannel: null,
    });
    const r = row(OWNER_PAYLOAD, "ob-unset");
    const res = await run(deps, r);
    assert(res.delivered === true, "no channel: the row completes rather than failing");
    eq(stateOf(r, NOTICE_STEP), "done", "no channel: the step is done, so nothing retries for ever");
    eq(calls.handoffNoticePosts.length, 0, "no channel: nothing is posted anywhere");
  }

  // --- a deployment with no Slack at all -------------------------------------
  // `slack-not-configured` is postSlack's own answer when the bot token is unset.
  // Retrying can never reach Slack from there, so it is recorded and the step
  // completes, rather than walking the row to the drain's give-up cap.
  {
    const ctx = ownedBooking();
    const { deps, calls } = makeDeps({
      existing: ctx,
      bookingById: ctx,
      handoffChannel: "C-SALES",
      handoffNoticePostFails: "slack-not-configured",
    });
    const r = row(OWNER_PAYLOAD, "ob-noslack");
    const res = await run(deps, r);
    assert(res.delivered === true, "no Slack: the row completes rather than retrying for ever");
    eq(stateOf(r, NOTICE_STEP), "done", "no Slack: the step is done");
    eq(calls.handoffNoticePosts.length, 1, "no Slack: it did try once");
  }

  // --- the smoke canary's own bookings are never announced -------------------
  // Every six hours the canary books, reassigns and cancels on the isolated SMOKE
  // agents (#396). Without this, each pass would put a synthetic lead in front of
  // the sales team. Derived from the BUCKET, because `bookings` has no is_test
  // column (#2369).
  {
    const ctx = { ...ownedBooking(), bucket: { ...bucket, is_test: true } };
    const { deps, calls } = makeDeps({
      existing: ctx,
      bookingById: ctx,
      handoffChannel: "C-SALES",
    });
    const res = await run(deps, row(OWNER_PAYLOAD, "ob-test"));
    assert(res.delivered === true, "test booking: the row completes");
    eq(calls.handoffNoticePosts.length, 0, "test booking: and the sales side hears nothing");
  }

  // --- a booking that is gone by the time the drain gets here -----------------
  {
    const { deps, calls } = makeDeps({ bookingById: null, handoffChannel: "C-SALES" });
    const res = await run(deps, row(OWNER_PAYLOAD, "ob-gone"));
    assert(res.delivered === true, "booking gone: the step completes rather than retrying nothing");
    eq(calls.handoffNoticePosts.length, 0, "booking gone: and says nothing about a call it cannot read");
  }

  // --- the words themselves ---------------------------------------------------
  const BASE = {
    advisorName: "Dana Whitfield",
    advisorEmail: "dana.whitfield@trypennie.com",
    advisorTimezone: "America/Denver",
    startsAt: "2026-09-17T15:30:00.000Z",
    leadName: "Jordan Lee",
    bookingUrl: "https://slate.trypennie.app/admin/bookings/bk1",
  };
  {
    const text = formatOwnerReassignNotice(BASE);
    assert(text.includes("11:30am Eastern"), `copy: the sales clock: ${JSON.stringify(text)}`);
    assert(text.includes("9:30am where Dana Whitfield is"), `copy: the advisor's own clock: ${JSON.stringify(text)}`);
    assert(text.includes("Jordan Lee"), "copy: the lead is named");
    assert(text.endsWith(BASE.bookingUrl), "copy: the link is last, so it is not buried mid sentence");
    assert(!/^\s*Slate\b/i.test(text), "copy: does not open with the word Slate, which the Slack app name already says");
  }

  // An advisor whose clock reads the same as Eastern says it ONCE. Nine of the
  // roster pairs the cal.com sweep found are America/Denver against America/Boise,
  // which never differ, and a sentence that states one time twice is noise (L605).
  {
    const text = formatOwnerReassignNotice({ ...BASE, advisorTimezone: "America/New_York" });
    eq(
      (text.match(/11:30am/g) ?? []).length,
      1,
      `copy: an Eastern advisor's time is given once: ${JSON.stringify(text)}`,
    );
    assert(!text.includes("which is"), "copy: and no empty second clause is left behind");
  }
  {
    // Indianapolis IS Eastern, under another name. The cal.com sweep found exactly
    // this pair on the live roster, so the predicate has to be the clock reading and
    // not the zone string.
    const text = formatOwnerReassignNotice({ ...BASE, advisorTimezone: "America/Indiana/Indianapolis" });
    assert(
      !text.includes("where Dana Whitfield is"),
      `copy: a zone NAME that keeps Eastern's clock is not a second time: ${JSON.stringify(text)}`,
    );
    // And the control: Boise is another name for Denver, which is NOT Eastern, so
    // its reading really is a second time and must still be given.
    const mountain = formatOwnerReassignNotice({ ...BASE, advisorTimezone: "America/Boise" });
    assert(
      mountain.includes("9:30am where Dana Whitfield is"),
      "copy: control, a zone whose clock really differs still gets its own time",
    );
  }

  // Slate holds no working hours for this advisor. It must not fall back to
  // Eastern and present it as theirs (L192): the notice simply says less.
  {
    const text = formatOwnerReassignNotice({ ...BASE, advisorTimezone: null });
    assert(text.includes("11:30am Eastern"), "copy: no zone held, the Eastern time still goes out");
    assert(
      !text.includes("where Dana Whitfield is"),
      "copy: and nothing claims to be the advisor's own time",
    );
  }

  // A zone far enough away lands on another calendar day, and a bare clock time
  // would then be the wrong day as well as a different hour.
  {
    const text = formatOwnerReassignNotice({ ...BASE, advisorTimezone: "Asia/Tokyo" });
    assert(
      text.includes("12:30am on Friday, September 18 where Dana Whitfield is"),
      `copy: a cross day advisor gets the day too: ${JSON.stringify(text)}`,
    );
  }

  // A redacted booking has no name left. "A lead's call" is better than a blank.
  {
    const text = formatOwnerReassignNotice({ ...BASE, leadName: null });
    assert(text.includes("A lead's call"), `copy: a redacted lead: ${JSON.stringify(text)}`);
    assert(!text.includes("undefined") && !text.includes("null"), "copy: and nothing leaks");
  }

  // Slate holds no name for the advisor, only an address.
  {
    const text = formatOwnerReassignNotice({ ...BASE, advisorName: null });
    assert(
      text.includes("dana.whitfield@trypennie.com"),
      "copy: the address stands in when there is no name",
    );
    eq(
      (text.match(/dana\.whitfield@trypennie\.com/g) ?? []).length,
      1,
      `copy: and a thirty character address is not read out twice in one line: ${JSON.stringify(text)}`,
    );
    assert(text.includes("9:30am where they are"), "copy: the second clock says whose it is without repeating it");
  }

  // An unreadable start is said, never guessed at.
  {
    const text = formatOwnerReassignNotice({ ...BASE, startsAt: "not a time" });
    assert(
      text.includes("a time Slate could not read"),
      `copy: an unreadable start: ${JSON.stringify(text)}`,
    );
    assert(!text.includes("Invalid"), "copy: and no library's own error wording reaches a reader");
  }

  finish();
}

await main();
