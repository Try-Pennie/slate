// #4222 follow up: ONE alert when the cron lanes cannot claim their ticks.
//
// Dan decided 2026-10-26: a first delivery whose claim on its tick cannot be read runs
// anyway, with one alert. The lanes never send it (src/lib/cron-lane-claim.test.ts
// holds that 28 of them send nothing). The monitor lane judges its OWN claim, which it
// makes like every lane at the top of its handler, on the same five minute boundary
// the every minute lanes claim on, and under its lease, so one run decides:
//   1. an unreadable claim raises `lane_claim_unreadable` once per monitor run;
//   2. a claim that was WRITTEN resolves it (the measured healthy reading);
//   3. anything else (a hand run with no tick id, a refusal, no claim at all) measures
//      nothing and neither raises nor resolves;
//   4. 28 lanes failing in one minute, then the monitor's run, post once in all;
//   5. a send or resolve that throws does not throw out of the check;
//   6. the copy carries no raw error and says what is happening and what to look at.
//
// Run: node --experimental-strip-types scripts/test-lane-claim-health.ts
import {
  LANE_CLAIM_UNREADABLE_KEY,
  formatLaneClaimRecovered,
  formatLaneClaimUnreadableAlert,
  laneClaimHealth,
  runLaneClaimHealthCheck,
} from "../src/lib/monitor/lane-claim-health.ts";
import { claimLane, type LaneClaim, type LaneClaimStore } from "../src/lib/monitor/lane-claim.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const unreadableStore: LaneClaimStore = {
  claim: async () => {
    throw new Error('relation "lane_runs" does not exist');
  },
};
const okStore: LaneClaimStore = { claim: async () => "claimed" };
const takenStore: LaneClaimStore = { claim: async () => "taken" };

function fakes() {
  const sent: Array<[string, number, string]> = [];
  const resolved: Array<[string, string]> = [];
  return {
    sent,
    resolved,
    notify: async (key: string, ms: number, text: string) => {
      sent.push([key, ms, text]);
    },
    resolve: async (key: string, text: string) => {
      resolved.push([key, text]);
      return true;
    },
  };
}

async function main() {
  eq(LANE_CLAIM_UNREADABLE_KEY, "lane_claim_unreadable", "one key for every lane, never one per lane");

  const unreadable = await claimLane("abc123", "/api/cron/monitor", unreadableStore);
  const claimed = await claimLane("abc124", "/api/cron/monitor", okStore);
  const handRun = await claimLane(null, "/api/cron/monitor", okStore);
  const duplicate = await claimLane("abc125", "/api/cron/monitor", takenStore);
  const refusedResend = await claimLane("abc126", "/api/cron/monitor", unreadableStore, "1");

  eq(laneClaimHealth(unreadable).status, "unreadable", "a first delivery that ran unclaimed reads as unreadable");
  eq(laneClaimHealth(refusedResend).status, "unreadable", "so does a re-send refused for an unreadable claim");
  eq(laneClaimHealth(claimed).status, "healthy", "a claim that was written is the measured healthy reading");
  for (const [claim, what] of [[handRun, "a hand run"], [duplicate, "a duplicate"], [null, "no claim at all"]] as const) {
    eq(laneClaimHealth(claim as LaneClaim | null).status, "unmeasured", `${what} measures nothing`);
  }

  // 1. raised once per run
  {
    const f = fakes();
    const health = await runLaneClaimHealthCheck({ claim: unreadable, notify: f.notify, resolve: f.resolve, cooldownMs: 86_400_000 });
    eq(health.status, "unreadable", "the check reports the unreadable claim");
    eq(f.sent.length, 1, "and raises the alert once");
    eq(f.sent[0]?.[0], "lane_claim_unreadable", "on the one key");
    eq(f.sent[0]?.[1], 86_400_000, "with the cooldown it was given");
    eq(f.resolved.length, 0, "and clears nothing");
  }

  // 2. resolved by a written claim
  {
    const f = fakes();
    await runLaneClaimHealthCheck({ claim: claimed, notify: f.notify, resolve: f.resolve, cooldownMs: 1 });
    eq(f.resolved.map((r) => r[0]), ["lane_claim_unreadable"], "a written claim resolves the alert");
    eq(f.resolved[0]?.[1], formatLaneClaimRecovered(), "with the recovery copy");
    eq(f.sent.length, 0, "and raises nothing");
  }

  // 3. unmeasured
  for (const claim of [handRun, duplicate, null]) {
    const f = fakes();
    const health = await runLaneClaimHealthCheck({ claim, notify: f.notify, resolve: f.resolve, cooldownMs: 1 });
    eq([health.status, f.sent.length, f.resolved.length], ["unmeasured", 0, 0], "an unmeasured run neither raises nor clears");
  }

  // 4. 28 lanes in one minute, then the monitor: one post
  {
    const f = fakes();
    const lanes = await Promise.all(
      Array.from({ length: 28 }, (_, i) => claimLane("abc127", `/api/cron/lane-${i}`, unreadableStore)),
    );
    assert(lanes.every((c) => c.run && c.claim === "unreadable"), "all 28 lanes ran with unreadable claims");
    eq(f.sent.length, 0, "and none of them posted: claiming sends nothing");
    await runLaneClaimHealthCheck({ claim: unreadable, notify: f.notify, resolve: f.resolve, cooldownMs: 1 });
    eq(f.sent.length, 1, "the monitor's one run posts once for the whole minute");
  }

  // 5. a throwing sender never throws out
  {
    let threw = false;
    try {
      await runLaneClaimHealthCheck({
        claim: unreadable,
        notify: async () => {
          throw new Error("slack down");
        },
        resolve: async () => {
          throw new Error("db down");
        },
        cooldownMs: 1,
      });
      await runLaneClaimHealthCheck({
        claim: claimed,
        notify: async () => {},
        resolve: async () => {
          throw new Error("db down");
        },
        cooldownMs: 1,
      });
    } catch {
      threw = true;
    }
    assert(!threw, "a send or resolve that throws is logged, never thrown out of the check");
  }

  // 6. the copy
  {
    const text = formatLaneClaimUnreadableAlert();
    assert(!/does not exist|relation|Error/.test(text), "the alert carries no raw error");
    assert(/lane_runs/.test(text), "it names the table to look at");
    assert(/run anyway|still run/i.test(text), "it says the lanes are still running");
    assert(/re-?sen[dt]/i.test(text), "and what is not protected while it lasts");
    assert(!/^Slate/.test(text), "it does not open with the word Slate");
    assert(/claim/i.test(formatLaneClaimRecovered()), "the recovery says what recovered");
  }

  finish();
}

void main();
