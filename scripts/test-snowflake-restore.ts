// Every decision `scripts/restore-from-snowflake.ts` makes, driven offline with hand
// written rows (#3075). The command itself needs live Snowflake and Supabase
// credentials and is never run by this suite.
//
// Run: node --experimental-strip-types scripts/test-snowflake-restore.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import { MIRROR_TABLES, type TableSpec } from "../src/lib/snowflake/export-core.ts";
import { interfaceFields, tableTypeMap } from "./lib/scan-db-columns.ts";
import {
  buildPageQuery,
  decodeRow,
  describePlan,
  parseRestorePoint,
  planTable,
  REDACTION_MARKER,
  RESTORE_ORDER,
  UNMIRRORED_COLUMNS,
  writeGate,
  type CurrentRow,
} from "./lib/snowflake-restore.ts";

const root = join(import.meta.dirname, "..");
const spec = (table: string): TableSpec => MIRROR_TABLES.find((t) => t.table === table)!;
const NOW = Date.parse("2026-10-03T15:00:00Z");

// --- the restore order covers exactly the mirrored tables, parents first ----------
eq([...RESTORE_ORDER].sort(), MIRROR_TABLES.map((t) => t.table).sort(), "the restore order is the mirrored tables, no more and no fewer");
eq(RESTORE_ORDER[0], "bookings", "bookings are written before the rows that reference them");

// --- the unmirrored columns are DERIVED, not trusted ------------------------------
{
  const schema = readFileSync(join(root, "src/lib/db/schema.ts"), "utf8");
  const types = readFileSync(join(root, "src/lib/db/types.ts"), "utf8");
  const typeOf = tableTypeMap(schema);
  const fields = interfaceFields(types);
  const dir = join(root, "supabase/migrations");
  const migrations = readdirSync(dir).filter((f) => f.endsWith(".sql")).map((f) => readFileSync(join(dir, f), "utf8"));
  assert(migrations.length > 100, `read the migrations (${migrations.length})`);
  for (const t of MIRROR_TABLES) {
    const iface = typeOf.get(t.table);
    const declared = iface ? fields.get(iface) : undefined;
    assert(declared !== undefined && declared.size > 3, `read the row type for ${t.table} (${iface})`);
    if (!declared) continue;
    const mirrored = new Set(t.cols.map((c) => c.name));
    const listed = Object.keys(UNMIRRORED_COLUMNS[t.table] ?? {});
    // The hand written row types lag the schema (pii_redacted_at and dedupe_key are in
    // the database and not in types.ts), so the types give a FLOOR: every column they
    // declare beyond the mirror must be listed. Each listed column must then really
    // exist, proved by a migration that names it beside its table.
    for (const f of [...declared].filter((f) => !mirrored.has(f))) {
      assert(listed.includes(f), `${t.table}.${f} is not mirrored, so UNMIRRORED_COLUMNS must say what a restore does with it`);
    }
    for (const f of listed) {
      assert(!mirrored.has(f), `${t.table}.${f} is really absent from the mirror`);
      const named = migrations.some((m) => m.includes(t.table) && new RegExp(`\\b${f}\\b`).test(m));
      assert(named, `${t.table}.${f} is a real column (a migration names it beside its table)`);
    }
  }
  for (const [table, col] of Object.entries(REDACTION_MARKER)) {
    assert(col in (UNMIRRORED_COLUMNS[table] ?? {}), `${table}.${col}, the redaction marker, is one the mirror lacks`);
  }
}

// --- the restore point --------------------------------------------------------------
{
  const ok = parseRestorePoint("2026-10-03T06:00:00Z", NOW);
  eq(ok.ok && ok.iso, "2026-10-03T06:00:00.000Z", "a UTC time is read as given");
  const offset = parseRestorePoint("2026-10-03T02:00:00-04:00", NOW);
  eq(offset.ok && offset.iso, "2026-10-03T06:00:00.000Z", "an explicit offset is honoured");
  for (const [raw, why] of [
    [undefined, "no restore point"],
    ["", "no restore point"],
    ["2026-10-03 06:00:00", "names no zone"],
    ["yesterday Z", "not a readable time"],
    ["2026-10-04T06:00:00Z", "in the future"],
  ] as const) {
    const r = parseRestorePoint(raw, NOW);
    assert(!r.ok && r.reason.includes(why), `refused ${JSON.stringify(raw)}: ${why}`);
  }
}

