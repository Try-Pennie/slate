/**
 * Replaying the low volume alarm against a measured booking series (#1956).
 *
 * It drives the SHIPPED `runLowVolumeCheck` once per lane tick, with the count read
 * off the series and the floors from a policy, so what it reports is what the armed
 * alarm would have sent, not what a second copy of its rule believes (L63). The
 * throttle is modelled the way the dispatcher behaves: a page, then silence for the
 * cooldown, and a measured all-clear ends the episode so the next breach pages again.
 */
import { runLowVolumeCheck, VOLUME_ALERT_KEY, type BusinessHoursConfig } from "../../src/lib/monitor/booking-volume.ts";
import { floorsFor, judgedFloors, type BookingSeries, type FloorPolicy } from "../../src/lib/monitor/volume-floors.ts";

export interface ReplayPage {
  atMs: number;
  text: string;
}

export interface ReplayResult {
  /** Ticks inside business hours, where the check actually measured something. */
  checked: number;
  pages: ReplayPage[];
}

/** Bookings in [sinceMs, untilMs), read off the series by bucket. */
export function seriesCounter(series: BookingSeries): (sinceMs: number, untilMs: number) => number {
  const per = series.bucketMinutes * 60_000;
  const prefix = [0];
  for (const n of series.counts) prefix.push(prefix[prefix.length - 1]! + n);
  const at = (ms: number) => {
    const i = Math.floor((ms - series.startMs) / per);
    return prefix[Math.max(0, Math.min(series.counts.length, i))]!;
  };
  return (sinceMs, untilMs) => at(untilMs) - at(sinceMs);
}

export async function replayLowVolume(opts: {
  series: BookingSeries;
  policy: FloorPolicy;
  businessHours: BusinessHoursConfig;
  fromMs: number;
  toMs: number;
  tickMinutes: number;
  cooldownMs: number;
}): Promise<ReplayResult> {
  const count = seriesCounter(opts.series);
  const pages: ReplayPage[] = [];
  let lastPageMs: number | null = null;
  let checked = 0;
  for (let now = opts.fromMs; now < opts.toMs; now += opts.tickMinutes * 60_000) {
    const tick = now;
    const out = await runLowVolumeCheck({
      nowMs: tick,
      businessHours: opts.businessHours,
      countSince: async (sinceIso) => count(Date.parse(sinceIso), tick),
      floors: judgedFloors(floorsFor(opts.policy, tick)),
      armed: true,
      cooldownMs: opts.cooldownMs,
      notify: async (_key, cooldownMs, text) => {
        if (lastPageMs !== null && tick - lastPageMs < cooldownMs) return false;
        lastPageMs = tick;
        pages.push({ atMs: tick, text });
        return true;
      },
      notifyCountUnreadable: async () => {
        throw new Error("the replay's count can never be unreadable");
      },
      resolveRecovered: async (recovered) => {
        if (recovered.some((r) => r.key === VOLUME_ALERT_KEY)) lastPageMs = null;
        return [];
      },
    });
    if (out.status === "checked") checked++;
  }
  return { checked, pages };
}

/** A copy of the series with every bucket in [fromMs, toMs) emptied: an injected outage. */
export function withGap(series: BookingSeries, fromMs: number, toMs: number): BookingSeries {
  const per = series.bucketMinutes * 60_000;
  return {
    ...series,
    counts: series.counts.map((n, i) => {
      const at = series.startMs + i * per;
      return at >= fromMs && at < toMs ? 0 : n;
    }),
  };
}

/** The first `bucketsKept` buckets of a series, for fitting on the earlier weeks only. */
export function headOf(series: BookingSeries, bucketsKept: number): BookingSeries {
  return { ...series, counts: series.counts.slice(0, bucketsKept) };
}
