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
import { floorsFor, judgedFloors, type BookingSeries, type FloorPolicy, type VolumeBaseline } from "../../src/lib/monitor/volume-floors.ts";
import { LOW_PAGES, runPageVolumeCheck, type LowPageId, type SourceRow } from "../../src/lib/monitor/page-volume.ts";

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

/**
 * The per page alarm (#2738), replayed the same way: the SHIPPED
 * `runPageVolumeCheck`, armed, once per lane tick, reading bookings synthesised
 * from each page's own measured series. Each page's key is throttled on its own,
 * as the dispatcher throttles them. `tierLow` is null by default, so a page's
 * detection is measured on its own rather than hidden behind the tier alarm.
 */
export async function replayPageVolume(opts: {
  series: Record<LowPageId, BookingSeries>;
  baselines: Record<LowPageId, VolumeBaseline>;
  businessHours: BusinessHoursConfig;
  fromMs: number;
  toMs: number;
  tickMinutes: number;
  cooldownMs: number;
  tierLow?: (tickMs: number) => boolean | null;
}): Promise<{ checked: number; pages: (ReplayPage & { key: string })[] }> {
  const pages: (ReplayPage & { key: string })[] = [];
  const lastPage = new Map<string, number>();
  let checked = 0;
  for (let now = opts.fromMs; now < opts.toMs; now += opts.tickMinutes * 60_000) {
    const tick = now;
    const out = await runPageVolumeCheck({
      nowMs: tick,
      businessHours: opts.businessHours,
      baselines: opts.baselines,
      // The series replayed is cal.com's: every lead on every page, so a share of 1
      // judges it against the floors as measured (#3193).
      share: { state: "applied", share: 1, heldSince: null, countedTo: new Date(tick).toISOString() },
      readSources: async (sinceIso) => {
        const since = Date.parse(sinceIso);
        const rows: SourceRow[] = [];
        for (const page of LOW_PAGES) {
          const s = opts.series[page.id];
          const per = s.bucketMinutes * 60_000;
          for (let i = Math.max(0, Math.floor((since - s.startMs) / per)); i < s.counts.length; i++) {
            const at = s.startMs + i * per;
            if (at >= tick) break;
            if (at < since) continue;
            for (let k = 0; k < s.counts[i]!; k++) rows.push({ createdMs: at, source: page.sources[0]!, hostless: false });
          }
        }
        return rows;
      },
      pageSeenSince: async () => true,
      tierLow: opts.tierLow ? opts.tierLow(tick) : null,
      armed: true,
      cooldownMs: opts.cooldownMs,
      notify: async (key, cooldownMs, text) => {
        const last = lastPage.get(key);
        if (last !== undefined && tick - last < cooldownMs) return;
        lastPage.set(key, tick);
        pages.push({ atMs: tick, text, key });
      },
      resolveRecovered: async (recovered) => {
        for (const r of recovered) lastPage.delete(r.key);
        return [];
      },
    });
    if (out.status === "checked") checked++;
  }
  return { checked, pages };
}
