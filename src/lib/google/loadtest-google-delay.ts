/**
 * The vocabulary of the load test's Google delay (#3490), with no imports, so the
 * load run's preflight and judge read a workflow input and a deployment's report
 * with the same parser the Worker acts on, on bare node (L41). Where the delay is
 * applied, and the gate that keeps it out of production, is `loadtestGoogleDelay` in
 * `loadtest-stub.ts`.
 *
 * Why it exists. The Google stand in answers every call at once, while a production
 * confirm spends seconds on its live free/busy check and its calendar write (#3221).
 * So every load run's confirm latency and burst timing left out production's
 * largest cost, and a crowd that walked the tier ladder inside the confirm line's
 * wait on a load run said nothing about whether a production crowd would. With this
 * set, the stubbed calls a lead waits on take a time drawn from a production shaped
 * distribution before they answer.
 *
 * The setting is one string, `SLATE_LOADTEST_GOOGLE_DELAY`, naming a median and a
 * 95th percentile in milliseconds for reads, writes, or both:
 *
 *   read=3000/5000,write=5000/8000
 *
 * Unset or blank is OFF, which is every run before this existed. Anything that does
 * not parse is also off, and is returned in `unknown` so the Worker can log it and
 * the preflight can refuse it, rather than a typo quietly running the rig nobody
 * asked for (L100).
 */
export const GOOGLE_DELAY_VAR = "SLATE_LOADTEST_GOOGLE_DELAY";

/** The two kinds of call that take their own distribution: the live check and the write. */
export const GOOGLE_DELAY_KINDS = ["read", "write"] as const;
export type GoogleDelayKind = (typeof GOOGLE_DELAY_KINDS)[number];

/** One kind's distribution, stated the way production's timings are read: a median and a p95. */
export interface DelayDistribution {
  p50Ms: number;
  p95Ms: number;
}

/** The delay in force for each kind (null is no delay), and the raw value when it did not parse. */
export interface GoogleDelaySetting {
  read: DelayDistribution | null;
  write: DelayDistribution | null;
  unknown: string | null;
}

/**
 * The largest figure the setting accepts. A Google call a lead waits on is cut off at
 * eight seconds (`GOOGLE_CONFIRM_TIMEOUT_MS`), so anything near a minute is a typo for
 * seconds rather than a measurement, and refusing it is cheaper than a run that spent
 * its whole budget waiting.
 */
export const GOOGLE_DELAY_MAX_MS = 60_000;

const OFF: GoogleDelaySetting = { read: null, write: null, unknown: null };

/** A raw value as a setting. Strict: one malformed part makes the WHOLE value unknown, because
 *  half a delay is a rig nobody asked for, and its report would describe the half that applied. */
export function parseGoogleDelay(raw: string | undefined): GoogleDelaySetting {
  const value = (raw ?? "").trim();
  if (value === "") return OFF;
  const out: GoogleDelaySetting = { read: null, write: null, unknown: null };
  const unknown = { read: null, write: null, unknown: value };
  for (const part of value.split(",")) {
    const m = /^\s*(read|write)\s*=\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(part);
    if (!m) return unknown;
    const kind = m[1] as GoogleDelayKind;
    const p50Ms = Number(m[2]);
    const p95Ms = Number(m[3]);
    if (out[kind] !== null) return unknown;
    if (!(p50Ms > 0 && p50Ms <= p95Ms && p95Ms <= GOOGLE_DELAY_MAX_MS)) return unknown;
    out[kind] = { p50Ms, p95Ms };
  }
  return out;
}

/** The canonical spelling of a setting, `""` when nothing is delayed. Two spellings of one rig
 *  format identically, so the preflight compares rigs rather than whitespace. */
export function formatGoogleDelay(setting: GoogleDelaySetting): string {
  return GOOGLE_DELAY_KINDS.flatMap((kind) => {
    const d = setting[kind];
    return d ? [`${kind}=${d.p50Ms}/${d.p95Ms}`] : [];
  }).join(",");
}

/** Whether anything is delayed at all. */
export function googleDelayOn(setting: GoogleDelaySetting): boolean {
  return setting.read !== null || setting.write !== null;
}

/**
 * The standard normal quantile (Acklam's rational approximation, relative error below
 * 1.2e-9), so a uniform draw can be turned into a lognormal one without a library.
 */
export function normalQuantile(u: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (u <= 0) return -Infinity;
  if (u >= 1) return Infinity;
  if (u < lo) {
    const q = Math.sqrt(-2 * Math.log(u));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (u > 1 - lo) {
    const q = Math.sqrt(-2 * Math.log(1 - u));
    return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  const q = u - 0.5;
  const r = q * q;
  return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

/** The z score of the 95th percentile: where `p95Ms` sits on the standard normal. */
const Z95 = 1.6448536269514722;

/**
 * The delay at quantile `u` of a lognormal whose median is `p50Ms` and whose 95th
 * percentile is `p95Ms`, in whole milliseconds.
 *
 * Lognormal because a network call's latency is: bounded below, with a long right tail,
 * and its median and p95 are the two figures production's timings are read in. Fitted
 * through exactly those two points, so a run asked for 3000/5000 meets a median of 3s
 * and a p95 of 5s, and a median equal to its p95 is a constant delay.
 */
export function delayAtQuantile(d: DelayDistribution, u: number): number {
  if (d.p50Ms === d.p95Ms) return d.p50Ms;
  const sigma = Math.log(d.p95Ms / d.p50Ms) / Z95;
  return Math.round(Math.exp(Math.log(d.p50Ms) + sigma * normalQuantile(u)));
}

/**
 * The load run report's line naming the Google rig a run was dispatched for, so two runs
 * are never compared across settings (#3490): a run with the delay off measured no Google
 * time at all, and its confirm latency is not comparable with one that did.
 */
export function googleDelayLine(raw: string | undefined): string {
  const setting = parseGoogleDelay(raw);
  if (setting.unknown !== null) {
    return `Google stand in delay: dispatched as "${setting.unknown}", which is no setting, so nothing was delayed (#3490).`;
  }
  if (!googleDelayOn(setting)) {
    return "Google stand in delay: **off**. The stand in answered at once, so confirm latency carries no Google time (#3490).";
  }
  const said = GOOGLE_DELAY_KINDS.flatMap((kind) => {
    const d = setting[kind];
    return [`${kind === "read" ? "live checks" : "calendar writes"} ${d ? `median ${d.p50Ms}ms, p95 ${d.p95Ms}ms` : "not delayed"}`];
  }).join("; ");
  return `Google stand in delay: **${formatGoogleDelay(setting)}** (${said}) (#3490).`;
}
