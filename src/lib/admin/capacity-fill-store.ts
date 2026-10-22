/**
 * The database side of the booking pace readings (#4102): each day's last snapshot, and a run's one
 * write. The rules are capacity-fill.ts.
 *
 * Every read throws on failure rather than answering empty: no snapshot would make every day a
 * first reading and hide the interval, and a snapshot read short would compare against a smaller
 * team than the one counted.
 */
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { parseStampMs } from "@/lib/date/stamp";
import type { FillLast, FillSnapshot, FillWrite } from "./capacity-fill";
import type { PaceReading, PatternCell } from "./capacity-pace";

function readAtMs(iso: string, what: string): number {
  const ms = parseStampMs(iso);
  if (ms === null) throw new Error(`${what} holds an unreadable read_at: "${iso}"`);
  return ms;
}

/** A stored snapshot, checked entry by entry: a malformed one is refused, never compared. */
export function parseFillSnapshot(raw: unknown, day: string): FillSnapshot {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`the capacity fill snapshot for ${day} is not an object`);
  const out: FillSnapshot = {};
  for (const [userId, e] of Object.entries(raw as Record<string, unknown>)) {
    const v = e as { open?: unknown; capacity?: unknown; fp?: unknown } | null;
    if (!v || !Number.isInteger(v.open) || !Number.isInteger(v.capacity) || typeof v.fp !== "string") {
      throw new Error(`the capacity fill snapshot for ${day} holds an unreadable entry for ${userId}`);
    }
    out[userId] = { open: v.open as number, capacity: v.capacity as number, fp: v.fp };
  }
  return out;
}

/** The org's latest snapshot instant, and the last snapshot of each of `days`. */
export async function readFillLast(orgId: string, days: string[]): Promise<{ latestReadAtMs: number | null; byDay: Map<string, FillLast> }> {
  const db = supabaseAdmin();
  const latest = unwrap(
    await db.from("capacity_fill_last").select("read_at").eq("org_id", orgId).order("read_at", { ascending: false }).limit(1).maybeSingle(),
    "capacity fill latest snapshot",
  ) as { read_at: string } | null;
  // One row per org and page day, and these are the page's days (about eight), so this is bounded
  // by the limit; the table itself grows a row a day.
  const rows = (unwrap(
    await db.from("capacity_fill_last").select("day, read_at, snapshot").eq("org_id", orgId).in("day", days).limit(days.length),
    "capacity fill snapshots",
  ) ?? []) as { day: string; read_at: string; snapshot: unknown }[];
  return {
    latestReadAtMs: latest === null ? null : readAtMs(latest.read_at, "the latest capacity fill snapshot"),
    byDay: new Map(rows.map((r) => [r.day, { readAtMs: readAtMs(r.read_at, `the capacity fill snapshot for ${r.day}`), snapshot: parseFillSnapshot(r.snapshot, r.day) }])),
  };
}

/** One run's readings and snapshots, in one transaction. Returns whether it wrote. */
export async function writeFill(orgId: string, w: FillWrite): Promise<boolean> {
  const wrote = unwrap(
    await supabaseAdmin().rpc("record_capacity_fill", {
      p_org: orgId,
      p_read_at: new Date(w.readAtMs).toISOString(),
      p_prev_read_at: w.prevReadAtMs === null ? null : new Date(w.prevReadAtMs).toISOString(),
      p_rows: w.rows,
      p_last: w.last,
    }),
    "record capacity fill",
  );
  if (typeof wrote !== "boolean") throw new Error("record_capacity_fill returned no answer");
  return wrote;
}

/**
 * The most readings one page day can hold in the pace's 3 hour look back, with room: one every half
 * hour is six or seven, and a rerun never adds one. A read that fills the limit may be missing some,
 * so it is refused rather than trusted.
 */
export const FILL_HISTORY_PER_DAY = 16;

function instantOf(raw: unknown, what: string): string {
  const ms = typeof raw === "string" ? parseStampMs(raw) : null;
  if (ms === null) throw new Error(`${what} is not a readable instant: "${String(raw)}"`);
  return new Date(ms).toISOString();
}

function numberOf(raw: unknown, what: string): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) throw new Error(`${what} is not a readable number: "${String(raw)}"`);
  return n;
}

/** Each of `days`' stored readings since `sinceMs`, oldest first, for its pace (#4103). */
export async function readFillHistory(orgId: string, days: string[], sinceMs: number): Promise<Map<string, PaceReading[]>> {
  const limit = days.length * FILL_HISTORY_PER_DAY;
  const rows = unwrap(
    // cap-safe: bounded by the page's days (about eight) times FILL_HISTORY_PER_DAY, and refused below when full.
    await supabaseAdmin()
      .from("capacity_fill_readings")
      .select("day, read_at, prev_read_at, taken")
      .eq("org_id", orgId)
      .in("day", days)
      .gte("read_at", new Date(sinceMs).toISOString())
      .order("read_at", { ascending: true })
      .limit(limit),
    "capacity fill recent readings",
  ) as { day: string; read_at: unknown; prev_read_at: unknown; taken: unknown }[] | null;
  if (!Array.isArray(rows)) throw new Error("the capacity fill recent readings read returned no list");
  if (rows.length >= limit) throw new Error(`the capacity fill recent readings read filled its limit of ${limit}, so some may be missing`);
  const byDay = new Map<string, PaceReading[]>();
  for (const r of rows) {
    const what = `the capacity fill reading of ${r.day}`;
    const reading: PaceReading = {
      read_at: instantOf(r.read_at, `${what}'s read_at`),
      prev_read_at: r.prev_read_at === null ? null : instantOf(r.prev_read_at, `${what}'s prev_read_at`),
      taken: r.taken === null ? null : numberOf(r.taken, `${what}'s taken`),
    };
    byDay.set(r.day, [...(byDay.get(r.day) ?? []), reading]);
  }
  return byDay;
}

/**
 * The pattern's cells from readings since `sinceMs` (#4103): one jsonb answer, since a cell per day
 * position, half hour and weekday grouping can pass the 1,000 rows a table answer would be cut at.
 */
export async function readFillPattern(orgId: string, sinceMs: number): Promise<PatternCell[]> {
  const raw = unwrap(
    await supabaseAdmin().rpc("capacity_fill_pattern", { p_org: orgId, p_since: new Date(sinceMs).toISOString() }),
    "capacity fill pattern",
  ) as unknown;
  if (!Array.isArray(raw)) throw new Error("capacity_fill_pattern returned no answer");
  return raw.map((c, i) => {
    const v = c as { day_position?: unknown; slot_of_day?: unknown; weekday?: unknown; avg_taken?: unknown; samples?: unknown } | null;
    const ok =
      v !== null &&
      Number.isInteger(v.day_position) && (v.day_position as number) >= 0 &&
      Number.isInteger(v.slot_of_day) && (v.slot_of_day as number) >= 0 && (v.slot_of_day as number) <= 47 &&
      (v.weekday === null || (Number.isInteger(v.weekday) && (v.weekday as number) >= 1 && (v.weekday as number) <= 7)) &&
      Number.isInteger(v.samples) && (v.samples as number) > 0;
    if (!ok) throw new Error(`capacity_fill_pattern returned an unreadable cell at ${i}`);
    return {
      dayPosition: v.day_position as number,
      slotOfDay: v.slot_of_day as number,
      weekday: v.weekday as number | null,
      avgTaken: numberOf(v.avg_taken, `the pattern cell at ${i}'s average`),
      samples: v.samples as number,
    };
  });
}
