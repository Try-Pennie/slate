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
  { table: "reroute_holds", cols: "booking_id", issue: "#3247/0166", why: "one reroute hold per booking; placing again replaces it, so a booking never holds two advisors" },
  // 0053 re-keyed this from (booking, target) to the booking alone, which is what lets
  // the moved invite handler (#3919) hold it to keep EVERY reschedule of a booking out,
  // whatever its target, while it puts an invite back. The old entry still named the
  // 0033 key, and a reader of it concluded the handler's lock excluded nothing.
  { table: "reschedule_locks", cols: "booking_id", issue: "0053", why: "one in-flight reschedule per booking, whatever its target (0053 re-keyed it from (booking, target)), which the moved invite handler (#3919) also holds while it puts an invite back" },
  { table: "pending_event_deletions", cols: "calendar_email,gcal_event_id", issue: "0044", why: "one pending deletion per (calendar, event)" },
  { table: "ooo_requests", cols: "user_id,starts_at,ends_at", issue: "0025", why: "one active OOO request per (agent, exact window) [partial]" },
  { table: "monitor_alert_config", cols: "id", issue: "0060", why: "single global config row (id pinned to 1)" },
  { table: "booking_settings", cols: "id", issue: "#1015/0086", why: "single direct-booking config row (id pinned to 1)" },
  { table: "owner_alert_events", cols: "booking_id", issue: "#2371/0126", why: "one LIVE advisor alert per booking [partial: removed_at is null]; removed rows stay as the history of who held the call" },
  { table: "regal_call_events", cols: "event_id", issue: "#2090/0137", why: "one row per Regal eventId, so a redelivered event is never recorded or counted twice" },
  { table: "regal_call_outcomes", cols: "event_id", issue: "#2944/0152", why: "one outcome per Regal eventId, so a redelivered call is never stored twice and the show rate never counts it twice" },
  { table: "booking_invite_changes", cols: "booking_id,event_updated", issue: "#3919/0189", why: "one record per change Google stamped on a booking's invite, so of two syncs that see the same moved invite only one reverts it or messages anybody" },
  { table: "booking_invite_changes", cols: "booking_id,move_number", issue: "#3919/0189", why: "one record per move number of a booking, so two runs can never both count a move as the first and both put it back" },
  { table: "calcom_override_removals", cols: "request_id,starts_at,ends_at", issue: "#2890/0153", why: "one stale cal.com block per (request, window), so recording it twice is one row and putting cal.com back takes it out once" },
  { table: "agent_link_names", cols: "user_id", issue: "#3026/0155", why: "one readable booking link name per user, so the copy link and the resolver can never disagree about which name is theirs" },
  { table: "capacity_history", cols: "user_id,day", issue: "#3940/0191", why: "one saved day per advisor (the primary key), so every tick merges into it and a past day can never count an advisor twice" },
  { table: "capacity_fill_readings", cols: "org_id,read_at,day", issue: "#4102/0198", why: "one booking pace reading per org, half hour and day (the primary key), so a rerun of a half hour inserts nothing and a day's pace never counts an interval twice" },
  { table: "capacity_fill_last", cols: "org_id,day", issue: "#4102/0198", why: "one last snapshot per org and day (the primary key), so the next reading compares with exactly one earlier one" },
  { table: "lane_runs", cols: "tick_id,lane", issue: "#4222/0205", why: "one claim per cron lane per tick (the primary key), so of any number of deliveries of a lane for one tick exactly one runs and the rest answer duplicate" },
  { table: "reminder_emails", cols: "slug", issue: "#4296/0211", why: "one reminder email per slug, so alert keys and the lane's per email records never name two emails" },
  { table: "reminder_email_versions", cols: "reminder_email_id,version", issue: "#4296/0211", why: "one copy version per number per email, so History and Restore never show two version 3s" },
  { table: "booking_reminder_sends", cols: "booking_id,reminder_email_id,sent_for", issue: "#4296/0211", why: "one send record per booking, email and start (the primary key), so a claim taken twice is refused and a lead is never emailed the same reminder twice" },
  { table: "advisor_photos", cols: "user_id", issue: "#3027/0156", why: "one photo row per user (the primary key), so the daily refresh upserts onto it and a person can never hold two pictures" },
  { table: "regal_call_ignores", cols: "user_id", issue: "#2090/0138", why: "one ignore list entry per person (the primary key), so a second add is refused rather than replacing the reason somebody wrote" },
  { table: "audit_log_chain_head", cols: "singleton", issue: "#3090/0160", why: "the ONE head of the audit_log hash chain (boolean key pinned true), so every insert locks the same row and the chain can never fork" },
  { table: "audit_log_chain_verify", cols: "singleton", issue: "#3090/0160", why: "the ONE position of the audit chain walk (boolean key pinned true), so the monitor lane resumes from a single place" },
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
  { table: "transfer_queue_days", category: "lock/counter", why: "#4380/0212: one tally row per business day, the date being the primary key, written only by record_transfer_queue_reading's upsert" },
  { table: "monitor_settings", category: "lock/counter", why: "single pinned settings row keyed by PK" },
  { table: "selfheal_scan_cursor", category: "lock/counter", why: "single scan-cursor row keyed by PK" },
  { table: "booking_failure_rate_state", category: "lock/counter", why: "#1313: one rolling-window state row keyed by a fixed text PK; the window lives in a jsonb column, not in extra rows" },
  { table: "export_cursor", category: "lock/counter", why: "one Snowflake-export watermark row per (lane, table) keyed by text PK; ~a dozen rows, #1098" },
  { table: "pilot_offer_samples", category: "growth/append-only", why: "#2927: an append only log of availability samples, two rows every quarter hour keyed by (sampled_at, system); never read as one row" },
  { table: "capacity_history_cursor", category: "lock/counter", why: "#3940: one recorded through row per organisation keyed by org_id as the PK, moved only forward by record_capacity_history" },
  { table: "lead_texting_lines", category: "lock/counter", why: "#3718: one texting line per lead keyed by the 15 character Lead id as the PK, so a second row for a lead is structurally impossible" },
  { table: "pilot_settings_samples", category: "growth/append-only", why: "#3641: an append only log of pilot split readings, one row every quarter hour keyed by sampled_at; never read as one row" },
  { table: "frame_origin_daily", category: "growth", why: "#3137: one row per (day, framing origin, booker page); capped at 200 hosts a day outside the allow list by record_frame_origins and pruned past 90 days by it" },
  { table: "api_caller_seen", category: "lock/counter", why: "#2717: one sighting row per (caller, host kind) keyed by that PK; four callers plus the canary lanes sighting (#2822), by four kinds, twenty rows at most" },
  { table: "bucket_slots", category: "lock/counter", why: "one precomputed cache row per bucket_code (PK), ~60 rows" },
  { table: "agent_links", category: "roster/config", why: "#2073: one booking link token per user, keyed by user_id as the PK, so a second row for a user is structurally impossible; bounded by the roster" },
  { table: "reason_options", category: "roster/config", why: "a few dozen reason rows keyed by (action, code) PK; config-bounded, #346" },
  // Roster / config-bounded: row count is capped by the roster or org, not by
  // booking volume or time, so duplicates are not the failure mode.
  { table: "organizations", category: "roster/config", why: "single-org PoC; bounded config table" },
  { table: "event_types", category: "roster/config", why: "a handful of booking event types per org" },
  { table: "webhook_endpoints", category: "roster/config", why: "a few configured webhook targets per org" },
  { table: "availability_rules", category: "roster/config", why: "per-schedule weekday rules, bounded by roster x 7" },
  { table: "business_hours", category: "lock/counter", why: "one org business-hours row per weekday, keyed by a 1..7 checked smallint PK; exactly seven rows forever, #1294" },
  { table: "business_hours_exceptions", category: "config", why: "one row per DATE the org overrides, keyed by the date as the PK, so a date can never be listed twice; an operator list of holidays, bounded by how many somebody types, #1363" },
  // Growth / append-only / queue: rows scale with volume or time BY DESIGN. A
  // second row is the point, not a bug (no singleton invariant applies).
  { table: "audit_log", category: "growth/append-only", why: "append-only audit trail" },
  { table: "booking_events", category: "growth/append-only", why: "append-only per-booking event log" },
  { table: "routing_decisions", category: "growth/append-only", why: "append-only routing decision log" },
  { table: "webhook_deliveries", category: "growth/append-only", why: "append-only webhook delivery attempts" },
  { table: "booking_outbox", category: "queue", why: "crash-safe mutation queue; one booking gets many rows" },
  { table: "booking_api_outcome_daily", category: "growth/append-only", why: "#418: daily outcome tally, one row per (day, outcome, bucket, error code); grows with time" },
  { table: "bulk_reassign_jobs", category: "queue", why: "#973: one coverage sweep per admin start; grows with sweeps, not a singleton" },
  { table: "bulk_reassign_items", category: "queue", why: "#973: one row per booking to move (UNIQUE(job_id, booking_id)); a job has many" },
  { table: "booking_handoffs", category: "queue", why: "#2367: a worklist of bookings waiting on a person, one OPEN row per (booking_id, kind) by a partial unique index; resolved rows stay as history, so a booking can hold many rows per kind" },
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
