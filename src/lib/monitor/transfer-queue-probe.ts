/**
 * The monitor lane's transfer queue probe (#4380).
 *
 * The coordinator page offers a live transfer only when Pennie's transfer queue endpoint
 * says enough advisors are free, and it fails quiet by design: an endpoint it cannot read
 * shows a plain line and booking goes on as before, so a broken endpoint, or a queue that
 * never has enough advisors, would look exactly like a busy week. This probe is what
 * speaks. In business hours, on every tick, it asks the endpoint the same way the page
 * does (`readTransferQueue`), counts the reading against its business day
 * (`transfer_queue_days`, migration 0213), and judges two CONDITIONS:
 *
 *  - `transfer_queue_unreadable`: the endpoint failed on `TRANSFER_QUEUE_FAILING_TICKS`
 *    ticks in a row (fifteen minutes), so no coordinator is being offered a transfer. Only a
 *    reading that succeeds clears it.
 *  - `transfer_queue_never_free`: no reading reached the threshold since the open of the
 *    last whole business day. Judged only on a day the probe read from within
 *    `TRANSFER_QUEUE_EDGE_MS` of its open to within it of its close, so a day the probe was
 *    not running for is unmeasured rather than quiet (L98). Only a measured reading at or
 *    above the threshold clears it.
 *
 * Outside business hours it reads nothing: the endpoint answering at night proves nothing
 * a coordinator would meet. A failed read of the stored days or the settings THROWS, or is
 * reported for the lane to throw, so the step's own failing streak pages a read that stays
 * broken; neither ever pages or clears either condition.
 *
 * Pure apart from the injected reads and dispatcher (scripts/test-transfer-queue-probe.ts).
 */
import { DateTime } from "luxon";
import { formatClockTime, formatLongDate } from "@/lib/date/parse";
import { parseStampMs } from "@/lib/date/stamp";
import { lastClosedBusinessDay, windowOnDate, type BusinessHoursException, type BusinessWindow } from "@/lib/booking/business-hours";
import { logAlertSendFailure, logResolveFailure } from "@/lib/notify/send-failure";
import type { TransferOfferSettings, TransferQueueFailure, TransferQueueReading } from "@/lib/coordinator/transfer-queue";
import type { AlertResolve, ThrottledNotify } from "./alert-deps";

export const TRANSFER_QUEUE_UNREADABLE_KEY = "transfer_queue_unreadable";
export const TRANSFER_QUEUE_NEVER_FREE_KEY = "transfer_queue_never_free";
export const TRANSFER_QUEUE_STREAK_KEY = `streak:${TRANSFER_QUEUE_UNREADABLE_KEY}`;

/** Failing ticks in a row before the unreadable condition pages: fifteen minutes on the five minute lane. */
export const TRANSFER_QUEUE_FAILING_TICKS = 3;
/** The streak's window, wide enough that consecutive ticks land in it. */
export const TRANSFER_QUEUE_STREAK_WINDOW_S = 2 * TRANSFER_QUEUE_FAILING_TICKS * 5 * 60;
/** How near the open and the close the probe must have read for a day to be judged. */
export const TRANSFER_QUEUE_EDGE_MS = 30 * 60_000;

type Hours = { zone: string; rules: BusinessWindow[]; exceptions: BusinessHoursException[] };
type Day = { isoDate: string; openMs: number; closeMs: number };

/** One `transfer_queue_days` row. */
export interface TransferQueueDayRow {
  day: string;
  readings: number;
  reached: number;
  most_free: number;
  first_read_at: string;
  last_read_at: string;
}

