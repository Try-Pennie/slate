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
  parseDeclaredTables,
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

// #874: the registry above only proves the KNOWN singletons stay guarded. It says
// nothing about a table that ships later and SHOULD have been a singleton but
// arrives with neither a unique constraint nor a registry entry, which is exactly
// how #513 and #532 slipped through. So force a conscious choice: every table the
// migrations declare must be listed either in SINGLETON_INVARIANTS above (a
// per-entity "one row per X" table, asserted guarded) OR here, as a table that is
// deliberately NOT a singleton. A new table in neither fails the build until its
// author classifies it. Fail-loud over churn, mirroring the #822 SAFE_TABLES posture.
//
// This is intentionally SEPARATE from #822's SAFE_TABLES (scan-src-capped-reads.ts):
// the two lists mirror each other's posture but draw the line differently. `bookings`
// is a growth table there (its row count scales with volume) yet carries singleton
// invariants here (manage_token), so one registry could not serve both.
const NON_SINGLETON_TABLES: { table: string; category: string; why: string }[] = [
  // Bounded-by-PK lock / counter / cursor tables: the row is keyed by a fixed or
  // text primary key, so a second row is structurally impossible. No separate
  // singleton guard needed (the PK is the guard).
  { table: "alert_state", category: "lock/counter", why: "one alert-cooldown row per text alert key (PK)" },
  { table: "sync_locks", category: "lock/counter", why: "one lock row per text lock key (PK)" },
  { table: "rate_limits", category: "lock/counter", why: "one window row per text rate-limit key (PK)" },
  { table: "lane_heartbeats", category: "lock/counter", why: "one heartbeat row per text lane name (PK)" },
  { table: "monitor_settings", category: "lock/counter", why: "single pinned settings row keyed by PK" },
  { table: "selfheal_scan_cursor", category: "lock/counter", why: "single scan-cursor row keyed by PK" },
  { table: "bucket_slots", category: "lock/counter", why: "one precomputed cache row per bucket_code (PK), ~60 rows" },
  // Roster / config-bounded: row count is capped by the roster or org, not by
  // booking volume or time, so duplicates are not the failure mode.
  { table: "organizations", category: "roster/config", why: "single-org PoC; bounded config table" },
  { table: "event_types", category: "roster/config", why: "a handful of booking event types per org" },
  { table: "webhook_endpoints", category: "roster/config", why: "a few configured webhook targets per org" },
  { table: "availability_rules", category: "roster/config", why: "per-schedule weekday rules, bounded by roster x 7" },
  // Growth / append-only / queue: rows scale with volume or time BY DESIGN. A
  // second row is the point, not a bug (no singleton invariant applies).
  { table: "audit_log", category: "growth/append-only", why: "append-only audit trail" },
  { table: "booking_events", category: "growth/append-only", why: "append-only per-booking event log" },
  { table: "routing_decisions", category: "growth/append-only", why: "append-only routing decision log" },
  { table: "webhook_deliveries", category: "growth/append-only", why: "append-only webhook delivery attempts" },
  { table: "booking_outbox", category: "queue", why: "crash-safe mutation queue; one booking gets many rows" },
];

{
  const singletonTables = new Set(SINGLETON_INVARIANTS.map((i) => i.table));
  const nonSingletonTables = new Set(NON_SINGLETON_TABLES.map((t) => t.table));
  for (const table of parseDeclaredTables(sql)) {
    assert(
      singletonTables.has(table) || nonSingletonTables.has(table),
      `#874: table "${table}" is consciously classified in SINGLETON_INVARIANTS (with its unique guard) or NON_SINGLETON_TABLES (growth/queue/lock/config). A new table in neither fails until its author classifies it, so a new singleton can't ship unguarded`,
    );
  }
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

// Positive control for the #874 completeness check: a table the migrations declare
// but that appears in NEITHER registry must be seen as unclassified. If this flips,
// the completeness assertion above has become a no-op and a new singleton could ship
// unguarded again.
{
  const declared = parseDeclaredTables(
    "create table brand_new_growth_thing (\n  id uuid primary key default gen_random_uuid()\n);",
  );
  const singletonTables = new Set(SINGLETON_INVARIANTS.map((i) => i.table));
  const nonSingletonTables = new Set(NON_SINGLETON_TABLES.map((t) => t.table));
  const unclassified = [...declared].filter(
    (t) => !singletonTables.has(t) && !nonSingletonTables.has(t),
  );
  assert(
    unclassified.length === 1 && unclassified[0] === "brand_new_growth_thing",
    "positive control: an unlisted new table is correctly detected as unclassified",
  );
}

finish();
