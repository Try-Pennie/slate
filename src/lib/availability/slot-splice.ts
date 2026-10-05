import { DateTime } from "luxon";
import { BUSINESS_ZONE } from "../booking/business-hours.ts";

/**
 * The pure half of splicing a booked window into a stored slot row (#3324).
 *
 * After a booking, the times that can have changed are the ones whose call, with
 * its buffers, would touch the booked call, plus, when the booking takes the advisor
 * to their daily cap, every time on the advisor's local day. Everything else in the
 * row is exactly as true as it was. So rather than recomputing a whole pool over the
 * whole horizon, the booking recomputes that window through the shared predicate and
 * splices the answer in.
 *
 * Three rules shape every function here.
 *
 * **A window a booking TAKES only removes.** Inside it a time stays only when the row
 * and the fresh compute both offer it. A booking only takes time, so a correct answer
 * inside the window is never larger than the row's; adding times is the full
 * compute's job. Removing only also means a splice can never re-offer a day the
 * bookable day trim took off the end of the row, and never re-trims one either.
 *
 * **A window a move LEAVES is re-judged both ways (#3334).** A reschedule or reassign
 * also frees the window the booking held, and there the fresh answer stands, so a
 * held time goes back on offer (`reofferList`). Only on a day the list already
 * offers, though, so a re-offer never opens a day the trim left out, and it never
 * re-trims either. A move splices its taken window first and its freed one second,
 * in one write, so where the two overlap the freed window's answer is what stands;
 * both come from the same post move state, so they agree on every start they share.
 *
 * **The row carries its own fence.** A splice leaves `computed_at` alone, because the
 * rest of the row is as old as it was, so the compare and swap that stops an older
 * compute overwriting a newer one (#1048) cannot see it. The splice therefore records
 * each window and the booking's instant in the payload (`splice`), and a full compute
 * that began before that instant keeps a time inside the window only where the row
 * agrees when it lands (`mergeFreshSplices`). Refusing such a compute outright was
 * measured and rejected: at load run rates it starves the recompute lane (see the PR
 * for #3324). Inside a FREED window that same merge lets an older compute withhold
 * the re-offered time again until the next compute, which is the safe side: nothing
 * can show a compute that began before the move knew the time was free.
 */

const MIN = 60_000;

/** The slot STARTS a splice re-judges: every start S with fromMs <= S <= lastStartMs. */
export interface SpliceWindow {
  fromMs: number;
  lastStartMs: number;
}

/** One splice the row still has to defend: its window and the booking's instant. */
export interface SpliceFence extends SpliceWindow {
  atMs: number;
}

/**
 * The fence record a spliced row carries in its payload. `fenceAt` is the newest
 * fence as an ISO string, the one value the write path filters on in SQL (a json
 * path compares as text, and `toISOString` stamps compare correctly as text).
 * `seq` changes on every splice, so a writer's compare and swap sees another
 * splice land between its read and its write.
 */
export interface SpliceMeta {
  seq: number;
  fenceAt: string;
  windows: SpliceFence[];
}

export interface SpliceEventType {
  duration_min: number;
  buffer_before_min: number;
  buffer_after_min: number;
}

/**
 * The starts whose call, with its buffers, overlaps the booked call [startMs, endMs).
 *
 * A start S is judged against busy time over [S - before, S + duration + after), so
 * it is touched exactly when S + duration + after > startMs and S - before < endMs.
 * Both edges are included: an edge start the booking does not touch is recomputed
 * to the same answer, which costs nothing and leaves no off by one to reason about.
 */
export function affectedWindow(startMs: number, endMs: number, ev: SpliceEventType): SpliceWindow {
  return {
    fromMs: startMs - (ev.duration_min + ev.buffer_after_min) * MIN,
    lastStartMs: endMs + ev.buffer_before_min * MIN,
  };
}

/**
 * Widen a window to the advisor's whole LOCAL day, for a booking that takes them to
 * their daily cap: from then on they are refused for every start on that day, in
 * their own zone, which is the zone the cap counts in.
 */
export function widenToLocalDay(w: SpliceWindow, startMs: number, timezone: string): SpliceWindow {
  const day = DateTime.fromMillis(startMs, { zone: timezone }).startOf("day");
  const dayStart = day.toMillis();
  const dayEnd = day.plus({ days: 1 }).toMillis();
  return { fromMs: Math.min(w.fromMs, dayStart), lastStartMs: Math.max(w.lastStartMs, dayEnd - 1) };
}

/** The windows a splice computes over and reads busy time over. */
export interface SpliceRange {
  /** The compute's [from, to]: it judges exactly the starts S with from <= S and S + duration <= to. */
  computeFrom: string;
  computeTo: string;
  /** Busy time is read wider by the buffers, so an edge start's buffers are judged
   *  against everything inside them, not only what falls inside the compute window. */
  readFrom: string;
  readTo: string;
}

