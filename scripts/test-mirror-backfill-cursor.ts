// Repo invariant (#1231): a backfill into a mirrored table that the Snowflake
// export can never see.
//
// The bug class. The export walks each mirrored table on a STRICTLY FORWARD keyset
// over that table's watermark (`src/lib/snowflake/export.ts` fetchBatch, position
// in `export_cursor`). A row committed with a watermark EARLIER than the cursor is
// never fetched again, so it is invisible to the mirror forever. On 2026-08-03 a
// 269 row OOO audit backfill landed carrying its real historical dates while the
// cursor was already at 2026-07-31: 251 rows were silently skipped, the only
// symptom was a drift page hours later, and the fix was a manual cursor rewind.
//
// A backfill or correction is EXACTLY when someone writes rows with old
// timestamps, so this will recur. This guard catches it at authoring time, in the
// two places such a write lives in the repo: a migration and a one-off script.
//
// What counts as dangerous: a write to a mirrored table that SUPPLIES that table's
// watermark column (`insert into audit_log (..., created_at)`, `update bookings set
// updated_at = ...`). A write that lets the watermark default to now() lands ahead
// of the cursor and exports normally, so it is deliberately not flagged.
//
// Out of scope, deliberately:
//   - DML inside a `$tag$ ... $tag$` function body. That runs at write time with a
//     current watermark, which is the normal path, not a backfill.
//   - `src/` application code, for the same reason: a runtime write is current by
//     definition, and flagging it would be pure noise.
//   - ad-hoc SQL run by hand against prod, which is where the 2026-08-03 incident
//     actually came from and which no repo scan can see. That path is covered
//     DETECTIVELY by the behind-the-watermark reading in the 6h reconcile lane
//     (`reconcile-core.ts`), and by the rule in docs/migrations-runbook.md.
//
// Compliant when the same file also touches `export_cursor` (the rewind that makes
// the rows reachable) or carries an `export-cursor-ok:` opt-out on, or in the
// comment block directly above, the write.
//
// The scan logic lives in scripts/lib/scan-mirror-backfill.ts so it is
// unit-testable. This file exercises it against synthetic fixtures (a positive
// control proving the detector flags the bad shape, so it cannot rot into a
// no-op), against a REAL migration (clean now, and a mutated copy MUST be caught),
// and finally over the whole scan surface (must be clean).
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-mirror-backfill-cursor.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MIRROR_TABLES } from "../src/lib/snowflake/export-core.ts";
import { scanMirrorBackfill } from "./lib/scan-mirror-backfill.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const HERE = import.meta.dirname; // scripts/
const ROOT = join(HERE, "..");
const SPECS = MIRROR_TABLES.map((t) => ({ table: t.table, watermark: t.watermark }));

// --- the table list is DERIVED, never retyped ---------------------------------
assert(SPECS.length === 6, `the guard reads all ${SPECS.length} mirrored tables from MIRROR_TABLES`);
assert(
  SPECS.some((s) => s.table === "audit_log" && s.watermark === "created_at"),
  "audit_log is watched on created_at (the table the 2026-08-03 backfill stranded)",
);

// --- positive control: fixtures the detector must flag, and must not ----------
// These are SYNTHETIC, written to the shape of the incident rather than copied
// from it: the statement that caused it was run by hand and never committed.
interface Fixture {
  name: string;
  file: string;
  flagged: boolean;
  src: string;
}

const FIXTURES: Fixture[] = [
  {
    name: "migration inserts audit rows carrying historical created_at",
    file: "supabase/migrations/9001_backfill.sql",
    flagged: true,
    src: `insert into audit_log (org_id, actor_id, action, target_id, created_at)\nselect r.org_id, r.actor_id, 'ooo.approved', r.id, r.approved_at\nfrom ooo_requests r;`,
  },
  {
    name: "migration rewrites a booking watermark to an old value",
    file: "supabase/migrations/9002_fix.sql",
    flagged: true,
    src: `update bookings set updated_at = created_at where updated_at is null;`,
  },
  {
    name: "schema-qualified insert is the same write",
    file: "supabase/migrations/9003_qualified.sql",
    flagged: true,
    src: `insert into public.booking_events (id, booking_id, action, created_at)\nvalues (gen_random_uuid(), '1', 'book', '2026-06-01T00:00:00Z');`,
  },
  {
    name: "insert that lets the watermark default to now()",
    file: "supabase/migrations/9004_safe.sql",
    flagged: false,
    src: `insert into audit_log (org_id, actor_id, action, target_id)\nvalues (null, null, 'system.seed', null);`,
  },
  {
    name: "write to a table that is not mirrored",
    file: "supabase/migrations/9005_other.sql",
    flagged: false,
    src: `insert into ooo_requests (id, created_at) values (gen_random_uuid(), '2026-06-01T00:00:00Z');`,
  },
  {
    name: "backfill that rewinds the cursor in the same migration",
    file: "supabase/migrations/9006_with_rewind.sql",
    flagged: false,
    src:
      `insert into audit_log (org_id, action, created_at)\nselect org_id, 'ooo.approved', approved_at from ooo_requests;\n\n` +
      `update export_cursor set last_ts = '2026-01-01T00:00:00Z', last_id = null where key = 'audit_log';`,
  },
  {
    name: "backfill carrying the opt-out",
    file: "supabase/migrations/9007_optout.sql",
    flagged: false,
    src:
      `-- export-cursor-ok: created_at is set to now() by the expression below, so the\n` +
      `-- rows land ahead of the cursor and export on the next tick.\n` +
      `insert into audit_log (org_id, action, created_at) select org_id, 'x', now() from orgs;`,
  },
  {
    name: "the same write inside a function body (runs at write time)",
    file: "supabase/migrations/9008_function.sql",
    flagged: false,
    src:
      `create or replace function log_it() returns void language plpgsql as $$\nbegin\n` +
      `  insert into audit_log (org_id, action, created_at) values (null, 'x', now());\nend;\n$$;`,
  },
  {
    name: "a mentioned-in-a-comment write is not a write",
    file: "supabase/migrations/9009_comment.sql",
    flagged: false,
    src: `-- We used to insert into audit_log (org_id, action, created_at) here.\nselect 1;`,
  },
  {
    name: "script backfilling a mirrored table with an explicit watermark",
    file: "scripts/backfill-audit.ts",
    flagged: true,
    src: `await db.from("audit_log").insert(rows.map((r) => ({ action: r.action, created_at: r.happened_at })));`,
  },
  {
    name: "script writing a mirrored table without touching the watermark",
    file: "scripts/seed-something.ts",
    flagged: false,
    src: `await db.from("audit_log").insert({ action: "system.seed", org_id: org.id });`,
  },
  {
    name: "script READING a mirrored table's watermark",
    file: "scripts/report.ts",
    flagged: false,
    src: `const { data } = await db.from("audit_log").select("id, created_at").order("created_at");`,
  },
];

