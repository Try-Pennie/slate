// Repo invariant (#1126): guard against a database function that pins its
// search_path and then calls an EXTENSION-schema function unqualified.
//
// The bug class (shipped once as #1125): `erase_booking_pii` pinned
// `search_path = public` and hashed with pgcrypto's `digest()`. pgcrypto lives in
// the `extensions` schema on Supabase, so `digest` was unreachable from the pinned
// path and EVERY call errored at the audit-hash step. Nothing about the migration
// looked wrong, the drift gate was green, and the function existed in prod: the
// failure was invisible until someone actually ran an erasure. The fix swapped in
// the built-in `sha256()`.
//
// The 2026-07-27 audit of prod found no OTHER instance (11 SECURITY DEFINER
// functions, only that one ever touched an extension function), so this guard
// exists to stop the NEXT migration from reintroducing it rather than to fix a
// backlog.
//
// SCOPE IS WIDER THAN THE ISSUE ON PURPOSE: the trap is the pinned search_path,
// not the SECURITY DEFINER flag, so a SECURITY INVOKER function with a pinned path
// fails exactly the same way and is flagged too. A function with NO pin resolves
// against the caller's path and is out of scope.
//
// A pinned function's extension call is fine when ANY of these holds:
//   - it is schema-qualified (`extensions.digest(...)`, `vault.create_secret(...)`)
//   - the pin includes the home schema (`set search_path = public, extensions`)
//   - the name also exists in pg_catalog, so the implicit path resolves it
//     (`gen_random_uuid()` and `sha256()` are built in on PG 13+/11+ and are
//     deliberately NOT in the map below; flagging them would be a false positive)
//   - a `// search-path-ok:` / `-- search-path-ok:` opt-out sits on or above the
//     call line.
//
// The scan logic lives in scripts/lib/scan-definer-search-path.ts so it is
// unit-testable. This file is the positive control (proves the detector flags the
// bad pattern and cannot rot into a no-op), a real-file mutation control that
// reverts the #1125 fix, and the whole-migrations invariant.
// Run: node --experimental-strip-types scripts/test-definer-search-path.ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { listPinnedFunctions, scanDefinerSearchPath } from "./lib/scan-definer-search-path.ts";
import { assert, finish } from "./lib/harness.ts";

const HERE = import.meta.dirname; // scripts/
const ROOT = join(HERE, "..");
const MIGRATIONS = join(ROOT, "supabase", "migrations");

// --- positive control: flag the bad pattern, allow the safe ones --------------

interface Fixture {
  name: string;
  flagged: boolean;
  sql: string;
}

/** Wraps a plpgsql body in a function header with the given trailing clauses. */
function fn(clauses: string, body: string): string {
  return `create or replace function f_test(p text)
returns text
language plpgsql
${clauses}
as $$
begin
${body}
end;
$$;`;
}

