// #4222 follow up: the one `lane_claim_unreadable` alert is wired everywhere a monitor
// alert has to be, and raised from ONE place.
//
// scripts/test-lane-claim-health.ts drives the check. This holds the wiring around it:
// the tunable key with a daily default, the condition classification, the runbook
// section, the preview, and the monitor lane step that judges the lane's OWN claim,
// after its lease. And the guarantee that makes it one alert rather than 28: nothing
// in src/ but the monitor lane names the key or the check, so no lane can send it.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-lane-claim-health-wiring.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import { LANE_CLAIM_UNREADABLE_KEY } from "@/lib/monitor/lane-claim-health";
import { ALERT_FIELDS, ALERT_KEYS, MONITOR_DEFAULTS } from "@/lib/monitor/settings";
import { ALERT_CATALOG } from "@/lib/notify/alert-catalog";
import { alertFamily } from "@/lib/notify/alert-runbook";
import { ALERT_PREVIEWS } from "@/lib/notify/alert-preview";

const ROOT = join(import.meta.dirname, "..");
const KEY = LANE_CLAIM_UNREADABLE_KEY;

// --- settings, catalog, runbook, preview ----------------------------------------------
assert((ALERT_KEYS as readonly string[]).includes(KEY), "the key is one of the monitor alert keys");
eq((MONITOR_DEFAULTS.cooldownMs as Record<string, number>)[KEY], 24 * 60 * 60_000, "it repeats once a day while unchanged (#3801)");
eq(ALERT_FIELDS.find((f) => f.key === KEY)?.urgency, "page", "the settings screen lists it as a page");
eq(ALERT_CATALOG.find((e) => e.key === KEY)?.kind, "condition", "it is a condition, so it ends with an all clear");
eq(alertFamily(KEY), "a-limit-or-a-guard-is-not-working", "its runbook family is the guards that fail open");
const runbook = readFileSync(join(ROOT, "docs/alerts-runbook.md"), "utf8");
assert(runbook.includes("`lane_claim_unreadable` means"), "and that section says what it means");
const previews = ALERT_PREVIEWS.filter((p) => p.key === KEY);
eq(previews.map((p) => p.channel).sort(), ["alert", "recovery"], "the preview renders the page and the all clear");

// --- the monitor lane judges its own claim, after its lease ---------------------------
const route = readFileSync(join(ROOT, "src/app/api/cron/monitor/route.ts"), "utf8");
const claimAt = route.indexOf('claimLaneTick(req.headers, "/api/cron/monitor", (c) => (ownClaim.claim = c))');
assert(claimAt > 0, "the monitor lane keeps its own claim through the observer");
const leaseAt = route.indexOf('acquireLease("cron_monitor"');
const stepAt = route.indexOf('steps.run("lane_claim_health"');
assert(stepAt > leaseAt && leaseAt > claimAt, "and judges it in its own step, under the lease, so two runs never judge at once");
const body = route.slice(stepAt, route.indexOf("\n    );\n", stepAt));
assert(body.includes("runLaneClaimHealthCheck("), "the step calls the check");
assert(body.includes("claim: ownClaim.claim"), "with the lane's own claim, the measurement");
assert(body.includes("sendThrottledAlert(") && body.includes("resolveAlert("), "raising and clearing through the dispatcher");
assert(
  body.includes("notify: (key, ms, text, repeat) => sendThrottledAlert(key, ms, text, repeat)"),
  "passing the page's AlertRepeat on to the dispatcher, as every monitor wiring must (#4235)",
);
assert(body.includes("cooldownMs.lane_claim_unreadable"), "with the tunable cooldown");

// --- one sender: nothing else in src/ can raise it ---------------------------------------
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(name) ? [p] : [];
  });
}
const allowed = new Set([
  "src/lib/monitor/lane-claim-health.ts",
  "src/app/api/cron/monitor/route.ts",
  // Registrations, which name the key but send nothing.
  "src/lib/monitor/alert-keys.ts",
  "src/lib/monitor/settings.ts",
  "src/lib/notify/alert-catalog.ts",
  "src/lib/notify/alert-runbook.ts",
  "src/lib/notify/alert-preview.ts",
]);
const strays = files(join(ROOT, "src"))
  .map((f) => relative(ROOT, f))
  .filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx") && !allowed.has(f))
  .filter((f) => {
    const text = readFileSync(join(ROOT, f), "utf8");
    return text.includes(KEY) || text.includes("runLaneClaimHealthCheck") || text.includes("LANE_CLAIM_UNREADABLE_KEY");
  });
eq(strays, [], "no other source file names the key or the check, so no lane can send it");
const glue = readFileSync(join(ROOT, "src/lib/cron-lane-claim.ts"), "utf8");
assert(!/notify\/dispatch/.test(glue), "the lanes' claim glue does not even import the dispatcher");

finish();
