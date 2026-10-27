// #3126: docs/pii-retention.md section 1 is checked against the schema, both ways.
//
// The inventory is what a deletion request, an audit or a counsel's question is
// answered from, and it was maintained by hand beside the migrations it describes
// (L41). It drifted: booking_reservations.payload held the whole attendee record
// and the manage token and appeared nowhere, so erasure never reached it either.
// scripts/test-pii-retention-doc.ts pins the doc's WORDING; this pins its
// COMPLETENESS.
//
//   1. Every live column whose name has the shape of lead data
//      (scripts/lib/scan-pii-columns.ts) is named in section 1, or is in
//      NOT_LEAD_PII below with the reason it is not.
//   2. Every column NOT_SHAPED_BUT_PII lists is named there too, because the
//      name scan cannot see contact data under an innocent name.
//   3. Every table.column section 1 names is a live column, so a dropped or
//      renamed column cannot linger in the inventory as though it still held data.
//
// Run: node --experimental-strip-types scripts/test-pii-inventory.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import {
  columnsNamedIn,
  liveColumns,
  piiShapedColumns,
  type MigrationText,
} from "./lib/scan-pii-columns.ts";

const root = join(import.meta.dirname, "..");
const migDir = join(root, "supabase", "migrations");
const migrations: MigrationText[] = readdirSync(migDir)
  .filter((f) => f.endsWith(".sql"))
  .map((name) => ({ name, sql: readFileSync(join(migDir, name), "utf8") }));

/**
 * Columns the name scan matches that hold no LEAD data, each with its reason.
 * An entry without a reason is a guess, so the test refuses one (L233).
 */
const NOT_LEAD_PII: Record<string, string> = {
  "bookings.agent_email": "the assigned advisor's work address, staff data",
  "booking_reservations.pinned_agent_email": "the pinned advisor's work address, staff data",
  "reassign_intents.pinned_agent_email": "an advisor's work address, staff data",
  "reassign_intents.prev_agent_email": "an advisor's work address, staff data",
  "reschedule_locks.pinned_agent_email": "an advisor's work address, staff data",
  "pending_event_deletions.calendar_email": "the advisor calendar an event is deleted from, staff data",
  "regal_call_outcomes.agent_email": "the work address of the employee on the call, staff data",
  "bucket_slots.payload": "the cached slot list for a bucket: times and advisor ids, no lead",
  "booking_reminder_sends.reminder_email_id": "the id of a reminder email template (#4296), not an email address",
  "reminder_email_versions.reminder_email_id": "the id of a reminder email template (#4296), not an email address",
  "bulk_reassign_jobs.reason_detail":
    "a staff written reason for moving an out advisor's bookings; it describes the advisor's absence, not a lead",
};

/** Lead data under a name the scan cannot recognise. Each must be in section 1. */
const NOT_SHAPED_BUT_PII = [
  // #3109: limiter keys are `book:contact:h:email:<address>` and `...:phone:<digits>`.
  "rate_limits.key",
];

const doc = readFileSync(join(root, "docs", "pii-retention.md"), "utf8");
const section1 = doc.match(/\n## 1\.[\s\S]*?(?=\n## 2\.)/)?.[0] ?? "";
assert(section1.length > 0, "docs/pii-retention.md has a section 1 ending at section 2");
const named = columnsNamedIn(section1);
const live = liveColumns(migrations);

// 1. Every PII shaped column is inventoried or exempted with a reason.
const shaped = piiShapedColumns(migrations);
assert(shaped.length >= 15, `the scan found the PII shaped columns (${shaped.length})`);
eq(
  shaped.filter((c) => !named.has(c) && !(c in NOT_LEAD_PII)),
  [],
  "every live column shaped like lead data is named in pii-retention.md section 1 or exempted with a reason",
);
for (const [column, why] of Object.entries(NOT_LEAD_PII)) {
  assert(why.trim().length > 20, `${column}: the exemption carries a reason`);
  assert(live.has(column), `${column}: the exemption names a live column (a stale one would hide nothing and read as coverage)`);
  assert(!named.has(column), `${column}: not both exempted and inventoried`);
}

// 2. The ones the name cannot reveal.
for (const column of NOT_SHAPED_BUT_PII) {
  assert(live.has(column), `${column} is a live column`);
  assert(named.has(column), `${column} is named in pii-retention.md section 1`);
}

// 3. Nothing in section 1 names a column that does not exist.
eq(
  [...named].filter((c) => !live.has(c)).sort(),
  [],
  "every table.column pii-retention.md section 1 names is a live column",
);

// Positive controls: the scan sees each statement shape it relies on.
{
  const fixture: MigrationText[] = [
    { name: "0001_a.sql", sql: "create table leads (\n  id uuid primary key,\n  attendee_middle_name text,\n  note text,\n  unique (id, note)\n);\n" },
    { name: "0002_b.sql", sql: "alter table leads add column if not exists lead_phone text;\nalter table leads add column old_email text;\n" },
    { name: "0003_c.sql", sql: "alter table leads drop column if exists old_email;\ncreate table gone (contact_email text);\ndrop table if exists gone;\n" },
  ];
  eq(
    piiShapedColumns(fixture),
    ["leads.attendee_middle_name", "leads.lead_phone"],
    "CONTROL: a created and an added PII shaped column are found, dropped ones are not",
  );
  assert(!liveColumns(fixture).has("leads.unique"), "CONTROL: a table constraint is not read as a column");

  // A rename moves a column or a whole table to a new name. Missed, the old name
  // stays "live" (so the doc could keep naming a column that no longer exists)
  // and the new one is invisible to the inventory check (L96).
  const renamedColumn = liveColumns([
    { name: "0001_a.sql", sql: "create table leads (\n  id uuid primary key,\n  note text\n);\n" },
    { name: "0002_b.sql", sql: "alter table leads rename column note to attendee_phone;\n" },
  ]);
  assert(
    renamedColumn.has("leads.attendee_phone") && !renamedColumn.has("leads.note"),
    "CONTROL: a renamed column is live under its new name only",
  );
  eq(
    piiShapedColumns([
      { name: "0001_a.sql", sql: "create table leads (\n  id uuid primary key,\n  note text\n);\n" },
      { name: "0002_b.sql", sql: "alter table if exists public.leads rename note to contact_email;\n" },
    ]),
    ["leads.contact_email"],
    "CONTROL: a column renamed without the COLUMN keyword into a PII shape is found",
  );
  const renamedTable = liveColumns([
    { name: "0001_a.sql", sql: "create table leads (\n  id uuid primary key,\n  attendee_name text\n);\n" },
    { name: "0002_b.sql", sql: "alter table leads rename to prospects;\n" },
  ]);
  assert(
    renamedTable.has("prospects.attendee_name") && renamedTable.has("prospects.id") && !renamedTable.has("leads.attendee_name"),
    "CONTROL: a renamed table carries every column to its new name and leaves none behind",
  );
  const withNew = [...migrations, { name: "9999_planted.sql", sql: "alter table bookings add column attendee_middle_name text;\n" }];
  assert(
    piiShapedColumns(withNew).some((c) => c === "bookings.attendee_middle_name" && !named.has(c)),
    "CONTROL: a new contact column on the real tree is reported as missing from the inventory",
  );
  assert(
    named.has("booking_reservations.payload"),
    "booking_reservations.payload, the column this guard was written for, is inventoried",
  );
}

finish();
