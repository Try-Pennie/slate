// #1070: pin the PII retention/compliance policy doc so its load-bearing
// invariants can't silently drift or vanish. A compliance doc that quietly loses
// "we don't delete calendar events" or "we keep the external IDs" is worse than
// no doc: it misrepresents the system to whoever reads it under a DSR or audit.
// This is the same doc-drift guard rationale as DEPLOY.md in test-cron-routes.ts.
// Run: node --experimental-strip-types scripts/test-pii-retention-doc.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";

const root = join(import.meta.dirname, "..");
let doc = "";
try {
  doc = readFileSync(join(root, "docs", "pii-retention.md"), "utf8");
} catch {
  /* asserted below */
}
assert(doc.trim().length > 0, "docs/pii-retention.md exists");

// The corrected-policy invariants (Dan, 2026-07-23) that must not be lost.
assert(
  /salesforce_id/.test(doc) && /external_id/.test(doc),
  "names the external Salesforce/lead reference columns",
);
assert(
  /not.{0,40}(the system of record|clear these)/i.test(doc),
  "states Slate does NOT clear the external Salesforce reference (not system of record)",
);
assert(
  /calendar event.{0,80}(stays|only on|cancellation)/is.test(doc) ||
    /not.{0,40}delete.{0,40}calendar/is.test(doc),
  "states retention/erasure does NOT delete agent calendar events (only cancellation does)",
);
assert(
  /redact(ed|ion)? in place/i.test(doc),
  "states redaction in place, not hard-delete",
);

// The #1040 reconciliation and the backup caveat must be present.
assert(
  /slate\.allow_erasure/.test(doc),
  "documents the #1040 append-only bypass sentinel GUC the erasure function uses",
);
assert(
  /backup/i.test(doc) && /restore/i.test(doc),
  "documents the backup/restore erasure caveat",
);

// The provisional windows and the legal-confirmation section.
assert(/24 months/.test(doc) && /90 days/.test(doc), "records the provisional retention windows");
assert(/CCPA/.test(doc) && /legal/i.test(doc), "lists the legal-confirmation questions owed");

finish();
