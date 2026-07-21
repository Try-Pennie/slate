// Migration hygiene: files must be NNNN_name.sql, numbered sequentially from
// 0001 with no gaps or duplicates (duplicate/misnumbered files break db push),
// and every table created must enable RLS (deny-all to API clients) or be
// explicitly marked `-- rls-exempt: <table>`. Slate's whole security model is
// RLS-default-deny + service-role on the server; a table without RLS leaks to
// the anon/publishable client (this guard exists because 0011/0012 did).
// Run: node --experimental-strip-types scripts/test-migrations.ts
import { readdirSync, readFileSync } from "node:fs";
import { SHIPPED_MIGRATION_VERSION } from "../src/lib/db/migration-version.ts";
import {
  parseDeclaredTables,
  parseMigrationConstraints,
  hasUpsertTarget,
} from "./lib/parse-migration-constraints.ts";
import { assert, finish } from "./lib/harness.ts";

const files = readdirSync("supabase/migrations")
  .filter((f) => f.endsWith(".sql"))
  .sort();

assert(files.length > 0, "migrations directory has .sql files");

const nums: number[] = [];
for (const f of files) {
  const m = f.match(/^(\d{4})_[a-z0-9_]+\.sql$/);
  if (!m) {
    assert(false, `"${f}" follows the NNNN_snake_case.sql convention`);
    continue;
  }
  nums.push(Number(m[1]));
}

nums.forEach((n, i) => {
  const expected = i + 1;
  assert(
    n === expected,
    `migration #${i} is ${String(expected).padStart(4, "0")} (no gaps/dupes); got ${String(n).padStart(4, "0")}`,
  );
});

// RLS coverage: scan all migrations as one corpus. Every created table must
// have RLS enabled somewhere (same or a later migration), unless exempted.
const sql = files
  .map((f) => readFileSync(`supabase/migrations/${f}`, "utf8"))
  .join("\n");
// Enumerate created tables through the shared parser (#875) so table detection
// has ONE behavior across guards. It is also stricter than the old local regex:
// case-insensitive and digit/`public.`-aware, so a `CREATE TABLE` or an
// `oauth2_tokens`-style name can't slip past this RLS-coverage check unnoticed.
const created = parseDeclaredTables(sql);
const rlsEnabled = new Set(
  [...sql.matchAll(/alter table ([a-z_]+)\s+enable row level security/g)].map((m) => m[1]),
);
const exempt = new Set(
  [...sql.matchAll(/--\s*rls-exempt:\s*([a-z_]+)/g)].map((m) => m[1]),
);
for (const table of created) {
  assert(
    rlsEnabled.has(table) || exempt.has(table),
    `table "${table}" enables RLS (or is marked "-- rls-exempt: ${table}")`,
  );
}

// #667: the retired 'create' outbox action must be dropped from the effective
// booking_outbox.action CHECK. No producer enqueues a create row: the create
// path uses booking_reservations as its durable intent (#613). The migration
// drops the original inline constraint and re-adds a named one without 'create'.
assert(
  /drop constraint (?:if exists )?booking_outbox_action_check/.test(sql),
  "booking_outbox_action_check is dropped before being redefined (#667)",
);
const outboxActionAdd = sql.match(
  /add constraint booking_outbox_action_check\s+check\s*\(\s*action in \(([^)]*)\)\s*\)/,
);
assert(
  outboxActionAdd !== null,
  "booking_outbox.action CHECK is redefined via a named constraint (#667)",
);
if (outboxActionAdd) {
  const allowed = outboxActionAdd[1];
  assert(
    !/'create'/.test(allowed),
    "redefined booking_outbox.action CHECK no longer allows 'create' (#667)",
  );
  for (const v of ["cancel", "reschedule", "reassign"]) {
    assert(
      new RegExp(`'${v}'`).test(allowed),
      `redefined booking_outbox.action CHECK allows '${v}' (#667)`,
    );
  }
}

