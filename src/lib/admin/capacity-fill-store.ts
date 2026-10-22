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
