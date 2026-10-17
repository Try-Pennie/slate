/**
 * The decision logic behind `scripts/verify-refusal-alerts-live.ts` (#1726), pinned offline by
 * `scripts/test-refusal-alert-live-control.ts`.
 *
 * WHY THERE IS A COMMAND AT ALL. The booking API's refusal alerts (#1442, #1450,
 * #1709) ship ARMED, and so do the embed booker's (#1727), but nothing has ever
 * refused often enough to reach a floor, so the path from a recorded refusal to a
 * built page has never executed once against the real store. The first firing
 * would otherwise be during a real incident, which is the worst possible first test
 * (L535). This is the `verify:burst-counter` shape: report against a key no real
 * caller can produce, read the counter back, and require the judged verdict to
 * CHANGE and the message to render. Both directions, or it proves nothing (L1).
 *
 * WHAT IS REAL AND WHAT IS NOT. Real: the write (`bump_booking_api_outcome`, through
 * the same `outcomeTallyArgs` the routes use), the read back of the row it wrote,
 * the mix RPC carrying each refusal name through, `normalizeMix`, the failure rate
 * window's own `advanceWindow`, the judges, the SHIPPED thresholds and limits, and
 * the copy builders. Not real: the interval CLOCK. The readings are minutes apart
 * on the wall clock and are labelled five minutes apart, because what the window
 * measures is the delta between two readings and its labels are only how the judge
 * counts intervals. And the Slack post: the message is built and checked, not sent,
 * because the transport is the one every other alert uses daily and sending would
 * page the alerts channel about a verification.
 */
import { INPUT_LIMITS } from "../../src/lib/booking/input-limits.ts";
import { normalizeMix, type SelfInflictedRefusal } from "../../src/lib/monitor/booking-api-outcome.ts";
import { advanceWindow, type RateWindowState } from "../../src/lib/monitor/booking-failure-rate.ts";
import {
  CEILING_ALERT_KEY,
  CREDENTIAL_ALERT_KEY,
  EMBED_CONTACT_CAP_ALERT_KEY,
  EMBED_HONEYPOT_ALERT_KEY,
  EMBED_IP_CAP_ALERT_KEY,
  LIST_ALERT_KEY,
  SHIPPED_REFUSAL_THRESHOLDS,
  embedRefusalCopy,
  judgeEmbedRefusalSignals,
  judgeRefusalSignals,
  refusalSignalCopy,
  samplesFromWindow,
  type EmbedLockouts,
  type RefusalSample,
} from "../../src/lib/monitor/api-refusal-signals.ts";
import { SHIPPED_EMBED_REFUSAL_THRESHOLDS } from "../../src/lib/monitor/embed-refusal-thresholds.ts";
import { SHIPPED_CEILING_LIMITS } from "../../src/lib/monitor/refusal-limits.ts";

/**
 * The bucket the probe writes under, and the whole reason it cannot touch a real
 * count. A tally row is keyed `(day, outcome, bucket_code, error_code, is_test,
 * host_class)`, and every route records a bucket code that is either empty, a code
 * `bucketCodeSchema` accepted (at most `INPUT_LIMITS.code` characters), or the raw
 * body's code cut to sixteen. This one is longer than all of them by construction,
 * so no request can produce it, and `scripts/test-refusal-alert-live-control.ts`
 * fails if the limit ever grows past it.
 *
 * It is ALSO written as test traffic (`is_test`), which every monitor's read leaves
 * out (`p_include_test: false`), so even its own name never reaches a real verdict.
 */
export const PROBE_BUCKET = `slate-verify-refusal-alerts-monitor-only-${"0".repeat(INPUT_LIMITS.code)}`;

/** How a run ended. Distinct causes, distinct codes, so a shell caller can branch on
 *  which one it met (L11). Nothing but agreement is 0. */
export const VERIFY_EXIT = {
  passed: 0,
  /** No Supabase URL or secret: nothing was attempted. */
  misconfigured: 2,
  /** The tally write was refused. Nothing downstream could be judged. */
  writeRefused: 3,
  /** The probe's row could not be read back. */
  readFailed: 4,
  /** The row read back did not rise by exactly what was written: the write and the
   *  read are not looking at the same row, or another run is writing beside this one. */
  counterDidNotRise: 5,
  /** The mix RPC the monitor reads did not carry a refusal name through, so the
   *  window would never see it however often it was recorded. */
  mixDropsName: 6,
  /** The judged verdict did not move from a measured clear to paging. */
  verdictUnchanged: 7,
  /** A paging verdict built no message, or one carrying a leaked value. */
  messageUnrendered: 8,
  /** The limiter's locked out count, which the embed caps need, could not be read. */
  lockoutReadFailed: 9,
  /** Everything passed and the probe's rows could not be deleted afterwards. */
  leftRows: 10,
} as const;

export type VerifyExit = (typeof VERIFY_EXIT)[keyof typeof VERIFY_EXIT];

const INTERVAL_MS = 5 * 60_000;