// #770: busy_blocks(booking_id) is UNIQUE, so a duplicate slate block for one
// booking is impossible rather than merely unlikely. Both writers must therefore
// SETTLE on a conflict instead of erroring, or the constraint would convert a
// harmless race into a failed booking-path write.
{
  // move_busy_block deletes by booking_id then inserts, so it can only collide with
  // a row a concurrent reconcile sweep committed in between. The booking's own write
  // is the authority on where its block belongs, so it must win and rewrite the row.
  const fn = sql.match(/create or replace function move_busy_block[\s\S]*?\$\$;/gi)?.at(-1) ?? "";
  assert(
    /on conflict\s*\(\s*booking_id\s*\)\s*do update/i.test(fn),
    "#770: move_busy_block settles on a booking_id conflict (does not error the booking path)",
  );
  assert(
    /delete from busy_blocks where booking_id = p_booking_id/i.test(fn),
    "#770: move_busy_block still deletes the booking's prior block first (one block per booking)",
  );
}

// #759: the reassign swap must record the REPLACED event and the fact that it
// committed onto the intent row INSIDE its own transaction. Doing it as a separate
// write after the swap left a window: a crash in between lost the old event id (so
// the sweep could never clean the orphan) and, since #758, left swapped_at unset on a
// committed swap, which the sweep then reads as a LOST reassign and alerts on. The
// booking update and the intent stamp have to commit together or not at all.
{
  const fn =
    sql.match(/create or replace function reassign_booking_swap[\s\S]*?\$\$;/gi)?.at(-1) ?? "";
  assert(
    /update reassign_intents/i.test(fn),
    "#759: reassign_booking_swap records the intent inside the swap transaction",
  );
  assert(
    /swapped_at\s*=\s*now\(\)/i.test(fn),
    "#759: the swap stamps swapped_at itself, so a committed swap can never look never-adopted",
  );
  for (const col of ["prev_agent_email", "prev_gcal_event_id"]) {
    assert(
      new RegExp(`${col}\\s*=`, "i").test(fn),
      `#759: the swap records ${col} atomically (no separate write to lose in a crash)`,
    );
  }
  assert(
    /p_gcal_client_id/i.test(fn),
    "#759: the swap is told WHICH intent row to stamp, rather than assuming the event id matches",
  );

  // #789: the 6-arg overload 0069 had to leave behind (the deployed code still called
  // it mid-rollout) must not outlive that rollout. It still WORKS, and it silently does
  // NOT stamp the intent, so any caller that reached it again would quietly reinstate
  // the orphan-and-false-alert bug #759 fixed. Dead code that still runs is worse than
  // dead code that doesn't.
  assert(
    /drop function if exists reassign_booking_swap\s*\(\s*uuid\s*,\s*uuid\s*,\s*text\s*,\s*text\s*,\s*text\s*,\s*jsonb\s*\)/i.test(
      sql,
    ),
    "#789: the superseded 6-arg reassign_booking_swap is dropped (only the intent-stamping one survives)",
  );
}

