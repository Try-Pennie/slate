import { spliceMetaOf } from "./slot-splice.ts";

/**
 * Which path wrote a stored `bucket_slots` row (#3381).
 *
 * On 2026-10-14 a refused confirm read its stored row as still offering the refused
 * time on a row two minutes old, so the row disagreed with the confirm's own candidate
 * read. Two writers had run in the second that row was computed (the recompute lane and
 * a Google push's refresh), and nothing on the row could say which, so the one fact
 * that would have named the divergence was not recorded anywhere. Every full write now
 * stamps its writer into the payload, beside the splice fence a booking already leaves
 * there, and both log lines that read a row (`slots served` and the refused time read
 * against the stored row) print it.
 *
 * It lives in the payload rather than a column on purpose: no migration, the write is
 * still one statement, and a column would need the compare and swap to carry it too.
 *
 * The vocabulary is a closed union, so a new writer is named by the type rather than
 * by whoever remembers to (L247). `writeSlotRow` takes it as a REQUIRED argument, so
 * `tsc` enumerates every site that stores a full compute.
 */
export type SlotRowWriter =
  /** The every minute recompute lane (`/api/cron/recompute`). */
  | "lane"
  /** A Google push's pool refresh (`refreshAgentPoolsAfterPush`). */
  | "push"
  /** A booking's coalesced pool refresh: a cancel, which has no window to splice. */
  | "booking"
  /** The per code recompute a booking runs when it cannot defer its refresh. */
  | "booking-code"
  /** A `candidate_read_empty` refusal whose stored row still offered the refused time (#3633). */
  | "refusal"
  /** The read path's self heal, when the bucket has no stored row to serve. */
  | "cold"
  /** An approved time off changing (`recomputeBucketsForAgent`). */
  | "time-off"
  /** The monitor lane's self heal of a bucket it found empty. */
  | "monitor-heal"
  /** An every minute sweep's pooled refresh, by the sweep's own label. */
  | `sweep:${string}`;

/** The payload field the writer is stored in. */
export const WRITTEN_BY_FIELD = "writtenBy";

/** Several writers as one stored value, only ever made by `joinWriters`. Branded so a
 *  free string cannot stand in for a writer at a write site. */
export type JoinedWriters = string & { readonly __joinedWriters: true };

/** What a full write is stamped with: one writer, or the writers a refresh was shared by. */
export type WrittenBy = SlotRowWriter | JoinedWriters;

/**
 * The writers a coalesced refresh ran for, as one stored value: sorted, deduplicated,
 * joined with "+" ("booking+refusal"). A refresh several requests shared was written by
 * all of them, and naming only the first would send the reader to the wrong path.
 */
export function joinWriters(writers: readonly SlotRowWriter[]): JoinedWriters {
  return [...new Set(writers)].sort().join("+") as JoinedWriters;
}

/** `payload` with its writer stamped in. A non object payload is returned as it is: the
 *  write path refuses those anyway, and stamping must not turn one into an object. */
export function stampWriter<T>(payload: T, writtenBy: string): T {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  return { ...(payload as Record<string, unknown>), [WRITTEN_BY_FIELD]: writtenBy } as T;
}

/**
 * What a stored row says about how it was made.
 *
 * - `writtenBy`: the full compute's writer, or null for a row written before this was
 *   recorded (or one whose field is unreadable). Null is "not recorded", never a writer.
 * - `spliced`: null when no booking has been spliced into the row since its compute;
 *   otherwise the newest fence's instant, with `+reoffer` when any splice since then
 *   re-offered a window a move left. A re-offer is the only splice that can ADD a time,
 *   so it is the one a divergence hunt needs to see.
 */
export interface RowProvenance {
  writtenBy: string | null;
  spliced: string | null;
}

export function rowProvenance(payload: unknown): RowProvenance {
  if (!payload || typeof payload !== "object") return { writtenBy: null, spliced: null };
  const raw = (payload as Record<string, unknown>)[WRITTEN_BY_FIELD];
  const writtenBy = typeof raw === "string" && raw.length > 0 ? raw : null;
  const meta = spliceMetaOf(payload);
  if (!meta || meta.windows.length === 0) return { writtenBy, spliced: null };
  const reoffer = meta.windows.some((f) => f.reoffer === true);
  const newest = Math.max(...meta.windows.map((f) => f.atMs));
  return { writtenBy, spliced: `${new Date(newest).toISOString()}${reoffer ? "+reoffer" : ""}` };
}
