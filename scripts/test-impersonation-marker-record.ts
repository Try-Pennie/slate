// Holds docs/design/impersonation-marker.html to its own numbers.
//
// The record is the authority for #2037, and its authority IS its measurements:
// "8.61:1" is the entire reason mustard is allowed on a functional surface, and
// DESIGN.md's Hazard Rule points at this file. A record whose figures have
// drifted from the tokens is worse than no record, because a reader believes it
// and stops measuring (L210, L244).
//
// It caught a real defect on the day it was written: the record was drawn with an
// invented #1C1C1C, called "graphite" in its own prose while Slate's graphite is
// #343434, and that colour exists in no stylesheet in the product.
//
// Run: node --experimental-strip-types scripts/test-impersonation-marker-record.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, fail, finish } from "./lib/harness.ts";
import { auditRecord, CONTRAST_CLAIMS, statedRatio, type AuditInput } from "./lib/scan-design-record.ts";

const RECORD_FILE = join("docs", "design", "impersonation-marker.html");
const GLOBALS_FILE = join("src", "app", "globals.css");
const DESIGN_FILE = "DESIGN.md";

// How the record names the colours its claims are about. The NAMES live here; the
// values are read out of the record itself, so this file holds no colour.
const PALETTE = {
  graphite: "graphite",
  mustard: "mustard",
  rose: "rose",
  "stripe-dark": "stripe-dark",
  "page-light": "page",
  "page-dark": "page-dark",
};

// Read once for the whole suite rather than per assertion.
const real: AuditInput = {
  record: readFileSync(RECORD_FILE, "utf8"),
  globals: readFileSync(GLOBALS_FILE, "utf8"),
  designMd: readFileSync(DESIGN_FILE, "utf8"),
  palette: PALETTE,
};

// --- the record itself ------------------------------------------------------

const problems = auditRecord(real);
if (problems.length === 0) {
  assert(true, `${RECORD_FILE}: every colour is a real token and every stated ratio measures true`);
} else {
  for (const p of problems) fail(`${p.kind}: ${p.detail}`);
}

// Every claim the audit knows about must actually appear, so a row silently
// deleted from the record is a failure rather than one fewer thing checked (L98).
for (const claim of CONTRAST_CLAIMS) {
  const stated = statedRatio(real.record, claim.label);
  assert(stated !== null, `the record states a ratio for "${claim.label}"${stated ? ` (${stated.text}:1)` : ""}`);
}

// The ten numbered requirements are what an implementer works from, so a record
// that lost them still reads like a design record while directing nobody.
for (let n = 1; n <= 10; n++) {
  assert(real.record.includes(`IM${n}.`), `requirement IM${n} is present`);
}

// --- positive controls ------------------------------------------------------
// Each mutates ONE thing and requires the audit to catch it, naming the kind, so
// a check that has quietly stopped looking cannot pass (L1, L154).

function only(kinds: string[], input: AuditInput, what: string) {
  const found = auditRecord(input).map((p) => p.kind);
  const missing = kinds.filter((k) => !found.includes(k));
  if (missing.length === 0) assert(true, `control: ${what} is caught (${[...new Set(found)].join(", ")})`);
  else fail(`control: ${what} was NOT caught; expected ${missing.join(", ")}, got ${found.join(", ") || "nothing"}`);
}

// 1. a mistyped ratio. It must be mutated in the MEASUREMENT TABLE, which is what
//    the audit reads: the first pass mutated the same figure where it appears in
//    the prose above, the table still said 8.61, and the control passed while
//    proving nothing (L1 again, one level up).
const TABLE_ROW = '<tr><td>graphite label on the mustard strip</td><td class="n">8.61:1</td></tr>';
if (!real.record.includes(TABLE_ROW)) {
  fail("control: the measurement row this control mutates is not in the record verbatim, so the control below is vacuous");
}
only(
  ["ratio-wrong"],
  { ...real, record: real.record.replace(TABLE_ROW, TABLE_ROW.replace("8.61:1", "4.20:1")) },
  "a ratio that does not measure what it claims",
);

// 2. a colour the product does not have
only(
  ["colour-not-a-token"],
  { ...real, record: real.record.replace(/--mustard:\s*#FFD073/i, "--mustard:#FFD074") },
  "a palette colour that is not a token in globals.css",
);

// 3. DESIGN.md drifting from the record
only(
  ["design-md-drift"],
  { ...real, designMd: real.designMd.replace("8.61:1", "9.99:1") },
  "DESIGN.md quoting a figure the record does not state",
);

// 4. the Hazard Rule removed entirely
only(
  ["hazard-rule-missing"],
  { ...real, designMd: real.designMd.replace("**The Hazard Rule.**", "**The Retired Rule.**") },
  "the Hazard Rule going missing from DESIGN.md",
);

// 5. a colour literal the audit cannot read. It must be REPORTED rather than
//    skipped: a guard that quietly stops looking reports a clean record, which is
//    indistinguishable from a correct one (L11, L98).
//    The planted value is VALID CSS that parseColor does not support (percentage
//    channels), which is the real shape of this fault: a truncated hex never
//    matches the colour regex at all and is caught earlier as palette-unreadable.
only(
  ["colour-unreadable"],
  { ...real, record: real.record.replace(/--mustard:\s*#FFD073/i, "--mustard:rgb(100% 82% 45%)") },
  "a colour literal that is valid CSS the audit cannot parse",
);

// 6. a measurement row deleted
only(
  ["claim-missing"],
  { ...real, record: real.record.replace("mustard strip against the rose bar below it", "something else entirely") },
  "a measurement row disappearing from the record",
);

finish();
