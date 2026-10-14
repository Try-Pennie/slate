/**
 * Is the booker offering a time the confirm would refuse, and has it gone on for
 * longer than a few minutes? (#3381)
 *
 * Nothing checked that the times a lead is SHOWN are times the confirm would accept.
 * On 2026-10-06 bucket 112 offered times that had been full for six to fifteen hours,
 * and on 2026-10-14 a stored row two minutes old offered a time the confirm's own
 * candidate read found none of 74 advisors free for. Both times the only signal was
 * leads being refused. The availability truth probe (#1315) asks a different question,
 * a fresh compute against Google, and the data anomaly probe compares the row against
 * a recompute that reads the same cache, so neither can see a SERVED time the confirm
 * refuses.
 *
 * So this samples served times and judges each with the confirm's own candidate read
 * (`roundRobinCandidates`, injected as `judge`), the same predicate, the same reads
 * and the same holds and Low rules, never a copy of them (L345: a detector sharing the
 * decision it checks can only confirm it, but here the decision under test is the
 * STORED ROW's, and the judge is the confirm's, which is the disagreement to find).
 *
 * **Longer than a few minutes.** A time a calendar change took a moment ago is
 * legitimately still offered until the pool is recomputed: the recompute lane rewrites
 * every pool at least once a `RECOMPUTE_FRESH_MS`, and a push refresh can be deferred
 * to it (#3258). So a time found offered with nobody free is only REMEMBERED (a marker
 * in `alert_state`), re-judged first on the next tick, and pages only if it is still
 * offered with nobody free at least `PERSIST_MS` after it was first seen. By then the
 * lane has had a whole freshness window to drop it, so a lag cannot explain it.
 *
 * **What it costs.** One judgment is one `ladder_candidate_inputs` request plus the
 * candidate predicate over the pool: about 4ms of CPU for a synthetic 75 advisor pool
 * on a laptop, measured 2026-10-14 after #2806 (it was about 137ms before), so the
 * REQUEST is the cost that binds. A tick judges at most `MAX_JUDGMENTS_PER_TICK`:
 * remembered times first, then new samples rotated across the pools. At the cap that is
 * nine subrequests on a healthy tick (the pool listing's two reads, the marker read, one
 * request per judgment), plus one marker write or delete per time found or settled, on
 * the five minute invocation four lanes share.
 *
 * **What a finding means.** Nobody in the CODE'S OWN pool is free at a time that code's
 * stored row offers. A lead on that code is then refused unless a lower tier on their
 * ladder can take the time, so the page says so rather than claiming every lead is
 * turned away; either way the row is offering what its own pool cannot take.
 *
 * **What it cannot see**, so a quiet day is never read as more than it measured: it
 * judges a handful of times a tick, so a single wrong time somewhere in a pool's three
 * days is found only when the rotation reaches it, and a lower rung's served list (the
 * Low exclusion a top tier lead's cascade reads) is not sampled, only each code's own.
 *
 * Pure apart from the injected reads, judge, markers and dispatcher, so
 * scripts/test-offered-nobody-free.ts drives every branch with no database and no clock.
 */
import type { AlertResolve, ThrottledNotify } from "./alert-deps.ts";
import { shapePrecomputedRow } from "../availability/precompute-shape.ts";
import { slotsWithinBusinessHours, type BusinessHoursRules } from "../availability/compute.ts";
import { rowProvenance } from "../availability/slot-row-writer.ts";
import { RECOMPUTE_FRESH_MS } from "../availability/precompute-cron.ts";
import { DateTime } from "luxon";
import { BUSINESS_ZONE } from "../booking/business-hours.ts";
import { formatClockTime, formatLongDate } from "../date/parse.ts";

/** The page: a single condition, naming every time it found. */
export const OFFERED_NOBODY_FREE_ALERT_KEY = "offered_nobody_free";