for (const f of FIXTURES) {
  const findings = scanMirrorBackfill(f.src, f.file, SPECS);
  assert(
    f.flagged ? findings.length > 0 : findings.length === 0,
    `${f.flagged ? "flags" : "allows"}: ${f.name}${f.flagged || findings.length === 0 ? "" : ` (got ${findings[0].table} on line ${findings[0].line})`}`,
  );
}

// A flagged finding has to be actionable: it names the table, the watermark and
// the line, or the reader cannot find the write.
{
  const [finding] = scanMirrorBackfill(FIXTURES[0].src, FIXTURES[0].file, SPECS);
  eq(finding.table, "audit_log", "the finding names the mirrored table");
  eq(finding.watermark, "created_at", "the finding names the watermark column supplied");
  eq(finding.line, 1, "the finding points at the line the write starts on");
}

// --- control against the REAL write that caused this ---------------------------
// scripts/sql/backfill-ooo-audit-1220.sql is the statement from the incident, as
// run. It is clean only because it now carries the cursor rewind; strip that and
// the detector MUST catch it, which is this guard proving itself against real text
// rather than against a shape someone imagined (L48). It was in fact found by
// running this guard: the file had no rewind.
{
  const real = "scripts/sql/backfill-ooo-audit-1220.sql";
  const src = readFileSync(join(ROOT, real), "utf8");
  assert(
    /insert into audit_log \([^)]*created_at/.test(src),
    "the real backfill still inserts audit_log rows carrying created_at (the shape this guard exists for)",
  );
  eq(scanMirrorBackfill(src, real, SPECS).length, 0, `${real} is clean (it rewinds export_cursor)`);

  const withoutRewind = src.replace(/update export_cursor[\s\S]*?;\n/, "");
  // The prose above the statement still MENTIONS export_cursor, which is the
  // point: the detector reads the stripped SQL, so a comment is not a rewind.
  assert(
    !/update export_cursor/.test(withoutRewind),
    "the mutation really removed the rewind statement (otherwise the control below proves nothing)",
  );
  const caught = scanMirrorBackfill(withoutRewind, real, SPECS);
  assert(caught.length > 0, "the real backfill WITHOUT its rewind is caught");
  eq(caught[0].table, "audit_log", "and it names audit_log");
}

// --- control that the function-body exclusion is a distinction, not a blind spot
// 0092 writes to audit_log inside a plpgsql function body, so it is clean. Hoist
// that same statement to the top level with a historical timestamp and the
// detector MUST catch it.
{
  const real = "supabase/migrations/0092_erase_booking_pii.sql";
  const src = readFileSync(join(ROOT, real), "utf8");
  assert(src.includes("insert into audit_log"), "the real control file still contains the audit_log write it is chosen for");
  eq(scanMirrorBackfill(src, real, SPECS).length, 0, `${real} is clean (its write is inside a function body)`);

  const hoisted = `insert into audit_log (org_id, actor_id, action, target_id, created_at)\nselect org_id, actor_id, action, target_id, '2026-06-16T00:00:00Z' from audit_log;\n${src}`;
  assert(
    scanMirrorBackfill(hoisted, real, SPECS).length > 0,
    "the same write hoisted OUT of the function body is caught (the body exclusion is not a blind spot)",
  );
}

// --- the whole surface must be clean -----------------------------------------
// This guard's own files carry the bad shape on purpose, as fixtures.
const SELF = ["scripts/test-mirror-backfill-cursor.ts", "scripts/lib/scan-mirror-backfill.ts"];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(rel, out);
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".sql")) out.push(rel);
  }
  return out;
}

const surface = [...walk("supabase/migrations"), ...walk("scripts")].filter((f) => !SELF.includes(f));
assert(surface.length > 100, `the scan surface is populated (${surface.length} files)`);

for (const rel of surface) {
  const findings = scanMirrorBackfill(readFileSync(join(ROOT, rel), "utf8"), rel, SPECS);
  for (const f of findings) {
    assert(
      false,
      `${f.file}:${f.line} writes ${f.table}.${f.watermark} directly, so those rows land behind the export ` +
        `cursor and the Snowflake mirror will never see them. Rewind export_cursor for ${f.table} in the same ` +
        `change (docs/migrations-runbook.md), or add "export-cursor-ok: <why>" above the write`,
    );
  }
}
assert(true, `${surface.length} migrations and scripts carry no unreachable mirrored-table write`);

finish();
