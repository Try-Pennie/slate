import { DateTime } from "luxon";

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
 * Two rules shape every function here.
 *
 * **A splice only ever REMOVES.** Inside the window a time stays only when the row
 * and the fresh compute both offer it. A booking only takes time, so a correct answer
 * inside the window is never larger than the row's; adding times is the full
 * compute's job. Removing only also means a splice can never re-offer a day the
 * bookable day trim took off the end of the row, and never re-trims one either.
 *
 * **The row carries its own fence.** A splice leaves `computed_at` alone, because the
 * rest of the row is as old as it was, so the compare and swap that stops an older
 * compute overwriting a newer one (#1048) cannot see it. The splice therefore records
 * its window and the booking's instant in the payload (`splice`), and a full compute
 * that began before that instant keeps the row's answer inside the window when it
 * lands (`mergeFreshSplices`). Refusing such a compute outright was measured and
 * rejected: at load run rates it starves the recompute lane (see the PR for #3324).
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

/** The two slot lists a row can carry (#2842). */
export interface SlotLists {
  slots: string[];
  slotsWithoutLow?: string[];
}

/**
 * Splice one list pair into another over a window. An absent second list on the row
 * stays absent ("unknown", read as nobody). An absent second list on the JUDGE means
 * it could not say who is free without Low, so the window is emptied rather than left
 * offering times nobody vouched for.
 */
function spliceLists<T extends SlotLists>(row: T, w: SpliceWindow, judge: SlotLists): T {
  const out = { ...row, slots: spliceList(row.slots, w, judge.slots) };
  if (Array.isArray(row.slotsWithoutLow)) {
    out.slotsWithoutLow = spliceList(row.slotsWithoutLow, w, judge.slotsWithoutLow ?? []);
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
 * The stored payload with one booking's window spliced in and its fence recorded.
 * Fences older than the row's own compute are dropped: the compute behind the row
 * began after them, so it saw those bookings, and any older compute is already
 * refused by `computed_at`.
 */
export function splicePayload(
  row: Record<string, unknown> & SlotLists,
  w: SpliceWindow,
  judge: SlotLists,
  fenceAtMs: number,
  rowComputedAtMs: number,
): Record<string, unknown> & SlotLists {
  const meta = spliceMetaOf(row);
  const kept = (meta?.windows ?? []).filter((f) => f.atMs >= rowComputedAtMs);
  const spliced = spliceLists(withoutSpliceMeta(row), w, judge);
  return { ...spliced, splice: metaFor([...kept, { atMs: fenceAtMs, ...w }], (meta?.seq ?? 0) + 1) };
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
