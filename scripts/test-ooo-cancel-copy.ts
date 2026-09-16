// Withdrawing a PENDING time off request and cancelling an APPROVED one are two
// different acts, and until #2406 the agent's control asked the same two words
// for both ("Cancel this?" / "Yes, cancel").
//
// What they do differs: `cancelOoo` runs `undoPostApproval` only when the
// request was approved, which deletes the manager's calendar event, the agent's
// own event, the busy block and the cal.com override, stops the coverage sweep,
// and leaves the agent bookable for those days from the next recompute. A
// pending request has none of that behind it.
//
// So this file asserts the CLAIM each sentence makes, not merely that the two
// differ in wording (L347): the approved copy must say what happens to the
// agent's calendar, and the pending copy must not claim anything about one.
// Run: node --experimental-strip-types scripts/test-ooo-cancel-copy.ts
import {
  CANCEL_ACT_WORDS,
  cancelActForOutcomeKind,
  cancelActForStatus,
  cancelActPerformed,
  cancelAgentDm,
  cancelConfirmCopy,
  cancelManagerDm,
  oooDayCount,
  type CancelAct,
} from "../src/lib/ooo/cancel-copy.ts";
import { assert, finish } from "./lib/harness.ts";

const ACTS: CancelAct[] = ["withdraw", "cancel"];

// --- which act a request is about to receive --------------------------------

assert(cancelActForStatus("approved") === "cancel", "an approved request is cancelled");
assert(cancelActForStatus("pending") === "withdraw", "a pending request is withdrawn");

// The act a call ALREADY made is driven by what it did, never by the stored
// status (L680), which by then reads "cancelled" for both.
assert(cancelActPerformed(true) === "cancel", "having been approved, it was cancelled");
assert(cancelActPerformed(false) === "withdraw", "not having been approved, it was withdrawn");

// --- the confirmation: two different sentences, each naming its own consequence

const pendingOne = cancelConfirmCopy("withdraw", 1);
const approvedOne = cancelConfirmCopy("cancel", 1);

assert(
  pendingOne.question === "Withdraw this request?",
  `pending question, got: ${pendingOne.question}`,
);
assert(
  pendingOne.consequence === "It stops waiting for approval.",
  `pending consequence, got: ${pendingOne.consequence}`,
);
assert(
  approvedOne.question === "Cancel this time off?",
  `approved question, got: ${approvedOne.question}`,
);
assert(
  approvedOne.consequence ===
    "Your calendar clears and you can be booked then again.",
  `approved consequence, got: ${approvedOne.consequence}`,
);

assert(
  pendingOne.question !== approvedOne.question &&
    pendingOne.consequence !== approvedOne.consequence,
  "the two states ask different questions and name different consequences",
);

// The CLAIM, not the vocabulary (L347). Approved must say what becomes of the
// calendar block the approval put there; pending must make no claim about one,
// because a pending request has never had a block, an event or an override.
const CALENDAR_CLAIM = /\bcalendar\b|\bbooked\b/i;
for (const days of [1, 5]) {
  const approved = cancelConfirmCopy("cancel", days);
  assert(
    CALENDAR_CLAIM.test(approved.consequence),
    `approved copy states what happens to the calendar (${days} days): ${approved.consequence}`,
  );
  const pending = cancelConfirmCopy("withdraw", days);
  assert(
    !CALENDAR_CLAIM.test(`${pending.question} ${pending.consequence}`),
    `pending copy claims nothing about a calendar (${days} days): ${pending.question} ${pending.consequence}`,
  );
}

// --- derived from the request, so it reads right at either size (L180) ------

const pendingFive = cancelConfirmCopy("withdraw", 5);
const approvedFive = cancelConfirmCopy("cancel", 5);
assert(
  pendingFive.question === "Withdraw the request for these 5 days?",
  `a five day pending window names its size, got: ${pendingFive.question}`,
);
assert(
  approvedFive.question === "Cancel the time off for these 5 days?",
  `a five day approved window names its size, got: ${approvedFive.question}`,
);
assert(
  approvedFive.consequence ===
    "Your calendar clears and you can be booked on those days again.",
  `a multi day consequence reads in the plural, got: ${approvedFive.consequence}`,
);
assert(
  pendingFive.question !== pendingOne.question,
  "the sentence is derived from the request rather than fixed",
);

// --- the day count the sentence is derived from -----------------------------

const TZ = "America/New_York";
assert(
  oooDayCount("2026-11-27T21:00:00Z", "2026-11-27T23:00:00Z", TZ) === 1,
  "a two hour window inside one day is one day",
);
assert(
  oooDayCount("2026-11-23T05:00:00Z", "2026-11-28T04:59:00Z", TZ) === 5,
  "an all day Monday to Friday window is five days",
);
assert(
  oooDayCount("not a date", "also not a date", TZ) === 1,
  "an unreadable window never renders a NaN into the sentence",
);
// The count is taken in the request's OWN zone, so a window that reads as one
// day in Los Angeles is not reported as two because UTC rolled over.
assert(
  oooDayCount(
    "2026-11-28T02:00:00Z",
    "2026-11-28T04:00:00Z",
    "America/Los_Angeles",
  ) === 1,
  "the day count is taken in the request's own zone",
);