export interface TransferQueueProbeDeps {
  hours: Hours;
  nowMs: number;
  readQueue: () => Promise<TransferQueueReading>;
  /** The stored threshold and line, or null when the read failed. */
  readSettings: () => Promise<TransferOfferSettings | null>;
  /** Count one reading against its business day. THROWS on a failed write. */
  recordReading: (day: string, free: number, reached: boolean) => Promise<void>;
  /** The rows for these days, absent ones left out. THROWS on a failed read. */
  loadDays: (days: string[]) => Promise<TransferQueueDayRow[]>;
  bumpStreak: () => Promise<"reached" | "below" | "unknown">;
  clearStreak: () => Promise<void>;
  notify: ThrottledNotify;
  resolve: AlertResolve<unknown>;
  cooldownMs: number;
}

export type TransferQueueProbeResult = {
  probe:
    | { status: "closed" }
    | { status: "read"; free: number; threshold: number | null; reached: boolean | null }
    | { status: "failed"; why: TransferQueueFailure; paged: boolean };
  judgement:
    | { status: "unmeasured"; why: string }
    | { status: "never-free"; day: string; readings: number; mostFree: number }
    | { status: "reached"; day: string };
  /** The settings could not be read: nothing was recorded, and the lane throws. */
  settingsUnreadable: boolean;
};

// ------------------------------------------------------------------------- copy

const REASON_WORDS: Record<TransferQueueFailure, string> = {
  timeout: "it did not answer within 3 seconds",
  network: "the connection to it failed",
  status: "it answered with an error",
  "not-json": "it answered something other than JSON",
  shape: "its answer did not say how many advisors are free",
};

const ENDPOINT = "queues.trypennie.app/boomsource-inbound-transfer";

export function formatTransferQueueUnreadableAlert(why: TransferQueueFailure): string {
  return (
    `Pennie's transfer queue could not be read on ${TRANSFER_QUEUE_FAILING_TICKS} checks in a row ` +
    `(${REASON_WORDS[why]}), so coordinators are not being offered a live transfer. They book a time as usual. ` +
    `Check that ${ENDPOINT} answers JSON with availableAgents, and the worker behind it.`
  );
}

export function formatTransferQueueUnreadableRecovery(): string {
  return `Pennie's transfer queue is answering again, so coordinators are offered a live transfer whenever enough advisors are free.`;
}

function dayWords(day: Day, zone: string): string {
  const open = formatClockTime(DateTime.fromMillis(day.openMs, { zone: "America/New_York" }));
  const close = formatClockTime(DateTime.fromMillis(day.closeMs, { zone: "America/New_York" }));
  const date = formatLongDate(DateTime.fromISO(day.isoDate, { zone })) ?? day.isoDate;
  return open && close ? `${date}, ${open} to ${close} ET` : date;
}

export function formatTransferQueueNeverFreeAlert(day: Day, seen: { readings: number; mostFree: number }, threshold: number | null, zone = "America/New_York"): string {
  const bar = threshold === null ? "enough" : `${threshold} or more`;
  return (
    `Pennie's transfer queue never had ${bar} advisors free during the last business day (${dayWords(day, zone)}): ` +
    `at most ${seen.mostFree} across ${seen.readings.toLocaleString("en-US")} checks. So no coordinator was offered a live ` +
    `transfer; they could only book a time. If advisors were free, check who is in the transfer queue in ` +
    `Regal; if the bar is too high, change it on Coordinator booking.`
  );
}

export function formatTransferQueueNeverFreeRecovery(mostFree: number): string {
  return `Pennie's transfer queue has had enough advisors free to offer live transfers again (${mostFree} at the most free check).`;
}

// ------------------------------------------------------------------------- the probe

function isOpen(hours: Hours, nowMs: number): { open: boolean; today: string } {
  const now = DateTime.fromMillis(nowMs, { zone: hours.zone });
  const today = now.toISODate() ?? "";
  const w = windowOnDate(hours, today, now.weekday);
  const minute = now.hour * 60 + now.minute;
  return { open: w !== null && minute >= w.start_minute && minute < w.end_minute, today };
}