/**
 * One alert being proved: the names it reads, what the probe writes for it in each
 * of the three intervals after the baseline, and how it is judged and rendered.
 * The per interval numbers are the smallest that reach each SHIPPED floor, derived
 * from the thresholds rather than typed, so a raised floor raises the probe with it.
 */
export interface ProbeSignal {
  id: string;
  alertKey: string;
  names: SelfInflictedRefusal[];
  bumps: number[];
  /** Whether the signal must reach `paging`. The embed caps cannot be driven to it
   *  without writing to the limiter's rows, which real leads are judged by. */
  mustPage: boolean;
  judge(samples: RefusalSample[], atMs: number, lockouts: EmbedLockouts): { status: string; text: string | null };
}

const t = SHIPPED_REFUSAL_THRESHOLDS;
const e = SHIPPED_EMBED_REFUSAL_THRESHOLDS;
const spread = (total: number, intervals: number) => {
  const per = Math.ceil(total / intervals);
  return Array.from({ length: intervals }, () => per);
};

export const PROBE_SIGNALS: ProbeSignal[] = [
  {
    id: "ceiling",
    alertKey: CEILING_ALERT_KEY,
    names: ["refused_ceiling_key"],
    bumps: spread(t.ceilingMinRefusals, 3),
    mustPage: true,
    judge: (s, at) => {
      const v = judgeRefusalSignals(s, at, t).ceiling;
      return { status: v.status, text: refusalSignalCopy.ceiling(v, t.windowMs, SHIPPED_CEILING_LIMITS) };
    },
  },
  {
    id: "credential rejected",
    alertKey: CREDENTIAL_ALERT_KEY,
    names: ["refused_key_wrong"],
    // One in each interval: the floor is a count of INTERVALS, and the suite fails
    // if it is ever raised past the three the probe has.
    bumps: [1, 1, 1],
    mustPage: true,
    judge: (s, at) => {
      const v = judgeRefusalSignals(s, at, t).credential;
      return { status: v.status, text: refusalSignalCopy.credential(v, t.windowMs) };
    },
  },
  {
    id: "credential not configured",
    alertKey: CREDENTIAL_ALERT_KEY,
    names: ["refused_not_configured"],
    bumps: [1, 0, 0],
    mustPage: true,
    judge: (s, at) => {
      const v = judgeRefusalSignals(s, at, t).credential;
      return { status: v.status, text: refusalSignalCopy.credential(v, t.windowMs) };
    },
  },
  {
    id: "list read",
    alertKey: LIST_ALERT_KEY,
    names: ["refused_list_read"],
    bumps: [1, 1, 1],
    mustPage: true,
    judge: (s, at) => {
      const v = judgeRefusalSignals(s, at, t).list;
      return { status: v.status, text: refusalSignalCopy.list(v, t.windowMs) };
    },
  },
  {
    id: "embed honeypot",
    alertKey: EMBED_HONEYPOT_ALERT_KEY,
    names: ["refused_embed_honeypot"],
    bumps: spread(e.honeypotMinTrips, 3),
    mustPage: true,
    judge: (s, at, l) => {
      const v = judgeEmbedRefusalSignals(s, at, e, l).honeypot;
      return { status: v.status, text: embedRefusalCopy.honeypot(v, e.windowMs) };
    },
  },
  {
    id: "embed address cap",
    alertKey: EMBED_IP_CAP_ALERT_KEY,
    names: ["refused_embed_ip_hour"],
    bumps: [1, 0, 0],
    mustPage: false,
    judge: (s, at, l) => {
      const v = judgeEmbedRefusalSignals(s, at, e, l).ipCap;
      return { status: v.status, text: embedRefusalCopy.ipCap(v, e.windowMs) };
    },
  },
  {
    id: "embed contact cap",
    alertKey: EMBED_CONTACT_CAP_ALERT_KEY,
    names: ["refused_embed_contact_hour"],
    bumps: [1, 0, 0],
    mustPage: false,
    judge: (s, at, l) => {
      const v = judgeEmbedRefusalSignals(s, at, e, l).contactCap;
      return { status: v.status, text: embedRefusalCopy.contactCap(v, e.windowMs) };
    },
  },
];

/** Every name the probe writes, once each. */
export function probeNames(signals: ProbeSignal[] = PROBE_SIGNALS): SelfInflictedRefusal[] {
  return [...new Set(signals.flatMap((s) => s.names))];
}

/** What to write in interval `k` (0, 1 or 2), summed per name across signals. */
export function bumpsForInterval(k: number, signals: ProbeSignal[] = PROBE_SIGNALS): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of signals) for (const n of s.names) out[n] = (out[n] ?? 0) + (s.bumps[k] ?? 0);
  return out;
}

/** A message that is fit to send: present, and free of anything a builder leaks
 *  when it was handed something it did not expect. */
export function renderable(text: string | null): boolean {
  return typeof text === "string" && text.trim().length > 40 && !/undefined|NaN|\[object Object\]|\bnull\b/.test(text);
}

