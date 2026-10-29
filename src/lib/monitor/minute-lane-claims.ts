/**
 * What `lane_runs` says about the every minute lanes (2026-10-29).
 *
 * On 2026-10-29 Cloudflare delivered no `* * * * *` tick from 4:52 to 5:06 AM ET while
 * every other schedule on the Worker fired, so sync, recompute, outbox and selfheal (and
 * the reroute hold sweep inside it) stood still for 14 minutes. The same signature showed
 * on 2026-10-26 during Cloudflare's "Delayed, missed, and duplicated Workers Cron
 * Triggers" incident, and in a dozen shorter gaps on 2026-10-27 with no incident open.
 * Nothing in Slate failed: the Worker was never invoked for that trigger.
 *
 * Every scheduled lane claims `(tick id, lane)` in `lane_runs` before any work (#4222),
 * so the table answers two questions here, both pure over rows already read:
 *
 * 1. WHICH every minute lanes are overdue (`overdueMinuteLanes`): no claim in the last
 *    three minutes. The five minute tick starts exactly those (worker/lane-backstop.ts).
 *    A lane claims at its START, so a lane that is running, or ran in the last three
 *    minutes, holds a recent claim and is never started; a lane still running after
 *    three minutes is refused by its own lock when the backstop's request reaches it.
 *    Any claim counts, the backstop's own included, so the backstop never starts a lane
 *    it started itself five minutes ago unless that one is also three minutes old.
 *
 * 2. WHETHER Cloudflare is delivering the trigger (`minuteTriggerReading`), for the lanes
 *    page. A delivery of the every minute trigger is a tick whose claims are ALL every
 *    minute lanes. The backstop runs inside a five minute tick, so its claims share a
 *    tick id with that tick's own lanes (complete, watch, monitor...) and are never read
 *    as a delivery: a backstop doing its job must not make the page say the trigger is
 *    fine. Read by tick id rather than by a mark on the row because the tick id scheme is
 *    #4363's to change, and this must keep working whichever way that goes.
 */
import { CRON_ROUTES, MINUTE_CRON } from "../../../worker/cron-routes.ts";
import { laneFieldName } from "./lane-timing.ts";
import { parseStampMs } from "../date/stamp.ts";

/** The routes the every minute trigger drives, derived from the schedule. */
export const MINUTE_LANE_PATHS: readonly string[] = (() => {
  const value = CRON_ROUTES[MINUTE_CRON];
  return Array.isArray(value) ? value : value ? [value] : [];
})();

const MINUTE_LANE_NAMES: ReadonlySet<string> = new Set(MINUTE_LANE_PATHS.map(laneFieldName));

/**
 * A lane with no claim this recent is overdue. Three minutes is three missed ticks: one
 * late tick (Cloudflare delivered 4:51's at 4:51:57) never starts a second run, and the
 * five minute backstop still reaches a lane well inside its 10 minute stale bound.
 */
export const MINUTE_LANE_OVERDUE_MS = 3 * 60_000;

/** How far back the backstop's check reads. Wider than the overdue line, so a lane with
 *  no row in the window has provably not claimed inside the line. About 55 rows. */
export const BACKSTOP_CHECK_WINDOW_MS = 10 * 60_000;

/** How far back the lanes page reads to name when the trigger was last delivered. Two
 *  hours is about 640 rows of the table's 7,600 a day, inside one 1,000 row page. */
export const TRIGGER_READING_WINDOW_MS = 2 * 60 * 60_000;

/** The largest page the readers ask for; a full page is read as cut short. */
export const CLAIM_READ_LIMIT = 1000;

/** One `lane_runs` row as the readers select it. */
export interface LaneClaimRow {
  tick_id: string;
  lane: string;
  claimed_at: string;
}

/**
 * The every minute lanes with no claim at or after `now - MINUTE_LANE_OVERDUE_MS`.
 * `rows` must cover at least `BACKSTOP_CHECK_WINDOW_MS`. A lane with an unreadable stamp
 * is neither overdue nor fine: it is named in `unreadable` and NOT started, because an
 * unreadable stamp cannot prove the lane did not just run.
 */
