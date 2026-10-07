/**
 * Where each burst's time went (#3416). A report, never a bar.
 *
 * Load run 37520312761 failed two of its three bursts: every burst confirm took about
 * ten seconds against three to four on run 37390071571, and the slowest losers were
 * refused 503 VERIFY_UNAVAILABLE instead of SLOT_TAKEN. The shared line accounted for
 * little of it, and nobody could say which stage took the rest, because no burst
 * confirm's log line was kept: the archive's tail starts after the burst job. The run
 * now streams a BURST TAIL (`burst-tail.jsonl`) from before the first burst's moment
 * until the last burst's lines are in, and this reads it.
 *
 * **It is its own file, read only here.** A crowd of a hundred confirms on one slot is
 * a different load shape from the steady pass, so its confirms must never join the
 * startup bar's population, which comes from the archive's `tail.jsonl` alone. The
 * diagnostic cold leg's tail is kept apart the same way.
 *
 * **One reader of the archive.** A confirm's lines are paired with each other by
 * being in the same invocation, through `tailInvocations` in `confirm-startup.ts`,
 * the same reader the startup split uses (L41, L420). What is added here is the step
 * that reader never needed: tying each REQUEST in the driver's burst files to its
 * invocation. The key is the deployment's own answer stamp. The route writes its
 * `confirm answered` line and then stamps `x-loadtest-answered-at` with no I/O in
 * between, and a Worker's clock moves only at I/O, so the line's timestamp IS the
 * stamp the driver recorded. Measured on run 37520312761's steady pass: driver 0's
 * 150 requests against the archive matched 111 exactly and none ambiguously on the
 * address, the stamp and the status; the other 39 were all sent before the archive's
 * tail connected. A burst answers many requests on one millisecond (32 of burst 1's
 * 100 shared address, stamp and status with another), so the key also carries
 * everything the deployment echoed about the line (which line, why, which key, its
 * milliseconds), which leaves 2 and 4 of a hundred sharing a key.
 *
 * Those few are handled without guessing. Requests whose key is identical and whose
 * count equals the confirms carrying that key, all ending the same way, are matched as
 * ONE BLOCK: which line is whose cannot change any figure below, because the figures
 * are reported per outcome and every member has the same one. Anything else sharing a
 * key is AMBIGUOUS and left out by count, never assigned by a guess (L521).
 *
 * Every way of learning nothing is said in its own words and is UNMEASURED, never a
 * quiet burst (L98): the burst tail never arriving, arriving empty, holding no burst
 * confirm, or a burst none of whose requests matched.
 */
import { answerLineOf, logNumber, logText, tailInvocations, type TailInvocation, type TailLogLine } from "./confirm-startup.ts";
import { WAIT_SPAN_FIELDS, type WaitSpanField } from "../../src/lib/booking/wait-marks.ts";
import { burstLegLabel, isSlotTaken, percentiles, refusalLabel, WAIT_SPAN_LABELS, type BurstLegGroup } from "./judge-booking-run.ts";
import type { BookingAttempt } from "./book-plan.ts";
import type { EchoField } from "../../src/lib/loadtest-echo.ts";
import { readOptionalText, type OptionalText } from "./read-optional.ts";

/** The burst tail's file name, which the workflow writes and the judge reads. */
export const BURST_TAIL_FILE = "burst-tail.jsonl";

/** One named stage of a confirm's profile, as its `confirm answered` line carries it. */
export interface StageTime {
  stage: string;
  ms: number;
  runs: number;
}

/** One dependency's calls, as the line carries them: covered ms, calls, the slowest call. */
export interface DependencyTime {
  dependency: string;
  ms: number;
  calls: number;
  maxMs: number;
}

/**
 * The stage profile a confirm's line carries (#3300): written only for a confirm that
 * timed out or took `CONFIRM_PROFILE_SLOW_MS` or longer, so a fast confirm has none.
 */
export interface LineProfile {
  stages: StageTime[];
  unattributedMs: number | null;
  callsBy: DependencyTime[];
}

