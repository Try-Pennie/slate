// Every scheduled workflow watched by CANARY_STALE_BOUNDS_MS gets its OWN words.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-canary-lane-copy.ts
//
// `canaryAlertText` and `canaryRecoveryText` branch on the lane name and FALL
// THROUGH to the booking smoke canary's wording. That fallback was correct while
// two of the three lanes were the booking canary; the moment a third scheduled
// workflow stamps into the same map, a stopped daily parity sweep pages as "the
// booking smoke canary has stopped" and sends the reader to re run the wrong
// workflow. One message answering for another is how somebody spends an afternoon
// on the wrong fault (L11), and it fails silently because both messages are true
// sentences about something.
import { CANARY_STALE_BOUNDS_MS } from "@/lib/monitor/health";
import { canaryAlertText, canaryRecoveryText } from "@/lib/monitor/lane-copy";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";

const lanes = Object.keys(CANARY_STALE_BOUNDS_MS);
assert(lanes.length > 0, "there are lanes to check");

const alerts = new Map<string, string>();
const clears = new Map<string, string>();
for (const lane of lanes) {
  const bound = CANARY_STALE_BOUNDS_MS[lane];
  const alert = canaryAlertText(
    { lane, ageMs: bound * 2, maxStaleMs: bound, unreadable: false },
    Math.round(bound / 60_000),
  );
  const clear = canaryRecoveryText(lane);
  for (const [what, text] of [["alert", alert], ["all clear", clear]] as const) {
    assert(text.trim().length > 0, `${lane} has ${what} copy`);
    assert(!/undefined|NaN|\[object/.test(text), `${lane}'s ${what} leaks nothing`);
    assert(!/[\u2014\u2013]/.test(text), `${lane}'s ${what} uses no dashes as punctuation`);
  }
  alerts.set(lane, alert);
  clears.set(lane, clear);
}

// The whole point: two lanes may not be told about with the same sentence, because
// the sentence names which workflow stopped and what to re run.
eq(new Set(alerts.values()).size, lanes.length, "no two lanes share the same page");
eq(new Set(clears.values()).size, lanes.length, "no two lanes share the same all clear");

// --- the remedy names a workflow that really exists (#2263) ---------------------
//
// Every one of these lanes is a scheduled GitHub workflow, and the only thing a
// reader can DO about a stopped one is re run it, so each page names which one. A
// message naming a workflow that is not there is a dead instruction: it changes
// nothing about the state the reader is stuck in, and they cannot tell a renamed
// file from a typo (L111). It is also the one part of this copy that can rot
// without anybody touching the copy, because renaming a workflow file is a change
// somewhere else entirely.
{
  const workflows = readdirSync(join(import.meta.dirname, "..", ".github", "workflows"))
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => f.replace(/\.ya?ml$/, ""));
  assert(workflows.length > 0, "the workflow directory was read at all");
  for (const lane of lanes) {
    const text = alerts.get(lane)!;
    assert(
      workflows.some((w) => text.includes(w)),
      `${lane}'s page names a workflow that exists (it names none of: ${workflows.join(", ")})`,
    );
  }
}

// --- the weekly replay page says what its silence can also mean (#2263) ----------
{
  // This lane goes quiet two ways: the schedule stopped, or it ran and could not
  // judge enough leads to conclude. They are the same silence and the same stale
  // heartbeat, so the page has to name the second or a reader re runs a workflow
  // that was running perfectly (L11).
  const bound = CANARY_STALE_BOUNDS_MS["router-replay"]!;
  const text = canaryAlertText(
    { lane: "router-replay", ageMs: bound * 2, maxStaleMs: bound, unreadable: false },
    Math.round(bound / 60_000),
  );
  assert(
    /could not judge|cannot judge|too thin|enough leads/i.test(text),
    "the replay page says a run that judged too little looks the same as one that never ran",
  );
}

finish();
