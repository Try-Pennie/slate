// Repo invariant (#822): guard against a capped single-page supabase-js list
// read on a GROWTH table in production `src/`.
//
// The bug class (shipped once as #35 / #166, cost months): a list read returns
// at most PostgREST's 1000-row page, and code treats the truncated result as the
// whole set. It left the availability cache under-populated and the booker
// over-offered slots. #730 (PR #821) added a static guard for the raw
// `fetch(...select=...)` shape in the loadtest + smoke scripts, and #828 (PR
// #831) paginated the four production reads the audit found. Nothing stops a NEW
// capped read from shipping in src/, which uses the supabase-js
// `.from("t").select(...)` shape the fetch detector cannot see. This guard
// closes that.
//
// TABLE-AWARE (Dan, 2026-07-16): only reads on a GROWTH table (row count scales
// with booking volume or time) are flagged. Roster-bounded config / singleton /
// lock tables (users, buckets, ... ~100-200 rows by the design target) are safe
// by construction and never flagged, so the guard stays focused instead of
// churning ~55 annotations. A table NOT on the safe list defaults to FLAGGED
// (fail-loud): a brand-new table must be justified, not silently unguarded.
//
// A growth-table SELECT is cap-safe when its chain carries ONE of:
//   - `.single()` / `.maybeSingle()`         (<= 1 row)
//   - `.limit(...)` / `.range(...)`          (an explicit bounded / paginated page)
//   - `.csv()`                               (streamed, not row-array)
//   - `{ ..., head: true }`                  (a server-side count, no rows)
//   - `.eq("id", ...)` / `.in("id", ...)`    (primary-key lookup, bounded set)
//   - a `// cap-safe: <reason>` opt-out on / above the `.from(` line.
// A write (`.insert` / `.update` / `.delete` / `.upsert` reached before any
// `.select`) is not a read and is never flagged. Reused query builders
// (`let q = db.from(...).select(...); ...; await q.range(...)`) are handled: the
// cap-safe signal applied on a later line still counts.
//
// The scan logic lives in scripts/lib/scan-src-capped-reads.ts so it is
// unit-testable. This file is the positive control (proves the detector flags
// the bad pattern and can't rot into a no-op), a real-file mutation control, and
// the whole-`src/` invariant.
// Run: node --experimental-strip-types scripts/test-src-capped-reads.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scanSrcCappedReads } from "./lib/scan-src-capped-reads.ts";
import { assert, finish } from "./lib/harness.ts";

const HERE = import.meta.dirname; // scripts/
const ROOT = join(HERE, "..");

// --- positive control: flag the bad pattern, allow the safe ones --------------

interface Fixture {
  name: string;
  flagged: boolean;
  src: string;
}