/** One burst confirm, read from its own invocation's `confirm answered` line. */
export interface BurstConfirm {
  /** The answer line's timestamp: the deployment's clock, and the stamp the response carried. */
  answeredAtMs: number;
  /** When its invocation began, on the same clock. */
  eventAtMs: number | null;
  /** The address the request came from, as the runtime archived it. */
  ip: string | null;
  status: number | null;
  /** What the line says about the confirm line, as written, null when it says nothing. */
  line: string | null;
  lineReason: string | null;
  lineKey: string | null;
  lineMs: string | null;
  /** The route's own answer time. */
  responseMs: number | null;
  /** The runtime's CPU for the whole invocation, deferred work included. */
  cpuMs: number | null;
  waits: Partial<Record<WaitSpanField, number>>;
  /** #3272: the stage that refused it and the per rung counts, or null when the line names none. */
  refusalStage: string | null;
  stageCounts: string | null;
  timedOut: boolean;
  profile: LineProfile | null;
  /** The line said it carried a profile and its stage list could not be read. */
  profileUnreadable: boolean;
}

/** What one burst tail holds. */
export interface BurstTailReading {
  /** Every invocation read, whatever it was. */
  events: number;
  /** Stretches that are not readable JSON, which a stream stopped mid write leaves. */
  unparsable: number;
  confirms: BurstConfirm[];
  /** Answer lines from another leg, set aside. */
  otherLegs: number;
  /** Answer lines naming no leg (a deployment predating #3354), set aside. */
  noLeg: number;
  /** Answer lines of the leg with no readable timestamp, which no request can be matched to. */
  unstamped: number;
  firstEventAtMs: number | null;
  lastEventAtMs: number | null;
}

/** `name:ms/runs` tokens, or null when any token is not that shape. */
function stageTimes(raw: string): StageTime[] | null {
  const out: StageTime[] = [];
  for (const token of raw.split(",")) {
    const m = /^(.+):(\d+)\/(\d+)$/.exec(token);
    if (!m) return null;
    out.push({ stage: m[1]!, ms: Number(m[2]), runs: Number(m[3]) });
  }
  return out;
}

/** `dependency:ms/calls/slowest` tokens, or null when any token is not that shape. */
function dependencyTimes(raw: string): DependencyTime[] | null {
  const out: DependencyTime[] = [];
  for (const token of raw.split(",")) {
    const m = /^(.+):(\d+)\/(\d+)\/(\d+)$/.exec(token);
    if (!m) return null;
    out.push({ dependency: m[1]!, ms: Number(m[2]), calls: Number(m[3]), maxMs: Number(m[4]) });
  }
  return out;
}

/** The profile a line carries: none, read, or claimed and unreadable (said apart, L11). */
function lineProfile(text: string): { profile: LineProfile | null; unreadable: boolean } {
  const run = logNumber(text, "stages_run");
  if (run === null) return { profile: null, unreadable: false };
  const rawStages = logText(text, "stages");
  const stages = rawStages === null ? (run === 0 ? [] : null) : stageTimes(rawStages);
  const rawCalls = logText(text, "calls_by");
  const callsBy = rawCalls === null ? [] : dependencyTimes(rawCalls);
  if (stages === null || callsBy === null) return { profile: null, unreadable: true };
  return { profile: { stages, unattributedMs: logNumber(text, "unattributed_ms"), callsBy }, unreadable: false };
}

function confirmOf(inv: TailInvocation, answer: TailLogLine & { timestamp: number }): BurstConfirm {
  const text = answer.text;
  const waits: Partial<Record<WaitSpanField, number>> = {};
  for (const f of WAIT_SPAN_FIELDS) {
    const v = logNumber(text, f);
    if (v !== null && v >= 0) waits[f] = v;
  }
  const { profile, unreadable } = lineProfile(text);
  return {
    answeredAtMs: answer.timestamp,
    eventAtMs: inv.eventTimestamp,
    ip: inv.requestIp,
    status: logNumber(text, "status"),
    line: logText(text, "line"),
    lineReason: logText(text, "line_reason"),
    lineKey: logText(text, "line_key"),
    lineMs: logText(text, "line_ms"),
    responseMs: logNumber(text, "response_ms"),
    cpuMs: inv.cpuTime,
    waits,
    refusalStage: logText(text, "refusal_stage"),
    stageCounts: logText(text, "stage_counts"),
    timedOut: logText(text, "timed_out") === "true",
    profile,
    profileUnreadable: unreadable,
  };
}

/**
 * Every burst confirm in a burst tail, read through the archive's one reader. `leg`
 * is the leg kept (the burst by default), so the matcher can be checked against
 * another leg's archive.
 */
