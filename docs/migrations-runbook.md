# Applying a database migration

Deploys do **not** apply Supabase migrations. A Cloudflare/OpenNext deploy ships
code only; the schema it expects has to be pushed to the database separately. If
code goes live ahead of its schema, the feature errors on the missing table,
column, or function (this has bitten with 0032 #214, 0037 #276, 0053 #439, 0055
#516). Applying the migration is therefore a deliberate human step, run through
`supabase db push` at or before the matching code merges.

This runbook is the exact, repeatable sequence. Follow it for every schema change
rather than reasoning it out per PR.

## The safety nets (so a forgotten apply cannot ship silently)

1. **Merge gate.** The CI `migration-drift` job runs `supabase migration list` and
   fails the PR while any committed migration is unapplied on the remote DB. It
   fail-closes if its secrets are missing (#766), so it cannot pass while checking
   nothing.
2. **Deploy gate.** The `deploy` job `needs: [ci, migration-drift]` (#482), so a
   push to main will not deploy code while a migration is unapplied.
3. **Prod monitor.** The monitor cron pages (`migration_version_lag`) if the
   deployed code ships a migration the live DB has not applied, including one
   missing from the middle of the sequence (#516, #814).
4. **Version guard.** `scripts/test-migrations.ts` fails on pre-push and in CI
   unless `SHIPPED_MIGRATION_VERSION` equals the highest migration file.

## Procedure

1. **Write the migration** at `supabase/migrations/NNNN_snake_case.sql`, numbered
   sequentially with no gaps. Every table it creates must enable RLS or carry an
   explicit `-- rls-exempt: <table>` marker (`scripts/test-migrations.ts` enforces
   both). If it defines or changes an RPC the server calls, update the hand-written
   types in `src/lib/db/schema.ts` to match.
2. **Bump the shipped version** in `src/lib/db/migration-version.ts`
   (`SHIPPED_MIGRATION_VERSION = "NNNN"`) in the **same commit** as the migration.
3. **Push the branch and open the PR.** The `migration-drift` check will fail with
   `Committed migrations are not applied to the remote DB. Run: supabase db push`.
   That is expected: the migration is not on prod yet.
4. **Apply to prod:**

   <!-- runbook-unverified: applies pending migrations to production, so it cannot be run
        on demand to prove itself (with nothing pending it is a no-op that proves nothing,
        and with something pending it is the real schema change). Its EFFECT is verified
        instead, by step 7's read-back below. -->

   ```
   supabase db push
   ```

   Never apply a Slate migration through the Supabase MCP `apply_migration` tool.
   It records a 14-digit **timestamp** version instead of the file's `NNNN` prefix,
   which the prod lag monitor filters out (`^[0-9]{4}$`); the migration would then
   read as never applied and, worse, could pin the check to a false "database is
   ahead" and silence it. `supabase db push` records the `NNNN` version correctly.
5. **Re-run the merge gate.** `gh run rerun <run-id> --failed`, then confirm the
   `migration-drift` check is green (`gh pr checks <pr>`).
6. **Merge.** The push to main deploys the code, now that its schema is already in
   place.
7. **Verify.** On the next monitor tick the `migration-drift` log line should read
   `status=in-sync`. To confirm the schema directly, read the applied set back via
   the `applied_migration_versions()` RPC (server-only; deny-all to API clients).
   Run this as an admin in the Supabase SQL editor:

   <!-- runbook-verified: 2026-08-03 (31d188fb) run against production; returned
        highest_applied 0094 across 94 rows, matching SHIPPED_MIGRATION_VERSION and the
        highest file supabase/migrations/0094_agent_calendar_watch_health.sql -->

   ```
   select max(v) as highest_applied, count(*) as applied_count
   from (select unnest(applied_migration_versions()) as v) t
   where v ~ '^[0-9]{4}$';
   ```

   `highest_applied` must equal `SHIPPED_MIGRATION_VERSION` in
   `src/lib/db/migration-version.ts`. The `^[0-9]{4}$` filter is the same one the
   prod lag monitor applies, so a migration applied through the Supabase MCP tool
   (which records a 14-digit timestamp version) is invisible here exactly as it is
   to the monitor. That is the point: if a migration you just applied does not show
   up, you applied it the wrong way.

## Notes

- **Ordering.** Apply **before** merge, not after. The merge gate enforces this,
  and applying first means the code never deploys ahead of its schema.
- **Rollback.** Migrations are forward-only; there is no automated down-migration
  (accepted, #607; the rationale is in "Roll-forward only, and what the migration
  tests cover" below). To undo, write a new forward migration that reverses the
  change and run this same procedure.
- **Credentials.** `supabase db push` needs the linked project (ref
  `drukfvgaynzrralbzkzj`) and the DB password. The same `SUPABASE_ACCESS_TOKEN` +
  `SUPABASE_DB_PASSWORD` are set as repo secrets for the CI `migration-drift` job.

## Writing a function with a pinned search_path (#1126)

Every function Slate ships pins its `search_path` (against a search-path attack on
a SECURITY DEFINER function). A pinned path is **not** the path you get in a normal
session, so a function that calls an **extension** function unqualified is
unreachable and errors on every call, at runtime only. That shipped once as #1125:
`erase_booking_pii` pinned `search_path = public` and hashed with pgcrypto's
`digest()`, but pgcrypto lives in the **`extensions`** schema on Supabase, so the
audit-hash step failed on every erasure. The migration looked correct, the drift
gate was green, and the function existed in prod.

**What is safe under `search_path = public`:** anything in `pg_catalog`, which
Postgres always searches implicitly. `sha256()`, `gen_random_uuid()`, `encode()`,
`convert_to()`, and `set_config()` are all built in and need no qualifier. Note
that `gen_random_uuid()` exists in *both* `pg_catalog` and pgcrypto, which is why
it works everywhere while its pgcrypto-only sibling `gen_random_bytes()` does not.

**What is not:** anything from pgcrypto, uuid-ossp, or `supabase_vault`. Prefer a
`pg_catalog` built-in; if you genuinely need the extension, schema-qualify it
(`extensions.digest(...)`) or add the schema to the pin
(`set search_path = public, extensions`).

`scripts/test-definer-search-path.ts` enforces this on pre-push and in CI, scanning
every migration. Its escape hatch is a `-- search-path-ok: <reason>` comment on or
above the call, for a call the pinned path genuinely can reach. When a new
extension is installed into a non-public schema, add its functions to
`EXTENSION_FUNCTIONS` in `scripts/lib/scan-definer-search-path.ts` (the regenerating
query is in that file's header), and drop any name that also exists in
`pg_catalog`. A new pinned function also goes on that test's `EXPECTED_PINNED`
list, which exists so a header-parse regression fails loudly instead of quietly
scanning nothing.

## Backfilling a mirrored table: rewind the export cursor (#1231)

A write that supplies its own timestamp into a **mirrored** table
(`MIRROR_TABLES` in `src/lib/snowflake/export-core.ts`: `bookings`,
`webhook_deliveries`, `booking_outbox`, `booking_events`, `audit_log`,
`routing_decisions`) can land **behind** the Snowflake export cursor, and the
export walks each table on a strictly forward keyset over its watermark, so those
rows are never fetched again. The mirror simply never gets them.

That shipped on 2026-08-03: a 269 row OOO audit backfill carried its real
historical `created_at` values while the cursor sat at 2026-07-31, so 251 rows were
skipped. Nothing failed, nothing errored, and the only symptom was a drift page
hours later.

**So a backfill owns its own reachability.** Rewind that table's cursor in the same
change as the write:

<!-- runbook-unverified: running this outside a real backfill would restart a full
     re-export of the table and pause the retention lanes until it caught up, so it
     is deliberately not executed to test it. The equivalent statement WAS run
     against production by hand on 2026-08-03 to recover the OOO audit backfill,
     and it now lives, executable and guarded against double-running, at the end of
     scripts/sql/backfill-ooo-audit-1220.sql. -->

```sql
update export_cursor
set last_ts = (select min(created_at) from audit_log),
    last_id = null
where key = 'audit_log';
```

Clearing `last_id` makes the next export tick walk the table from the start (the
keyset only applies when both halves are set). Re-exporting is safe: the warehouse
load is a MERGE on `id` with UPDATE and INSERT and **no DELETE**
(`src/lib/snowflake/merge.ts`), so it cannot duplicate or destroy a warehouse row.
`scripts/sql/backfill-ooo-audit-1220.sql` is the worked example, including how to
make the rewind a no-op when re-run after the export has caught up.

Expect one temporary side effect while the cursor sits behind: `export-lag.ts` reads
that table as lagging and the retention lanes refuse to delete (the safe
direction), clearing once the export catches up. The drift all-clear arrives on the
next 6-hourly reconcile, not immediately.

Two things enforce this rather than trusting memory:

- `scripts/test-mirror-backfill-cursor.ts` (pre-push and CI) fails a migration or
  script that writes a mirrored table's watermark column without a rewind in the
  same file. Its escape hatch is `-- export-cursor-ok: <why>` (or `//` in TS) on or
  above the write, for a write whose watermark is genuinely current.
- The 6-hourly reconcile lane counts, per table, the exportable rows strictly
  **behind** the cursor and compares that to the warehouse count. Every row behind
  the cursor should already be there, and every legitimate difference makes the
  warehouse bigger, so a single stranded row pages with no tolerance. That is the
  net under **hand-run** SQL, which no repo scan can see.

## Roll-forward only, and what the migration tests cover (#607)

Slate deliberately uses **roll-forward-only** migrations. There are no
down-migrations, and `scripts/test-migrations.ts` intentionally guards only
**repo hygiene invariants**, not rollback. This is a settled decision (#607);
this section records the reasoning so it is not re-litigated.

**What the test guards.** `scripts/test-migrations.ts` is a static file scan. It
checks sequencing (files are `NNNN_snake_case.sql`, numbered from 0001 with no
gaps or duplicates), that every created table enables RLS or is explicitly
`-- rls-exempt`, that hand-written RPC arg types in `src/lib/db/schema.ts` match
each function's SQL definition, and that `SHIPPED_MIGRATION_VERSION` equals the
highest migration file. These are cheap, deterministic regression guards that run
on pre-push and in CI without touching a database.

**What it does not guard, and why.** It does not test that any migration can be
reversed, because there is nothing to reverse: the model is forward-only. To undo
a change you write a **new forward migration** that reverses it and run the normal
procedure above. Testing rollback would mean standing up a disposable database to
apply and then revert each migration against, which is a different class of test
entirely (stateful, slow, infrastructure-dependent) from the static invariant
guards this file holds. The cost is not justified for a forward-only model where
no down-migration is ever run.

**Where the real risk actually lives.** The failure this project has repeatedly
hit is not a bad rollback; it is **drift**, code deploying ahead of the schema it
needs (0032 #214, 0037 #276, 0053 #439, 0055 #516). That gap is covered by the
safety nets listed above (the `migration-drift` merge gate, the `deploy` gate, the
prod `migration_version_lag` monitor, and the `SHIPPED_MIGRATION_VERSION` guard),
not by rollback tests. Effort on migration reliability belongs there, not on a
down-migration harness.
