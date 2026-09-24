// Import an agent's cal.com week the moment they become bookable (#2627).
//
// WHY. A hire is seeded with the org default week (Mon to Fri 08:00 to 17:00
// Eastern) and their real week arrived only with the daily importer at 12:20 UTC.
// Measured 2026-09-22: nshort@ (Los Angeles, 07:00 to 16:00 local) was flipped
// bookable at 19:58 UTC and sat on the Eastern default until an on demand run at
// 20:03. On an ordinary day that gap is up to 24 hours, during which the booker
// offers a West Coast agent at 05:00 their time.
//
// So the activation gate, once the calendar has been admitted and BEFORE the
// bookable write, asks cal.com for this one agent's week and writes it through the
// importer's own mapping (`planImportedWeek`) and write (`writeImportedWeek`), so the
// agent enters the pool on the right hours rather than being corrected into them.
//
// ONLY A SEEDED WEEK IS REPLACED. The rule is `isUnsetHours`, the same predicate the
// unset hours alert and the readiness command use: a week stamped `seed`, or an
// unstamped one (written before migration 0117) still shaped exactly like the org
// default, zone included. Anything an agent or an admin wrote, and anything the
// importer already wrote, is left alone and cal.com is not even asked. That is
// deliberately stricter than the daily importer's `hoursOverwriteRefusal`, which
// overwrites an admin's edit (Dan, 2026-09-10): a person pressing Activate after
// setting somebody's hours by hand must not watch them change in the same click,
// and the daily run, whose rule is Dan's, is still what keeps them in step.
//
// IT NEVER BLOCKS ACTIVATION. Every way it can fail, cal.com refusing, rate
// limiting, not knowing the person, holding no schedule, answering something
// unreadable, a Slate read or write refused, leaves the seeded week, logs its own
// reason, and returns. The daily importer repairs the week, and the unset hours
// alert names the agent if it does not. Being bookable on the seeded week is the
// state every agent was in before this existed; refusing the activation over it
// would trade a wrong hour for no hours at all.
//
// IT IS BOUNDED. At most two cal.com calls, each with a deadline no longer than
// half of what is left of `ACTIVATION_BUDGET_MS`, no retry, and a write only if the
// budget has not run out while reading.
//
// Retires with the importer at cutover (#65), when agents set their own hours in
// Slate (#2350).
import type { OrgDefaults } from "@/lib/schedule-core";
import { isUnsetHours, type UnsetHoursSchedule } from "@/lib/monitor/unset-hours";
import { diffSchedule, planImportedWeek, type SlateRule } from "@/lib/calcom/schedule-import";
import { readScheduleForImport, type ScheduleForImportRead } from "@/lib/calcom/client";
import { writeImportedWeek } from "@/lib/calcom/import-write";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { log, type LogFields, type LogTag } from "@/lib/log";

/** The week Slate holds for the agent, with who wrote it. */
export type StoredWeek = UnsetHoursSchedule;

/**
 * Why a week was NOT imported. One word per cause, and no two causes share one,
 * because each sends a different person to do a different thing (L11).
 */
export type ActivationHoursReason =
  /** Somebody set this week (agent, admin, a previous import), so it is left alone. */
  | "hours-already-set"
  /** No schedule row, or one holding no rules: the default fill's finding, not ours. */
  | "no-schedule-row"
  /** No cal.com key or org in this deployment. */
  | "calcom-not-configured"
  /** Refused under the load test environment (#2335). */
  | "loadtest"
  | "no-calcom-account"
  | "no-calcom-schedule"
  | "calcom-rate-limited"
  | "calcom-refused"
  | "calcom-unreachable"
  | "calcom-unreadable"
  /** cal.com's week is one the mapping or Slate's validator refuses. */
  | "schedule-not-importable"
  /** Not enough of the activation budget left to read, or it ran out while reading. */
  | "out-of-budget"
  /** Slate could not read the stored week or the org default that judges it. */
  | "slate-read-failed"
  | "write-failed";

