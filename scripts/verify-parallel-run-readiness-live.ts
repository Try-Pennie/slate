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
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireSupabaseCredentials } from "./lib/supabase-credentials.ts";

const creds = requireSupabaseCredentials();
if (!creds) process.exit(1);

const { supabaseAdmin } = await import("@/lib/supabase/admin");
const { unwrap } = await import("@/lib/db/result");
const { eligibleAgentIds } = await import("@/lib/availability/service");
const { withoutLowCarriers } = await import("@/lib/availability/low-exclusion");
const { emptyBuckets: emptyBucketCodes } = await import("@/lib/availability/bucket-coverage");
type BucketCoverage = import("@/lib/availability/bucket-coverage").BucketCoverage;
const { uncoveredCalendars, calendarWindowRow, CALENDAR_WINDOW_COLUMNS } = await import("@/lib/monitor/calendar-window-coverage");
type CalendarWindowSourceRow = import("@/lib/monitor/calendar-window-coverage").CalendarWindowSourceRow;
const { MONITOR_DEFAULTS } = await import("@/lib/monitor/settings");
const { CANARY_STALE_BOUNDS_MS } = await import("@/lib/monitor/health");
const { readHeartbeatMs } = await import("@/lib/monitor/heartbeat");
const { isAlertFiring } = await import("@/lib/notify/dispatch");
const { loadBookingHorizonDays } = await import("@/lib/booking/settings");
const { agentsOnUnsetHours, groupRulesBySchedule } = await import("@/lib/monitor/unset-hours");
const { loadTierAgentCounts } = await import("@/lib/monitor/tier-staffing-load");
const { DEBT_TIER } = await import("@/lib/xbc");
const { CALLER_HOST_KINDS } = await import("@/lib/booking/caller-seen");
const { BOOKING_API_CALLERS } = await import("@/lib/booking/api-auth");
type CallerSeenRow = import("@/lib/booking/caller-seen").CallerSeenRow;
const { judgeReadiness, parityDriftFromSummary, pickParityRun, ghFailureReason } = await import("./lib/parallel-run-readiness.ts");
type ReadinessFacts = import("./lib/parallel-run-readiness.ts").ReadinessFacts;
type ParityDriftDetail = import("./lib/parallel-run-readiness.ts").ParityDriftDetail;
/** Where the daily lane runs, and what it keeps (`.github/workflows/schedule-parity.yml`). */
const PARITY_REPO = "Try-Pennie/slate";
const PARITY_ARTIFACT = "parity-summary";
type LowVolumeArmingFacts = import("./lib/parallel-run-readiness.ts").LowVolumeArmingFacts;
const { measurePageSources } = await import("@/lib/monitor/customer-bookings");
const { loadBusinessHours } = await import("@/lib/booking/business-hours-load");
const { holidayDatesToDecide, uncoveredHolidays } = await import("@/lib/booking/us-federal-holidays");
const { DateTime } = await import("luxon");
/**
 * How far ahead the holiday check looks (#2767): about a quarter, so a run on any
 * day sees at least the next two holidays, and one added now has time to be decided.
 */
const HOLIDAY_WINDOW_DAYS = 90;

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

// #2875: whether cal.com is retired decides whether anything below is judged at all.
// `loadCalcomRetired` answers null on a failed read rather than throwing.
const { loadCalcomRetired } = await import("@/lib/calcom/retirement");
const calcomRetired = await loadCalcomRetired();

const lastRunMs = await section("parity heartbeat", () => readHeartbeatMs("schedule-parity"));
const drifting = await section("drift alert state", () => isAlertFiring("schedule_parity_drift"));

/**
 * Who drifted (#2089), from the summary the daily lane kept as its run's
 * `parity-summary` artifact, never by re-running the four minute sweep. Asked only
 * while the alert is firing, and every way it can fail becomes a reason in the
 * finding rather than an unreadable section: the drift is measured either way, and
 * only the names are missing.
 */
