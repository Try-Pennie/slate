// Pure logic for the self-heal saturation signal (#726): the #428 reconcile drains
// at most RECONCILE_LIMIT blocks per tick, so a backlog bigger than the drain rate
// clears slowly and silently. Saturation (a tick that hits the cap) sustained over
// consecutive ticks means the pile-up is outpacing the sweep.
// The streak counting itself lives in notify/streak.ts (rate_limit_hit), tested there.
// Run: node --experimental-strip-types scripts/test-sweep-saturation.ts
import {
  isSweepSaturated,
  formatSaturationAlert,
  SATURATION_ALERT_AFTER_TICKS,
  SATURATION_WINDOW_SECONDS,
} from "../src/lib/monitor/sweep-saturation.ts";
import { assert, finish } from "./lib/harness.ts";

// Em dash, en dash, or a spaced hyphen used as punctuation. Built from escapes so
// this file never stores the literal characters the copy rule forbids.
const DASHES = new RegExp("[\\u2013\\u2014]|\\s-\\s");

// --- isSweepSaturated: a tick that hit its cap ---
{
  assert(isSweepSaturated(200, 200), "freed == limit is saturated");
  assert(isSweepSaturated(201, 200), "freed > limit is saturated (defensive)");
  assert(!isSweepSaturated(199, 200), "freed just under the limit is not saturated");
  assert(!isSweepSaturated(0, 200), "an idle tick is not saturated");
  // The sweep returns null when it threw. A failed tick tells us nothing about the
  // backlog, so it must not read as saturation (a lie) and must not be trusted as
  // evidence the backlog cleared either.
  assert(!isSweepSaturated(null, 200), "a failed sweep is not saturation");
}

// --- thresholds: one burst must not page; a sustained streak must ---
{
  assert(SATURATION_ALERT_AFTER_TICKS > 1, "a single saturated tick never pages");
  // The lane runs once a minute; the streak window has to span the whole streak
  // with slack, or consecutive ticks fall into different windows and each looks
  // like the first.
  assert(
    SATURATION_WINDOW_SECONDS > SATURATION_ALERT_AFTER_TICKS * 60,
    "the streak window outlasts the streak it must count",
  );
}

// --- formatSaturationAlert: says what is stuck, for how long, and what to do ---
{
  const msg = formatSaturationAlert("cancelled-block reconcile", 12, 200);
  assert(msg.includes("12"), "alert states how many consecutive ticks it has been saturated");
  // The streak keeps alerting past the threshold, so an exact duration would
  // understate a long outage.
  assert(/at least/i.test(msg), "alert hedges the duration as a floor, not an exact figure");
  assert(msg.includes("200"), "alert states the per-tick drain cap");
  assert(msg.includes("cancelled-block reconcile"), "alert names which sweep is stuck");
  assert(/backlog|pile/i.test(msg), "alert explains the backlog is outpacing the drain");
  assert(/mass cancel|cancel path|cap/i.test(msg), "alert suggests where to look");
  assert(!DASHES.test(msg), "saturation alert has no dashes");
}

finish();
