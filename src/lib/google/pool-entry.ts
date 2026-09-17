import { ensureWatches, hydrateCalendar, loadAgentCalendars, markAgentsSynced } from "@/lib/google/sync";
import type { AgentCalendar } from "@/lib/db/types";
import type { WatchResult } from "@/lib/google/sync";
import { log } from "@/lib/log";

/**
 * Make an agent ready the moment they enter the bookable pool (#2302).
 *
 * The mirror of `cleanupOnPoolExit`, and it exists for the same reason: entering
 * and leaving the pool are transitions with side effects, and leaving one of them
 * to be discovered later by a rotation leaves a window nobody owns.
 *
 * WHAT THAT WINDOW COST. `bookable` is flipped by the hourly roster sync, while the
 * three things that make an agent ready happen in three other lanes on their own
 * cadences: the watch lane discovers their calendars and creates the
 * `agent_calendars` rows (every five minutes), the sync rotation does the first
 * sync (every minute), and the hydration rotation bootstraps the busy window (every
 * fifteen minutes, in a batch sized for a daily refresh). Measured 2026-09-14, four
 * agents upgraded to the Sales profile were bookable at 09:00 and not covered until
 * between 09:15 and 09:30. Throughout that window `loadMembersAvailability` read no
 * busy blocks for them, so the booker offered every hour their working hours allow
 * and round robin handed the most available looking agents a disproportionate share.
 *
 * Verify on book reads the real calendar at confirm time, so the exposure is
 * offering rather than double booking. That is the reason this is a defect and not
 * an incident, and it stops being true of nothing at cutover.
 *
 * THE ORDER IS LOAD BEARING. A brand new agent has no `agent_calendars` rows at all;
 * `ensureWatches` is what discovers them from Google. Hydrating first would find
 * nothing, report a clean run, and leave the agent exactly as uncovered.
 */
export interface PoolEntryDeps {
  ensureWatches: (userId: string) => Promise<WatchResult>;
  loadAgentCalendars: (userId: string) => Promise<AgentCalendar[]>;
  hydrateCalendar: (cal: AgentCalendar) => Promise<{ ok: boolean; events: number }>;
  markAgentsSynced: (userIds: string[]) => Promise<void>;
}

const defaultDeps: PoolEntryDeps = {
  ensureWatches,
  loadAgentCalendars,
  hydrateCalendar,
  markAgentsSynced,
};

export interface PoolEntryResult {
  /** Calendars found for the agent after the watch reconcile. */
  calendars: number;
  /** Calendars bootstrapped out to the horizon. */
  hydrated: number;
  /** Calendars whose bootstrap failed; each records its own health on its row. */
  failed: number;
  /** What the watch reconcile reported. It never throws, it answers. */
  watch: WatchResult["status"];
  /**
   * The run stopped starting work because the caller's budget was spent (#2317),
   * so some of this agent's calendars were never attempted.
   *
   * Its own field rather than folded into `failed`, because they are opposite
   * facts: a failed calendar was measured and something is wrong with it, and an
   * unattempted one was not measured at all. Scoring the second as the first
   * sends a reader to the sync lane to look for an error nobody recorded (L11).
   */
  outOfBudget: boolean;
}

export interface PoolEntryOptions {
  /**
   * False once the caller's budget for this activation is spent (#2317).
   *
   * Checked BETWEEN Google calls, never during one: it stops the run starting new
   * work and cannot interrupt a call already in flight, which is the same
   * per-calendar granularity `hydrate-calendars` has had since it shipped. Said
   * plainly because a deadline that only bounds what has not started yet is not
   * the same guarantee as one that bounds the whole wait, and the difference is
   * exactly one oversized Google request wide.
   *
   * Omitted means unbounded, so every existing caller keeps its current behaviour
   * rather than being quietly refused.
   */
  withinBudget?: () => boolean;
}

export async function onboardIntoPool(
  userId: string,
  deps: PoolEntryDeps = defaultDeps,
  opts: PoolEntryOptions = {},
): Promise<PoolEntryResult> {
  const withinBudget = opts.withinBudget ?? (() => true);

  // Before the FIRST call, not only between the later ones. The caller's budget
  // can already be spent by the time it gets here (the reachability probe and its
  // retry come first), and starting a calendar list then would be spending a
  // Google call on a run that cannot finish.
  if (!withinBudget()) {
    log.warn("pool-entry", { msg: "no budget left to start", user_id: userId });
    return { calendars: 0, hydrated: 0, failed: 0, watch: "skipped", outOfBudget: true };
  }

  const watch = await deps.ensureWatches(userId);
  if (watch.status === "error" || watch.status === "skipped") {
    // Said, not swallowed, and NOT a reason to stop. An agent who already has
    // calendar rows can have a renewal fail while every one of those calendars is
    // perfectly readable, and the bootstrap below is the half that fills the cache.
    // A brand new agent simply comes back with no calendars and is reported as such.
    log.warn("pool-entry", { msg: "watch reconcile did not complete", user_id: userId, watch: watch.status });
  }

  const cals = await deps.loadAgentCalendars(userId);
  let hydrated = 0;
  let failed = 0;
  let outOfBudget = false;
  for (const cal of cals) {
    if (!withinBudget()) {
      outOfBudget = true;
      break;
    }
    // Each calendar is its own failure boundary (L73). One that throws must not
    // abandon the ones behind it: they are unrelated repairs and the caller would
    // see a single error standing for all of them.
    try {
      const res = await deps.hydrateCalendar(cal);
      if (res.ok) hydrated += 1;
      else failed += 1;
    } catch (err) {
      failed += 1;
      log.error("pool-entry", { msg: "bootstrap failed", user_id: userId, calendar_id: cal.calendar_id }, err);
    }
  }

  // Only on a real success, and only on a COMPLETE one (#2317). `users.last_synced_at`
  // is what the staleness gauge reads, so stamping it after a run that achieved
  // nothing would hand the agent a fresh age and buy fifteen minutes of silence about
  // an empty cache, which is the window this whole change exists to close. A run the
  // budget cut short is the same thing one calendar at a time: part of the cache is
  // built and part of it was never attempted, and a fresh age over that is a claim
  // nobody measured. Left unstamped, the rotation still sorts them first and the
  // monitors still see a never synced agent, correctly.
  if (hydrated > 0 && !outOfBudget) await deps.markAgentsSynced([userId]);

  log.info("pool-entry", {
    msg: "onboarded",
    user_id: userId,
    watch: watch.status,
    calendars: cals.length,
    hydrated,
    failed,
    out_of_budget: outOfBudget,
  });
  return { calendars: cals.length, hydrated, failed, watch: watch.status, outOfBudget };
}