// The hand-written RPC arg types in src/lib/db/schema.ts must match the function
// each migration actually defines. This guard exists because NOTHING else catches
// that drift: supabase-js does not type-check rpc() argument names against the
// Database generic (verified by passing a bogus param name through `tsc --noEmit`
// clean), so a renamed, missing, or typo'd parameter sails past the compiler and
// only fails against the live database. #759 shipped exactly that: a new
// p_gcal_client_id param that schema.ts did not declare.
//
// Compares against the LAST definition of each function, which is the one the code
// calls when a migration adds an overload.
{
  const schema = readFileSync("src/lib/db/schema.ts", "utf8");
  // Each `name: { Args: {...}; Returns: ... }` entry under Functions. Anchored on
  // `Returns:` because Args is written inline on one line for the short functions
  // and as a multi-line block for the long ones.
  const declared = new Map<string, Set<string>>();
  for (const m of schema.matchAll(/(\w+):\s*\{\s*Args:\s*\{([\s\S]*?)\};\s*Returns:/g)) {
    const params = new Set([...m[2].matchAll(/(p_\w+)\s*\??:/g)].map((p) => p[1]));
    if (params.size > 0) declared.set(m[1], params);
  }
  assert(declared.size > 0, "schema.ts RPC arg types are parseable (the guard can see them)");

  for (const [fn, args] of declared) {
    const def = sql
      .match(new RegExp(`create or replace function ${fn}\\s*\\(([\\s\\S]*?)\\)\\s*returns`, "gi"))
      ?.at(-1);
    if (!def) {
      assert(false, `schema.ts declares rpc "${fn}", which some migration defines`);
      continue;
    }
    const actual = new Set([...def.matchAll(/(p_\w+)\s+\w/g)].map((p) => p[1]));
    const missing = [...actual].filter((p) => !args.has(p));
    const extra = [...args].filter((p) => !actual.has(p));
    assert(
      missing.length === 0 && extra.length === 0,
      `schema.ts args for "${fn}" match its SQL definition` +
        (missing.length ? ` (missing: ${missing.join(", ")})` : "") +
        (extra.length ? ` (not in SQL: ${extra.join(", ")})` : ""),
    );
  }
}

// #876: webhook fan-out (emitWebhook) POSTs to EVERY active endpoint matching
// (org_id, event), and the exactly-once dedupe is scoped per endpoint_id. So two
// endpoint rows sharing a URL (different ids) each fire, double-delivering every
// booking event to that URL (e.g. two Regal alerts, cf. #492). The admin UI is
// singleton-per-org so it can't create a duplicate, but nothing at the DB level
// forbids one from a seed script, manual SQL, or a later multi-endpoint feature.
// A full (non-partial) unique index on (org_id, url) blocks the duplicate at the
// source while still allowing an org's several DISTINCT targets (Regal + Cadence).
{
  const constraints = parseMigrationConstraints(sql);
  assert(
    hasUpsertTarget(constraints, "webhook_endpoints", "org_id,url"),
    "#876: webhook_endpoints(org_id, url) is UNIQUE, so the same destination URL " +
      "cannot be configured twice for an org and double-send to Regal",
  );
}

// #816: the single-value applied_migration_version() (0071) was superseded by the
// set-returning applied_migration_versions() (0072, #814). 0072 deliberately left
// the old one in place so the pre-#814 code (still live during the migrate-before-
// merge window) kept reading it. Now that #814 has deployed, nothing reads it
// (src/lib/monitor/migration-drift.ts calls only the plural), so it is dead SQL and
// must be dropped. The `\(` anchor keeps this from matching the plural, whose next
// char is `s`, not `(`.
assert(
  /drop function if exists applied_migration_version\s*\(\s*\)/i.test(sql),
  "#816: the orphaned single-value applied_migration_version() is dropped (dead since #814)",
);

// #624: resolveBucketByCode looks a bucket up by code alone (no org filter), so
// the single-org assumption that codes are globally unique must be ENFORCED in
// the schema, not just assumed. A global unique index on buckets(code) makes a
// second org reusing a code fail loud at config time instead of hard-failing
// every embed for that code on the hot path. This guard fails if that index is
// ever dropped. The composite `unique (org_id, code)` does NOT satisfy it (that
// is a table constraint, not a `create unique index ... on buckets(code)`).
assert(
  /create\s+unique\s+index\s+\w+\s+on\s+buckets\s*\(\s*code\s*\)/i.test(sql),
  "#624: a global unique index on buckets(code) enforces single-org code uniqueness",
);

// The deployed build has no filesystem, so the prod lag alert (#516) compares the
// live DB against a constant baked into the bundle. That constant is only as good
// as this guard: adding a migration without bumping it would make prod look in
// sync while the schema it needs is unapplied, which is the exact false-confidence
// failure the alert exists to catch.
{
  const highest = String(Math.max(...nums)).padStart(4, "0");
  assert(
    SHIPPED_MIGRATION_VERSION === highest,
    `SHIPPED_MIGRATION_VERSION (src/lib/db/migration-version.ts) is the highest migration ` +
      `(${highest}); got ${SHIPPED_MIGRATION_VERSION}. Bump it in the same commit as the migration.`,
  );
}

finish();