export function readBurstTail(archive: string, opts?: { leg?: string }): BurstTailReading {
  const leg = opts?.leg ?? "burst";
  const reading: BurstTailReading = {
    events: 0,
    unparsable: 0,
    confirms: [],
    otherLegs: 0,
    noLeg: 0,
    unstamped: 0,
    firstEventAtMs: null,
    lastEventAtMs: null,
  };
  for (const item of tailInvocations(archive)) {
    if (item.kind === "unparsable") {
      reading.unparsable += 1;
      continue;
    }
    const inv = item.invocation;
    reading.events += 1;
    if (inv.eventTimestamp !== null) {
      reading.firstEventAtMs = Math.min(reading.firstEventAtMs ?? inv.eventTimestamp, inv.eventTimestamp);
      reading.lastEventAtMs = Math.max(reading.lastEventAtMs ?? inv.eventTimestamp, inv.eventTimestamp);
    }
    const answer = answerLineOf(inv);
    if (answer === null) continue;
    const named = logText(answer.text, "loadtest_leg");
    if (named === null || named === "") {
      reading.noLeg += 1;
      continue;
    }
    if (named !== leg) {
      reading.otherLegs += 1;
      continue;
    }
    if (answer.timestamp === null) {
      reading.unstamped += 1;
      continue;
    }
    reading.confirms.push(confirmOf(inv, { text: answer.text, timestamp: answer.timestamp }));
  }
  return reading;
}

/** How a burst request's outcome is named in the breakdown, the judge's own way (L41). */
export function burstOutcomeLabel(a: BookingAttempt): string {
  if (a.status === 0) return "no reply";
  if (a.status === 200) return "won";
  if (isSlotTaken(a)) return "SLOT_TAKEN";
  return refusalLabel(a);
}

function echoPart(f: EchoField<string> | EchoField<number> | undefined): string {
  if (!f || f.state === "absent") return "-";
  return f.state === "unreadable" ? f.raw : String(f.value);
}

/** A request's key, or null when it carries no readable answer stamp. */
function attemptKey(a: BookingAttempt): string | null {
  const stamp = a.echo?.answeredAtMs;
  if (!stamp || stamp.state !== "read") return null;
  const e = a.echo!;
  return [a.seenIp ?? "-", stamp.value, a.status, echoPart(e.line), echoPart(e.reason), echoPart(e.key), echoPart(e.lineMs)].join("|");
}

/** A confirm's key, built from its own line the same way. */
function confirmKey(c: BurstConfirm): string {
  return [c.ip ?? "-", c.answeredAtMs, c.status ?? "-", c.line ?? "-", c.lineReason ?? "-", c.lineKey ?? "-", c.lineMs ?? "-"].join("|");
}

/** Every burst request, matched to its own confirm's lines or counted by why it was not. */
export interface BurstMatch {
  /** In the requests' own order. */
  matched: { attempt: BookingAttempt; confirm: BurstConfirm }[];
  /** Of those, the ones matched as a block of identical keys, one outcome. */
  interchangeable: number;
  /** No reply at all, so no line exists to match. */
  noReply: BookingAttempt[];
  /** Answered with no readable answer stamp. */
  noStamp: BookingAttempt[];
  /** Nothing in the tail carries its key. */
  unmatched: BookingAttempt[];
  /** Its key is shared in a way only a guess could resolve. */
  ambiguous: BookingAttempt[];
}

export function matchBurstAttempts(attempts: readonly BookingAttempt[], confirms: readonly BurstConfirm[]): BurstMatch {
  const out: BurstMatch = { matched: [], interchangeable: 0, noReply: [], noStamp: [], unmatched: [], ambiguous: [] };
  const byKey = new Map<string, BurstConfirm[]>();
  for (const c of confirms) {
    const k = confirmKey(c);
    byKey.set(k, [...(byKey.get(k) ?? []), c]);
  }
  const order = new Map<BookingAttempt, number>();
  const wanting = new Map<string, BookingAttempt[]>();
  for (const [i, a] of attempts.entries()) {
    order.set(a, i);
    if (a.status === 0) {
      out.noReply.push(a);
      continue;
    }
    const k = attemptKey(a);
    if (k === null) {
      out.noStamp.push(a);
      continue;
    }
    wanting.set(k, [...(wanting.get(k) ?? []), a]);
  }
  for (const [k, want] of wanting) {
    const have = byKey.get(k) ?? [];
    if (have.length === 0) {
      out.unmatched.push(...want);
      continue;
    }
    const oneOutcome = new Set(want.map(burstOutcomeLabel)).size === 1;
    if (want.length !== have.length || !oneOutcome) {
      out.ambiguous.push(...want);
      continue;
    }
    // Paired in sending order against invocation order. Within a block nothing below
    // depends on the pairing: every member has one key and one outcome.
    const a = [...want].sort((x, y) => x.sentAtMs - y.sentAtMs);
    const c = [...have].sort((x, y) => (x.eventAtMs ?? Infinity) - (y.eventAtMs ?? Infinity));
    for (let i = 0; i < a.length; i++) out.matched.push({ attempt: a[i]!, confirm: c[i]! });
    if (want.length > 1) out.interchangeable += want.length;
  }
  out.matched.sort((x, y) => order.get(x.attempt)! - order.get(y.attempt)!);
  return out;
}