const FIXTURES: Fixture[] = [
  // FLAGGED: a pinned path that cannot reach the extension's home schema -------
  {
    name: "the real #1125 bug: search_path=public calling pgcrypto digest()",
    flagged: true,
    sql: fn(
      "security definer\nset search_path = public",
      `  return encode(digest(p, 'sha256'), 'hex');`,
    ),
  },
  {
    name: "empty pin cannot reach extensions either",
    flagged: true,
    sql: fn("security definer\nset search_path = ''", `  return crypt(p, gen_salt('bf'));`),
  },
  {
    name: "pg_catalog-only pin calling pgcrypto",
    flagged: true,
    sql: fn("security definer\nset search_path = pg_catalog", `  return hmac(p, 'k', 'sha256');`),
  },
  {
    name: "uuid-ossp uuid_generate_v4() under a public pin",
    flagged: true,
    sql: fn("security definer\nset search_path = public", `  return uuid_generate_v4()::text;`),
  },
  {
    name: "gen_random_bytes (pgcrypto-only, unlike gen_random_uuid)",
    flagged: true,
    sql: fn("security definer\nset search_path = public", `  return encode(gen_random_bytes(16), 'hex');`),
  },
  {
    name: "vault.create_secret unqualified under a public pin",
    flagged: true,
    sql: fn("security definer\nset search_path = public", `  perform create_secret(p);`),
  },
  {
    name: "SECURITY INVOKER with a pinned path is the same trap",
    flagged: true,
    sql: fn("set search_path = public", `  return encode(digest(p, 'sha256'), 'hex');`),
  },
  {
    name: "language sql body (no begin/end) with a pinned path",
    flagged: true,
    sql: `create or replace function f_sql(p text) returns text
language sql
security definer
set search_path = public
as $$
  select encode(digest(p, 'sha256'), 'hex');
$$;`,
  },
  {
    name: "a second function in the same file is scanned too",
    flagged: true,
    sql: `${fn("security definer\nset search_path = public", `  return p;`)}\n\n${fn(
      "security definer\nset search_path = public",
      `  return encode(digest(p, 'sha256'), 'hex');`,
    )}`,
  },
  {
    name: "dollar-tag body ($fn$) is still scanned",
    flagged: true,
    sql: `create or replace function f_tag(p text) returns text
language plpgsql
security definer
set search_path = public
as $fn$
begin
  return encode(digest(p, 'sha256'), 'hex');
end;
$fn$;`,
  },

  // NOT FLAGGED: the call is reachable ----------------------------------------
  {
    name: "the #1125 fix: built-in sha256() needs no extension schema",
    flagged: false,
    sql: fn(
      "security definer\nset search_path = public",
      `  return encode(sha256(convert_to(p, 'UTF8')), 'hex');`,
    ),
  },
  {
    name: "schema-qualified extensions.digest()",
    flagged: false,
    sql: fn(
      "security definer\nset search_path = public",
      `  return encode(extensions.digest(p, 'sha256'), 'hex');`,
    ),
  },
  {
    name: "the pin includes extensions",
    flagged: false,
    sql: fn(
      "security definer\nset search_path = public, extensions",
      `  return encode(digest(p, 'sha256'), 'hex');`,
    ),
  },
  {
    name: "gen_random_uuid() is built in on PG 13+ (must not false-flag)",
    flagged: false,
    sql: fn("security definer\nset search_path = public", `  return gen_random_uuid()::text;`),
  },
  {
    name: "no pin at all: resolves against the caller's path, out of scope",
    flagged: false,
    sql: fn("security definer", `  return encode(digest(p, 'sha256'), 'hex');`),
  },
  {
    name: "the call sits in a SQL comment",
    flagged: false,
    sql: fn(
      "security definer\nset search_path = public",
      `  -- we deliberately avoid digest(p, 'sha256') here\n  return p;`,
    ),
  },
  {
    name: "search-path-ok opt-out on the line above",
    flagged: false,
    sql: fn(
      "security definer\nset search_path = public",
      `  -- search-path-ok: the caller installs pgcrypto into public in this deployment\n  return encode(digest(p, 'sha256'), 'hex');`,
    ),
  },
  {
    name: "a column or variable merely NAMED digest is not a call",
    flagged: false,
    sql: fn("security definer\nset search_path = public", `  return (select digest from t limit 1);`),
  },
  {
    name: "a table default outside any function body is out of scope",
    flagged: false,
    sql: `create table t (id uuid primary key default gen_random_uuid(), h bytea default digest('x', 'sha256'));`,
  },
];

for (const f of FIXTURES) {
  const found = scanDefinerSearchPath(f.sql, "fixture").length > 0;
  assert(found === f.flagged, `${f.flagged ? "flags" : "allows"}: ${f.name}`);
}

// --- real-file mutation control: reverting the #1125 fix must be caught -------
// 0092 hashes with the built-in sha256() precisely because it pins
// search_path = public. Putting pgcrypto's digest() back is the exact shipped bug,
// and the guard MUST notice, which proves it checks the real migrations rather
// than only its own fixtures.
const erasePath = join(MIGRATIONS, "0092_erase_booking_pii.sql");
const eraseSql = readFileSync(erasePath, "utf8");
assert(
  scanDefinerSearchPath(eraseSql, erasePath).length === 0,
  "the real 0092_erase_booking_pii.sql is clean",
);
const reverted = eraseSql.replace(
  "encode(sha256(convert_to(norm, 'UTF8')), 'hex')",
  "encode(digest(norm, 'sha256'), 'hex')",
);
assert(reverted !== eraseSql, "the mutation control actually rewrote 0092 (fix text still present)");
assert(
  scanDefinerSearchPath(reverted, erasePath).length > 0,
  "positive control: reverting 0092 to pgcrypto digest() is caught",
);

const files = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .sort();
assert(files.length > 0, `found migrations to scan (got ${files.length})`);

