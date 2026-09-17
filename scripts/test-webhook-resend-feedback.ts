// Every resend outcome says something to the admin (#1076).
//
// The resend action already refuses correctly: it will not re-fire a delivery whose
// payload was blanked for PII retention (#1073), nor a suppressed test delivery, and
// the send itself can fail. All of that was logged server side and NOTHING appeared
// on screen, so the admin pressed a button and watched the log re-render unchanged.
// A refusal that looks identical to a success is the standing defect this closes.
//
// The rule the copy has to hold: a refusal and a failure are different screens, and
// each refusal has its own reason, because "could not resend" tells an admin nothing
// about whether to try again, wait, or stop.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-webhook-resend-feedback.ts
import {
  RESEND_RESULTS,
  replayFeedback,
  resendFeedback,
  type ResendResult,
} from "../src/lib/webhooks/resend-feedback.ts";
import { assert, eq, finish } from "./lib/harness.ts";

/** Built from escapes, so this file holds no literal dash. */
const DASHES = new RegExp("[\\u2013\\u2014]");

// --- every outcome is covered, driven off the LIST ----------------------------
// A new outcome added to ResendResult and not to the copy would render nothing,
// which is the exact silence this issue is about, one level along (L96).
for (const result of RESEND_RESULTS) {
  const fb = resendFeedback(result);
  assert(fb !== null, `${result} has something to say`);
  assert((fb?.message.length ?? 0) > 15, `${result} says it in a sentence, not a word`);
  assert(!DASHES.test(fb?.message ?? ""), `${result} uses no dashes`);
  assert(
    !/undefined|NaN|\[object Object\]/.test(fb?.message ?? ""),
    `${result} renders no placeholder leak`,
  );
}

// --- success and refusal are different screens --------------------------------
{
  eq(resendFeedback("sent")?.tone, "ok", "a sent resend reads as a success");
  for (const refused of RESEND_RESULTS.filter((r) => r !== "sent")) {
    eq(resendFeedback(refused)?.tone, "error", `${refused} does NOT read as a success`);
  }
}

// --- each refusal has its OWN reason -------------------------------------------
// "Could not resend" for all of them would leave an admin with no idea whether to
// retry, wait, or stop, and two of these can never succeed however often it is
// pressed (L11).
{
  const messages = RESEND_RESULTS.map((r) => resendFeedback(r)!.message);
  eq(new Set(messages).size, RESEND_RESULTS.length, `each outcome has its own words (${messages.join(" | ")})`);

  // The two that are PERMANENT must say so, or the admin keeps pressing.
  const erased = resendFeedback("payload-erased")!.message;
  assert(/retention|erased|deleted/i.test(erased), "an erased payload says why it is gone");
  assert(
    !/try again|retry/i.test(erased),
    "and does not invite a retry that can never work",
  );

  const suppressed = resendFeedback("suppressed")!.message;
  assert(/test/i.test(suppressed), "a suppressed delivery says it is test traffic");
  assert(!/try again|retry/i.test(suppressed), "and does not invite a retry either");

  // Deduped is the opposite: it already went, so the admin needs to know it worked
  // rather than that it refused.
  const deduped = resendFeedback("deduped")!.message;
  assert(/already/i.test(deduped), "a deduped resend says it already went");
}

// --- an unknown value is not silently dropped ----------------------------------
// The action passes through whatever the resend returned. A value the copy does not
// know must still produce something, or the admin is back to a button that does
// nothing visible.
{
  const fb = resendFeedback("something-new" as ResendResult);
  assert(fb !== null, "an unrecognised outcome still says something");
  eq(fb?.tone, "error", "and errs toward reporting a problem rather than a success");
}

// --- the BATCH replay says what it did too (#2384) -----------------------------
// It said nothing on either ending. Success revalidated a page the form is not on
// and returned void; a duplicate press inside the five minute dedupe window
// returned in silence. So the one control that re-fires a receiver's whole backlog
// after an outage was indistinguishable from a broken button on exactly the press
// somebody makes when they are unsure the first one worked, which is the fault
// #1076 closed for the Resend button beside it.
{
  const cases: [string, string][] = [
    ["0", "none found"],
    ["1", "one"],
    ["9", "several"],
    ["deduped", "a duplicate press"],
  ];
  for (const [raw, label] of cases) {
    const fb = replayFeedback(raw);
    assert(fb !== null, `${label} says something`);
    assert((fb?.message.length ?? 0) > 15, `${label} says it in a sentence, not a word`);
    assert(!DASHES.test(fb?.message ?? ""), `${label} uses no dashes`);
    assert(
      !/undefined|NaN|\[object Object\]/.test(fb?.message ?? ""),
      `${label} renders no placeholder leak`,
    );
  }

  // Zero is the ordinary healthy answer and must not read as a failure. The
  // reader's next move is a longer window, which the sentence names, because a
  // message leaving somebody with nothing to do is worth about as much as no
  // message (L111).
  const none = replayFeedback("0")!;
  eq(none.tone, "ok", "finding nothing to replay is not a failure");
  assert(/longer window|older/i.test(none.message), "and it says what to try instead");
  assert(!/^0 /.test(none.message), "and it does not open with a bare zero");

  // One and many are different sentences, because "1 failed deliveries" is the
  // kind of line a reader stops trusting the rest of the screen over.
  assert(/^1 failed delivery /.test(replayFeedback("1")!.message), "one reads as one");
  assert(/^9 failed deliveries /.test(replayFeedback("9")!.message), "nine reads as nine");

  // The duplicate press is the one #2384 was opened about. It has to say the
  // receiver is not being sent anything a second time, rather than looking like a
  // button that did nothing.
  const deduped = replayFeedback("deduped")!;
  eq(deduped.tone, "error", "a deduped replay reads as something that did not happen");
  assert(/replayed|again/i.test(deduped.message), "and says the window already went");

  // A value this page never issues draws NOTHING rather than being rounded into a
  // count: inventing a number would confirm a replay nobody ran (L11).
  for (const bad of ["", "lots", "-2", "3.5", null, undefined]) {
    eq(replayFeedback(bad), null, `${JSON.stringify(bad)} says nothing at all`);
  }
}

finish();