/**
 * The marker prefix for a time found offered with nobody free, waiting for its second
 * look. Not an alert key: namespaced away from the page's own cooldown key, as the
 * drift probe's `availability_drift_seen` is. Its suffix is `<code>@<start ISO>`.
 *
 * Bounded by construction, not by a cap: a tick re-judges every live marker before it
 * takes a new sample, and only a new sample can add one, so there are never more live
 * markers than `MAX_JUDGMENTS_PER_TICK`. A marker whose time is no longer offered, or
 * has passed, is deleted on the next tick.
 */
export const OFFERED_NOBODY_FREE_SEEN_PREFIX = "offered_nobody_free_seen";

/** The monitor lane's cadence. Restated rather than imported to keep this module free of
 *  the lane's other imports; `scripts/test-offered-nobody-free.ts` holds the two equal. */
export const OFFERED_CHECK_CADENCE_MS = 5 * 60_000;

/**
 * How long a time must stay offered with nobody free before it pages. DERIVED from the
 * recompute lane's freshness window (L63): the lane rewrites every pool at least once
 * inside it, so a time still offered after it was not a lag.
 */
export const PERSIST_MS = RECOMPUTE_FRESH_MS;

/** Times closer than this are skipped: a booking may be landing on them right now, and
 *  verify on book is about to judge them live anyway. */
export const LEAD_MS = 30 * 60_000;

/** The per tick ceiling, in judgments: one subrequest each (see the header for the cost). */
export const MAX_JUDGMENTS_PER_TICK = 6;

/** A `bucket_slots` row as the monitor lane's setup read holds it. */
export interface OfferedRow {
  bucket_code: string;
  payload: unknown;
  computed_at: string;
}

/** A time remembered from an earlier tick. */
export interface Suspect {
  code: string;
  startMs: number;
  firstSeenMs: number;
}

/** What the confirm's candidate read said about one time. */
export interface Judgment {
  /** Advisors the read found free (after holds). */
  free: number;
  /** Advisors in the pool, before any availability. */
  members: number;
}

/** The event type fields the judge needs to build its read window. */
export interface JudgeEventType {
  duration_min: number;
  buffer_before_min: number;
  buffer_after_min: number;
}

/** One time that has stayed offered with nobody free past `PERSIST_MS`. */
export interface OfferedFinding {
  code: string;
  startMs: number;
  firstSeenMs: number;
  members: number;
  /** When the stored row was computed, and by which path (#3381), for the reader. */
  rowComputedAt: string;
  writtenBy: string | null;
}

export interface OfferedNobodyFreeDeps {
  nowMs: number;
  /** The stored rows, from the lane's own setup read. */
  rows: OfferedRow[];
  /** The org's week, the filter every served list passes through. */
  hours: BusinessHoursRules;
  /** Real bucket codes grouped by pool. THROWS on a failed read. */
  loadPools(): Promise<string[][]>;
  /** Times remembered by earlier ticks. THROWS on a failed read. */
  readSuspects(): Promise<Suspect[]>;
  /** The confirm's candidate read for one time. Null when it could not be read. */
  judge(code: string, startMs: number, eventType: JudgeEventType): Promise<Judgment | null>;
  /** Remember a time (THROWS on failure). */
  markSuspect(code: string, startMs: number, firstSeenMs: number): Promise<void>;
  /** Forget a time (THROWS on failure). */
  clearSuspect(code: string, startMs: number): Promise<void>;
  notify: ThrottledNotify;
  resolve: AlertResolve<unknown>;
  cooldownMs: number;
  log(fields: Record<string, string | number | boolean | null>): void;
}

export type OfferedNobodyFreeResult =
  | { status: "unreadable"; why: string }
  | {
      status: "measured";
      /** Times judged with an answer this tick. */
      judged: number;
      /** Of those, offered with nobody free. */
      nobodyFree: number;
      /** Judgments the candidate read could not answer. */
      unreadable: number;
      /** Times that have stayed offered with nobody free past `PERSIST_MS`. */
      persisting: OfferedFinding[];
      /** Remembered times still waiting for a second look after this tick. */
      suspects: number;
      paged: boolean;
      cleared: boolean;
    };

interface Served {
  starts: number[];
  eventType: JudgeEventType;
  computedAt: string;
  writtenBy: string | null;
}

