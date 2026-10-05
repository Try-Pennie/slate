// Unit test for the #354 embed-relationship scanner (scripts/lib/scan-embed-relationships.ts),
// driven by synthetic inputs so a parser break is caught independently of the real
// src/ + schema.ts the guard (scripts/test-db-embed-relationships.ts) runs against.
// Run: node --experimental-strip-types scripts/test-scan-embed-relationships.ts
import {
  findEmbeds,
  findDeclaredRelationships,
  isEmbedCovered,
} from "./lib/scan-embed-relationships.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// --- findEmbeds ---
{
  // Single-line embed.
  const single = `db.from("buckets").select("*, event_types(*)").eq("code", c)`;
  eq(JSON.stringify(findEmbeds(single)), JSON.stringify([{ table: "buckets", relation: "event_types" }]), "findEmbeds: single-line embed");

  // Multi-line `.select(\n  "...",\n)` with nested column list on the relation.
  const multi = `db
    .from("availability_schedules")
    .select(
      "id, user_id, availability_rules(schedule_id, weekday)",
    )`;
  eq(
    JSON.stringify(findEmbeds(multi)),
    JSON.stringify([{ table: "availability_schedules", relation: "availability_rules" }]),
    "findEmbeds: multi-line embed, nested columns not mistaken for relations",
  );

  // PostgREST's join-hint syntax (`table!inner(...)`, also `!left`) names the
  // EMBEDDED TABLE before the hint. Reading the hint as the relation name would make
  // the embed impossible to cover, since no relationship is ever declared against a
  // table called "inner", so the guard would report a missing relationship that had
  // in fact been declared correctly (#1258 is the repo's first such embed).
  const hinted = `db.from("bookings").select("*, buckets!inner(is_test)", { count: "exact" })`;
  eq(
    JSON.stringify(findEmbeds(hinted)),
    JSON.stringify([{ table: "bookings", relation: "buckets" }]),
    "findEmbeds: a !inner join hint resolves to the embedded table, not the hint",
  );
  const left = `db.from("bookings").select("id, buckets!left(is_test)")`;
  eq(
    JSON.stringify(findEmbeds(left)),
    JSON.stringify([{ table: "bookings", relation: "buckets" }]),
    "findEmbeds: a !left join hint resolves the same way",
  );

  // A relationship hint (`table!<constraint>(...)`, optionally followed by a join
  // hint) names the CONSTRAINT after the table, for when more than one path links
  // the two tables (#3304). The embedded table is still the identifier before the
  // first `!`; reading the constraint name as the relation would report a covered
  // embed as missing, and would let one through against a table nobody declared.
  const fkHinted = `db.from("bookings").select("id, users!bookings_assigned_user_id_fkey!inner(id)")`;
  eq(
    JSON.stringify(findEmbeds(fkHinted)),
    JSON.stringify([{ table: "bookings", relation: "users" }]),
    "findEmbeds: a constraint hint before !inner resolves to the embedded table",
  );
  const fkOnly = `db.from("bookings").select("id, users!bookings_assigned_user_id_fkey(id)")`;
  eq(
    JSON.stringify(findEmbeds(fkOnly)),
    JSON.stringify([{ table: "bookings", relation: "users" }]),
    "findEmbeds: a constraint hint alone resolves to the embedded table",
  );

  // A plain column list (no `identifier(`) is not an embed.
  assert(findEmbeds(`db.from("users").select("id, role")`).length === 0, "findEmbeds: plain column list yields nothing");

  // A write's returning `.select("id")` is not an embed either.
  assert(findEmbeds(`db.from("busy_blocks").insert(b).select("id").single()`).length === 0, "findEmbeds: returning select is not an embed");
}

// --- findDeclaredRelationships ---
{
  const schema = `
    event_types: Table<EventType>;
    buckets: Table<
      Bucket,
      [
        { foreignKeyName: "buckets_event_type_id_fkey"; columns: ["event_type_id"]; isOneToOne: false; referencedRelation: "event_types"; referencedColumns: ["id"] },
      ]
    >;
    availability_rules: Table<
      AvailabilityRule,
      [
        { foreignKeyName: "availability_rules_schedule_id_fkey"; columns: ["schedule_id"]; isOneToOne: false; referencedRelation: "availability_schedules"; referencedColumns: ["id"] },
      ]
    >;
  `;
  const declared = findDeclaredRelationships(schema);
  assert(
    declared.some((d) => d.table === "buckets" && d.referencedRelation === "event_types"),
    "findDeclaredRelationships: reads a forward relationship",
  );
  assert(
    declared.some((d) => d.table === "availability_rules" && d.referencedRelation === "availability_schedules"),
    "findDeclaredRelationships: reads a reverse relationship",
  );
  // A `Table<Row>` with no relationships tuple contributes nothing.
  assert(
    !declared.some((d) => d.table === "event_types"),
    "findDeclaredRelationships: a table with no relationships tuple is skipped",
  );

  // --- isEmbedCovered (both directions + the miss) ---
  assert(isEmbedCovered({ table: "buckets", relation: "event_types" }, declared), "isEmbedCovered: forward embed covered");
  assert(
    isEmbedCovered({ table: "availability_schedules", relation: "availability_rules" }, declared),
    "isEmbedCovered: reverse embed covered",
  );
  assert(
    !isEmbedCovered({ table: "buckets", relation: "availability_rules" }, declared),
    "isEmbedCovered: unrelated embed reported uncovered",
  );
}

finish();
