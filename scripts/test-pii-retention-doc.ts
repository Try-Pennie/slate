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

// #3143: the flow map in docs/pii.md must keep saying that the Worker logs hold
// the manage token. It is a credential to a lead's booking, it sits in the URL
// PATH of every manage page request (/booking/manage/[token]), and Cloudflare
// records that URL for seven days. Dan accepted that risk on 2026-10-03 rather
// than change the link every lead holds, so the record of it must not be lost.
{
  let map = "";
  try {
    map = readFileSync(join(root, "docs", "pii.md"), "utf8");
  } catch {
    /* asserted below */
  }
  const cloudflareRow = map.split("\n").find((l) => l.startsWith("| **Cloudflare**")) ?? "";
  assert(cloudflareRow.length > 0, "docs/pii.md has the Cloudflare row in its flow table");
  assert(/manage token/i.test(cloudflareRow), "the Cloudflare row names the manage token the request URL carries");
  assert(
    /booking\/manage\/\[token\]/.test(map),
    "docs/pii.md names the manage page path the token travels in",
  );
  assert(
    /accepted risk \(Dan, 2026-10-03\)/.test(map.slice(map.indexOf("### The manage token is in the URL path"))),
    "the manage token paragraph records Dan's acceptance of the risk, with its date",
  );
  assert(
    /scrubContactData/.test(map.slice(map.indexOf("## 6. Slack"))),
    "the Slack section says unexpected fault detail is scrubbed of contact data",
  );
}

finish();