// --- parse-completeness control: the scan is not vacuous ----------------------
// A header-parse regression (a missed `create function` shape, a search_path
// clause the regex stops matching) would silently drop every function from the
// scan and read as "no findings" forever, which is the false-confidence class
// this repo keeps rediscovering. So pin the set the parser must still find.
//
// Cross-checked against prod on 2026-07-27: the database has 11 SECURITY DEFINER
// functions in `public`, all with a pinned path. The list below is that set minus
// `rls_auto_enable` (Supabase's own event-trigger function, not in Slate's
// migrations) plus `applied_migration_version`, whose definition is still in 0071
// though 0076 dropped it from the database. The list is every PINNED function the
// parser finds, definer or not: the trap is the pin, not the definer flag, so a
// SECURITY INVOKER function with a pinned path belongs here too (0144's
// `agent_link_for_new_user`, #2073) and adds nothing to that definer count.
const EXPECTED_PINNED = [
  // #2073: mints a new user's booking link token. Security INVOKER, pinned, and
  // it reaches only pg_catalog built ins (sha256, gen_random_uuid).
  "agent_link_for_new_user",
  // #3026: the readable advisor link name. Derives the base from an email, reserves
  // a name for a new user, and refuses releasing, renaming or moving one. All four
  // are Security INVOKER, pinned, and reach only pg_catalog built ins.
  "agent_link_name_base",
  "agent_link_name_for_new_user",
  "agent_link_names_keep_reserved",
  "applied_migration_version",
  "applied_migration_versions",
  // #3090: the audit_log hash chain. The field encoder and the link are Security
  // INVOKER; the trigger is DEFINER so it can move the chain head whoever inserts.
  // All three reach only pg_catalog built ins (sha256, convert_to, encode).
  "audit_log_chain_append",
  "audit_log_chain_field",
  "audit_log_chain_link",
  "before_user_created_domain_gate",
  "booking_api_outcome_mix",
  // #2366: keeps booking_settings.public_booking_paused_at in step with the flag.
  "booking_settings_stamp_pause",
  // #4202: a booking on the placeholder is staff_placed and stacks, and a move off it
  // makes the call routed. Definer, pinned, reading only users.
  "bookings_kind_follows_assignee",
  // #3247: the reroute hold backstop on bookings, and the delete of a cancelled
  // booking's hold. Definer, pinned, reaching only pg_catalog built ins.
  "bookings_refuse_held_agent",
  "bookings_release_reroute_hold",
  "bump_booking_api_outcome",
  // #2369: decides whether a named booking is really a duplicate and, when it is,
  // cancels it and enqueues its outbox row in ONE transaction.
  "cancel_duplicate_booking",
  // #2369: the half of that decision about the NAMED booking alone, its own function
  // because it is asked twice, once before any lock and once under it.
  "cancel_duplicate_named_refusal",
  // #4103: the pattern's cells as one jsonb array, in plain SQL over stored columns.
  "capacity_fill_pattern",
  // #3936: the past days capacity history holds, for the page's date picker. Plain SQL.
  "capacity_history_days",
  // #4296: the reminder email claim, under a per booking advisory lock; definer, pinned
  // to public, pg_catalog built ins only (hashtextextended, pg_advisory_xact_lock).
  "claim_reminder_send",
  // #3247: the first step of a reroute confirm.
  "claim_reroute_hold",
  // #3495: a fresh booking's save after its calendar event, in one transaction;
  // definer, pinned to public, pg_catalog built ins only, execute revoked.
  "commit_fresh_booking",
  // #3265: the gated reschedule and its outbox row in one transaction.
  "commit_reschedule",
  // #4202: commit_reschedule for a move onto the placeholder, as staff_placed and stacking.
  "commit_reschedule_onto_placeholder",
  "count_bookings_per_local_day",
  // #2447: reports which definer functions the web roles can execute. Security INVOKER
  // itself, deliberately, so it adds no row to the list it reports on.
  "definer_function_web_grants",
  // #3495: a webhook's deliveries in one call; definer, pinned to public, pg_catalog
  // built ins only, execute revoked from the web roles.
  "enqueue_webhook_deliveries",
  "erase_booking_pii",
  // #4296: a reminder email send failed for good; definer, pinned, pg_catalog only.
  "fail_reminder_send",
  // #3476: a lead's active bookings in one call; security INVOKER, pinned anyway,
  // pg_catalog built ins only, execute revoked from the web roles.
  "find_active_bookings_for_person",
  // #3489: every rung's candidate inputs in one call; security INVOKER, pinned anyway,
  // execute revoked from the web roles. It calls two public functions, both on the path.
  "ladder_candidate_inputs",
  // #3248: the live reroute holds the booker skips, judged on the database clock.
  "live_reroute_holds",
  // #4296: a claimed reminder email was sent; definer, pinned, pg_catalog only.
  "mark_reminder_sent",
  // #3896: stamps when cal.com was marked retired. Security INVOKER; now() and
  // coalesce are pg_catalog built ins.
  "monitor_alert_config_stamp_calcom_retired",
  "move_busy_block",
  // #3365: releases a time off's held 'ooo' block when its request ends or stops
  // pointing at it. A trigger, Security DEFINER, pinned to public, no extensions.
  "ooo_release_held_window",
  // #3247: holds an advisor at a booking's buffered window for a bucket correction.
  "place_reroute_hold",
  // #3248: removes expired reroute holds' busy blocks, on the self heal lane.
  "prune_expired_reroute_hold_blocks",
  // #3109: the daily rate_limits prune.
  "prune_rate_limits",
  "rate_limit_hit",
  "rate_limit_refund",
  "reason_usage_counts",
  "reassign_booking_swap",
  // #4102: one booking pace reading per page day and the snapshots moved on, in plain SQL;
  // hashtextextended is a pg_catalog built in.
  "record_capacity_fill",
  // #3940: merges one capacity history tick and moves its cursor, in plain SQL.
  "record_capacity_history",
  // #3137: adds one batch of framed booker loads. Security definer, pinned; now() and the
  // date arithmetic are pg_catalog built ins.
  "record_frame_origins",
  // #3592: the reconcile-missing sweep's conditional re-create. Security INVOKER, plain
  // SQL; now() is a pg_catalog built in.
  "recreate_missing_busy_blocks",
  "regal_call_reason_counts",
  // #4296: a reminder email claim given back after a transient failure.
  "release_reminder_send",
  // #1293: replaces a schedule's weekly rules in one transaction, so a failure
  // cannot leave an agent with no working hours (and therefore no availability).
  "replace_availability_rules",
  // #1930: replaces a bucket's manual members in one transaction, so a failure
  // cannot leave a routing pool with nobody in it while the save reads as done.
  "replace_bucket_members",
  // #2002: replaces an agent's timezone AND their week in one transaction, so a
  // failed rules write cannot leave the new zone sitting over the old hours.
  "replace_user_schedule",
  "replace_user_schedule_if_unchanged",
  // #3248: writes and removes a reroute hold's busy block.
  "reroute_hold_write_block",
  // #3247: the one clash rule the hold trigger and placement share. Security INVOKER.
  "reroute_window_clash",
  "reserve_agent_link_name",
  // #3124: routed real bookings per minute for the daily busy minute check. Security
  // INVOKER, plain SQL; floor, extract and jsonb_agg are pg_catalog built ins.
  "routed_bookings_per_minute",
  // #4296: the one write of a reminder email, with its version and audit row; and a
  // reminder email recorded as never to be sent. Definer, pinned, pg_catalog only.
  "save_reminder_email",
  "skip_reminder_send",
  // #2369: the digit rule two stored phone numbers are compared by. Deliberately not
  // libphonenumber, which no SQL expression reproduces; see migration 0124.
  "slate_phone_match_key",
];