/** What each code's own row is serving, from `notBeforeMs` on, through the org's week. */
export function servedStarts(rows: OfferedRow[], hours: BusinessHoursRules, notBeforeMs: number): Map<string, Served> {
  const out = new Map<string, Served>();
  for (const row of rows) {
    const shaped = shapePrecomputedRow(row);
    if (!shaped) continue;
    const ev = shaped.eventType;
    // The later of the lead and the event type's own minimum notice: a time inside the
    // notice is not being served at all (the route filters it), so judging it says nothing.
    const earliestMs = notBeforeMs + Math.max(LEAD_MS, ev.min_notice_min * 60_000);
    const starts = slotsWithinBusinessHours(shaped.slots, ev.duration_min, hours)
      // parse-ok: an unreadable instant is NaN, which fails the comparison and is dropped.
      .map((s) => Date.parse(s))
      .filter((ms) => Number.isFinite(ms) && ms >= earliestMs)
      .sort((a, b) => a - b);
    out.set(row.bucket_code, {
      starts,
      eventType: { duration_min: ev.duration_min, buffer_before_min: ev.buffer_before_min, buffer_after_min: ev.buffer_after_min },
      computedAt: row.computed_at,
      writtenBy: rowProvenance(row.payload).writtenBy,
    });
  }
  return out;
}

/**
 * A 32 bit integer mix of two integers (murmur3's finaliser over a combined word), so a
 * tick's choices are spread evenly and are the same every time the tick is replayed.
 */