export async function runTransferQueueProbe(deps: TransferQueueProbeDeps): Promise<TransferQueueProbeResult> {
  const { open, today } = isOpen(deps.hours, deps.nowMs);
  let probe: TransferQueueProbeResult["probe"] = { status: "closed" };
  let settingsUnreadable = false;
  let threshold: number | null = null;

  if (open) {
    const [reading, settings] = await Promise.all([deps.readQueue(), deps.readSettings()]);
    threshold = settings?.threshold ?? null;
    if (settings === null) settingsUnreadable = true;
    if (!reading.ok) {
      const streak = await deps.bumpStreak();
      // A streak that cannot be counted speaks: holding the failure relies on hearing the next one.
      const page = streak !== "below";
      if (page) {
        await deps
          .notify(TRANSFER_QUEUE_UNREADABLE_KEY, deps.cooldownMs, formatTransferQueueUnreadableAlert(reading.why))
          .catch(logAlertSendFailure(TRANSFER_QUEUE_UNREADABLE_KEY));
      }
      probe = { status: "failed", why: reading.why, paged: page };
    } else {
      await deps.clearStreak();
      await deps
        .resolve(TRANSFER_QUEUE_UNREADABLE_KEY, formatTransferQueueUnreadableRecovery())
        .catch(logResolveFailure(TRANSFER_QUEUE_UNREADABLE_KEY));
      const reached = settings === null ? null : reading.free >= settings.threshold;
      if (reached !== null) await deps.recordReading(today, reading.free, reached);
      probe = { status: "read", free: reading.free, threshold, reached };
    }
  } else {
    // Closed: no reading, but the last whole day is still judged, so its threshold matters.
    threshold = (await deps.readSettings())?.threshold ?? null;
  }

  return { probe, judgement: await judgeNeverFree(deps, today, threshold), settingsUnreadable };
}

async function judgeNeverFree(deps: TransferQueueProbeDeps, today: string, threshold: number | null): Promise<TransferQueueProbeResult["judgement"]> {
  const day = lastClosedBusinessDay(deps.hours, deps.nowMs);
  if (!day) return { status: "unmeasured", why: "no open business day in the last two weeks" };
  const wanted = day.isoDate === today ? [day.isoDate] : [day.isoDate, today];
  const rows = await deps.loadDays(wanted);
  const row = rows.find((r) => r.day === day.isoDate);
  if (!row) return { status: "unmeasured", why: `the probe recorded no reading on ${day.isoDate}` };
  const first = parseStampMs(row.first_read_at);
  const last = parseStampMs(row.last_read_at);
  if (first === null || last === null) return { status: "unmeasured", why: `the readings on ${day.isoDate} carry a stamp that cannot be read` };
  if (first > day.openMs + TRANSFER_QUEUE_EDGE_MS || last < day.closeMs - TRANSFER_QUEUE_EDGE_MS) {
    return { status: "unmeasured", why: `the probe did not read from open to close on ${day.isoDate}` };
  }
  const since = rows.filter((r) => r.day === day.isoDate || r.day === today);
  if (since.some((r) => r.reached > 0)) {
    const mostFree = Math.max(...since.map((r) => r.most_free));
    await deps
      .resolve(TRANSFER_QUEUE_NEVER_FREE_KEY, formatTransferQueueNeverFreeRecovery(mostFree))
      .catch(logResolveFailure(TRANSFER_QUEUE_NEVER_FREE_KEY));
    return { status: "reached", day: day.isoDate };
  }
  await deps
    .notify(TRANSFER_QUEUE_NEVER_FREE_KEY, deps.cooldownMs, formatTransferQueueNeverFreeAlert(day, { readings: row.readings, mostFree: row.most_free }, threshold, deps.hours.zone))
    .catch(logAlertSendFailure(TRANSFER_QUEUE_NEVER_FREE_KEY));
  return { status: "never-free", day: day.isoDate, readings: row.readings, mostFree: row.most_free };
}
