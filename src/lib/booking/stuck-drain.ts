// Stuck-drain normalization (#517).
//
// The durable drains (#445) re-attempt a failing booking_outbox row (a mutation's
// side effects: calendar + webhook) or a booking_reservation (a crash-recovered
// create) every cron tick, backing off and alerting once a row has failed
// DRAIN_ALERT_AFTER times. Diagnosing WHY still meant querying the DB. The admin
// "stuck deliveries" view lists those wedged rows; the two tables differ in shape,
// so this normalizes each into one StuckRow the page can render uniformly.
//
// Pure (only a constant import), so it is node-native testable.

import { DRAIN_GIVE_UP_AT } from "@/lib/booking/drain-backoff";
import type { BookingOutboxAction } from "@/lib/db/types";

export type StuckKind = "outbox" | "reservation";

/** One wedged drain row, normalized across the outbox and reservation tables. */
export interface StuckRow {
  kind: StuckKind;
  id: string;
  /** The mutation kind: cancel/reschedule/reassign for outbox, always "create" for a reservation. */
  action: BookingOutboxAction | "create";
  /** A human-followable reference: the booking id (outbox) or idempotency key (reservation). */
  ref: string | null;
  attempts: number;
  lastError: string | null;
  /** Earliest the drain may re-attempt; null means it is eligible to retry now. */
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** The drain has stopped retrying this row (attempts past the give-up cap); it now needs a human. */
  gaveUp: boolean;
}

type OutboxLike = {
  id: string;
  booking_id: string | null;
  action: BookingOutboxAction;
  attempts: number;
  last_error: string | null;
  next_attempt_at: string | null;
  created_at: string;
  updated_at: string;
};

type ReservationLike = {
  id: string;
  idempotency_key: string;
  attempts: number;
  last_error: string | null;
  next_attempt_at: string | null;
  created_at: string;
  updated_at: string;
};

export function normalizeOutboxRow(row: OutboxLike): StuckRow {
  return {
    kind: "outbox",
    id: row.id,
    action: row.action,
    ref: row.booking_id,
    attempts: row.attempts,
    lastError: row.last_error,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    gaveUp: row.attempts >= DRAIN_GIVE_UP_AT,
  };
}

export function normalizeReservationRow(row: ReservationLike): StuckRow {
  return {
    kind: "reservation",
    id: row.id,
    action: "create",
    ref: row.idempotency_key,
    attempts: row.attempts,
    lastError: row.last_error,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    gaveUp: row.attempts >= DRAIN_GIVE_UP_AT,
  };
}

export interface StuckSummary {
  total: number;
  outbox: number;
  reservations: number;
  gaveUp: number;
}

export function summarizeStuck(rows: StuckRow[]): StuckSummary {
  return {
    total: rows.length,
    outbox: rows.filter((r) => r.kind === "outbox").length,
    reservations: rows.filter((r) => r.kind === "reservation").length,
    gaveUp: rows.filter((r) => r.gaveUp).length,
  };
}
