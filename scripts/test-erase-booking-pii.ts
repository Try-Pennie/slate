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
import { REDACTED_BOOKING_UPDATE } from "../src/lib/booking/pii-retention.ts";

const dir = join(import.meta.dirname, "..", "supabase", "migrations");
// The function is defined with `create or replace`, so when several migrations
// define it the HIGHEST-numbered one is what is actually live. Taking the first
// match (as this guard originally did) pins superseded SQL and silently stops
// checking the real function the moment it is amended, which is how #1140's
// missing outbox erasure would have passed this guard unnoticed.
const file = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .reverse()
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
// Regression: the function pins search_path=public, but pgcrypto's digest() lives
// in the extensions schema, so digest() errors at runtime (caught only by running
// the redaction path, not the no-match path). Use the built-in sha256(bytea).
assert(
  !/\bdigest\s*\(/.test(code),
  "hashes with the built-in sha256(), not pgcrypto digest() (unreachable under search_path=public)",
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

// #1140: booking_outbox carries the SAME free-text reason as booking_events (its
// payload.reasonDetail is written from the same mutation), so erasing one and not
// the other leaves a copy of data we told the person was gone. Verified against
// production: the outbox payload holds fromAgentUserId / fromStartsIso /
// initiator / reasonCode / reasonDetail, and reasonDetail is the only PII-bearing
// field; steps[].error and last_error can additionally embed an external response
// body. It is NOT the attendee name/email/phone/prefill the issue first described.
assert(code.includes("booking_outbox"), "erases the matching booking_outbox rows (#1140)");
assert(
  /reasondetail/.test(code),
  "removes the outbox payload's free-text reasonDetail (the same text redacted in booking_events)",
);
assert(
  code.includes("last_error"),
  "clears the outbox last_error, which can embed an external response body",
);
// The outbox has NO set_updated_at trigger (its writers stamp updated_at from the
// Worker's own clock), and it is deliberately absent from the export's
// skip-redacted set. So stamping updated_at here is what makes the next export
// MERGE the blanked row over the warehouse copy, erasing Snowflake automatically
// instead of needing a hand-run purge. Without it the mirror keeps the reason text.
assert(
  /update\s+booking_outbox[\s\S]{0,400}updated_at\s*=\s*now\(\)/.test(code),
  "stamps booking_outbox.updated_at so the export overwrites the warehouse copy",
);
// The operational fields are what the drain needs to finish a still-pending row.
// Blanking them would strand a mutation's side effects, so erasure must take the
// reason text ONLY, which is also why no row has to be excluded by status.
for (const keep of ["reasoncode", "initiator", "fromstartsiso", "fromagentuserid"]) {
  assert(
    !new RegExp(`-\\s*'${keep}'`).test(code) && !new RegExp(`#-\\s*'?${keep}`).test(code),
    `does NOT strip the outbox payload's operational '${keep}' (the drain needs it)`,
  );
}

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


// #3126: a pending create reservation holds the whole attendee record (and the
// manage token) in booking_reservations.payload until the booking lands. Erasure
// has to take it, and has to take it even when no booking exists yet: a
// reservation the drain later resumes would otherwise recreate the booking, with
// every field the request asked us to remove.
{
  assert(
    /delete from booking_reservations/.test(code),
    "deletes the person's booking_reservations rows (#3126)",
  );
  assert(
    /lower\(\s*trim\(\s*payload\s*->\s*'booking'\s*->>\s*'attendee_email'\s*\)\s*\)\s*=\s*norm/.test(code),
    "matches a reservation by the same normalized attendee email the bookings match uses",
  );
  const reservationsAt = code.indexOf("delete from booking_reservations");
  const noMatchAt = code.indexOf("'no-match'");
  assert(
    reservationsAt !== -1 && noMatchAt !== -1 && reservationsAt < noMatchAt,
    "takes the reservations BEFORE the no-match return, so a person with only a pending reservation is still erased",
  );
  assert(/'reservations_deleted'/.test(code), "the audit row counts the reservations deleted");
}

// #2549: erasure on request clears EVERY contact column retention clears, derived
// from the retention shape rather than listed again here, so a contact column
// added to one (attendee_first_name was the first) cannot be missed by the other.
{
  const bookingsUpdate = code.match(/update bookings set ([\s\S]*?) where/)?.[1] ?? "";
  assert(bookingsUpdate.length > 0, "erase_booking_pii has an update bookings ... set ... where block");
  for (const column of Object.keys(REDACTED_BOOKING_UPDATE)) {
    assert(
      new RegExp(`\\b${column}\\s*=`).test(bookingsUpdate),
      `erase_booking_pii clears ${column}, as retention does (${file})`,
    );
  }
}

finish();