const FIXTURES: Fixture[] = [
  // FLAGGED: growth-table SELECTs with no bounding signal ----------------------
  {
    name: "window-bounded growth read, no limit, consumed as .length",
    flagged: true,
    src: `const { data } = await db.from("bookings").select("id").eq("assigned_user_id", u).in("status", ["confirmed"]).gte("starts_at", a).lt("starts_at", b);\nif ((data ?? []).length === 0) return;`,
  },
  {
    name: "all-time per-agent growth read consumed via map/filter",
    flagged: true,
    src: `const { data } = await supabaseAdmin().from("bookings").select("gcal_event_id").eq("assigned_user_id", u).in("status", ["confirmed"]);\nreturn new Set((data ?? []).map((r) => r.g).filter(Boolean));`,
  },
  {
    name: "growth read passed straight into a helper (no local aggregate)",
    flagged: true,
    src: `const share = fromResult(await supabaseAdmin().from("bookings").select("assigned_user_id, starts_at").eq("bucket_id", b).gte("starts_at", a));`,
  },
  {
    name: "growth read on busy_blocks, eq(non-id) only",
    flagged: true,
    src: `const { data } = await db.from("busy_blocks").select("gcal_event_id").eq("user_id", userId).eq("source", "gcal");\nconst blocks = (data ?? []).map((b) => b.gcal_event_id);`,
  },
  {
    name: "growth read on a brand-new (unknown) table defaults to flagged",
    flagged: true,
    src: `const { data } = await db.from("some_new_ledger").select("id").eq("kind", "x");\nreturn (data ?? []).length;`,
  },
  {
    name: "webhook_deliveries unbounded select",
    flagged: true,
    src: `const { data } = await db.from("webhook_deliveries").select("id").eq("status", "failed");\nreturn (data ?? []).length;`,
  },

  // NOT FLAGGED: cap-safe signals ---------------------------------------------
  {
    name: "range() paginator page",
    flagged: false,
    src: `db.from("bookings").select("assigned_user_id, starts_at").in("assigned_user_id", ids).gte("starts_at", a).range(pageFrom, pageTo);`,
  },
  {
    name: "single() by id",
    flagged: false,
    src: `const { data } = await db.from("bookings").select("*").eq("id", id).single();`,
  },
  {
    name: "maybeSingle()",
    flagged: false,
    src: `const { data } = await db.from("busy_blocks").select("id").eq("booking_id", bId).maybeSingle();`,
  },
  {
    name: "limit(20)",
    flagged: false,
    src: `const { data } = await supabaseAdmin().from("bookings").select("*").in("status", active).limit(20);\nif ((data ?? []).length) x();`,
  },
  {
    name: 'in("id", ids) primary-key membership',
    flagged: false,
    src: `const { data: bks } = await db.from("bookings").select("id, gcal_event_id").in("id", ids);`,
  },
  {
    name: 'eq("id", ...) primary-key lookup without single()',
    flagged: false,
    src: `const { data } = await db.from("bookings").select("id, status").eq("id", bookingId);\nconst row = (data ?? [])[0];`,
  },
  {
    name: "head:true server-side count",
    flagged: false,
    src: `const { count } = await db.from("bookings").select("id", { count: "exact", head: true }).eq("bucket_id", b);\nif (count) x();`,
  },
  {
    name: "cap-safe opt-out on the line above",
    flagged: false,
    src: `// cap-safe: one agent's collision-window bookings, <= a handful\nconst { data } = await db.from("bookings").select("id").eq("assigned_user_id", u).gte("starts_at", a);\nif ((data ?? []).length === 0) return;`,
  },

  // NOT FLAGGED: writes (no select before the mutator) -------------------------
  {
    name: "insert()",
    flagged: false,
    src: `await supabaseAdmin().from("audit_log").insert({ action: "x" });`,
  },
  {
    name: "insert().select().single() (write returning one row)",
    flagged: false,
    src: `const { data } = await db().from("busy_blocks").insert(block).select("id").single();`,
  },
  {
    name: "update()",
    flagged: false,
    src: `await db().from("ooo_requests").update(patch).eq("id", id);`,
  },
  {
    name: "delete()",
    flagged: false,
    src: `await db.from("availability_rules").delete().eq("schedule_id", scheduleId);`,
  },

  // NOT FLAGGED: roster-bounded / config / singleton tables --------------------
  {
    name: "users org-wide select consumed as .length (roster-bounded)",
    flagged: false,
    src: `const { data } = await db.from("users").select("id, name").eq("org_id", o);\nif ((data ?? []).length === 0) fail();`,
  },
  {
    name: "bucket_members whole-table select (roster-bounded)",
    flagged: false,
    src: `db.from("bucket_members").select("bucket_id, user_id").eq("active", true);`,
  },
  {
    name: "buckets select",
    flagged: false,
    src: `const { data } = await db.from("buckets").select("*").eq("org_id", o);\nreturn (data ?? []).length;`,
  },

  // NOT FLAGGED: reused query builder with the bound applied on a later line ----
  {
    name: "reused builder, range() applied on a later statement",
    flagged: false,
    src: `let q = supabaseAdmin().from("bookings").select("*");\nif (filter.status) q = q.eq("status", filter.status);\nif (filter.bucketId) q = q.eq("bucket_id", filter.bucketId);\nconst { data } = await q.order("id", { ascending: true }).range(offset, offset + limit - 1);\nconst rows = (data ?? []).length;`,
  },
  {
    name: "reused builder, limit() applied on a later statement",
    flagged: false,
    src: `let q = db.from("ooo_requests").select("*");\nif (org) q = q.eq("org_id", org);\nconst { data } = await q.limit(500);\nreturn (data ?? []).length;`,
  },
];

for (const f of FIXTURES) {
  const found = scanSrcCappedReads(f.src, "fixture").length > 0;
  assert(found === f.flagged, `${f.flagged ? "flags" : "allows"}: ${f.name}`);
}

// --- real-file mutation control: a paginated read stripped of .range is caught -
// availability/service.ts pages busy_blocks + bookings via selectAllPages() with
// .range(); removing the .range() turns them into capped single-page reads and
// the guard MUST notice. Proves it verifies something against the real code.
const availPath = join(ROOT, "src", "lib", "availability", "service.ts");
const availSrc = readFileSync(availPath, "utf8");
assert(
  scanSrcCappedReads(availSrc, availPath).length === 0,
  "the real availability/service.ts is clean",
);
const mutated = availSrc.replace(/\n\s*\.range\(pageFrom, pageTo\)/g, "");
assert(
  scanSrcCappedReads(mutated, availPath).length > 0,
  "positive control: stripping .range() from the paginated reads is caught",
);

// --- repo invariant: all of src/ is clean -------------------------------------
import { readdirSync } from "node:fs";
function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...tsxFiles(p));
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

const surface = tsxFiles(join(ROOT, "src"));
assert(surface.length > 0, `found src files to scan (got ${surface.length})`);

let siteCount = 0;
for (const file of surface) {
  const src = readFileSync(file, "utf8");
  const findings = scanSrcCappedReads(src, file.slice(ROOT.length + 1));
  siteCount += findings.length;
  for (const fnd of findings) {
    assert(
      false,
      `${fnd.file}:${fnd.line} capped single-page read on growth table "${fnd.table}"; ` +
        `paginate (selectAllPages, src/lib/supabase/paginate.ts), add .limit()/.range(), ` +
        `use a head:true count, or annotate // cap-safe: <reason>`,
    );
  }
}
if (siteCount === 0) {
  console.log(`ok: no capped single-page growth-table reads across ${surface.length} src files`);
}

finish();