export interface ProbeRun {
  /** The ET day every write was keyed to, fixed at the start so a run that crosses
   *  midnight cannot split its rows across two days. */
  day: string;
  startMs: number;
  /** The probe row's count per name: before anything, after a zero interval, then
   *  after each of the three intervals' writes. Five readings. */
  readings: Record<string, number>[];
  /** Whether the mix RPC (test traffic included) carried each name with at least the
   *  probe's own count. */
  mixCarried: Record<string, boolean>;
  /** The limiter's locked out counts, read live for the embed caps, or null when the
   *  read failed. */
  lockouts: EmbedLockouts | null;
}

export type ProbeVerdict =
  | { ok: true; lines: string[] }
  | { ok: false; exitCode: VerifyExit; message: string; lines: string[] };

/** The failure rate window built from the probe's readings for ONE signal's names,
 *  through the real `advanceWindow`, the way the monitor lane builds it. */
function windowFor(signal: ProbeSignal, run: ProbeRun, upTo: number): RateWindowState | null {
  let state: RateWindowState | null = null;
  for (let k = 0; k <= upTo; k++) {
    const byOutcome: Record<string, number> = {};
    for (const n of signal.names) byOutcome[n] = run.readings[k]?.[n] ?? 0;
    const mix = normalizeMix({ by_outcome: byOutcome });
    state = advanceWindow(
      state,
      { day: run.day, attempts: mix.total, failures: 0, byCode: {}, refusals: mix.refusals },
      run.startMs + k * INTERVAL_MS,
      t.windowMs,
    ).state;
  }
  return state;
}

export function judgeProbeRun(run: ProbeRun, signals: ProbeSignal[] = PROBE_SIGNALS): ProbeVerdict {
  const lines: string[] = [];
  const fail = (exitCode: VerifyExit, message: string): ProbeVerdict => ({ ok: false, exitCode, message, lines });
  if (run.readings.length !== 5) {
    return fail(VERIFY_EXIT.readFailed, `expected five readings of the probe row, got ${run.readings.length}`);
  }

  // 1. The counter rose by exactly what was written, at every step.
  for (const name of probeNames(signals)) {
    const base = run.readings[0]![name] ?? 0;
    const planned = [0, 0, ...[0, 1, 2].map((k) => bumpsForInterval(k, signals)[name] ?? 0)];
    let expected = base;
    for (let k = 1; k < 5; k++) {
      expected += planned[k]!;
      const got = run.readings[k]![name] ?? 0;
      if (got !== expected) {
        return fail(
          VERIFY_EXIT.counterDidNotRise,
          `${name}: the probe row read ${got} after step ${k}, but ${expected} was written. ` +
            (got < expected
              ? "The write and the read are not looking at the same row."
              : "Something else is writing under the probe's key; is another run going?"),
        );
      }
    }
    lines.push(`${name}: rose from ${base} to ${expected}, exactly what was written`);
  }

  // 2. The read the monitor makes carries every name through.
  for (const name of probeNames(signals)) {
    if (!run.mixCarried[name]) {
      return fail(
        VERIFY_EXIT.mixDropsName,
        `${name}: booking_api_outcome_mix did not carry it, so the window could never see it however often it was recorded`,
      );
    }
  }

  // 3. The embed caps cannot be judged without the limiter's count.
  if (signals.some((s) => !s.mustPage) && run.lockouts === null) {
    return fail(VERIFY_EXIT.lockoutReadFailed, "the locked out count in rate_limits could not be read, so the embed caps cannot be judged");
  }
  const lockouts = run.lockouts ?? { addresses: null, contactKeys: null };

  // 4. Each verdict moves from a measured clear to paging, and the page renders.
  for (const s of signals) {
    const before = windowFor(s, run, 1);
    const after = windowFor(s, run, 4);
    const b = s.judge(samplesFromWindow(before?.samples ?? []), run.startMs + INTERVAL_MS, lockouts);
    const a = s.judge(samplesFromWindow(after?.samples ?? []), run.startMs + 4 * INTERVAL_MS, lockouts);
    if (b.status !== "clear") {
      return fail(VERIFY_EXIT.verdictUnchanged, `${s.id} (${s.alertKey}): the baseline window judged ${b.status}, not a measured clear`);
    }
    if (s.mustPage) {
      if (a.status !== "paging") {
        return fail(VERIFY_EXIT.verdictUnchanged, `${s.id} (${s.alertKey}): the probe's refusals judged ${a.status}, not paging`);
      }
      if (!renderable(a.text)) {
        return fail(VERIFY_EXIT.messageUnrendered, `${s.id} (${s.alertKey}): the paging verdict built no sendable message`);
      }
      lines.push(`${s.id} (${s.alertKey}): clear, then paging; message: ${a.text!.slice(0, 90)}...`);
    } else {
      if (a.status === "unmeasured") {
        return fail(VERIFY_EXIT.verdictUnchanged, `${s.id} (${s.alertKey}): the probe's trip left the cap unmeasured`);
      }
      lines.push(
        `${s.id} (${s.alertKey}): clear with no read, then judged ${a.status} against the live locked out count ` +
          `(paging here is not driven: that would mean writing the limiter's rows real leads are judged by)`,
      );
    }
  }
  return { ok: true, lines };
}
