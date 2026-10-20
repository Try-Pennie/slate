/**
 * Has the booking load run's bar stopped sitting ten times over real traffic? (#3124)
 *
 * Dan's rule, 2026-10-20: once a day, look at the last 7 days of routed bookings and
 * say so on the alerts channel when a minute holding MORE than a tenth of the bar
 * (8 or more at 70, `busyMinuteThreshold`) happened on 3 or more different days. One
 * odd spike stays quiet. The bar is `LOAD_RUN_BOOKINGS_PER_MINUTE`, so a raise moves
 * this with it.
 *
 * Until cutover (#65) the count is BOTH systems added minute by minute: cal.com's
 * routed routing form responses plus Slate's routed real bookings. Counting Slate
 * alone would have missed the busiest minute there has been, 7 on cal.com and 0 on
 * Slate at 2026-10-01 14:20 UTC. Once cal.com is marked retired on the alerts page
 * (`loadCalcomRetired`, #2875) Slate's half is the whole count.
 *
 * DAYS ARE UTC DAYS. The window is the 7 whole UTC days before the run's UTC day, and
 * a busy minute belongs to the UTC day it falls in. Busy minutes are mid morning ET, so
 * the boundary (8pm ET in summer) splits nothing that matters, and a whole day is the
 * same window for the first run and its retry.
 *
 * A half that could not be counted is NEVER a quiet week. A failed or partial cal.com
 * read, a failed Slate read, an unreadable retired switch, no cal.com key while cal.com
 * is live, and an EMPTY cal.com while cal.com is live (it carries most of the traffic
 * before cutover) each end as `unmeasured`, its own outcome, never as zero. So is a
 * week with no routed booking anywhere, which Pennie has never had (L98).
 *
 * PURE, with no runtime imports, so `scripts/test-busy-minutes.ts` drives every branch
 * on bare node. The IO is `busy-minutes-lane.ts`; the words are `busy-minutes-copy.ts`.
 */
import { busyMinuteThreshold } from "../load-bar.ts";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** How many whole UTC days a run looks back over. */
export const BUSY_WINDOW_DAYS = 7;
/** How many different days must hold a busy minute before the bar is said to be outgrown. */
export const BUSY_DAYS_TO_ALERT = 3;

/** The lane's route, and the two crons that drive it (worker/cron-routes.ts). */
export const BUSY_MINUTES_ROUTE = "/api/cron/busy-minutes";
/**
 * 05:41 UTC, and 09:41 UTC as the automatic re attempt (L533), which stands down when
 * the first run already reached a verdict. Both are night or early morning ET, which
 * matters for one reason: cal.com meters the routing responses endpoint per KEY (about
 * 120 requests a minute, measured on #2240), and the same key does the time off dual
 * write and the cross system checks in the working day. Minute 41 is not a multiple of
 * 5, so it shares a moment with no other trigger but the every minute one.
 */
export const BUSY_MINUTES_CRONS = ["41 5 * * *", "41 9 * * *"] as const;
/** The UTC hour of the re attempt: a run at or after it is the day's last chance. */
const RETRY_HOUR_UTC = 9;

