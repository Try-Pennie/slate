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
    const reason = "routing_decisions: the oldest row waiting for export is 4 hours old, with 812 rows waiting";
    const text = retentionSkippedText("prune-routing", reason);
    assert(text.includes("catches up"), "the lag remedy sends the reader to the export lane");
    assert(text.includes("snowflake-export"), "the lag remedy names the lane to check");
    assert(!text.includes("DEPLOY.md"), "the lag remedy does NOT send the reader to the deploy doc");
    assert(text.includes(reason), "the measured reason is carried through verbatim");
  }

  // 3. Every lane says what is actually at stake while it is stopped, so the
  //    reader can judge urgency without opening the code.
  {
    const lanes = ["prune-bookings-pii", "prune-webhook-payloads", "prune-routing", "prune-warehouse-pii"];
    const stakes = new Set(lanes.map((l) => retentionLaneStake(l)));
    assert(stakes.size === lanes.length, "each lane states a DISTINCT consequence");
    // The old shape fell through to routing's sentence for any lane it did not
    // recognise, so a new lane's skip alert would have claimed routing decisions
    // were at stake. The fallback must claim nothing about a lane it cannot name.
    assert(
      retentionLaneStake("prune-something-new") !== retentionLaneStake("prune-routing"),
      "an unrecognised lane does not borrow another lane's consequence",
    );
    assert(
      retentionLaneStake("prune-warehouse-pii").includes("warehouse"),
      "the warehouse lane names the copy it protects, not the live database",
    );
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

  // 6. The all-clear's REASON is the gate that actually cleared, not a borrowed
  //    one (#1180). The three Supabase lanes are gated on the export lane keeping
  //    up; the warehouse lane has no export gate at all, so claiming the mirror
  //    was confirmed current would assert something nothing measured (L11).
  {
    const supabaseSide = retentionResumedText("prune-bookings-pii");
    const warehouseSide = retentionResumedText("prune-warehouse-pii");
    assert(
      supabaseSide.includes("confirmed current"),
      "a Supabase lane's all-clear names the export gate it passed",
    );
    assert(
      !warehouseSide.includes("confirmed current"),
      "the warehouse lane's all-clear does NOT claim a gate it never has",
    );
    assert(
      warehouseSide.includes("credential"),
      "the warehouse lane's all-clear names the gate it does have",
    );
    assert(
      warehouseSide.includes("No action is needed"),
      "the warehouse all-clear closes the loop too",
    );
  }
}

main();
finish();