function readParityDrift(): ParityDriftDetail {
  if (drifting !== true) return { kind: "unavailable", why: "the comparison is not reporting drift" };
  const gh = (args: string[]): string =>
    execFileSync("gh", ["-R", PARITY_REPO, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
  let runs: { id: number; updatedAtMs: number; url: string }[];
  try {
    const listed = JSON.parse(
      gh(["run", "list", "--workflow", "schedule-parity.yml", "--status", "success", "--limit", "5", "--json", "databaseId,updatedAt,url"]),
    ) as { databaseId: number; updatedAt: string; url: string }[];
    runs = listed
      .map((r) => ({ id: r.databaseId, updatedAtMs: Date.parse(r.updatedAt), url: r.url }))
      .filter((r) => Number.isFinite(r.updatedAtMs));
  } catch (err) {
    return { kind: "unavailable", why: `the schedule parity runs could not be listed with gh (${ghFailureReason(err)})` };
  }
  const run = pickParityRun(runs, lastRunMs);
  if ("why" in run) return { kind: "unavailable", why: run.why };
  const dir = mkdtempSync(join(tmpdir(), "parity-summary-"));
  try {
    gh(["run", "download", String(run.id), "-n", PARITY_ARTIFACT, "-D", dir]);
    return parityDriftFromSummary(JSON.parse(readFileSync(join(dir, "parity-summary.json"), "utf8")), run.url);
  } catch (err) {
    return { kind: "unavailable", why: `run ${run.url} kept no readable ${PARITY_ARTIFACT} artifact (${ghFailureReason(err)})` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const parityDrift = readParityDrift();

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
    await db.from("agent_calendars").select(CALENDAR_WINDOW_COLUMNS).in("user_id", ids),
    "agent_calendars",
  ) ?? []) as CalendarWindowSourceRow[];
  const byUser = new Map(agents.map((a) => [a.id, a]));
  const withRow = new Set(cals.map((c) => c.user_id));
  const missingRows = agents.filter((a) => !withRow.has(a.id)).map((a) => a.email);
  const horizonDays = await loadBookingHorizonDays();
  const uncovered = uncoveredCalendars({
    rows: cals.map((c) => calendarWindowRow(c, byUser.get(c.user_id))),
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
    const { ids, lowIds } = await eligibleAgentIds(b as never);
    coverage.push({
      code: b.code,
      eligibleCount: ids.length,
      // #2842: what a top tier lead's cascade may use from this bucket.
      eligibleWithoutLowCount: withoutLowCarriers(ids, lowIds).length,
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
  const rulesBySchedule = groupRulesBySchedule(rules);
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

// #2717: which hosts trypennie's key has authenticated from. Only the callers the
// authorizer knows, so rows left by the retired shared key (#2865) take no place. At
// most one row per caller and host kind, so the limit is the whole key space and the
// read can never be long.
const partnerKey = await section("partner key sightings", async () => {
  const rows = (unwrap(
    await db
      .from("api_caller_seen")
      .select("caller, host_kind, last_seen_at, method, origin")
      .in("caller", [...BOOKING_API_CALLERS])
      .limit(BOOKING_API_CALLERS.length * CALLER_HOST_KINDS.length),
    "api_caller_seen",
  ) ?? []) as CallerSeenRow[];
  return { caller: "trypennie", rows };
});

// #2767: what arming the low volume alarms (#1956, #2738) depends on. Each read is
// the alarm's own: its arming switch, its own "has this page recorded anything"
// lookup over its own lookback, and the org hours the alarms judge an open hour by.
const armedState = await section("low volume arming switch", async () => {
  const row = unwrap(
    await db.from("monitor_alert_config").select("low_volume_armed").eq("id", 1).maybeSingle(),
    "monitor_alert_config",
  ) as { low_volume_armed: boolean | null } | null;
  const stored = row?.low_volume_armed ?? null;
  return stored === true ? "armed" : stored === false ? "disarmed" : "unset";
}) as LowVolumeArmingFacts["armed"];

// #2765: the same measurement /admin/alerts shows in place of the per page floors.
const pageSources = await section("Low page booking sources", () => measurePageSources(db, nowMs));

const holidays = await section("holiday exceptions", async () => {
  const hours = await loadBusinessHours();
  const todayIso = DateTime.fromMillis(nowMs).setZone(hours.zone).toISODate();
  if (!todayIso) throw new Error("today's date in the business zone is unreadable");
  const openWeekdays = hours.rules.map((r) => r.weekday);
  return {
    windowDays: HOLIDAY_WINDOW_DAYS,
    checked: holidayDatesToDecide(todayIso, HOLIDAY_WINDOW_DAYS).length,
    uncovered: uncoveredHolidays({
      todayIso,
      windowDays: HOLIDAY_WINDOW_DAYS,
      openWeekdays,
      exceptionDates: hours.exceptions.map((e) => e.on_date),
    }),
  };
});

const facts: ReadinessFacts = {
  nowMs,
  stretchedCooldowns,
  parity: { lastRunMs, boundMs: CANARY_STALE_BOUNDS_MS["schedule-parity"], drifting, drift: parityDrift },
  pendingBookable,
  calendars,
  emptyBuckets,
  emptyTiers,
  unsetHours,
  partnerKey,
  lowVolumeArming: { armed: armedState, pageSources, holidays },
  calcomRetired,
};
const verdict = judgeReadiness(facts);
console.log(verdict.summary);
process.exit(verdict.exit);
