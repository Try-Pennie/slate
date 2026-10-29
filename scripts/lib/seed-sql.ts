// The rows the real database suites (`scripts/verify-*-sql.ts`) seed, as SQL, in one
// place (#3489). Each suite seeded bookings and event types with its own copy of the
// same insert, and the copies drift: a NOT NULL column added to bookings would fail one
// suite and pass the copy nobody updated.
//
// Imports nothing: the real database workflow runs these suites on bare node with no
// install (`.github/workflows/db-replay.yml`, pinned by scripts/test-db-replay-workflow.ts).

/** A SQL literal: a quoted, escaped string, or null. */
export const sqlLiteral = (v: string | null | undefined): string => (v == null ? "null" : `'${v.replace(/'/g, "''")}'`);

/** One booking, as the suites seed one: every NOT NULL column set, the rest optional. */
export interface SeedBooking {
  id: string;
  orgId: string;
  bucketId: string;
  eventTypeId: string;
  assignedUserId: string;
  startIso: string;
  endIso: string;
  status?: string;
  attendeeEmail?: string | null;
  attendeePhone?: string | null;
  externalId?: string | null;
  salesforceId?: string | null;
  kind?: string;
}

/**
 * The columns every seeded booking sets, in the order both inserts below give their
 * values, so a single row and a series cannot drift apart over which columns they fill.
 */
const BOOKING_SEED_COLUMNS = `org_id, bucket_id, event_type_id, assigned_user_id, agent_name, agent_email,
      starts_at, ends_at, original_starts_at, original_ends_at, timezone, status, attendee_name, attendee_email,
      attendee_phone, external_id, salesforce_id, gcal_event_id, manage_token, idempotency_key, kind, source`;

/** The insert for one booking, its event, token and idempotency key derived from its id. */
export function bookingInsertSql(b: SeedBooking): string {
  return `insert into bookings (id, ${BOOKING_SEED_COLUMNS})
    values ('${b.id}', '${b.orgId}', '${b.bucketId}', '${b.eventTypeId}', '${b.assignedUserId}', 'Agent', 'agent@example.com',
      '${b.startIso}', '${b.endIso}', '${b.startIso}', '${b.endIso}', 'America/New_York', '${b.status ?? "confirmed"}', 'Dana Lead',
      ${sqlLiteral(b.attendeeEmail)}, ${sqlLiteral(b.attendeePhone)}, ${sqlLiteral(b.externalId)}, ${sqlLiteral(b.salesforceId)},
      'gcal-${b.id}', 'tok-${b.id}', 'key-${b.id}', '${b.kind ?? "routed"}', 'booking');`;
}

/**
 * Many bookings in ONE statement, for a suite that needs a production sized table so
 * the planner costs a read as production would (#3863). Rows are numbered 1..rows as
 * `i`; each field is a SQL expression over `i`. Every row is twenty minutes long on one
 * agent, so `start` must give each row its own window or the active overlap constraint
 * (0120) refuses the insert.
 */
export interface SeedBookingSeries {
  orgId: string;
  bucketId: string;
  eventTypeId: string;
  assignedUserId: string;
  rows: number;
  /** The start, a timestamptz expression over `i`. */
  start: string;
  /** The status, a text expression over `i`. */
  status: string;
  /** The idempotency key, a text expression over `i`. */
  idempotencyKey: string;
  /** When the row was made, a timestamptz expression over `i`. */
  createdAt: string;
}

/** The insert for a series of bookings, event, token and email derived from `i`. */
export function bookingSeriesInsertSql(s: SeedBookingSeries): string {
  return `insert into bookings (${BOOKING_SEED_COLUMNS}, created_at)
    select '${s.orgId}', '${s.bucketId}', '${s.eventTypeId}', '${s.assignedUserId}', 'Agent', 'agent@example.com',
      t.s, t.s + interval '20 minutes', t.s, t.s + interval '20 minutes', 'America/New_York', ${s.status}, 'Dana Lead',
      'lead' || i || '@example.com', null, null, null, 'gcal-' || i, 'tok-' || i, ${s.idempotencyKey}, 'routed', 'booking',
      ${s.createdAt}
    from generate_series(1, ${s.rows}) as i, lateral (select ${s.start} as s) t;`;
}

