// Node test for the retention lane's skip/resume alert copy (#1139).
//
// These sentences are read on a phone, mid-incident, by someone deciding what to
// do. The branch under test is the REMEDY: "the mirror is not confirmed current"
// has two causes that need opposite actions, and sending the reader to chase a
// lagging export lane that was never configured wastes the only attention the
// alert gets (L11: distinct causes get distinct messages).
//
// Pure copy builders, no IO, so this is a node script rather than vitest.
import { assert, finish } from "./lib/harness.ts";
import {
  MIRROR_NOT_CONFIGURED,
  retentionLaneStake,
  retentionResumedText,
  retentionSkippedText,
} from "../src/lib/notify/misc-alert-copy.ts";

function main() {
  // 1. An unconfigured warehouse points at the credential, NOT at the export lane.
  {
    const text = retentionSkippedText("prune-bookings-pii", MIRROR_NOT_CONFIGURED);
    assert(text.includes("warehouse credential is set"), "the unconfigured remedy names the credential");
    assert(text.includes("DEPLOY.md"), "the unconfigured remedy points at DEPLOY.md");
    assert(!text.includes("catches up"), "the unconfigured remedy does NOT send the reader to the export lane");
  }

  // 2. A lagging export lane points at the export lane, NOT at the credential.
  {
    const reason = "routing_decisions: the export lane is 4 hours behind, with 812 rows waiting";
    const text = retentionSkippedText("prune-routing", reason);
    assert(text.includes("catches up"), "the lag remedy sends the reader to the export lane");
    assert(text.includes("snowflake-export"), "the lag remedy names the lane to check");
    assert(!text.includes("DEPLOY.md"), "the lag remedy does NOT send the reader to the deploy doc");
    assert(text.includes(reason), "the measured reason is carried through verbatim");
  }

  // 3. Every lane says what is actually at stake while it is stopped, so the
  //    reader can judge urgency without opening the code.
  {
    const stakes = new Set(
      ["prune-bookings-pii", "prune-webhook-payloads", "prune-routing"].map((l) => retentionLaneStake(l)),
    );
    assert(stakes.size === 3, "each lane states a DISTINCT consequence");
    assert(
      retentionLaneStake("prune-bookings-pii").includes("24 month"),
      "the bookings lane names its 24 month window",
    );
    assert(
      retentionSkippedText("prune-webhook-payloads", "x").includes("90 day"),
      "the webhook lane's stake reaches the rendered sentence",
    );
  }

  // 4. Both sentences name Slate, which the alert-preview guard also enforces:
  //    these land in a busy channel and the reader must know which system spoke.
  {
    for (const text of [
      retentionSkippedText("prune-routing", "x"),
      retentionResumedText("prune-routing"),
    ]) {
      assert(
        !/^\s*Slate\b/i.test(text),
        `the alert does not open with a Slate label: ${text.slice(0, 32)}`,
      );
      assert(!/undefined|NaN|\[object Object\]/.test(text), "no placeholder leaked into the copy");
    }
  }

  // 5. The all-clear says the condition ended and asks for nothing, because the
  //    reader is being told to stop acting, not to act.
  {
    const text = retentionResumedText("prune-bookings-pii");
    assert(text.includes("deleting again"), "the all-clear says the lane is deleting again");
    assert(text.includes("No action is needed"), "the all-clear closes the loop");
  }
}

main();
finish();
