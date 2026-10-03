// #3141: docs/slo.md quotes the numbers the checks and the targets use, and nothing held it to
// them. It said "disarmed" for two days after the failure rate page was armed, and "1-hour
// window" for weeks after #2494 moved it to three. Now every number in it is a whole line
// generated from the constant it comes from (scripts/lib/slo-doc.ts), and this fails when
// the document and the code disagree (L41).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-slo-doc.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import { expectedSloDocLines, sloDocFindings, RETIRED_SLO_CLAIMS } from "./lib/slo-doc.ts";
import {
  AVAILABILITY_TARGET_PCT,
  BOOKING_SUCCESS_TARGET_PCT,
  SERVER_FAULT_ERROR_CODES,
  sloArithmetic,
} from "../src/lib/monitor/slo-targets.ts";

const doc = readFileSync(join(import.meta.dirname, "..", "docs", "slo.md"), "utf8");

// --- the document agrees with the code -------------------------------------------
{
  const findings = sloDocFindings(doc);
  assert(findings.length === 0, findings.length === 0 ? "docs/slo.md carries every generated line" : findings.join("\n\n"));
  assert(expectedSloDocLines().length >= 12, "the guard still generates every line it is meant to hold");
}

// --- the targets are what Dan asked for: a little below what the pilot achieved -----
{
  const a = sloArithmetic();
  assert(BOOKING_SUCCESS_TARGET_PCT < a.successPct, "the booking success target sits below the pilot's measured share");
  assert(a.successPct - BOOKING_SUCCESS_TARGET_PCT <= 1, "and only a little below it, not a number nobody could miss");
  eq(a.serverFaults, 0, "the pilot recorded no server fault");
  assert(
    100 - AVAILABILITY_TARGET_PCT > a.faultUpperBoundPct,
    "the availability target sits under what zero faults in the pilot can vouch for",
  );
  // The server fault list is derived, so prove the derivation found the paths it must.
  for (const code of ["internal", "INTERNAL", "verify_unavailable", "reschedule_internal", "cancel_internal"]) {
    assert(SERVER_FAULT_ERROR_CODES.includes(code), `${code} is a server fault`);
  }
  for (const code of ["slot_unavailable", "invalid_request", "SLOT_TAKEN", "reschedule_slot_taken"]) {
    assert(!SERVER_FAULT_ERROR_CODES.includes(code), `${code} is not a server fault`);
  }
}

// --- positive controls: the guard fails on the drift it exists for (L1) -------------
{
  const moved = doc.replace(`**${BOOKING_SUCCESS_TARGET_PCT}%** of counted`, "**97.5%** of counted");
  assert(moved !== doc, "control: the target is where the control edits it");
  assert(
    sloDocFindings(moved).some((f) => f.includes("booking success target row")),
    "control: a target edited in the document alone is caught",
  );

  const window = doc.replace("rolling **3 hour** window", "rolling **1 hour** window");
  assert(window !== doc, "control: the window is where the control edits it");
  assert(
    sloDocFindings(window).some((f) => f.includes("failure rate row")),
    "control: the failure rate window drifting from the shipped thresholds is caught",
  );

  const lines = expectedSloDocLines().map((l) =>
    l.label === "cron headroom row" ? { ...l, line: l.line.replace("**60s**", "**90s**") } : l,
  );
  assert(
    sloDocFindings(doc, lines).some((f) => f.includes("cron headroom row")),
    "control: a constant moved in code alone is caught",
  );

  const onSite = doc.replace("where not is_test and host_class <> 'offsite'", "where not is_test");
  assert(onSite !== doc, "control: the hand query's filter is where the control edits it");
  assert(
    sloDocFindings(onSite).some((f) => f.includes("hand query population filter")),
    "control: a hand query counting off site rows the automated check leaves out is caught",
  );

  const fewer = doc.replace("`cancel_internal`.", "`cancel_write_failed`.");
  assert(
    sloDocFindings(fewer).some((f) => f.includes("server fault codes")),
    "control: a server fault code dropped from the document is caught",
  );

  for (const { label } of RETIRED_SLO_CLAIMS) {
    const sample: Record<string, string> = {
      "the pre pilot no traffic caveat": "Slate has taken no real customer traffic yet.",
      "the failure rate page as disarmed": "| x | y | **Disarmed.** z |",
      "that nothing computes the monthly targets": "Nothing computes these automatically.",
    };
    assert(label in sample, `control: ${label} has a sample to plant`);
    const stale = `${doc}\n${sample[label]}`;
    assert(sloDocFindings(stale).some((f) => f.includes(label)), `control: ${label} coming back is caught`);
  }
}

finish();