/** One outcome's share of one burst. */
export interface OutcomeBreakdown {
  label: string;
  requests: number;
  matched: number;
  /** The driver's own wall time, over every answered request of this outcome. */
  wallMs: number[];
  responseMs: number[];
  cpuMs: number[];
  waits: Partial<Record<WaitSpanField, number[]>>;
  /** Matched confirms whose line carried a stage profile. */
  profiled: number;
  profileUnreadable: number;
  stages: Record<string, number[]>;
  unattributedMs: number[];
  callsBy: Record<string, number[]>;
  /** The refusing stage, tallied: by name for SLOT_TAKEN, with per rung counts for any other refusal. */
  refusals: Record<string, number>;
}

/** One burst, broken down by outcome. */
export interface BurstBreakdown {
  index: number;
  label: string;
  momentMs: number | null;
  requests: number;
  matched: number;
  interchangeable: number;
  noReply: number;
  noStamp: number;
  unmatched: number;
  ambiguous: number;
  groups: OutcomeBreakdown[];
}

function refusalSignature(c: BurstConfirm, withCounts: boolean): string {
  const base =
    c.refusalStage === null
      ? "no stage on its line"
      : withCounts && c.stageCounts
        ? `${c.refusalStage} at ${c.stageCounts}`
        : c.refusalStage;
  return c.timedOut ? `${base}, timed out` : base;
}

function emptyOutcome(label: string): OutcomeBreakdown {
  return {
    label,
    requests: 0,
    matched: 0,
    wallMs: [],
    responseMs: [],
    cpuMs: [],
    waits: {},
    profiled: 0,
    profileUnreadable: 0,
    stages: {},
    unattributedMs: [],
    callsBy: {},
    refusals: {},
  };
}

function outcomeRank(label: string): number {
  return label === "won" ? 0 : label === "SLOT_TAKEN" ? 1 : label === "no reply" ? 3 : 2;
}

/**
 * Every burst's breakdown, its requests matched against the whole tail at once so no
 * confirm can be claimed by two bursts.
 */
export function burstBreakdowns(groups: readonly BurstLegGroup[], tail: BurstTailReading): BurstBreakdown[] {
  const all = groups.flatMap((g) => g.files.flatMap((f) => f.attempts));
  const match = matchBurstAttempts(all, tail.confirms);
  const confirmOfAttempt = new Map(match.matched.map((m) => [m.attempt, m.confirm]));
  const inBlock = new Set<BookingAttempt>();
  if (match.interchangeable > 0) {
    const keyCount = new Map<string, number>();
    for (const m of match.matched) {
      const k = attemptKey(m.attempt)!;
      keyCount.set(k, (keyCount.get(k) ?? 0) + 1);
    }
    for (const m of match.matched) if ((keyCount.get(attemptKey(m.attempt)!) ?? 0) > 1) inBlock.add(m.attempt);
  }
  const count = (list: BookingAttempt[], mine: Set<BookingAttempt>) => list.filter((a) => mine.has(a)).length;
  return groups.map((g) => {
    const attempts = g.files.flatMap((f) => f.attempts);
    const mine = new Set(attempts);
    const byLabel = new Map<string, OutcomeBreakdown>();
    for (const a of attempts) {
      const label = burstOutcomeLabel(a);
      const o = byLabel.get(label) ?? emptyOutcome(label);
      byLabel.set(label, o);
      o.requests += 1;
      if (a.status !== 0) o.wallMs.push(a.wallMs);
      const c = confirmOfAttempt.get(a);
      if (!c) continue;
      o.matched += 1;
      if (c.responseMs !== null) o.responseMs.push(c.responseMs);
      if (c.cpuMs !== null) o.cpuMs.push(c.cpuMs);
      for (const [f, v] of Object.entries(c.waits) as [WaitSpanField, number][]) (o.waits[f] ??= []).push(v);
      if (c.profileUnreadable) o.profileUnreadable += 1;
      if (c.profile) {
        o.profiled += 1;
        for (const s of c.profile.stages) (o.stages[s.stage] ??= []).push(s.ms);
        if (c.profile.unattributedMs !== null) o.unattributedMs.push(c.profile.unattributedMs);
        for (const d of c.profile.callsBy) (o.callsBy[d.dependency] ??= []).push(d.ms);
      }
      if (label !== "won") {
        const sig = refusalSignature(c, label !== "SLOT_TAKEN");
        o.refusals[sig] = (o.refusals[sig] ?? 0) + 1;
      }
    }
    const outcomes = [...byLabel.values()].sort(
      (x, y) => outcomeRank(x.label) - outcomeRank(y.label) || y.requests - x.requests || x.label.localeCompare(y.label),
    );
    const first = g.files[0];
    return {
      index: g.index,
      // The judge's own name for the burst (#3429), so the report never names one burst two ways.
      label: burstLegLabel(g),
      momentMs: first?.burstLeg?.startAtMs ?? null,
      requests: attempts.length,
      matched: attempts.filter((a) => confirmOfAttempt.has(a)).length,
      interchangeable: attempts.filter((a) => inBlock.has(a)).length,
      noReply: count(match.noReply, mine),
      noStamp: count(match.noStamp, mine),
      unmatched: count(match.unmatched, mine),
      ambiguous: count(match.ambiguous, mine),
      groups: outcomes,
    };
  });
}