// --- one vocabulary, every site --------------------------------------------

const withdraw = CANCEL_ACT_WORDS.withdraw;
const cancel = CANCEL_ACT_WORDS.cancel;

assert(withdraw.control === "Withdraw", "the row control names the act it performs");
assert(cancel.control === "Cancel", "the row control names the act it performs");
assert(
  withdraw.confirmControl === "Yes, withdraw" &&
    cancel.confirmControl === "Yes, cancel",
  "the confirming control repeats the act's own verb",
);
assert(
  withdraw.outcomeHeading === "Request withdrawn" &&
    cancel.outcomeHeading === "Time off cancelled",
  "the banner heading names the act that produced it",
);
assert(
  withdraw.outcomeMessage === "Your time off request was withdrawn." &&
    cancel.outcomeMessage === "Your approved time off was cancelled.",
  "the outcome message names the act that produced it",
);

// No two acts may share a word at any site, or the confusion #2406 is about is
// simply moved rather than fixed.
for (const key of [
  "control",
  "confirmControl",
  "confirmPending",
  "outcomeKind",
  "outcomeHeading",
  "outcomeMessage",
  "pastParticiple",
  "managerVerb",
] as const) {
  assert(
    withdraw[key] !== cancel[key],
    `the two acts differ at every site, and share "${withdraw[key]}" at ${key}`,
  );
}

// The banner reads the act back out of the outcome kind the action redirected
// with, so one derivation rather than two that have to stay in step (L70).
for (const act of ACTS) {
  assert(
    cancelActForOutcomeKind(CANCEL_ACT_WORDS[act].outcomeKind) === act,
    `${act} survives the round trip through its outcome kind`,
  );
}
assert(
  cancelActForOutcomeKind("sent") === null &&
    cancelActForOutcomeKind(null) === null,
  "a kind that is not one of these two acts is not read as one",
);

// --- the Slack copy for the same event uses the same vocabulary -------------

const WHEN = "Mon, Nov 23 2026 9:00am - Fri, Nov 27 2026 5:00pm ET";
assert(
  cancelAgentDm("withdraw", WHEN) ===
    `Your time off request for ${WHEN} was withdrawn.`,
  `agent DM for a withdrawal, got: ${cancelAgentDm("withdraw", WHEN)}`,
);
assert(
  cancelAgentDm("cancel", WHEN) ===
    `Your time off request for ${WHEN} was cancelled.`,
  `agent DM for a cancellation, got: ${cancelAgentDm("cancel", WHEN)}`,
);
assert(
  cancelManagerDm("withdraw", "Dana Reid", WHEN) ===
    `Dana Reid withdrew their time off request for ${WHEN}.`,
  `manager DM for a withdrawal, got: ${cancelManagerDm("withdraw", "Dana Reid", WHEN)}`,
);

// --- every sentence is readable and obeys the copy rules --------------------

const everyLine: string[] = [];
for (const act of ACTS) {
  const words = CANCEL_ACT_WORDS[act];
  everyLine.push(
    words.control,
    words.confirmControl,
    words.confirmPending,
    words.outcomeHeading,
    words.outcomeMessage,
    cancelAgentDm(act, WHEN),
    cancelManagerDm(act, "Dana Reid", WHEN),
  );
  for (const days of [1, 2, 5, 90]) {
    const copy = cancelConfirmCopy(act, days);
    everyLine.push(copy.question, copy.consequence);
  }
}
assert(everyLine.length >= 30, "every state produced a line to check");
for (const line of everyLine) {
  // Written as escapes so this file holds no literal dash for the style guard to
  // catch: it cannot tell the line banning the character from a line using it.
  assert(!/[\u2014\u2013]/.test(line), `no em or en dash in: ${line.slice(0, 60)}`);
  assert(
    !/undefined|NaN|\[object Object\]|null/.test(line),
    `no leaked value in: ${line.slice(0, 60)}`,
  );
  assert(line.trim().length > 0, "no empty line");
}

// The dismiss control may never be the word the destructive act is called, or
// the dialog offers "Cancel" to back out of cancelling (#2406).
assert(
  !ACTS.some((act) => CANCEL_ACT_WORDS[act].dismiss === CANCEL_ACT_WORDS[act].control),
  "the way out of the confirm is never named after the act it backs out of",
);
assert(
  CANCEL_ACT_WORDS.withdraw.dismiss === CANCEL_ACT_WORDS.cancel.dismiss,
  "backing out is one act, so it is one word on both",
);

finish();