const pinned = new Map<string, string[]>();
for (const file of files) {
  for (const p of listPinnedFunctions(readFileSync(join(MIGRATIONS, file), "utf8"))) {
    pinned.set(p.functionName, p.searchPath);
  }
}
const foundNames = [...pinned.keys()].sort();
assert(
  JSON.stringify(foundNames) === JSON.stringify(EXPECTED_PINNED),
  `parser still finds every pinned function (expected ${EXPECTED_PINNED.length}, got ` +
    `${foundNames.length}: ${foundNames.join(", ")}). A new pinned function belongs on ` +
    `EXPECTED_PINNED; a MISSING one means the header parser regressed and the scan is vacuous`,
);
// The pin's VALUE must parse too, or every path would look reachable.
assert(
  JSON.stringify(pinned.get("erase_booking_pii")) === JSON.stringify(["public"]),
  "parses erase_booking_pii's pin as [public]",
);
assert(
  JSON.stringify(pinned.get("applied_migration_versions")) === JSON.stringify([]),
  "parses applied_migration_versions' empty pin as []",
);

// --- repo invariant: every migration is clean ---------------------------------
let siteCount = 0;
for (const file of files) {
  const sql = readFileSync(join(MIGRATIONS, file), "utf8");
  const findings = scanDefinerSearchPath(sql, `supabase/migrations/${file}`);
  siteCount += findings.length;
  for (const fnd of findings) {
    assert(
      false,
      `${fnd.file}:${fnd.line} function ${fnd.functionName}() pins search_path=[${fnd.searchPath.join(", ")}] ` +
        `but calls ${fnd.calledFunction}(), which lives in "${fnd.homeSchema}"; ` +
        `schema-qualify it (${fnd.homeSchema}.${fnd.calledFunction}), add "${fnd.homeSchema}" to the pin, ` +
        `use a pg_catalog built-in, or annotate -- search-path-ok: <reason>`,
    );
  }
}
if (siteCount === 0) {
  console.log(
    `ok: no unreachable extension calls in pinned-search_path functions across ${files.length} migrations`,
  );
}

finish();