export function spliceRanges(w: SpliceWindow, ev: SpliceEventType): SpliceRange {
  const computeTo = w.lastStartMs + ev.duration_min * MIN;
  return {
    computeFrom: new Date(w.fromMs).toISOString(),
    computeTo: new Date(computeTo).toISOString(),
    readFrom: new Date(w.fromMs - ev.buffer_before_min * MIN).toISOString(),
    readTo: new Date(computeTo + ev.buffer_after_min * MIN).toISOString(),
  };
}

/**
 * Whether the advisor is at or over their daily cap on the booked start's local day,
 * read from the same per day count the slot predicate consults (#832), which already
 * includes the booking that was just committed.
 */
export function reachedDailyCap(
  member: { timezone: string; dayCounts?: Map<string, number> },
  startMs: number,
  dailyCap: number | null,
): boolean {
  if (dailyCap === null) return false;
  const key = DateTime.fromMillis(startMs, { zone: member.timezone }).toISODate();
  if (key === null) return false;
  return (member.dayCounts?.get(key) ?? 0) >= dailyCap;
}

/**
 * Whether the advisor was at or over their daily cap on the FREED start's local day
 * before a move (#3334), so every other start that day was refused them and the move
 * may have opened the whole day. The count is read after the move, so it includes the
 * moved booking on that day only when it stayed there with the same advisor
 * (`stillCountedThere`); otherwise the count before the move was one higher.
 */
export function atCapBeforeMove(
  member: { timezone: string; dayCounts?: Map<string, number> },
  freedStartMs: number,
  dailyCap: number | null,
  stillCountedThere: boolean,
): boolean {
  if (dailyCap === null) return false;
  const key = DateTime.fromMillis(freedStartMs, { zone: member.timezone }).toISODate();
  if (key === null) return false;
  return (member.dayCounts?.get(key) ?? 0) + (stillCountedThere ? 0 : 1) >= dailyCap;
}

const inWindow = (w: SpliceWindow, startMs: number) => startMs >= w.fromMs && startMs <= w.lastStartMs;

/**
 * `stored` with every start inside the window that `judge` does not also offer taken
 * out. Outside the window nothing changes. An unreadable entry is left where it is:
 * the read path drops it (#1296), and this is not the place to start judging it.
 */
export function spliceList(stored: string[], w: SpliceWindow, judge: string[]): string[] {
  const keep = new Set<number>();
  for (const s of judge) {
    const t = Date.parse(s);
    if (Number.isFinite(t)) keep.add(t);
  }
  return stored.filter((s) => {
    // parse-ok: NaN fails inWindow, so an unreadable entry is kept for the read path to drop.
    const t = Date.parse(s);
    return !inWindow(w, t) || keep.has(t);
  });
}

/**
 * `stored` with the window replaced by what `judge` offers there, for a window a
 * move left (#3334). The booking that held those times has gone, so the fresh answer
 * is authoritative inside the window in both directions, with one limit:
 *
 * **A time goes back only on a day the list already offers.** A stored list holds
 * the first N bookable days the lane found (#1326), grouped in the org's zone as the
 * lane groups them, and the splice does not know N. Opening a day the list lacks (the
 * booking held that day's only time, the cap had closed it, or the trim left it out)
 * would stretch the strip past the horizon, so that day waits for the next full
 * compute, as every freed time did before #3334. Withholding a free time is the safe
 * side; offering one past the horizon is not.
 */
export function reofferList(stored: string[], w: SpliceWindow, judge: string[]): string[] {
  const days = new Set<string>();
  for (const s of stored) {
    const day = dayOf(Date.parse(s));
    if (day !== null) days.add(day);
  }
  const outside = stored.filter((s) => !inWindow(w, Date.parse(s)));
  const inside: { iso: string; ms: number }[] = [];
  for (const s of judge) {
    const t = Date.parse(s);
    const day = dayOf(t);
    if (day !== null && inWindow(w, t) && days.has(day)) inside.push({ iso: s, ms: t });
  }
  return mergeByInstant(outside, inside);
}

/** The org local date an instant falls on, the grouping the bookable day trim uses
 *  (`precompute.ts`), or null for an unreadable one. */
function dayOf(ms: number): string | null {
  if (!Number.isFinite(ms)) return null;
  return DateTime.fromMillis(ms, { zone: BUSINESS_ZONE }).toISODate();
}

/** `kept` (in its order) with `added` placed by instant; an unreadable kept entry
 *  stays where it was for the read path to drop. */
function mergeByInstant(kept: string[], added: { iso: string; ms: number }[]): string[] {
  const queue = [...added].sort((a, b) => a.ms - b.ms);
  const out: string[] = [];
  let i = 0;
  for (const s of kept) {
    const t = Date.parse(s);
    while (Number.isFinite(t) && i < queue.length && queue[i]!.ms < t) out.push(queue[i++]!.iso);
    out.push(s);
  }
  while (i < queue.length) out.push(queue[i++]!.iso);
  return out;
}

/** The two slot lists a row can carry (#2842). */
export interface SlotLists {
  slots: string[];
  slotsWithoutLow?: string[];
}

