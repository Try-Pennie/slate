// Write the mirrored tables back from Snowflake after a database restore (#3075).
//
// docs/dr-runbook.md section 4. A restore rolls Supabase back to the restore point,
// and every booking, booking event, outbox row, routing decision, webhook delivery and
// audit entry written since is gone from it. The export lane copied each of them to
// the warehouse within about thirty minutes of the write, so this reads every mirrored
// row whose watermark is at or after the restore point and writes back the ones
// Supabase is missing or holds an older copy of. The rules (never over a newer row,
// never over a redacted one, parents first) live in scripts/lib/snowflake-restore.ts,
// pinned offline by scripts/test-snowflake-restore.ts.
//
// DRY RUN BY DEFAULT: it reads both sides and prints, per table, what it WOULD write.
// Writing needs APPLY=1 AND RESTORE_CONFIRM_HOST naming the Supabase host the write
// goes to, so a shell still pointing somewhere else cannot be written to by accident.
// Re-running is safe: every write is an upsert on id of a row this run judged older.
//
//   RESTORE_POINT=2026-10-03T06:00:00Z pnpm restore:from-snowflake
//   RESTORE_POINT=... APPLY=1 RESTORE_CONFIRM_HOST=<project>.supabase.co pnpm restore:from-snowflake
//
// Needs the Snowflake key (SNOWFLAKE_PRIVATE_KEY, SNOWFLAKE_ACCOUNT, as the Worker
// holds them) and the Supabase URL and secret key of the RESTORED project, from the
// environment or .env.local / .dev.vars. Not named test-*.ts: it needs live systems,
// and that glob is the offline suite.
//
// Never a pass on nothing: a read it cannot make exits non-zero and says which.
import { loadEnvFiles } from "./smoke-env.ts";

loadEnvFiles([".env.local", ".dev.vars"]);

const { supabaseAdmin } = await import("@/lib/supabase/admin");
const { readSnowflakeConfig } = await import("@/lib/snowflake/config");
const { executeStatement } = await import("@/lib/snowflake/client");
const { MIRROR_TABLES } = await import("@/lib/snowflake/export-core");
const {
  buildPageQuery,
  decodeRow,
  describePlan,
  PAGE_SIZE,
  parseRestorePoint,
  planTable,
  REDACTION_MARKER,
  RESTORE_ORDER,
  UNMIRRORED_COLUMNS,
  writeGate,
} = await import("./lib/snowflake-restore.ts");
type Row = import("./lib/snowflake-restore.ts").Row;
type CurrentRow = import("./lib/snowflake-restore.ts").CurrentRow;
type TablePlan = import("./lib/snowflake-restore.ts").TablePlan;

function fail(code: string, why: string): never {
  console.error(`\nFAILED (${code}): ${why}`);
  process.exit(1);
}

const point = parseRestorePoint(process.env.RESTORE_POINT, Date.now());
if (!point.ok) fail("restore-point", point.reason);

const gate = writeGate(process.env, process.env.NEXT_PUBLIC_SUPABASE_URL);
if ("refused" in gate) fail("not-confirmed", gate.refused);
const apply = gate.apply;

let snowflake: ReturnType<typeof readSnowflakeConfig>;
try {
  snowflake = readSnowflakeConfig();
} catch (e) {
  fail("snowflake-config", String(e));
}
if (!snowflake) fail("snowflake-config", "SNOWFLAKE_PRIVATE_KEY is not set here, so the warehouse cannot be read");

const db = supabaseAdmin();
/** Ids per Supabase read: a PostgREST `in()` list is safe at 200 and refused at 400. */
const ID_CHUNK = 200;
/** Rows per Supabase write. */
const WRITE_CHUNK = 200;

async function readWarehouse(table: string): Promise<Row[]> {
  const spec = MIRROR_TABLES.find((t) => t.table === table)!;
  const rows: Row[] = [];
  let after: { ts: string; id: string } | null = null;
  for (;;) {
    const q = buildPageQuery(spec, point.iso, after);
    let res;
    try {
      res = await executeStatement(snowflake!, q.sql, q.bindings);
    } catch (e) {
      fail("snowflake-read", `${table}: ${String(e)}`);
    }
    const data = res.data ?? [];
    const declared = res.resultSetMetaData?.numRows;
    // A page whose declared size differs from what arrived is a short read; acting on
    // it would treat rows that exist as rows that do not (L211).
    if (declared !== undefined && declared !== data.length) {
      fail("snowflake-short-read", `${table}: Snowflake declared ${declared} rows and returned ${data.length}`);
    }
    const page = data.map((cells) => decodeRow(spec, cells));
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
    const last = page[page.length - 1]!;
    after = { ts: String(last[spec.watermark]), id: String(last.id) };
  }
}

async function readCurrent(table: string, ids: string[]): Promise<Map<string, CurrentRow>> {
  const spec = MIRROR_TABLES.find((t) => t.table === table)!;
  const marker = REDACTION_MARKER[table];
  const cols = ["id", spec.watermark === "updated_at" ? "updated_at" : null, marker ?? null].filter(Boolean).join(", ");
  const out = new Map<string, CurrentRow>();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    // cap-safe: a primary key lookup of at most ID_CHUNK ids.
    const { data, error } = await db.from(table as never).select(cols).in("id", chunk);
    if (error) fail("supabase-read", `${table}: ${error.message}`);
    for (const r of (data ?? []) as unknown as Record<string, unknown>[]) {
      const flag = marker ? r[marker] : null;
      out.set(String(r.id), {
        updated_at: typeof r.updated_at === "string" ? r.updated_at : null,
        redacted: marker === "payload_erased" ? flag === true : flag !== null && flag !== undefined,
      });
    }
  }
  return out;
}

async function write(plan: TablePlan): Promise<void> {
  const rows = [...plan.insert, ...plan.update];
  for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
    const chunk = rows.slice(i, i + WRITE_CHUNK);
    // export-cursor-ok: these rows are already in the warehouse, written there by the
    // export lane; the restore copies them BACK, so nothing behind the cursor is missing.
    const { error } = await db.from(plan.table as never).upsert(chunk as never, { onConflict: "id" });
    if (error) {
      fail(
        "supabase-write",
        `${plan.table}: rows ${i + 1} to ${i + chunk.length} were refused (${error.message}). ` +
          `Everything before them is written; fix the cause and run again, which skips what is already current.`,
      );
    }
  }
}

console.log(`Restore point ${point.iso}. ${apply ? `WRITING to ${gate.host}.` : "Dry run: nothing is written."}`);
const plans: TablePlan[] = [];
for (const table of RESTORE_ORDER) {
  const spec = MIRROR_TABLES.find((t) => t.table === table)!;
  const warehouse = await readWarehouse(table);
  const current = await readCurrent(table, warehouse.map((r) => String(r.id)));
  const plan = planTable(spec, warehouse, current);
  if (apply) await write(plan);
  plans.push(plan);
}

for (const line of describePlan(plans, apply)) console.log(line);
console.log("\nNot carried by the mirror, so not restored:");
for (const [table, cols] of Object.entries(UNMIRRORED_COLUMNS)) {
  for (const [col, effect] of Object.entries(cols)) console.log(`  ${table}.${col}: ${effect}`);
}
const seen = plans.reduce((n, p) => n + p.insert.length + p.update.length + p.keptNewer.length + p.keptRedacted.length, 0);
console.log(`\n${seen} warehouse rows at or after the restore point were judged.`);
if (seen === 0) {
  fail(
    "nothing-found",
    "the warehouse holds no mirrored row at or after the restore point. Either nothing was written in the gap, or the point is wrong; check it before believing the first.",
  );
}
