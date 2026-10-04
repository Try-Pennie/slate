/**
 * The pure rules a reroute hold is judged by (#3248, phase 2 of #3244).
 *
 * A hold keeps an advisor at one booking's window while an admin confirms a bucket
 * correction. The database refuses a booking landing on a held advisor (migration
 * 0166, the BACKSTOP); this module is what lets the booker skip a held advisor
 * BEFORE it sends any invite, so a lead picking that time is routed to somebody else
 * rather than invited and then cancelled.
 *
 * No runtime imports beyond compute's date math, so the node suite can drive it.
 */
import { DateTime } from "luxon";

import type { MemberAvailability } from "../availability/compute.ts";

const MIN = 60_000;

/** A live hold, as the candidate read loads it. Epoch ms throughout. */
export interface LiveHold {
  agentUserId: string;
  /** The booking the hold is FOR; its own reroute is never refused by it. */
  bookingId: string;
  startMs: number;
  endMs: number;
  bufferedStartMs: number;
  bufferedEndMs: number;
}

/** A call being judged against holds: its raw window and its buffers. */
export interface CallWindow {
  startMs: number;
  endMs: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
}

const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number) => aStart < bEnd && bStart < aEnd;

/**
 * Whether a call clashes with a hold: EITHER side's buffered window overlaps the
 * other's raw window. The same rule as `reroute_window_clash` in migration 0166,
 * so the booker's skip and the database's refusal can never disagree about which
 * advisor is held. Half open, like the overlap constraint.
 */
export function holdClashes(call: CallWindow, hold: LiveHold): boolean {
  const bufStart = call.startMs - call.bufferBeforeMin * MIN;
  const bufEnd = call.endMs + call.bufferAfterMin * MIN;
  return (
    overlaps(bufStart, bufEnd, hold.startMs, hold.endMs) ||
    overlaps(call.startMs, call.endMs, hold.bufferedStartMs, hold.bufferedEndMs)
  );
}

/**
 * `candidates` without every advisor held for ANOTHER booking at a window this
 * call clashes with, in their original order. `forBookingId` is the booking being
 * rerouted, whose own hold never excludes anybody (a re-run of its own search).
 */
export function dropHeldAgents(
  candidates: string[],
  holds: readonly LiveHold[],
  call: CallWindow,
  forBookingId?: string,
): string[] {
  if (holds.length === 0) return candidates;
  const held = new Set(
    holds
      .filter((h) => h.bookingId !== forBookingId && holdClashes(call, h))
      .map((h) => h.agentUserId),
  );
  return held.size === 0 ? candidates : candidates.filter((id) => !held.has(id));
}

/** One stored hold row, as the read returns it. */
export interface LiveHoldRow {
  agent_user_id: string;
  booking_id: string;
  booking_starts_at: string;
  booking_ends_at: string;
  buffered_starts_at: string;
  buffered_ends_at: string;
}

/**
 * Parse the hold rows the candidate read loaded. A row whose instants cannot be
 * read THROWS rather than being dropped: dropping it would read as "not held", the
 * permissive side, and route a lead onto an advisor an admin is holding (L50).
 */
export function parseLiveHolds(rows: readonly LiveHoldRow[]): LiveHold[] {
  return rows.map((r) => {
    const startMs = Date.parse(r.booking_starts_at);
    const endMs = Date.parse(r.booking_ends_at);
    const bufferedStartMs = Date.parse(r.buffered_starts_at);
    const bufferedEndMs = Date.parse(r.buffered_ends_at);
    if (![startMs, endMs, bufferedStartMs, bufferedEndMs].every(Number.isFinite)) {
      throw new Error(`reroute hold for booking ${r.booking_id} has an unreadable window`);
    }
    return { agentUserId: r.agent_user_id, bookingId: r.booking_id, startMs, endMs, bufferedStartMs, bufferedEndMs };
  });
}

/**
 * The current advisor's availability with THIS booking taken out of it, so the
 * booking cannot count against itself when asking whether they could keep it in a
 * corrected bucket: its own write through busy block is removed from their busy
 * time, and the booking is taken off their daily cap count for its own local day.
 *
 * Only busy intervals lying ENTIRELY inside the booking's own window are removed,
 * the same containment rule the in place reschedule uses for its own event (#523):
 * that covers the write through block and Google's mirror of the invite, while a
 * meeting reaching outside the booking still counts.
 */
export function withoutOwnBooking(
  m: MemberAvailability,
  own: { startMs: number; endMs: number },
): MemberAvailability {
  const busy = m.busy.filter((b) => !(b.start >= own.startMs && b.end <= own.endMs));
  if (m.dayCounts) {
    const dayKey = DateTime.fromMillis(own.startMs, { zone: m.timezone }).toISODate();
    const dayCounts = new Map(m.dayCounts);
    if (dayKey !== null) {
      const n = dayCounts.get(dayKey) ?? 0;
      if (n > 0) dayCounts.set(dayKey, n - 1);
    }
    return { ...m, busy, dayCounts };
  }
  return { ...m, busy, bookingStartsMs: m.bookingStartsMs.filter((s) => s !== own.startMs) };
}