/**
 * One window a splice re-judges, with the shared predicate's fresh answer over it.
 * A create splices one; a move splices two (#3334), in ONE compare and swap per code.
 */
export interface SplicePart {
  w: SpliceWindow;
  judge: SlotLists;
  /** The window a move LEFT (#3334): the fresh answer may put times back inside it
   *  (`reofferList`). Absent, the window was taken and the splice only removes. */
  reoffer?: boolean;
}

/**
 * Splice one list pair into another over a window. An absent second list on the row
 * stays absent ("unknown", read as nobody). An absent second list on the JUDGE means
 * it could not say who is free without Low, so the window is emptied rather than left
 * offering times nobody vouched for.
 */
function spliceLists<T extends SlotLists>(row: T, w: SpliceWindow, judge: SlotLists, reoffer = false): T {
  const one = reoffer ? reofferList : spliceList;
  const out = { ...row, slots: one(row.slots, w, judge.slots) };
  if (Array.isArray(row.slotsWithoutLow)) {
    out.slotsWithoutLow = one(row.slotsWithoutLow, w, judge.slotsWithoutLow ?? []);
  }
  return out;
}

/** The fence record on a stored payload, or null for a row nobody has spliced. */
export function spliceMetaOf(payload: unknown): SpliceMeta | null {
  if (!payload || typeof payload !== "object") return null;
  const m = (payload as { splice?: unknown }).splice;
  if (!m || typeof m !== "object") return null;
  const meta = m as Partial<SpliceMeta>;
  if (typeof meta.seq !== "number" || !Array.isArray(meta.windows)) return null;
  return {
    seq: meta.seq,
    fenceAt: typeof meta.fenceAt === "string" ? meta.fenceAt : "",
    windows: meta.windows.filter(
      (f): f is SpliceFence =>
        !!f && Number.isFinite(f.atMs) && Number.isFinite(f.fromMs) && Number.isFinite(f.lastStartMs),
    ),
  };
}

/** A payload without its fence record: what is served, and what a merge starts from. */
export function withoutSpliceMeta<T>(payload: T): T {
  if (!payload || typeof payload !== "object" || !("splice" in payload)) return payload;
  const { splice: _fence, ...rest } = payload as T & { splice?: unknown };
  return rest as T;
}

function metaFor(windows: SpliceFence[], seq: number): SpliceMeta {
  const newest = Math.max(...windows.map((f) => f.atMs));
  return { seq, fenceAt: new Date(newest).toISOString(), windows };
}

/** The fences recorded at or after `sinceMs`: the bookings a compute that began then
 *  cannot be shown to have seen. Equality counts, as it does for a settings save. */
export function freshFences(meta: SpliceMeta | null, sinceMs: number): SpliceFence[] {
  return (meta?.windows ?? []).filter((f) => f.atMs >= sinceMs);
}

export function windowsOverlap(a: SpliceWindow, b: SpliceWindow): boolean {
  return a.fromMs <= b.lastStartMs && b.fromMs <= a.lastStartMs;
}

/**
 * The stored payload with one booking's windows spliced in, in order, and a fence
 * recorded for each. Fences older than the row's own compute are dropped: the
 * compute behind the row began after them, so it saw those bookings, and any older
 * compute is already refused by `computed_at`.
 */
export function splicePayload(
  row: Record<string, unknown> & SlotLists,
  parts: SplicePart[],
  fenceAtMs: number,
  rowComputedAtMs: number,
): Record<string, unknown> & SlotLists {
  const meta = spliceMetaOf(row);
  const kept = (meta?.windows ?? []).filter((f) => f.atMs >= rowComputedAtMs);
  let spliced = withoutSpliceMeta(row);
  for (const p of parts) spliced = spliceLists(spliced, p.w, p.judge, p.reoffer);
  const fences = parts.map((p) => ({ atMs: fenceAtMs, ...p.w }));
  return { ...spliced, splice: metaFor([...kept, ...fences], (meta?.seq ?? 0) + 1) };
}

/**
 * A full compute that began at `computedAtMs`, merged with the row it is about to
 * replace: inside every window spliced at or after that instant, a time stays only
 * if the row (which knows about the booking) also offers it. Those fences stay on
 * the result, for any compute older still that lands after it. With no such fence
 * this is the computed payload unchanged.
 */
export function mergeFreshSplices<T extends SlotLists>(
  computed: T,
  row: unknown,
  computedAtMs: number,
): T {
  const meta = spliceMetaOf(row);
  const fresh = freshFences(meta, computedAtMs);
  const base = withoutSpliceMeta(computed);
  if (fresh.length === 0) return base;
  const r = row as SlotLists;
  const judge: SlotLists = {
    slots: Array.isArray(r.slots) ? r.slots : [],
    ...(Array.isArray(r.slotsWithoutLow) ? { slotsWithoutLow: r.slotsWithoutLow } : {}),
  };
  let merged = base;
  for (const f of fresh) merged = spliceLists(merged, f, judge);
  return { ...merged, splice: metaFor(fresh, (meta?.seq ?? 0) + 1) };
}
