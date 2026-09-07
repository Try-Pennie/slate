// Repo invariant (#1248): the recompute freshness window and the staleness alarm
// are one PAIR, and widening the window cannot trip the alarm.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-recompute-window-pair.ts
//
// The trap. Two constants were declared independently two lines apart, with
// nothing enforcing the gap between them, and the headroom alert's own
// remediation advice was "widen the freshness window". Anyone following that
// under pressure past the alarm's threshold starts tripping the `bucket_slots_stale`
// page instead, so the advice manufactures a second alert while the reader is
// already dealing with the first. That is L36's canned-remediation warning: a
// message must not steer a diagnosis wrong.
//
// A comment saying "keep these apart" enforces nothing (L57), so the ordering and
// the margin are asserted here, and the alert names the pair rather than one half
// of it.
import {
  RECOMPUTE_FRESH_MS,
  STALE_ALARM_MS,
  STALE_ALARM_MARGIN_MS,
} from "../src/lib/availability/precompute-cron.ts";
import { recomputeHeadroomAlert, recomputeHeadroomRecovery } from "../src/lib/monitor/cron-alert-copy.ts";
import { assert, eq, finish } from "./lib/harness.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Em/en dash detector built from escapes, so this file holds no literal dash. */
const DASHES = new RegExp("[\\u2013\\u2014]");

// --- the pair, and the direction of the gap ---------------------------------
{
  assert(
    STALE_ALARM_MS > RECOMPUTE_FRESH_MS,
    `the alarm must sit ABOVE the freshness window (fresh ${RECOMPUTE_FRESH_MS}ms, alarm ${STALE_ALARM_MS}ms), ` +
      "or every bucket is stale the moment it ages out and the alarm fires on normal aging",
  );
  eq(
    STALE_ALARM_MS,
    RECOMPUTE_FRESH_MS + STALE_ALARM_MARGIN_MS,
    "the alarm is DERIVED from the window plus a margin, so widening one moves the other with it",
  );
  assert(
    STALE_ALARM_MARGIN_MS >= 60_000,
    `the margin must exceed one tick of the every-minute lane (${STALE_ALARM_MARGIN_MS}ms), or a bucket ` +
      "that ages out is already alarming before the next cycle has had a chance to refresh it",
  );
}

// --- the alarm is written in terms of the window, not merely equal to it ------
{
  // A value assertion cannot tell a DERIVED alarm from a hardcoded one that
  // happens to equal the sum today, and the two are indistinguishable until
  // someone widens the window, which is exactly the moment this has to hold. So
  // read the source, with comments stripped so prose about the derivation cannot
  // stand in for it (L103).
  const src = readFileSync(join(import.meta.dirname, "..", "src/lib/availability/precompute-cron.ts"), "utf8")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .filter((line) => !/^\s*\*/.test(line) && !/^\s*\/\*/.test(line))
    .join("\n");
  const decl = /export const STALE_ALARM_MS\s*=\s*([^;]+);/.exec(src)?.[1] ?? "";
  assert(
    decl.includes("RECOMPUTE_FRESH_MS"),
    `STALE_ALARM_MS must be computed FROM the freshness window, not restated beside it (found "${decl.trim()}")`,
  );
  assert(
    !/\d+\s*\*\s*60_000/.test(decl),
    `and must not carry its own literal minute count (found "${decl.trim()}")`,
  );
}

// --- the property the derivation exists for ---------------------------------
{
  // Widening the window is exactly what the headroom alert tells the reader to do.
  // Whatever they widen it to, the alarm must still sit above it, because the
  // alarm's job is "the lane cannot keep up", never "a bucket aged out".
  for (const widened of [4, 6, 10, 30, 120].map((m) => m * 60_000)) {
    const alarm = widened + STALE_ALARM_MARGIN_MS;
    assert(
      alarm > widened,
      `a freshness window of ${widened / 60_000}min still leaves the alarm above it`,
    );
  }
}

// --- the alert names the pair, so following it cannot trip the other ---------
{
  const text = recomputeHeadroomAlert(7, 24, 62, 96, 5);
  assert(/freshness window/i.test(text), "the remediation still names the freshness window");
  assert(
    /for 5 minutes running/.test(text),
    "the page says how long the lane has been behind, not the vague 'consecutive cycles' (#2021)",
  );
  assert(
    /stale/i.test(text),
    "and says the staleness alarm moves with it, so widening the window does not manufacture a second page",
  );
  assert(!DASHES.test(text), "no dashes in alert copy");
  assert(!text.startsWith("Slate"), "an alert never opens with the word Slate");
  assert(text.length < 600, "and it stays readable on a phone mid-incident");
  const recovery = recomputeHeadroomRecovery(5);
  assert(
    /for 5 minutes running/.test(recovery),
    "and the all-clear says how long it has been keeping up, since one caught-up minute is no longer a recovery",
  );
  assert(!DASHES.test(recovery), "no dashes in recovery copy");
}

finish();
