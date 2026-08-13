// #1464: the reconcile sweep's Slack line told whoever read it to "check
// cancel-path health", which is the right instruction for a block whose booking
// was cancelled and whose write-through delete was missed, and the wrong one for
// a block that never referenced a booking at all. On 2026-08-13 it sent a reader
// to the cancel path over a row that had never had a booking: an approved time
// off's fallback block, which the sweep had just deleted (L11: a message may
// claim only what its check actually measured).
//
// So the copy is built from the two counts the sweep now reports separately, and
// each kind names its own thing to go and look at.
// Run: node --experimental-strip-types scripts/test-reconcile-freed-alert-copy.ts
import { reconcileFreedAlert } from "../src/lib/booking/alert-copy.ts";
import { assert, finish } from "./lib/harness.ts";

const CANCEL_ADVICE = /cancel-path health/i;

{
  // Only missed cancels: unchanged instruction, because it is the true one.
  const text = reconcileFreedAlert({ freedCancelled: 3, freedOrphans: 0, agentCount: 2 });
  assert(CANCEL_ADVICE.test(text), "a cancelled-booking miss still points at cancel-path health");
  assert(text.includes("3"), "names how many it freed");
  assert(!/orphan/i.test(text), "says nothing about orphans when there were none");
}

{
  // Only unowned orphans: the cancel path is not implicated and must not be named,
  // or the reader spends the incident looking at code that did nothing wrong.
  const text = reconcileFreedAlert({ freedCancelled: 0, freedOrphans: 2, agentCount: 1 });
  assert(
    !CANCEL_ADVICE.test(text),
    "an orphan with no booking must NOT send the reader to the cancel path",
  );
  assert(/2/.test(text), "names how many orphans it freed");
  assert(
    /own|orphan/i.test(text),
    "says what it actually found: a row nothing owned",
  );
}

{
  // Both kinds in one sweep: both counts survive, so neither is hidden behind the
  // other's total.
  const text = reconcileFreedAlert({ freedCancelled: 4, freedOrphans: 5, agentCount: 3 });
  assert(CANCEL_ADVICE.test(text), "mixed: still points at the cancel path for the 4");
  assert(text.includes("4") && text.includes("5"), "mixed: reports both counts, not just the total");
  assert(text.includes("3"), "mixed: reports the agent count");
}

{
  // Copy rules: no dashes as punctuation, and the alert must not open with the
  // product name (it arrives under Slate's own app name in Slack).
  for (const args of [
    { freedCancelled: 1, freedOrphans: 0, agentCount: 1 },
    { freedCancelled: 0, freedOrphans: 1, agentCount: 1 },
    { freedCancelled: 1, freedOrphans: 1, agentCount: 1 },
  ]) {
    const text = reconcileFreedAlert(args);
    // Escapes, not the literal characters: the pre-push style hook cannot tell a
    // line banning a dash from a line using one.
    assert(!/[\u2014\u2013]/.test(text), `no dash punctuation in ${JSON.stringify(args)}`);
    assert(!/^Slate\b/.test(text), `does not open with the product name in ${JSON.stringify(args)}`);
    assert(!/undefined|NaN|\[object/.test(text), `nothing leaks in ${JSON.stringify(args)}`);
  }
}

finish();
