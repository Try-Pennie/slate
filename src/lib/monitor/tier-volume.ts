/**
 * The low volume alarm for every tier judged BESIDE Low (#2874).
 *
 * Which tiers those are is decided upstream, by `resolveTierBaselines`: exactly the
 * tiers Slate carries whose own bookings have been learned. Each is judged by the
 * same check as Low (`runLowVolumeCheck`), on its own count, its own floors and its
 * own alert key, one after another, so a tier's page names that tier and one tier's
 * cooldown never silences another's (L707).
 *
 * The floors are the learned ones and nothing else: the two floor overrides on
 * /admin/alerts are Low's knobs, named for the alarm that predates the tiers.
 *
 * No `@/` imports, so node scripts can drive it.
 */
import {
  formatTierVolumeCheckFailedAlert,
  formatTierVolumeCheckRanNotice,
  runLowVolumeCheck,
  type BusinessHoursConfig,
  type LowVolumeResult,
} from "./booking-volume.ts";
import { floorsFor, judgedFloors, type VolumeBaseline } from "./volume-floors.ts";
import { tierCheckFailedKey, tierCountUnreadableKey, tierLabel, tierVolumeAlertKey, type VolumeTier } from "./volume-tiers.ts";
import type { ThrottledNotify } from "./alert-deps";
import { logAlertSendFailure, logAllClearFailure } from "../notify/send-failure.ts";

export async function runTierVolumeChecks(deps: {
  nowMs: number;
  businessHours: BusinessHoursConfig;
  /** From `resolveTierBaselines`: every tier judged beside Low, with its floors. */
  baselines: Partial<Record<VolumeTier, VolumeBaseline>>;
  /** One tier's bookings created at or after `sinceIso`, or null when the read failed. */
  countSince: (tier: VolumeTier, sinceIso: string) => Promise<number | null>;
  armed: boolean;
  cooldownMs: number;
  notify: ThrottledNotify;
  notifyCountUnreadable: ThrottledNotify;
  resolveRecovered: (recovered: { key: string; text: string }[]) => Promise<string[]>;
  log?: (fields: Record<string, unknown>) => void;
  /** Where a tier's thrown error is logged in full; the page carries none of it. */
  logError?: (fields: { msg: string; tier: string }, err: unknown) => void;
}): Promise<Partial<Record<VolumeTier, LowVolumeResult>>> {
  // all-clear-proof: scripts/test-tier-volume.ts - pins that a tier whose count
  // cannot be read clears nothing, and that a tier's reading clears only its own page.
  const out: Partial<Record<VolumeTier, LowVolumeResult>> = {};
  // Every tier's all-clears are collected and settled in ONE call after the loop:
  // each settle is an alert_state read on the budget four cron lanes share, so
  // five tiers must not cost five. Only what a tier MEASURED is ever collected,
  // because each check offers nothing on a path that could not read its count.
  const recovered: { key: string; text: string }[] = [];
  for (const [tier, baseline] of Object.entries(deps.baselines) as [VolumeTier, VolumeBaseline | undefined][]) {
    if (!baseline) continue;
    const label = tierLabel(tier);
    // EACH TIER IS ITS OWN FAILURE BOUNDARY (L73). One tier throwing, a damaged
    // stored floor record most likely, must not leave the tiers after it unjudged
    // nor drop the all-clears already collected: it is that tier's finding, on its
    // own key, reported as not measured and never as healthy.
    const mine: { key: string; text: string }[] = [];
    try {
      out[tier] = await runLowVolumeCheck({
        nowMs: deps.nowMs,
        businessHours: deps.businessHours,
        countSince: (sinceIso) => deps.countSince(tier, sinceIso),
        floors: judgedFloors(floorsFor({ baseline, override30: null, override120: null }, deps.nowMs)),
        armed: deps.armed,
        cooldownMs: deps.cooldownMs,
        notify: deps.notify,
        notifyCountUnreadable: deps.notifyCountUnreadable,
        resolveRecovered: async (r) => {
          mine.push(...r);
          return [];
        },
        tier: { key: tierVolumeAlertKey(tier), countUnreadableKey: tierCountUnreadableKey(tier), label },
        log: deps.log,
      });
    } catch (err) {
      out[tier] = { status: "unverified" };
      deps.logError?.({ msg: "tier volume check failed", tier: label }, err);
      await deps.notify(tierCheckFailedKey(tier), deps.cooldownMs, formatTierVolumeCheckFailedAlert(label)).catch(logAlertSendFailure(tierCheckFailedKey(tier)));
      continue;
    }
    recovered.push(...mine);
    // Its own "check failed" page is over only once the tier was actually JUDGED:
    // a count it could not read ran the check and still judged nothing (#1152).
    if (out[tier]?.status === "checked") {
      recovered.push({ key: tierCheckFailedKey(tier), text: formatTierVolumeCheckRanNotice(label) });
    }
  }
  if (recovered.length > 0) {
    await deps
      .resolveRecovered(recovered)
      .catch(logAllClearFailure(recovered.map((r) => r.key)));
  }
  return out;
}
