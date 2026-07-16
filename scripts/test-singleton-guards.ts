// Repo invariant (#839): every "one row per X" relationship in the schema must
// be backed by a unique index / constraint the database enforces. Without one,
// duplicates accumulate and a reader silently picks one by query order.
//
// This codebase shipped that exact bug twice:
//   - #513 (migration 0067): a second busy_block per booking, so the availability
//     cache and reconcile miscounted.
//   - #532 (migration 0074): a second availability_schedule per user, so the
//     booker read a silently-divergent schedule.
// Both were invisible in code review and in unit tests (a mocked client accepts
// any insert); they only surfaced after duplicates existed in production. So the
// audit that closed #839 is locked in HERE, statically, against the migrations:
// a registry of every real singleton invariant, each asserted to have a guard.
//
// Adding a NEW table whose rows are meant to be "one per X" without its unique
// constraint fails this test until the constraint is added or the entry is
// consciously left off. Fail-loud over churn, the same posture as the #822
// capped-read SAFE_TABLES registry.
//
// SCOPE: per-entity business singletons (the #513/#532 divergence class) plus the
// pinned global-config singleton. Pure lock/counter tables keyed by a text PK
// (alert_state, sync_locks, rate_limits, lane_heartbeats, monitor_settings,
// selfheal_scan_cursor, bucket_slots) are singleton BY their primary key: a
// second row is structurally impossible, so they need no separate entry.
//
// Run: node --experimental-strip-types scripts/test-singleton-guards.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseMigrationConstraints,
  hasSingletonGuard,
} from "./lib/parse-migration-constraints.ts";
import { assert, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
const MIGRATIONS = join(ROOT, "supabase", "migrations");

const sql = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
  .join("\n");

const constraints = parseMigrationConstraints(sql);

/** Every "at most one row per X" invariant the schema must enforce.
 *  `cols` is the entity key the singleton is scoped to (normalized, no spaces). */
const SINGLETON_INVARIANTS: {
  table: string;
  cols: string;
  issue: string;
  why: string;
}[] = [
  { table: "google_credentials", cols: "user_id", issue: "0001", why: "one Google connection per agent" },
  { table: "agent_calendars", cols: "user_id,calendar_id", issue: "0012", why: "one sync/push state row per (agent, calendar)" },
  { table: "availability_schedules", cols: "user_id", issue: "#532/0074", why: "one working-hours schedule per agent" },
  { table: "busy_blocks", cols: "booking_id", issue: "#513/0067", why: "one slate busy block per booking" },
  { table: "bucket_members", cols: "bucket_id,user_id", issue: "0001", why: "one membership per (bucket, agent)" },
  { table: "buckets", cols: "org_id,code", issue: "0001", why: "one bucket per (org, XBC code)" },
  { table: "users", cols: "email", issue: "0001", why: "one user per email" },
  { table: "users", cols: "auth_user_id", issue: "0006", why: "one login identity per user (partial: non-null)" },
  { table: "bookings", cols: "manage_token", issue: "0001", why: "one booking per manage token" },
  { table: "booking_reservations", cols: "idempotency_key", issue: "0052", why: "the create-path concurrency arbiter (one intent per key)" },
  { table: "reassign_intents", cols: "booking_id,gcal_client_id", issue: "0065", why: "one create-intent per (booking, deterministic event id)" },
  { table: "reschedule_locks", cols: "booking_id,target_starts_at", issue: "0033", why: "one in-flight reschedule lock per (booking, target)" },
  { table: "pending_event_deletions", cols: "calendar_email,gcal_event_id", issue: "0044", why: "one pending deletion per (calendar, event)" },
  { table: "ooo_requests", cols: "user_id,starts_at,ends_at", issue: "0025", why: "one active OOO request per (agent, exact window) [partial]" },
  { table: "monitor_alert_config", cols: "id", issue: "0060", why: "single global config row (id pinned to 1)" },
];

for (const inv of SINGLETON_INVARIANTS) {
  assert(
    hasSingletonGuard(constraints, inv.table, inv.cols),
    `#839: ${inv.table}(${inv.cols}) is guarded against duplicates [${inv.issue}: ${inv.why}]`,
  );
}

// Positive control: the guard must actually have teeth. A synthetic table meant
// to be one row per user, but with NO unique constraint, MUST read as unguarded;
// once given the constraint (even a PARTIAL one) it MUST read as guarded. If
// either of these flips, the check above is verifying nothing.
{
  const unguarded = parseMigrationConstraints(
    "create table widget_prefs (\n  id uuid primary key default gen_random_uuid(),\n  user_id uuid not null references users(id)\n);",
  );
  assert(
    !hasSingletonGuard(unguarded, "widget_prefs", "user_id"),
    "positive control: an unguarded one-per-user table is correctly flagged as NOT guarded",
  );

  const guardedPartial = parseMigrationConstraints(
    "create table widget_prefs (\n  id uuid primary key default gen_random_uuid(),\n  user_id uuid not null\n);\ncreate unique index widget_prefs_user_uniq on widget_prefs (user_id) where user_id is not null;",
  );
  assert(
    hasSingletonGuard(guardedPartial, "widget_prefs", "user_id"),
    "positive control: a PARTIAL unique index counts as a singleton guard",
  );
}

finish();