export type ActivationHoursOutcome =
  | { kind: "imported"; timezone: string; rules: number; changes: string[] }
  | { kind: "skipped"; reason: ActivationHoursReason; detail: string };

export interface ActivationHoursDeps {
  /** The agent's schedule row and rules; null when they have no row. Throws on a failed read. */
  loadWeek: (userId: string) => Promise<StoredWeek | null>;
  /** The org default, read ONLY to judge an unstamped row. Throws on a failed read. */
  loadOrgDefaults: (userId: string) => Promise<OrgDefaults | null>;
  /** One agent's default cal.com schedule; never throws. */
  readCalcom: (email: string, timeoutMs: number) => Promise<ScheduleForImportRead>;
  /** The importer's write. Throws on a refused write or a wrong count. */
  writeWeek: (userId: string, week: { timezone: string; rules: SlateRule[] }) => Promise<void>;
  /** Milliseconds left of the activation budget. */
  remainingMs: () => number;
  log: {
    info: (tag: LogTag, fields: LogFields) => void;
    warn: (tag: LogTag, fields: LogFields) => void;
  };
}

/** The longest one cal.com call may take. cal.com answers these in well under a second. */
export const CALCOM_CALL_TIMEOUT_MS = 4_000;
/** Below this much budget there is no point starting: two calls cannot both fit. */
export const MIN_IMPORT_BUDGET_MS = 1_000;

const TAG = "bookable-api";

/** Reasons that are a normal state rather than a week left wrong. */
const QUIET: ReadonlySet<ActivationHoursReason> = new Set([
  "hours-already-set",
  "calcom-not-configured",
  "loadtest",
]);

const CALCOM_REASON: Record<Exclude<ScheduleForImportRead["kind"], "schedule">, ActivationHoursReason> = {
  "not-configured": "calcom-not-configured",
  loadtest: "loadtest",
  "no-account": "no-calcom-account",
  "no-schedule": "no-calcom-schedule",
  "rate-limited": "calcom-rate-limited",
  refused: "calcom-refused",
  unreachable: "calcom-unreachable",
  unreadable: "calcom-unreadable",
};

function calcomDetail(read: Exclude<ScheduleForImportRead, { kind: "schedule" }>): string {
  switch (read.kind) {
    case "refused":
      return `cal.com answered ${read.status}`;
    case "unreachable":
      return `cal.com could not be reached: ${read.detail.slice(0, 120)}`;
    case "unreadable":
      return read.why;
    default:
      return read.kind;
  }
}

/**
 * Import this one agent's cal.com week if Slate still holds the seeded default.
 * Never throws; the outcome says what happened and has already been logged.
 */