// --- the page query -----------------------------------------------------------------
{
  const first = buildPageQuery(spec("bookings"), "2026-10-03T06:00:00.000Z", null);
  assert(first.sql.includes("WHERE updated_at >= TO_TIMESTAMP_TZ(?)"), "bookings are selected by updated_at at or after the point");
  assert(first.sql.includes("ORDER BY updated_at, id LIMIT 500"), "in keyset order, one partition sized page at a time");
  assert(first.sql.includes(`TO_VARCHAR(starts_at, 'YYYY-MM-DD"T"HH24:MI:SS.FF6TZH:TZM') AS starts_at`), "timestamps come back as ISO with microseconds and offset");
  assert(first.sql.includes("TO_JSON(prefill) AS prefill"), "a variant comes back as JSON text");
  assert(!/exported_at/.test(first.sql), "the warehouse load stamp is never selected, so it is never written to Supabase");
  eq(first.bindings, ["2026-10-03T06:00:00.000Z"], "the point is a binding, never spliced into the SQL");

  const next = buildPageQuery(spec("audit_log"), "2026-10-03T06:00:00.000Z", { ts: "2026-10-03T07:00:00.000000+00:00", id: "abc" });
  assert(next.sql.includes("created_at >= TO_TIMESTAMP_TZ(?) AND (created_at > TO_TIMESTAMP_TZ(?) OR (created_at = TO_TIMESTAMP_TZ(?) AND id > ?))"), "an append only table pages on created_at past the last row");
  eq(next.bindings.length, 4, "every value in the keyset is a binding");
}

// --- decoding a Snowflake row ---------------------------------------------------------
{
  const s = spec("routing_decisions");
  const cells = s.cols.map((c) => {
    if (c.name === "id") return "rd-1";
    if (c.type === "variant") return '[{"agent":"a"}]';
    if (c.type === "boolean") return "true";
    if (c.type === "number") return "2";
    if (c.type === "timestamp_tz") return "2026-10-03T07:00:00.123456+00:00";
    return c.name === "booking_id" ? null : "x";
  });
  const row = decodeRow(s, cells);
  eq(row.considered, [{ agent: "a" }], "a variant is parsed back into JSON");
  eq(row.empty_pool_fallback, true, "a boolean is a boolean");
  eq(row.rungs_dropped, 2, "a number is a number");
  eq(row.booking_id, null, "a null stays null");
  eq(row.created_at, "2026-10-03T07:00:00.123456+00:00", "a timestamp keeps its microseconds");
  let threw = "";
  try {
    decodeRow(s, cells.slice(1));
  } catch (e) {
    threw = String(e);
  }
  assert(threw.includes("expected"), "a row with the wrong column count is refused, not misaligned");
  threw = "";
  try {
    decodeRow(s, cells.map((c, i) => (s.cols[i]!.type === "number" ? "lots" : c)));
  } catch (e) {
    threw = String(e);
  }
  assert(threw.includes("is not a number"), "an unreadable number is refused, not written as NaN");
}

// --- the plan: never newer, never redacted -----------------------------------------
{
  const s = spec("bookings");
  const wh = (id: string, updated_at: string) => ({ id, updated_at, status: "confirmed" });
  const current = new Map<string, CurrentRow>([
    ["older", { updated_at: "2026-10-03T07:00:00Z", redacted: false }],
    ["newer", { updated_at: "2026-10-03T09:00:00Z", redacted: false }],
    ["same", { updated_at: "2026-10-03T08:00:00Z", redacted: false }],
    ["redacted", { updated_at: "2026-10-03T07:00:00Z", redacted: true }],
    ["unreadable", { updated_at: "not a time", redacted: false }],
  ]);
  const warehouse = ["missing", "older", "newer", "same", "redacted", "unreadable"].map((id) => wh(id, "2026-10-03T08:00:00Z"));
  const plan = planTable(s, warehouse, current);
  eq(plan.insert.map((r) => r.id), ["missing"], "a booking the restore lost is written back");
  eq(plan.update.map((r) => r.id), ["older"], "a booking Supabase holds an older copy of is brought forward");
  eq(plan.keptNewer, ["newer", "same", "unreadable"], "a newer, equal or unreadable live row is never written over");
  eq(plan.keptRedacted, ["redacted"], "a redacted row is never un-redacted from the warehouse");

  const events = planTable(spec("booking_events"), [{ id: "e1", created_at: "x" }, { id: "e2", created_at: "x" }], new Map([["e1", { updated_at: null, redacted: false }]]));
  eq(events.insert.map((r) => r.id), ["e2"], "an append only row is written only when absent");
  eq(events.keptNewer, ["e1"], "and left alone when it is there");

  const lines = describePlan([plan], false);
  assert(lines[0]!.startsWith("bookings: would write 1 missing and 1 older rows"), "a dry run says what it WOULD write");
  assert(describePlan([plan], true)[0]!.includes("wrote"), "an applied run says what it wrote");
}

// --- the write gate -------------------------------------------------------------------
{
  const url = "https://abcd.supabase.co";
  eq(writeGate({}, url), { apply: false }, "dry run is the default");
  eq(writeGate({ APPLY: "true" }, url), { apply: false }, "only APPLY=1 applies");
  assert("refused" in writeGate({ APPLY: "1" }, url), "APPLY=1 alone is refused: the target must be confirmed");
  assert("refused" in writeGate({ APPLY: "1", RESTORE_CONFIRM_HOST: "drukfvgaynzrralbzkzj.supabase.co" }, url), "a confirmation naming another host is refused");
  assert("refused" in writeGate({ APPLY: "1", RESTORE_CONFIRM_HOST: "x" }, undefined), "no target URL is refused");
  eq(writeGate({ APPLY: "1", RESTORE_CONFIRM_HOST: "abcd.supabase.co" }, url), { apply: true, host: "abcd.supabase.co" }, "a confirmed host is written to");
}

finish();
