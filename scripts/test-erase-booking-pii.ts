// #1072/#1103: the data-subject erasure function erase_booking_pii(target_email).
// A SECURITY DEFINER SQL function that, in one idempotent transaction, redacts a
// person's Slate-collected contact data on request. This static guard pins the
// shape AND the POLICY BOUNDARY (docs/pii-retention.md sections 4/7): the narrow
// scope Dan set on 2026-07-23 must not silently broaden. It also pins the #1118
// integration points: the function must stamp the pii_redacted_at marker (so the
// export freezes the row) and match webhook deliveries by the affected booking
// ids (so a delivery whose attendee email is null but carries the person's other
// PII is still blanked).
//
// Runtime behavior is verified by applying the migration and running the function
// (docs/pii-erasure-runbook.md); this guard is the repo invariant.
// Run: node --experimental-strip-types scripts/test-erase-booking-pii.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";

const dir = join(import.meta.dirname, "..", "supabase", "migrations");
const file = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .find((f) => readFileSync(join(dir, f), "utf8").toLowerCase().includes("function erase_booking_pii"));

assert(file !== undefined, "a migration defines erase_booking_pii(...)");

const sqlRaw = file ? readFileSync(join(dir, file), "utf8") : "";
const sql = sqlRaw.toLowerCase();
// Comment-stripped, whitespace-collapsed view: the header comment legitimately
// NAMES the fields the function must NOT touch, so the negative (policy) checks
// look at code only.
const code = sql.replace(/--.*$/gm, "").replace(/\s+/g, " ");

// Shape.
assert(
  /create\s+(?:or\s+replace\s+)?function\s+erase_booking_pii\s*\(/.test(sql),
  "defines function erase_booking_pii(target_email ...)",
);
assert(/security definer/.test(code), "erase_booking_pii is SECURITY DEFINER");
assert(
  code.includes("slate.allow_erasure"),
  "sets the slate.allow_erasure sentinel so #1040's trigger permits the booking_events redaction",
);
assert(
  code.includes("encode(") && code.includes("sha256"),
  "audits an email HASH (sha256), never cleartext email",
);
assert(
  code.includes("booking_events") && code.includes("reason_detail"),
  "redacts booking_events.reason_detail",
);
assert(code.includes("audit_log"), "writes an audit_log erasure entry");

// Regression: org_id is a uuid, and min()/max() are undefined for uuid in
// Postgres, so aggregating it that way makes EVERY call error at runtime (caught
// only by actually running the function, not by this shape check). Use array
// indexing instead.
assert(
  !/\b(?:min|max)\s*\(\s*org_id\s*\)/.test(code),
  "does NOT aggregate org_id with min()/max() (undefined for uuid; use array indexing)",
);

// #1118 integration: stamps the marker so the export freezes the redacted row at
// its last full-fidelity version instead of re-MERGEing the blanked one.
assert(code.includes("pii_redacted_at"), "stamps bookings.pii_redacted_at (the #1118 export-freeze marker)");

// #1103 (red-team Flaw G): webhook deliveries are matched by the affected booking
// ids, not attendee email alone, so a delivery with a null attendee email but the
// person's other PII is still blanked. Still blanks the payload and flags erased.
assert(
  code.includes("webhook_deliveries") && code.includes("payload_erased"),
  "blanks matching webhook_deliveries payloads and flags payload_erased",
);
assert(
  /payload\s*->>\s*'booking_id'/.test(code),
  "matches webhook deliveries by payload booking_id (the affected id set), not email alone",
);

// Policy boundary (docs/pii-retention.md section 4): erasure is deliberately
// NARROW. It must NOT clear the external Salesforce reference or delete calendar
// events. (booking_id, not salesforce_id, keys the webhook match by design.)
assert(
  !code.includes("salesforce_id"),
  "erasure does NOT touch salesforce_id (Salesforce is the system of record)",
);
assert(!code.includes("external_id"), "erasure does NOT touch external_id (Salesforce is the system of record)");
assert(
  !code.includes("gcal") && !code.includes("calendar"),
  "erasure does NOT delete Google Calendar events (agent's operational record)",
);

finish();