/** One event type, with its buffers. */
export interface SeedEventType {
  id: string;
  orgId: string;
  name: string;
  durationMin: number;
  bufferBeforeMin?: number;
  bufferAfterMin?: number;
}

/** The insert for event types. */
export function eventTypesInsertSql(rows: readonly SeedEventType[]): string {
  const values = rows
    .map((e) => `('${e.id}', '${e.orgId}', ${sqlLiteral(e.name)}, ${e.durationMin}, ${e.bufferBeforeMin ?? 0}, ${e.bufferAfterMin ?? 0})`)
    .join(", ");
  return `insert into event_types (id, org_id, name, duration_min, buffer_before_min, buffer_after_min) values ${values};`;
}

/** One bucket, routed to an event type. */
export interface SeedBucket {
  id: string;
  orgId: string;
  code: string;
  name: string;
  eventTypeId: string;
}

/** The insert for buckets. */
export function bucketsInsertSql(rows: readonly SeedBucket[]): string {
  const values = rows.map((b) => `('${b.id}', '${b.orgId}', ${sqlLiteral(b.code)}, ${sqlLiteral(b.name)}, '${b.eventTypeId}')`).join(", ");
  return `insert into buckets (id, org_id, code, name, event_type_id) values ${values};`;
}

/**
 * A real bucket "100" and a test world bucket "T100" on one event type, the pair the
 * placeholder suites judge every world rule against (a test bucket's call belongs to the
 * test placeholder, and never counts as real).
 */
export function realAndTestBucketsSql(orgId: string, eventTypeId: string, realId: string, testId: string): string {
  return `${bucketsInsertSql([
    { id: realId, orgId, code: "100", name: "Low", eventTypeId },
    { id: testId, orgId, code: "T100", name: "Test", eventTypeId },
  ])}
    update buckets set is_test = true where id = '${testId}';`;
}

/**
 * One unconsumed reroute hold (migration 0166) on an advisor, for a booking already
 * written. Times are SQL timestamptz literals; it expires `expiresIn` (an SQL interval)
 * from now, so a suite never sleeps to reach either side of it.
 */
export interface SeedRerouteHold {
  orgId: string;
  bookingId: string;
  agentUserId: string;
  bufferedStartsAt: string;
  bufferedEndsAt: string;
  bookingStartsAt: string;
  bookingEndsAt: string;
  /** Both the requested and the target bucket. */
  bucketId: string;
  expiresIn?: string;
}

/** The insert for one reroute hold. */
export function rerouteHoldInsertSql(h: SeedRerouteHold): string {
  return `insert into reroute_holds (org_id, booking_id, agent_user_id, buffered_starts_at, buffered_ends_at, booking_starts_at,
      booking_ends_at, reschedule_seq, requested_bucket_id, target_bucket_id, expires_at)
    values ('${h.orgId}', '${h.bookingId}', '${h.agentUserId}', '${h.bufferedStartsAt}', '${h.bufferedEndsAt}', '${h.bookingStartsAt}',
      '${h.bookingEndsAt}', 0, '${h.bucketId}', '${h.bucketId}', now() + interval '${h.expiresIn ?? "5 minutes"}');`;
}

/** The twenty minute call (10 minutes either side) the booking suites seed as their one event type. */
export function callEventTypeSql(orgId: string, id: string): string {
  return eventTypesInsertSql([{ id, orgId, name: "Call", durationMin: 20, bufferBeforeMin: 10, bufferAfterMin: 10 }]);
}

/** A Low bucket, code 100, booking `eventTypeId`. */
export function lowBucketSql(orgId: string, id: string, eventTypeId: string): string {
  return bucketsInsertSql([{ id, orgId, code: "100", name: "Low", eventTypeId }]);
}