/** Midnight UTC of the day `ms` falls in. */
function utcDayStart(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

export interface BusyWindow {
  fromMs: number;
  toMs: number;
}

/** The 7 whole UTC days before the UTC day `nowMs` falls in: [from, to). */
export function busyWindow(nowMs: number): BusyWindow {
  const toMs = utcDayStart(nowMs);
  return { fromMs: toMs - BUSY_WINDOW_DAYS * DAY_MS, toMs };
}

/** Whether a run at `nowMs` is the day's last attempt, so a failure must be said now. */
export function isFinalAttempt(nowMs: number): boolean {
  return new Date(nowMs).getUTCHours() >= RETRY_HOUR_UTC;
}

/** Whether the retry should stand down: a verdict was already reached this UTC day. */
export function alreadyMeasuredToday(lastVerdictMs: number | null, nowMs: number): boolean {
  return lastVerdictMs !== null && lastVerdictMs >= utcDayStart(nowMs);
}

/** Slate's half: [minute since the epoch, routed real bookings in it], or a failed read. */
export type SlateHalf = { ok: true; minutes: readonly (readonly [number, number])[] } | { ok: false };

/**
 * Judge what `routed_bookings_per_minute` (migration 0193) answered. Anything that is
 * not a list of whole, non negative pairs inside the window asked for is a failed read,
 * never an empty week: an answer that changed shape counted as no bookings would be the
 * quiet week this check must never invent.
 */
export function slateMinutesFrom(raw: unknown, window: BusyWindow): SlateHalf {
  if (!Array.isArray(raw)) return { ok: false };
  const fromMin = window.fromMs / MINUTE_MS;
  const toMin = window.toMs / MINUTE_MS;
  const minutes: [number, number][] = [];
  for (const pair of raw) {
    if (!Array.isArray(pair) || pair.length !== 2) return { ok: false };
    const [minute, count] = pair as unknown[];
    if (!Number.isInteger(minute) || !Number.isInteger(count)) return { ok: false };
    const m = minute as number;
    const n = count as number;
    if (n < 0 || m < fromMin || m >= toMin) return { ok: false };
    minutes.push([m, n]);
  }
  return { ok: true, minutes };
}

/**
 * cal.com's half, as the lane found it.
 *
 * - `read`: every routed response (cal.com's non empty `routedToBookingUid`) the paged
 *   read returned. The read asks from the window's start with no upper bound, so the
 *   judge filters; `id` lets a response read twice, when a new arrival shifts cal.com's
 *   paging under the read, count once.
 * - `retired`: cal.com is marked retired, so its half is not part of the count.
 * - `retired-unknown`: the retired switch could not be read.
 * - `not-configured`: no cal.com key here while cal.com is not retired.
 * - `unreadable`: a page was refused or the read threw (`status` 0), so the read is partial.
 */
export type CalcomHalf =
  | { kind: "read"; routed: readonly { id?: string; createdAt: string }[] }
  | { kind: "retired" }
  | { kind: "retired-unknown" }
  | { kind: "not-configured" }
  | { kind: "unreadable"; status: number; formName?: string };

/** Why a run could not count, one per cause, so the page names each. */
export type UnmeasuredReason =
  | { kind: "slate-unreadable" }
  | { kind: "calcom-unreadable"; status: number; formName?: string }
  | { kind: "calcom-empty" }
  | { kind: "calcom-not-configured" }
  | { kind: "calcom-retired-unknown" }
  | { kind: "calcom-bad-stamp" }
  | { kind: "nothing-counted" };

export interface BusyMinute {
  atMs: number;
  total: number;
  slate: number;
  calcom: number;
}

export interface BusyDay {
  /** Midnight UTC of the day. */
  dayStartMs: number;
  /** The day's busiest minute at or over the threshold (the earliest, on a tie). */
  busiest: BusyMinute;
}

export type BusyVerdict =
  | { kind: "unmeasured"; reasons: UnmeasuredReason[] }
  | {
      kind: "measured";
      barPerMinute: number;
      threshold: number;
      window: BusyWindow;
      /** False once cal.com is retired: the count is Slate's alone. */
      calcomCounted: boolean;
      slateBookings: number;
      calcomRouted: number;
      /** The window's busiest minute (the earliest, on a tie). */
      busiest: BusyMinute | null;
      /** Each UTC day holding a minute at or over the threshold, in date order. */
      crossingDays: BusyDay[];
      /** At least `BUSY_DAYS_TO_ALERT` crossing days: the bar is outgrown. */
      raise: boolean;
    };

/** Whether `a` should be named over `b` as the busier minute. */
function busier(a: BusyMinute, b: BusyMinute): boolean {
  return a.total > b.total || (a.total === b.total && a.atMs < b.atMs);
}

export function judgeBusyMinutes(input: {
  barPerMinute: number;
  window: BusyWindow;
  slate: SlateHalf;
  calcom: CalcomHalf;
}): BusyVerdict {
  const { window } = input;
  const reasons: UnmeasuredReason[] = [];
  if (!input.slate.ok) reasons.push({ kind: "slate-unreadable" });

  // cal.com's minutes, deduplicated by response id and filtered to the window.
  const calByMinute = new Map<number, number>();
  let calcomRouted = 0;
  const c = input.calcom;
  if (c.kind === "unreadable") reasons.push({ kind: "calcom-unreadable", status: c.status, formName: c.formName });
  else if (c.kind === "not-configured") reasons.push({ kind: "calcom-not-configured" });
  else if (c.kind === "retired-unknown") reasons.push({ kind: "calcom-retired-unknown" });
  else if (c.kind === "read") {
    const seen = new Set<string>();
    let badStamp = false;
    for (const r of c.routed) {
      if (r.id !== undefined) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
      }
      // parse-ok: judged on the next line; an unreadable stamp is a routed booking the
      // count would otherwise lose, so it ends the run as unmeasured.
      const ms = Date.parse(r.createdAt);
      if (!Number.isFinite(ms)) {
        badStamp = true;
        continue;
      }
      if (ms < window.fromMs || ms >= window.toMs) continue;
      const minute = Math.floor(ms / MINUTE_MS);
      calByMinute.set(minute, (calByMinute.get(minute) ?? 0) + 1);
      calcomRouted += 1;
    }
    if (badStamp) reasons.push({ kind: "calcom-bad-stamp" });
    else if (calcomRouted === 0) reasons.push({ kind: "calcom-empty" });
  }
  if (reasons.length > 0 || !input.slate.ok) return { kind: "unmeasured", reasons };

  // Added MINUTE BY MINUTE: a minute's total is both halves' counts for that minute.
  const byMinute = new Map<number, BusyMinute>();
  let slateBookings = 0;
  for (const [minute, n] of input.slate.minutes) {
    slateBookings += n;
    const atMs = minute * MINUTE_MS;
    const prev = byMinute.get(minute) ?? { atMs, total: 0, slate: 0, calcom: 0 };
    byMinute.set(minute, { ...prev, total: prev.total + n, slate: prev.slate + n });
  }
  for (const [minute, n] of calByMinute) {
    const atMs = minute * MINUTE_MS;
    const prev = byMinute.get(minute) ?? { atMs, total: 0, slate: 0, calcom: 0 };
    byMinute.set(minute, { ...prev, total: prev.total + n, calcom: prev.calcom + n });
  }
  if (slateBookings + calcomRouted === 0) return { kind: "unmeasured", reasons: [{ kind: "nothing-counted" }] };

  const threshold = busyMinuteThreshold(input.barPerMinute);
  let busiest: BusyMinute | null = null;
  const days = new Map<number, BusyMinute>();
  for (const m of byMinute.values()) {
    if (busiest === null || busier(m, busiest)) busiest = m;
    if (m.total < threshold) continue;
    const day = utcDayStart(m.atMs);
    const held = days.get(day);
    if (!held || busier(m, held)) days.set(day, m);
  }
  const crossingDays = [...days.entries()]
    .sort(([a], [b]) => a - b)
    .map(([dayStartMs, m]) => ({ dayStartMs, busiest: m }));
  return {
    kind: "measured",
    barPerMinute: input.barPerMinute,
    threshold,
    window,
    calcomCounted: c.kind === "read",
    slateBookings,
    calcomRouted,
    busiest,
    crossingDays,
    raise: crossingDays.length >= BUSY_DAYS_TO_ALERT,
  };
}

export interface BusyMinutesActions {
  pageUnread: boolean;
  resolveUnread: boolean;
  pageOutgrown: boolean;
  resolveOutgrown: boolean;
  stampVerdict: boolean;
}

/**
 * What a run does with its verdict. Every all clear and the verdict stamp hang off a
 * MEASURED run (#1134, #1152): a run that could not count clears nothing and stamps
 * nothing. It says it could not count only on the day's last attempt, since the first
 * run's failure is usually a passing cal.com refusal the retry four hours later rides
 * out, and a page followed by its own all clear before anybody is awake is noise (L36).
 */
export function planBusyMinutesActions(verdict: BusyVerdict, opts: { finalAttempt: boolean }): BusyMinutesActions {
  if (verdict.kind === "unmeasured") {
    return { pageUnread: opts.finalAttempt, resolveUnread: false, pageOutgrown: false, resolveOutgrown: false, stampVerdict: false };
  }
  return {
    pageUnread: false,
    resolveUnread: true,
    pageOutgrown: verdict.raise,
    resolveOutgrown: !verdict.raise,
    stampVerdict: true,
  };
}
