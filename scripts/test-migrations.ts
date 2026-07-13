// Migration hygiene: files must be NNNN_name.sql, numbered sequentially from
// 0001 with no gaps or duplicates (duplicate/misnumbered files break db push),
// and every table created must enable RLS (deny-all to API clients) or be
// explicitly marked `-- rls-exempt: <table>`. Slate's whole security model is
// RLS-default-deny + service-role on the server; a table without RLS leaks to
// the anon/publishable client (this guard exists because 0011/0012 did).
// Run: node --experimental-strip-types scripts/test-migrations.ts
import { readdirSync, readFileSync } from "node:fs";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else console.log("ok:", msg);
}

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
const created = new Set(
  [...sql.matchAll(/create table (?:if not exists )?([a-z_]+)/g)].map((m) => m[1]),
);
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

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