export function overdueMinuteLanes(
  rows: readonly LaneClaimRow[],
  nowMs: number,
): { overdue: string[]; unreadable: string[] } {
  const latest = new Map<string, number>();
  const unreadableLanes = new Set<string>();
  for (const r of rows) {
    if (!MINUTE_LANE_NAMES.has(r.lane)) continue;
    const ms = parseStampMs(r.claimed_at);
    if (ms === null) {
      unreadableLanes.add(r.lane);
      continue;
    }
    latest.set(r.lane, Math.max(latest.get(r.lane) ?? -Infinity, ms));
  }
  const overdue: string[] = [];
  const unreadable: string[] = [];
  for (const path of MINUTE_LANE_PATHS) {
    const lane = laneFieldName(path);
    if (unreadableLanes.has(lane)) {
      unreadable.push(path);
      continue;
    }
    const last = latest.get(lane);
    if (last === undefined || nowMs - last > MINUTE_LANE_OVERDUE_MS) overdue.push(path);
  }
  return { overdue, unreadable };
}

/**
 * Whether Cloudflare is delivering the every minute trigger, as `lane_runs` records it.
 *
 * - `delivered`: a tick that claimed only every minute lanes did so inside the overdue
 *   line, so the trigger is arriving and a quiet lane is a run that failed.
 * - `silent`: no such tick inside the line. `sinceMs` is the last one in the window read,
 *   or null when the window held none at all.
 * - `unknown`: the read was cut short (a full page) and found no delivery, so the last
 *   delivery may sit in rows that were never read. Claims nothing.
 */
export type MinuteTriggerReading =
  | { kind: "delivered"; lastMs: number }
  | { kind: "silent"; sinceMs: number | null }
  | { kind: "unknown" };

export function minuteTriggerReading(
  rows: readonly LaneClaimRow[],
  nowMs: number,
  read: { truncated: boolean },
): MinuteTriggerReading {
  const byTick = new Map<string, { onlyMinute: boolean; latestMs: number | null }>();
  for (const r of rows) {
    const entry = byTick.get(r.tick_id) ?? { onlyMinute: true, latestMs: null };
    if (!MINUTE_LANE_NAMES.has(r.lane)) entry.onlyMinute = false;
    const ms = parseStampMs(r.claimed_at);
    if (ms !== null) entry.latestMs = Math.max(entry.latestMs ?? -Infinity, ms);
    byTick.set(r.tick_id, entry);
  }
  let last: number | null = null;
  for (const t of byTick.values()) {
    if (!t.onlyMinute || t.latestMs === null) continue;
    last = Math.max(last ?? -Infinity, t.latestMs);
  }
  if (last !== null && nowMs - last <= MINUTE_LANE_OVERDUE_MS) return { kind: "delivered", lastMs: last };
  if (last === null && read.truncated) return { kind: "unknown" };
  return { kind: "silent", sinceMs: last };
}

/**
 * The backstop check's answer as the dispatcher reads it: the overdue paths, each once,
 * or null when the answer is not one. A path that is not an every minute lane makes the
 * WHOLE answer unreadable rather than being dropped, because the dispatcher must never
 * start a route on a guess (and an answer naming one has been tampered with or broken).
 */
export function parseBackstopAnswer(text: string): string[] | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;
  const overdue = (body as { overdue?: unknown }).overdue;
  if (!Array.isArray(overdue)) return null;
  const known = new Set(MINUTE_LANE_PATHS);
  const paths: string[] = [];
  for (const p of overdue) {
    if (typeof p !== "string" || !known.has(p)) return null;
    if (!paths.includes(p)) paths.push(p);
  }
  return paths;
}

/** As much of a Supabase query as the reader uses, so it can be faked. */
export interface LaneClaimQuery {
  select(columns: string): {
    gte(column: string, value: string): {
      order(column: string, opts: { ascending: boolean }): {
        limit(n: number): PromiseLike<{ data: LaneClaimRow[] | null; error: { message: string } | null }>;
      };
    };
  };
}

/**
 * The claims made since `sinceIso`, newest first, at most one page. THROWS on a failed
 * read: an empty list here means "no lane claimed", which the backstop acts on by starting
 * every lane and the page acts on by blaming Cloudflare, so a failure must never read as
 * one (L90). `truncated` is true when the page came back full.
 */
export async function readRecentLaneClaims(
  table: LaneClaimQuery,
  sinceIso: string,
): Promise<{ rows: LaneClaimRow[]; truncated: boolean }> {
  const { data, error } = await table
    .select("tick_id, lane, claimed_at")
    .gte("claimed_at", sinceIso)
    .order("claimed_at", { ascending: false })
    .limit(CLAIM_READ_LIMIT);
  if (error) throw new Error(`lane_runs read failed: ${error.message}`);
  if (!data) throw new Error("lane_runs read returned no rows and no error");
  return { rows: data, truncated: data.length >= CLAIM_READ_LIMIT };
}
