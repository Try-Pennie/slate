// Repo invariant (#1151): an alert that reports an ONGOING CONDITION must be able
// to tell you it ended, and a notice that never needed action must never pretend
// to.
//
// The bug class. #1133/#1134 gave two alerts a recovery notice and deliberately
// gave the info-channel whispers none, because an all-clear for something that
// needed no action is pure noise. That classification then lived only in comments
// and in whoever last touched it, so the next named alert could ship as a page
// with no way to tell it had ended, which is the confusion #1134 was filed about.
//
// The classification now lives in src/lib/notify/alert-catalog.ts, and this
// checks it against the code in BOTH directions, in the shape of
// scripts/test-heartbeat-lane-coverage.ts (which pairs heartbeats with bounds):
//
//   1. every key the code pages on is classified, and classified as something
//      that can page (never as `info`);
//   2. every key the code whispers on is classified `info`;
//   3. every `condition` has a resolveAlert for the same key, so it can clear;
//   4. no `info` key is ever resolved;
//   5. every `incident` is genuinely unresolved, so the exemption stays honest
//      rather than becoming a place to park a condition someone did not want to
//      build recovery for;
//   6. the catalog has no entry for a key the code never sends, so a rename
//      cannot leave a stale classification behind claiming coverage.
//
// Plus an anti-vacuity floor: a regex regression that found zero call sites would
// make every assertion above pass by default, which is the exact false-confidence
// shape these guards exist to prevent.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-alert-recovery-coverage.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scanAlertSites, type AlertSite } from "./lib/scan-alert-keys.ts";
import { ALERT_CATALOG, alertEntry } from "../src/lib/notify/alert-catalog.ts";
import { assert, finish } from "./lib/harness.ts";

const HERE = import.meta.dirname; // scripts/
const ROOT = join(HERE, "..");
const SRC = join(ROOT, "src");
/** The dispatch module DEFINES the three helpers, so it is not a call site. */
const DEFINITION = join("lib", "notify", "dispatch.ts");

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...tsFiles(p));
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

// --- fixtures: the reader itself must work ------------------------------------
// Checked before the real tree, so a failure here reads as "the scanner broke",
// not as "the codebase changed".
{
  const fx = (src: string) => scanAlertSites(src, "fixture");

  const literal = fx(`await sendThrottledAlert("sync_failures", MS, text);`);
  assert(literal[0]?.key === "sync_failures" && literal[0].channel === "alert", "reads a literal key");

  const constant = fx(`const FOO_KEY = "watch_lapse";\nawait resolveAlert(FOO_KEY, text);`);
  assert(
    constant[0]?.key === "watch_lapse" && constant[0].channel === "resolve",
    "reads a key defined as a constant in the same file",
  );

  const template = fx('await sendThrottledAlert(`webhook_dead:${id}`, MS, text);');
  assert(template[0]?.key === "webhook_dead:*", "collapses a template key to its family");

  const builder = fx(
    "const laneKey = (lane: string) => `cron_lane_stale:${lane}`;\n" +
      "await sendThrottledAlert(laneKey(l), MS, text);",
  );
  assert(builder[0]?.key === "cron_lane_stale:*", "follows a key-builder arrow to its family");

  const info = fx(`await sendThrottledInfo("reassign-unknown-reason-code", MS, text);`);
  assert(info[0]?.channel === "info", "distinguishes the info channel");

  const opaque = fx(`await sendThrottledAlert(spec.key, MS, text);`);
  assert(opaque[0]?.key === null, "an unreadable key is reported opaque, never guessed");

  const declared = fx(`// alert-key: verify_on_book_outage\nawait sendThrottledAlert(spec.key, MS, text);`);
  assert(declared[0]?.key === "verify_on_book_outage", "an // alert-key: declaration is read");

  // The first argument must survive an inner comma, or a key built by a call
  // would be truncated and silently mis-keyed.
  const nested = fx("const k = (a: string, b: string) => `x:${a}`;\nawait sendThrottledAlert(k(one, two), MS, text);");
  assert(nested[0]?.key === "x:*", "a key-builder call with several arguments is read whole");
}

// --- the real tree ------------------------------------------------------------