/** The burst tail as the judge found it: absent, unreadable, or read. */
export type BurstTailFile = OptionalText;

/**
 * Read the burst tail, telling a file that never arrived from one that could not be
 * read (L11), through the reader the cold leg's results use too.
 */
export const readBurstTailFile: (read: () => string) => BurstTailFile = readOptionalText;

/** One value or a spread, through the judge's own percentiles (L41); null when there is none. */
function spread(xs: number[]): string | null {
  const p = percentiles(xs);
  if (p === null) return null;
  return xs.length === 1 ? `${p.max}ms` : `p50 ${p.p50}ms max ${p.max}ms`;
}

/** A tally, commonest first, each count marked `xN` so it never reads as part of a rung's counts. */
function tally(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label, n]) => `${label} x${n}`)
    .join(", ");
}

function iso(ms: number | null): string {
  return ms === null ? "an unknown time" : new Date(ms).toISOString();
}

/** Named timings, the highest median first, so a reader meets the expensive one first. */
function dearestFirst(a: [string, number[]], b: [string, number[]]): number {
  return (percentiles(b[1])?.p50 ?? 0) - (percentiles(a[1])?.p50 ?? 0) || a[0].localeCompare(b[0]);
}

function outcomeText(o: OutcomeBreakdown): string {
  if (o.label === "no reply") return `${o.label} (${o.requests}): no answer came back, so there is no log line to match`;
  const head = `${o.label} (${o.requests}, ${o.matched} matched)`;
  if (o.matched === 0) return `${head}: none matched a confirm in the burst tail, so nothing to break down`;
  const parts: string[] = [];
  const wall = spread(o.wallMs);
  const route = spread(o.responseMs);
  parts.push(`answered in ${wall ?? "n/a"} at the driver, ${route ?? "n/a"} in the route`);
  const cpu = spread(o.cpuMs);
  if (cpu) parts.push(`invocation cpu ${cpu}`);
  const spans = WAIT_SPAN_FIELDS.flatMap((f) => {
    const s = spread(o.waits[f] ?? []);
    return s === null ? [] : [`${WAIT_SPAN_LABELS[f]} ${s}`];
  });
  parts.push(spans.length > 0 ? `before the profile: ${spans.join(", ")}` : "no line carried marks before the profile");
  if (o.profiled === 0) {
    parts.push(
      "no line carried a stage profile (one is written only for a slow or timed out confirm)" +
        (o.profileUnreadable > 0 ? `, ${o.profileUnreadable} carried one that could not be read` : ""),
    );
  } else {
    const stages = Object.entries(o.stages)
      .sort(dearestFirst)
      .map(([name, ms]) => `${name} ${spread(ms)}${ms.length < o.profiled ? ` in ${ms.length}` : ""}`);
    const deps = Object.entries(o.callsBy)
      .sort(dearestFirst)
      .map(([name, ms]) => `${name} ${spread(ms)}`);
    const unattributed = spread(o.unattributedMs);
    parts.push(
      `by stage over the whole confirm (${o.profiled} of ${o.matched} carried a profile` +
        (o.profileUnreadable > 0 ? `, ${o.profileUnreadable} unreadable` : "") +
        `): ${stages.join(", ") || "no stage ran"}` +
        (unattributed ? `; unattributed ${unattributed}` : "") +
        (deps.length > 0 ? `; calls ${deps.join(", ")}` : ""),
    );
  }
  const refused = tally(o.refusals);
  // The rung counts are `refusalLogFields`' own tokens; their legend is said once.
  const legend = Object.keys(o.refusals).some((k) => k.includes(" at ")) ? " (per rung code:members/read/claimed/checked)" : "";
  if (refused) parts.push(`refused at ${refused}${legend}`);
  return `${head}: ${parts.join("; ")}`;
}

