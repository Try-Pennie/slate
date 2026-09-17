// Is the shadow run trustworthy today? Run: pnpm verify:parallel-run-readiness (#2066)
//
// Reads production, writes nothing. Judgement is in lib/parallel-run-readiness.ts
// and pinned by scripts/test-parallel-run-readiness.ts; this file only gathers the
// facts, each through the code that already owns that fact rather than a query
// written beside it (L107): the empty bucket alarm's own eligibility predicate, the
// hydration monitor's own coverage judge, the monitor settings' own defaults.
//
// Exit codes are READINESS_EXIT, plus 1 for "no credentials here", decided before
// anything is read so it can never be confused with a finding.
import { loadEnvFiles } from "./smoke-env.ts";

loadEnvFiles([".env.local", ".dev.vars"]);
if (!process.env.SUPABASE_SECRET_KEY?.trim() || !process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()) {
  console.error("FAILED (not-configured): SUPABASE_SECRET_KEY and NEXT_PUBLIC_SUPABASE_URL are needed here; nothing was read");
  process.exit(1);
}

const { supabaseAdmin } = await import("@/lib/supabase/admin");
const { unwrap } = await import("@/lib/db/result");
const { eligibleAgentIds } = await import("@/lib/availability/service");
const { emptyBuckets: emptyBucketCodes } = await import("@/lib/availability/bucket-coverage");
type BucketCoverage = import("@/lib/availability/bucket-coverage").BucketCoverage;
const { uncoveredCalendars } = await import("@/lib/monitor/calendar-window-coverage");
const { MONITOR_DEFAULTS } = await import("@/lib/monitor/settings");
const { CANARY_STALE_BOUNDS_MS } = await import("@/lib/monitor/health");
const { readHeartbeatMs } = await import("@/lib/monitor/heartbeat");
const { isAlertFiring } = await import("@/lib/notify/dispatch");
const { loadBookingHorizonDays } = await import("@/lib/booking/settings");
const { agentsOnUnsetHours } = await import("@/lib/monitor/unset-hours");
const { loadTierAgentCounts } = await import("@/lib/monitor/tier-staffing-load");
const { DEBT_TIER } = await import("@/lib/xbc");
const { judgeReadiness } = await import("./lib/parallel-run-readiness.ts");
type ReadinessFacts = import("./lib/parallel-run-readiness.ts").ReadinessFacts;

const db = supabaseAdmin();
const nowMs = Date.now();