const sites: AlertSite[] = [];
for (const file of tsFiles(SRC)) {
  if (file.endsWith(DEFINITION)) continue;
  const src = readFileSync(file, "utf8");
  if (!/sendThrottled(Alert|Info)\(|resolveAlert\(/.test(src)) continue;
  sites.push(...scanAlertSites(src, file.slice(ROOT.length + 1)));
}

// Anti-vacuity: a broken regex finds nothing and every check below passes.
assert(
  sites.length >= 45,
  `scan still finds the alert call sites (expected at least 45, got ${sites.length}). ` +
    `A LOW count means the scan regressed, not that the alerts went away`,
);
for (const known of ["sync_failures", "cron_lane_stale:*", "webhook_dead:*"]) {
  assert(
    sites.some((s) => s.key === known),
    `scan finds the ${known} sites`,
  );
}
assert(
  sites.some((s) => s.channel === "resolve") && sites.some((s) => s.channel === "info"),
  "scan finds all three channels, so no channel check is vacuous",
);

// Every site's key must be readable. An unreadable one is a hard failure, not a
// skip: silently dropping it would leave exactly the unclassified alert this
// guard exists to catch.
for (const s of sites.filter((x) => x.key === null)) {
  assert(
    false,
    `${s.file}:${s.line} sends an alert whose key this guard cannot read (\`${s.expression}\`). ` +
      `Add a "// alert-key: <key or prefix:*>" comment on or above the line naming what it sends, ` +
      `so it can be classified in src/lib/notify/alert-catalog.ts`,
  );
}

const readable = sites.filter((s) => s.key !== null) as (AlertSite & { key: string })[];
const paged = new Set(readable.filter((s) => s.channel === "alert").map((s) => s.key));
const whispered = new Set(readable.filter((s) => s.channel === "info").map((s) => s.key));
const resolved = new Set(readable.filter((s) => s.channel === "resolve").map((s) => s.key));

// 1 + 2: every key the code sends is classified, on the right channel.
for (const key of [...paged].sort()) {
  const entry = alertEntry(key);
  if (!entry) {
    assert(
      false,
      `alert key "${key}" is sent by the code but not classified in src/lib/notify/alert-catalog.ts. ` +
        `Add it as a "condition" (an ongoing state, and give it a resolveAlert) or an "incident" ` +
        `(a finished event, and say what healthy state does not exist)`,
    );
    continue;
  }
  assert(
    entry.kind !== "info",
    `alert key "${key}" is classified "info" but is sent with sendThrottledAlert, which PAGES. ` +
      `Either send it with sendThrottledInfo or reclassify it`,
  );
}
for (const key of [...whispered].sort()) {
  const entry = alertEntry(key);
  assert(entry !== undefined, `info key "${key}" is classified in the alert catalog`);
  if (entry) {
    assert(
      entry.kind === "info",
      `key "${key}" is sent on the INFO channel but classified "${entry.kind}". An info notice needs ` +
        `no action, so it must not be classified as something that pages`,
    );
  }
}

// 3: every condition can announce that it ended.
for (const entry of ALERT_CATALOG.filter((e) => e.kind === "condition")) {
  assert(
    resolved.has(entry.key),
    `"${entry.key}" is classified a CONDITION (${entry.why}) but nothing calls resolveAlert for it, ` +
      `so it pages once and never tells anyone it is over. Add the recovery notice where the ` +
      `condition is re-measured, or reclassify it as an incident with an argument`,
  );
}

// 4: an info notice never sends an all-clear for something that needed no action.
for (const entry of ALERT_CATALOG.filter((e) => e.kind === "info")) {
  assert(
    !resolved.has(entry.key),
    `"${entry.key}" is informational but something calls resolveAlert for it. An all-clear for a ` +
      `notice nobody had to act on is noise`,
  );
}

// 5: the incident exemption stays honest. A key that DOES resolve is behaving
// like a condition, so the classification is wrong even though nothing is broken.
for (const entry of ALERT_CATALOG.filter((e) => e.kind === "incident")) {
  assert(
    !resolved.has(entry.key),
    `"${entry.key}" is classified an INCIDENT (no healthy state to announce) but something calls ` +
      `resolveAlert for it. One of the two is wrong: either it is really a condition, or that ` +
      `recovery notice is announcing the end of something that already finished`,
  );
}

// 6: no stale classification. A catalog entry for a key nothing sends is a claim
// of coverage over an alert that no longer exists, which is how a rename leaves
// the real new key unclassified while the list still looks complete.
for (const entry of ALERT_CATALOG) {
  assert(
    paged.has(entry.key) || whispered.has(entry.key),
    `the catalog classifies "${entry.key}" but no code sends it. Remove the entry, or fix the key ` +
      `if it was renamed (a stale entry makes the list look complete while the real key goes unclassified)`,
  );
}

finish();