export async function importHoursOnActivation(
  agent: { id: string; email: string },
  deps: ActivationHoursDeps,
): Promise<ActivationHoursOutcome> {
  const skip = (reason: ActivationHoursReason, detail: string): ActivationHoursOutcome => {
    // A warn is a week left on the seed that the daily importer now has to repair;
    // the quiet reasons are states nobody needs to act on.
    const emit = QUIET.has(reason) ? deps.log.info : deps.log.warn;
    emit(TAG, { msg: "calcom hours not imported on activation", user_id: agent.id, reason, detail });
    return { kind: "skipped", reason, detail };
  };

  const budget = deps.remainingMs();
  if (budget < MIN_IMPORT_BUDGET_MS) {
    return skip("out-of-budget", `${Math.max(0, Math.round(budget))}ms of the activation budget left`);
  }

  let stored: StoredWeek | null;
  try {
    stored = await deps.loadWeek(agent.id);
  } catch (err) {
    return skip("slate-read-failed", `schedule: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (stored === null) return skip("no-schedule-row", "the agent has no availability_schedules row");
  if (stored.rules.length === 0) return skip("no-schedule-row", "the agent's schedule holds no rules");

  // The org default is needed only to judge a row written before the stamp existed.
  let org: OrgDefaults | null = null;
  if (stored.hours_source === null) {
    try {
      org = await deps.loadOrgDefaults(agent.id);
    } catch (err) {
      return skip("slate-read-failed", `org defaults: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (org === null) return skip("slate-read-failed", "org defaults: no organization row");
  }
  // `org` is unused by `isUnsetHours` for a stamped row, which is the only case it is null here.
  if (!isUnsetHours(stored, org as OrgDefaults)) {
    return skip(
      "hours-already-set",
      stored.hours_source === null ? "an unstamped week that is not the org default" : `hours_source is ${stored.hours_source}`,
    );
  }

  // Re-read, never reuse `budget`: the Slate reads above spent some of it, and a
  // deadline derived from the opening reading would let the cal.com read outlive the
  // bound. Each call gets at most half of what is left NOW, so both together fit.
  const left = deps.remainingMs();
  if (left < MIN_IMPORT_BUDGET_MS) {
    return skip("out-of-budget", `${Math.max(0, Math.round(left))}ms left after reading the stored week`);
  }
  const timeoutMs = Math.min(CALCOM_CALL_TIMEOUT_MS, Math.floor(left / 2));
  const read = await deps.readCalcom(agent.email, timeoutMs);
  if (read.kind !== "schedule") return skip(CALCOM_REASON[read.kind], calcomDetail(read));

  // The importer's own reading of a cal.com week: mapping, empty check, validator.
  const plan = planImportedWeek(read.schedule);
  if (!plan.ok) return skip("schedule-not-importable", plan.why);

  if (deps.remainingMs() <= 0) return skip("out-of-budget", "the budget ran out while reading cal.com");

  try {
    await deps.writeWeek(agent.id, { timezone: plan.timezone, rules: plan.rules });
  } catch (err) {
    return skip("write-failed", err instanceof Error ? err.message : String(err));
  }
  // Written even when the week already matched, so the stamp says cal.com confirmed
  // it rather than leaving a coincidentally correct seed reading as unset.
  const { reasons } = diffSchedule({ timezone: stored.timezone, rules: stored.rules }, plan);
  deps.log.info(TAG, {
    msg: "calcom hours imported on activation",
    user_id: agent.id,
    outcome: "imported",
    timezone: plan.timezone,
    rules: plan.rules.length,
    changes: reasons.length ? reasons.join("; ") : "none, the seeded week already matched",
  });
  return { kind: "imported", timezone: plan.timezone, rules: plan.rules.length, changes: reasons };
}

/**
 * The production wiring. `remainingMs` comes from the activation gate's own deadline,
 * so this and the calendar reads before it spend ONE budget between them.
 */
export function defaultActivationHoursDeps(remainingMs: () => number): ActivationHoursDeps {
  return {
    loadWeek: async (userId) => {
      const db = supabaseAdmin();
      const sched = unwrap(
        await db
          .from("availability_schedules")
          .select("id, user_id, timezone, hours_source, hours_set_at, created_at")
          .eq("user_id", userId)
          .maybeSingle(),
        "activation hours schedule",
      ) as (Omit<StoredWeek, "rules"> & { id: string }) | null;
      if (sched === null) return null;
      const rules = unwrap(
        await db
          .from("availability_rules")
          .select("weekday, start_minute, end_minute")
          .eq("schedule_id", sched.id)
          // cap-safe: one agent's week, at most a few windows per weekday
          .limit(200),
        "activation hours rules",
      ) as StoredWeek["rules"] | null;
      const { id: _id, ...row } = sched;
      return { ...row, rules: rules ?? [] };
    },
    loadOrgDefaults: async (userId) => {
      const db = supabaseAdmin();
      const user = unwrap(
        await db.from("users").select("org_id").eq("id", userId).maybeSingle(),
        "activation hours org id",
      ) as { org_id: string } | null;
      if (user === null) return null;
      return unwrap(
        await db
          .from("organizations")
          .select("default_timezone, default_start_minute, default_end_minute, default_weekdays")
          .eq("id", user.org_id)
          .maybeSingle(),
        "activation hours org defaults",
      ) as OrgDefaults | null;
    },
    readCalcom: readScheduleForImport,
    writeWeek: (userId, week) => writeImportedWeek(supabaseAdmin(), userId, week),
    remainingMs,
    log,
  };
}