/** A section that throws becomes null, which the judge reports as unreadable. */
async function section<T>(label: string, read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    console.error(`could not read ${label}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

const stretchedCooldowns = await section("alert cooldowns", async () => {
  const rows = (unwrap(await db.from("monitor_settings").select("key, cooldown_min"), "monitor_settings") ??
    []) as { key: string; cooldown_min: number | null }[];
  const defaults = MONITOR_DEFAULTS.cooldownMs as Record<string, number>;
  return rows
    .filter((r) => r.cooldown_min !== null && r.key in defaults && r.cooldown_min * 60_000 > defaults[r.key])
    .map((r) => ({ key: r.key, minutes: r.cooldown_min as number, defaultMinutes: defaults[r.key] / 60_000 }));
});

const lastRunMs = await section("parity heartbeat", () => readHeartbeatMs("schedule-parity"));
const drifting = await section("drift alert state", () => isAlertFiring("schedule_parity_drift"));

const pendingBookable = await section("pending bookable flips", async () => {
  const rows = (unwrap(
    await db.from("users").select("email").not("bookable_pending_since", "is", null).is("deactivated_at", null),
    "pending flips",
  ) ?? []) as { email: string }[];
  return rows.map((r) => r.email);
});

const calendars = await section("calendars", async () => {
  const agents = (unwrap(
    await db.from("users").select("id, email, name").eq("bookable", true).is("deactivated_at", null).eq("is_test", false),
    "bookable agents",
  ) ?? []) as { id: string; email: string; name: string | null }[];
  if (agents.length === 0) return { bookableAgents: 0, missingRows: [], uncovered: [] };
  const ids = agents.map((a) => a.id);
  // cap-safe: one row per (agent, calendar) for a roster bounded at ~200 agents
  const cals = (unwrap(
    await db.from("agent_calendars").select("user_id, calendar_id, sync_window_to").in("user_id", ids),
    "agent_calendars",
  ) ?? []) as { user_id: string; calendar_id: string; sync_window_to: string | null }[];
  const byUser = new Map(agents.map((a) => [a.id, a]));
  const withRow = new Set(cals.map((c) => c.user_id));
  const missingRows = agents.filter((a) => !withRow.has(a.id)).map((a) => a.email);
  const horizonDays = await loadBookingHorizonDays();
  const uncovered = uncoveredCalendars({
    rows: cals.map((c) => ({
      userId: c.user_id,
      name: byUser.get(c.user_id)?.name ?? null,
      email: byUser.get(c.user_id)?.email ?? null,
      calendarId: c.calendar_id,
      syncWindowToIso: c.sync_window_to,
    })),
    horizonDays,
    nowIso: new Date(nowMs).toISOString(),
  }).map((r) => `${r.email ?? r.userId} (${r.calendarId})`);
  return { bookableAgents: agents.length, missingRows, uncovered };
});

const emptyBuckets = await section("buckets", async () => {
  const buckets = (unwrap(await db.from("buckets").select("*").eq("is_test", false), "buckets") ?? []) as {
    code: string;
  }[];
  // Counted per bucket, then judged by the SAME predicate the hourly page uses
  // (#2483), rather than by a `ids.length === 0` written beside it (L107). It
  // used to ask per code, so the Low plus Beyond codes 120, 121 and 122 made this
  // gate exit 4 on the flip morning about three buckets that are correct: no Low
  // agent carries the Beyond backend, and a Beyond lead overflows to Achieve
  // (#1909). Sharing the predicate is also what stops the two drifting, which
  // here would mean the gate and the alarm disagreeing about whether the roster
  // can take a lead.
  const coverage: BucketCoverage[] = [];
  for (const b of buckets) {
    const { ids } = await eligibleAgentIds(b as never);
    coverage.push({
      code: b.code,
      eligibleCount: ids.length,
      // The pool grouping is what the PAGE uses to fold six codes into one
      // finding. This gate names codes, so each stands alone here.
      poolKey: b.code,
      poolLabel: null,
    });
  }
  return { realBuckets: buckets.length, empty: emptyBucketCodes(coverage).sort() };
});

// #2505: the question the gate could not answer before. Asked of the same
// criteria-only predicate the monitor lane's alarm uses, so the gate and the
// alarm cannot drift on what "this tier has nobody" means (L107).
const emptyTiers = await section("debt tiers", async () => {
  const counts = await loadTierAgentCounts();
  return {
    measuredTiers: counts.size,
    empty: [...counts.entries()]
      .filter(([, n]) => n <= 0)
      .map(([tier]) => DEBT_TIER[tier]?.label ?? tier)
      .sort(),
  };
});

const unsetHours = await section("hours sources", async () => {
  const agents = (unwrap(
    await db.from("users").select("id, email, name").eq("bookable", true).is("deactivated_at", null).eq("is_test", false),
    "bookable agents",
  ) ?? []) as { id: string; email: string; name: string | null }[];
  if (agents.length === 0) return [];
  const org = unwrap(
    await db.from("organizations").select("default_timezone, default_start_minute, default_end_minute, default_weekdays").limit(1).maybeSingle(),
    "org defaults",
  ) as { default_timezone: string; default_start_minute: number; default_end_minute: number; default_weekdays: number[] } | null;
  if (!org) throw new Error("no organization row");
  // cap-safe: one schedule per agent, roster bounded at ~200
  const scheds = (unwrap(
    await db.from("availability_schedules").select("id, user_id, timezone, hours_source, hours_set_at, created_at").in("user_id", agents.map((a) => a.id)),
    "schedules",
  ) ?? []) as {
    id: string;
    user_id: string;
    timezone: string;
    hours_source: "seed" | "agent" | "admin" | "calcom-import" | null;
    hours_set_at: string | null;
    created_at: string;
  }[];
  // cap-safe: at most seven rules per schedule for a roster bounded at ~200
  const rules = (unwrap(
    await db.from("availability_rules").select("schedule_id, weekday, start_minute, end_minute").in("schedule_id", scheds.map((s) => s.id)),
    "rules",
  ) ?? []) as { schedule_id: string; weekday: number; start_minute: number; end_minute: number }[];
  const rulesBySchedule = new Map<string, typeof rules>();
  for (const r of rules) rulesBySchedule.set(r.schedule_id, [...(rulesBySchedule.get(r.schedule_id) ?? []), r]);
  return agentsOnUnsetHours({
    org,
    agents,
    schedules: scheds.map((s) => ({
      user_id: s.user_id,
      timezone: s.timezone,
      hours_source: s.hours_source,
      hours_set_at: s.hours_set_at,
      created_at: s.created_at,
      rules: rulesBySchedule.get(s.id) ?? [],
    })),
    // No grace here, deliberately: the Slack alert waits two days because it
    // arrives daily and unbidden, while this is run at a chosen moment before real
    // leads are sent, and an agent seeded yesterday is offered on coincidence hours
    // just the same.
  }).map((a) => a.email ?? a.id);
});

const facts: ReadinessFacts = {
  nowMs,
  stretchedCooldowns,
  parity: { lastRunMs, boundMs: CANARY_STALE_BOUNDS_MS["schedule-parity"], drifting },
  pendingBookable,
  calendars,
  emptyBuckets,
  emptyTiers,
  unsetHours,
};
const verdict = judgeReadiness(facts);
console.log(verdict.summary);
process.exit(verdict.exit);
