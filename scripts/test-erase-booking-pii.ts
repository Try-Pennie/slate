// #1072: the data-subject erasure function erase_booking_pii(target_email). A
// SECURITY DEFINER SQL function that, in one idempotent transaction, redacts a
// person's Slate-collected contact data on request. This static guard pins the
// shape and, crucially, the POLICY BOUNDARY (docs/pii-retention.md §4/§7): the
// narrow scope Dan set on 2026-07-23 must not silently broaden.
//
// Runtime behavior is verified by applying the migration and running the
// function (docs/pii-erasure-runbook.md); this guard is the repo invariant.
// Run: node --experimental-strip-types scripts/test-erase-booking-pii.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";

const dir = join(import.meta.dirname, "..", "supabase", "migrations");
const file = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .find((f) => readFileSync(join(dir, f), "utf8").toLowerCase().includes("function erase_booking_pii"));

assert(file !== undefined, "a migration defines erase_booking_pii(...)");

const sql = file ? readFileSync(join(dir, file), "utf8").toLowerCase() : "";
// Comment-stripped view: the header comment legitimately NAMES the fields the
// function must NOT touch, so the negative (policy) checks look at code only.
const code = sql.replace(/--.*$/gm, "");

// Shape.
assert(
  /create\s+(?:or\s+replace\s+)?function\s+erase_booking_pii\s*\(/.test(sql),
  "defines function erase_booking_pii(target_email ...)",
);
assert(/security\s+definer/.test(code), "erase_booking_pii is SECURITY DEFINER");
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
assert(
  code.includes("webhook_deliveries") && code.includes("payload"),
  "blanks matching webhook_deliveries payloads (exact attendee email path)",
);
assert(code.includes("audit_log"), "writes an audit_log erasure entry");

// Policy boundary (docs/pii-retention.md §4): erasure is deliberately NARROW.
assert(
  !code.includes("salesforce_id"),
  "erasure does NOT touch salesforce_id (Salesforce is the system of record, §4)",
);
assert(
  !code.includes("external_id"),
  "erasure does NOT touch external_id (Salesforce is the system of record, §4)",
);
assert(
  !code.includes("gcal") && !code.includes("calendar"),
  "erasure does NOT delete Google Calendar events (agent's operational record, §4)",
);

finish();