const HEAD = "- where each burst's time went (reported, not a bar)";

/**
 * The burst section of the report: one head line, then each burst and each of its
 * outcomes, or one line saying why it was UNMEASURED. Never empty: a section that is
 * silently left out reads exactly like a run whose bursts were quick (L98).
 */
export function burstBreakdownLines(input: { groups: readonly BurstLegGroup[]; tail: BurstTailFile }): string[] {
  if (input.groups.length === 0) return [`${HEAD}: no burst leg in this run, so there was nothing to break down`];
  const t = input.tail;
  if (t.kind === "absent") {
    return [
      `${HEAD}: UNMEASURED, the burst tail (${BURST_TAIL_FILE}) never arrived, so no burst confirm's log line ` +
        "was kept and nothing here says where the bursts' time went",
    ];
  }
  if (t.kind === "unreadable") return [`${HEAD}: UNMEASURED, the burst tail (${BURST_TAIL_FILE}) could not be read (${t.why})`];
  if (t.text.trim() === "") {
    return [
      `${HEAD}: UNMEASURED, the burst tail (${BURST_TAIL_FILE}) arrived empty, so the stream never delivered an ` +
        "event and no burst confirm's log line was kept (its stderr is in the burst-tail artifact)",
    ];
  }
  const reading = readBurstTail(t.text);
  const asideParts = [
    reading.otherLegs > 0 ? `${reading.otherLegs} from other legs` : null,
    reading.noLeg > 0 ? `${reading.noLeg} naming no leg` : null,
    reading.unstamped > 0 ? `${reading.unstamped} with no readable time` : null,
    reading.unparsable > 0 ? `${reading.unparsable} not readable JSON` : null,
  ].filter((p): p is string => p !== null);
  const events = `${reading.events} event${reading.events === 1 ? "" : "s"}`;
  if (reading.confirms.length === 0) {
    return [
      `${HEAD}: UNMEASURED, the burst tail holds ${events} and not one burst confirm's answer line` +
        (asideParts.length > 0 ? ` (${asideParts.join(", ")})` : "") +
        ", so no burst request could be matched",
    ];
  }
  const bursts = burstBreakdowns(input.groups, reading);
  const requests = bursts.reduce((n, b) => n + b.requests, 0);
  const matched = bursts.reduce((n, b) => n + b.matched, 0);
  const lines = [
    `${HEAD}: ${matched} of ${requests} burst requests matched to their confirm's own lines, from ${events} in the burst tail` +
      (asideParts.length > 0 ? `; set aside ${asideParts.join(", ")}` : ""),
  ];
  for (const b of bursts) {
    const lost = [
      b.interchangeable > 0 ? `${b.interchangeable} matched as one block: one answer stamp, address and line, one outcome` : null,
      b.unmatched > 0 ? `${b.unmatched} not in the tail` : null,
      b.ambiguous > 0 ? `${b.ambiguous} ambiguous, sharing a key only a guess could split` : null,
      b.noStamp > 0 ? `${b.noStamp} answered with no readable stamp` : null,
      b.noReply > 0 ? `${b.noReply} no reply` : null,
    ].filter((p): p is string => p !== null);
    if (b.matched === 0) {
      lines.push(
        `  - ${b.label}: UNMEASURED, none of its ${b.requests} requests matched a confirm in the burst tail` +
          (lost.length > 0 ? ` (${lost.join(", ")})` : "") +
          `; the tail ran from ${iso(reading.firstEventAtMs)} to ${iso(reading.lastEventAtMs)} and the burst fired at ${iso(b.momentMs)}`,
      );
      continue;
    }
    lines.push(`  - ${b.label}: ${b.matched} of ${b.requests} requests matched${lost.length > 0 ? ` (${lost.join("; ")})` : ""}`);
    for (const o of b.groups) lines.push(`    - ${outcomeText(o)}`);
  }
  return lines;
}