function mix(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * The new samples for this tick: consecutive pools from a start the tick picks, and in
 * each the code and the time the tick picks, so over successive ticks every pool, code
 * and offered time is reached.
 *
 * Every choice is a function of the TICK and the pool alone, never of the budget, which
 * moves with how many remembered times the tick re-judged: a smaller budget takes a
 * prefix of the very samples a full one would have (a review of #3381 caught a stride
 * that moved with the budget and so skipped some samples and repeated others). And it
 * is a mix rather than a counter, because a counter stepped by a fixed stride lands on
 * the same few pools whenever the stride shares a factor with the number of pools.
 */
export function newSamples(
  pools: string[][],
  served: Map<string, Served>,
  tick: number,
  budget: number,
  taken: Set<string>,
): { code: string; startMs: number }[] {
  const out: { code: string; startMs: number }[] = [];
  const n = pools.length;
  if (n === 0) return out;
  const first = mix(tick, 0) % n;
  for (let i = 0; i < n && out.length < budget; i++) {
    const k = (first + i) % n;
    const pool = pools[k]!;
    if (pool.length === 0) continue;
    const code = pool[mix(tick, 2 * k + 1) % pool.length]!;
    const starts = served.get(code)?.starts ?? [];
    if (starts.length === 0) continue;
    const startMs = starts[mix(tick, 2 * k + 2) % starts.length]!;
    const id = suspectId(code, startMs);
    if (taken.has(id)) continue;
    taken.add(id);
    out.push({ code, startMs });
  }
  return out;
}

export const suspectId = (code: string, startMs: number) => `${code}@${new Date(startMs).toISOString()}`;

export async function runOfferedNobodyFreeCheck(deps: OfferedNobodyFreeDeps): Promise<OfferedNobodyFreeResult> {
  const { nowMs } = deps;
  let pools: string[][];
  let suspects: Suspect[];
  try {
    [pools, suspects] = await Promise.all([deps.loadPools(), deps.readSuspects()]);
  } catch (err) {
    // Neither read is guessed at: no pools reads as nothing to check, and no markers
    // reads as nothing remembered, which would all clear a condition still true.
    const why = `could not read the pools or the remembered times: ${err instanceof Error ? err.message : String(err)}`;
    deps.log({ msg: "offered nobody free unreadable", why });
    return { status: "unreadable", why };
  }

  // A marker write is bookkeeping for the NEXT tick, so one that fails must not take
  // this tick's findings with it: it is logged by name and answered false, and the
  // callers below count a failed clear as a time still remembered (which holds the all
  // clear back) and a failed mark as a time judged but not remembered (a later tick's
  // sample finds it again). Lessons review on #3726.
  const marked = async (op: "mark" | "clear", code: string, startMs: number, write: () => Promise<void>) => {
    try {
      await write();
      return true;
    } catch (err) {
      deps.log({
        msg: "offered time marker not written",
        op,
        bucket: code,
        start: new Date(startMs).toISOString(),
        why: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  };

  const served = servedStarts(deps.rows, deps.hours, nowMs);
  const isOffered = (code: string, startMs: number) => served.get(code)?.starts.includes(startMs) ?? false;

  let suspectsLeft = suspects.length;
  const plan: { code: string; startMs: number; suspect: Suspect | null }[] = [];
  const taken = new Set<string>();
  // Remembered times first, oldest first: a second look is what decides a page.
  for (const s of [...suspects].sort((a, b) => a.firstSeenMs - b.firstSeenMs)) {
    if (!isOffered(s.code, s.startMs)) {
      // No longer offered (the row dropped it, or it is now too close or past): over.
      if (await marked("clear", s.code, s.startMs, () => deps.clearSuspect(s.code, s.startMs))) suspectsLeft--;
      continue;
    }
    if (plan.length >= MAX_JUDGMENTS_PER_TICK) continue;
    taken.add(suspectId(s.code, s.startMs));
    plan.push({ code: s.code, startMs: s.startMs, suspect: s });
  }
  const tick = Math.floor(nowMs / OFFERED_CHECK_CADENCE_MS);
  for (const x of newSamples(pools, served, tick, MAX_JUDGMENTS_PER_TICK - plan.length, taken)) {
    plan.push({ ...x, suspect: null });
  }

  let judged = 0;
  let nobodyFree = 0;
  let unreadable = 0;
  const persisting: OfferedFinding[] = [];
  for (const p of plan) {
    const row = served.get(p.code)!;
    let j: Judgment | null;
    try {
      j = await deps.judge(p.code, p.startMs, row.eventType);
    } catch (err) {
      // Counted as unreadable, never as free, and the reason is kept: a read failing on
      // every time would otherwise look like a tick with nothing to judge until the
      // verdict stamp lapsed six hours later.
      deps.log({
        msg: "offered time could not be judged",
        bucket: p.code,
        start: new Date(p.startMs).toISOString(),
        why: err instanceof Error ? err.message : String(err),
      });
      j = null;
    }
    if (j === null) {
      unreadable++;
      continue;
    }
    judged++;
    if (j.free > 0) {
      if (p.suspect && (await marked("clear", p.code, p.startMs, () => deps.clearSuspect(p.code, p.startMs)))) {
        suspectsLeft--;
      }
      continue;
    }
    nobodyFree++;
    const firstSeenMs = p.suspect?.firstSeenMs ?? nowMs;
    deps.log({
      msg: "offered time nobody is free for",
      bucket: p.code,
      start: new Date(p.startMs).toISOString(),
      members: j.members,
      first_seen: new Date(firstSeenMs).toISOString(),
      row_computed_at: row.computedAt,
      written_by: row.writtenBy,
    });
    if (p.suspect) {
      if (nowMs - p.suspect.firstSeenMs >= PERSIST_MS) {
        persisting.push({
          code: p.code,
          startMs: p.startMs,
          firstSeenMs: p.suspect.firstSeenMs,
          members: j.members,
          rowComputedAt: row.computedAt,
          writtenBy: row.writtenBy,
        });
      }
    } else if (await marked("mark", p.code, p.startMs, () => deps.markSuspect(p.code, p.startMs, nowMs))) {
      suspectsLeft++;
    }
  }

  let paged = false;
  let cleared = false;
  if (persisting.length > 0) {
    // alert-key: offered_nobody_free
    await deps.notify(OFFERED_NOBODY_FREE_ALERT_KEY, deps.cooldownMs, formatOfferedNobodyFreeAlert(persisting, nowMs));
    paged = true;
  } else if (judged > 0 && nobodyFree === 0 && suspectsLeft === 0) {
    // Over only on a MEASURED healthy result (L345, #1134): something was judged this
    // tick, nothing judged was offered with nobody free, and no remembered time is left
    // waiting. A remembered time this tick could not look at again (the read failed, or
    // the budget ran out) is not a time that recovered, so it holds the all clear back.
    // alert-key: offered_nobody_free
    await deps.resolve(OFFERED_NOBODY_FREE_ALERT_KEY, formatOfferedNobodyFreeAllClear(judged));
    cleared = true;
  }
  // One line a tick, so "judged nothing" and "judged and found it clean" never read alike.
  deps.log({
    msg: "offered nobody free",
    judged,
    nobody_free: nobodyFree,
    unreadable,
    persisting: persisting.length,
    remembered: suspectsLeft,
    paged,
    cleared,
  });
  return { status: "measured", judged, nobodyFree, unreadable, persisting, suspects: suspectsLeft, paged, cleared };
}

/** "4:30pm ET on Wednesday, October 14": the instant as a person in the business zone
 *  reads it, through the one time and date spelling (#1765, #2221). */
function etTime(ms: number): string {
  const dt = DateTime.fromMillis(ms, { zone: BUSINESS_ZONE });
  return `${formatClockTime(dt) ?? "an unreadable time"} ET on ${formatLongDate(dt) ?? "an unreadable day"}`;
}

const WRITER_NAMES: Record<string, string> = {
  lane: "the recompute lane",
  push: "a Google push refresh",
  booking: "a booking's refresh",
  "booking-code": "a booking's single bucket recompute",
  refusal: "a refused confirm's refresh",
  cold: "the booker's own compute",
  "time-off": "a time off change",
  "monitor-heal": "the monitor's self heal",
};

/** Who wrote a row, in words, or "an unrecorded path" for a row from before #3381. */
export function writerName(writtenBy: string | null): string {
  if (!writtenBy) return "an unrecorded path";
  return writtenBy
    .split("+")
    .map((w) => WRITER_NAMES[w] ?? (w.startsWith("sweep:") ? `the ${w.slice(6)} sweep` : w))
    .join(" and ");
}

/** The page. Pure: every instant it names is passed in. */
export function formatOfferedNobodyFreeAlert(findings: OfferedFinding[], nowMs: number): string {
  const shown = findings.slice(0, 5);
  const lines = shown.map((f) => {
    const minutes = Math.max(1, Math.round((nowMs - f.firstSeenMs) / 60_000));
    // parse-ok: a stamp that will not parse reads as "unknown", never NaN minutes.
    const computed = Date.parse(f.rowComputedAt);
    const age = Number.isFinite(computed) ? `${Math.max(0, Math.round((nowMs - computed) / 60_000))} min ago` : "at an unknown time";
    const pool = f.members === 0 ? "nobody is in its pool" : `none of its ${f.members} advisors is free then`;
    return `${f.code} at ${etTime(f.startMs)}: offered for at least ${minutes} min while ${pool}. Its row was computed ${age} by ${writerName(f.writtenBy)}.`;
  });
  const more = findings.length > shown.length ? `\nAnd ${findings.length - shown.length} more.` : "";
  const subject =
    findings.length === 1
      ? "A stored row is offering a time nobody in its pool is free for"
      : `Stored rows are offering ${findings.length} times nobody in their pool is free for`;
  const choosing = findings.length === 1 ? "it" : "one";
  return (
    `${subject}, past the recompute lane's freshness window, so a lead choosing ${choosing} is refused unless a lower tier can take it.\n` +
    `${lines.join("\n")}${more}\n` +
    'Look at the Worker logs for msg="offered time nobody is free for" and the matching msg="slots served" line.'
  );
}

/** The all clear. */
export function formatOfferedNobodyFreeAllClear(judged: number): string {
  return `The stored rows are no longer offering times nobody in their pool is free for: ${judged} offered ${judged === 1 ? "time was" : "times were"} judged this check and every remembered one has been taken off or found free.`;
}
