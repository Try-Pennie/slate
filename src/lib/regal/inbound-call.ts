/**
 * The inbound Regal call feed (#2090): what one `call.completed` body means to Slate.
 *
 * Regal posts every completed call to `/api/regal/calls`. The detector this feeds
 * asks one question, "is somebody Slate will not route to placing calls", and
 * almost none of the traffic is about a person at all: the AI agent places most of
 * the calls (`is_ai_agent: true`, an address on regal.ai), and a progressive dialer
 * attempt that nobody answered has no person on it (`agent_email: null`). So the
 * edge drops most of what arrives.
 *
 * A filter that stores nothing on a quiet day reads exactly like a filter that is
 * broken, or like Regal having stopped sending (L98, L506). So every event is
 * recorded under exactly ONE named reason, and the reasons that mean "Regal changed
 * its contract" (a field that used to be there is absent, or the wrong type) are
 * their own buckets. Absent and false are different answers: an absent
 * `is_ai_agent` is NOT a human, and an absent `agent_email` is NOT the ordinary
 * null of an unanswered dialer attempt. A strict comparison against a missing field
 * would silently refuse nobody, which is the trap L506 names.
 *
 * WHAT SURVIVES THE EDGE INTO THE DETECTOR'S ROW, decided by Dan on 2026-09-08:
 * the acting agent's email, Regal's event id and the call's instant. Nothing else.
 * The body also carries the lead's phone, email and Salesforce id, and an AI
 * written summary of the call. The agent email is staff data. `userId` on this body
 * is the LEAD's Salesforce id, the opposite of what the same field means on the
 * events Slate sends Regal (#2085).
 *
 * THE CALL OUTCOME ROW (#2944) is a second, separate read of the same body, for the
 * Slate vs cal.com show rate: the lead's Salesforce Lead id (as its 15 character
 * key), the call's start, its talk time and its labels (direction, type,
 * disposition, whether a conversation happened, whether the AI placed it). Dan
 * decided on 2026-10-01 that the Salesforce id is an external id and safe to
 * store. The phone, the email, the name and the notes are still never read. It
 * runs on every `call.completed` independently of the detector's classification,
 * because an AI call or an unanswered dialer attempt is dropped by the detector and
 * is still a call the show rate has to see.
 *
 * Pure apart from the injected store calls, so the node suite drives it
 * (scripts/test-regal-inbound-call.ts).
 */
import { normalizeEmail } from "@/lib/auth/email";
import { isAllowedEmail } from "@/lib/auth/domain";
import { OUR_DOMAIN } from "@/lib/twilio/roster";
import { isLeadId, leadIdKey } from "@/lib/salesforce/lead-xbc";

/**
 * Every reason an event can be recorded under. The migration's CHECK constraint
 * holds the same list, and the suite asserts the two are equal in both directions,
 * so a reason added here and not there is refused at the database rather than
 * silently lost (L41).
 */
export const REGAL_CALL_REASONS = [
  // A human agent on our domain who is a Slate user. The only reason that stores
  // an email, and the only rows the detector reads.
  "candidate",
  // Ordinary drops. Each is a normal, common event and is counted so a change in
  // the mix is visible.
  "not_call_completed",
  "ai_agent",
  "agent_email_null",
  "foreign_domain",
  "no_slate_user",
  // Unreadable: the payload no longer says what the filter needs. Any of these
  // leaving zero means Regal changed the contract and the detector's whole
  // population changed with it.
  "body_unreadable",
  "event_id_unreadable",
  "ai_flag_unreadable",
  "agent_email_unreadable",
  "timestamp_unreadable",
] as const;

export type RegalCallReason = (typeof REGAL_CALL_REASONS)[number];

/** The subset that means the payload itself could not be read. */
export const REGAL_CALL_UNREADABLE_REASONS: readonly RegalCallReason[] = [
  "body_unreadable",
  "event_id_unreadable",
  "ai_flag_unreadable",
  "agent_email_unreadable",
  "timestamp_unreadable",
];

/** The domain a Slate user's address is on, without the `@`. */
const COMPANY_DOMAIN = OUR_DOMAIN.replace(/^@/, "");

/** Regal's ids are 32 hex characters; anything past this is not an id. */
const MAX_EVENT_ID_LENGTH = 128;

/**
 * The oldest and newest instants a call can plausibly carry, in SECONDS. The lower
 * bound refuses a value in 1970 (a zero or a small counter); the upper bound
 * refuses milliseconds read as seconds, which would land tens of thousands of
 * years out and pass every "is it recent" comparison as the far future.
 */
const MIN_PLAUSIBLE_SECONDS = Date.UTC(2020, 0, 1) / 1000;
const MAX_PLAUSIBLE_SECONDS = Date.UTC(2100, 0, 1) / 1000;

/**
 * Unix SECONDS to epoch milliseconds, or null.
 *
 * Regal sends `completed_at` as a number of seconds and `originalTimestamp` as the
 * same number in a STRING. `Date.parse("1788889891")` does not yield that instant,
 * which is why this never goes near `Date.parse`: a NaN compares false against
 * every threshold and lands on the permissive branch (#1169). Anything that is not
 * a whole number of seconds inside a plausible range is refused, never guessed.
 */
export function unixSecondsToMs(value: unknown): number | null {
  let seconds: number;
  if (typeof value === "number") seconds = value;
  else if (typeof value === "string" && /^\d{1,12}$/.test(value.trim())) seconds = Number(value.trim());
  else return null;
  if (!Number.isFinite(seconds) || !Number.isInteger(seconds)) return null;
  if (seconds < MIN_PLAUSIBLE_SECONDS || seconds > MAX_PLAUSIBLE_SECONDS) return null;
  return seconds * 1000;
}

/** What the edge decided before any lookup. */
export type RegalCallClassification =
  | { kind: "dropped"; reason: Exclude<RegalCallReason, "candidate" | "no_slate_user">; eventId: string | null }
  /** Passed every payload check; the user lookup decides candidate or no_slate_user. */
  | { kind: "pending"; eventId: string; agentEmail: string; occurredAtMs: number };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readEventId(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const id = v.trim();
  if (id === "" || id.length > MAX_EVENT_ID_LENGTH) return null;
  return id;
}

/**
 * Classify one body. The order is part of the contract:
 *
 *  1. the body and its event id, because nothing after them can be recorded
 *     against a key without them;
 *  2. the event name. Regal is configured to send only `call.completed`, and this
 *     is checked anyway: a consumer that trusts a producer's subscription to stay
 *     narrow is #1459's shape, and a widened one would arrive silently;
 *  3. the AI flag, BEFORE the email, because an AI agent's address is on regal.ai
 *     and would otherwise be counted as a foreign address, which is a different
 *     finding with a different remedy (L11);
 *  4. the email: absent, null, blank, off our domain;
 *  5. the instant.
 */
export function classifyRegalCall(body: unknown): RegalCallClassification {
  if (!isRecord(body)) return { kind: "dropped", reason: "body_unreadable", eventId: null };
  const eventId = readEventId(body.eventId);
  if (eventId === null) return { kind: "dropped", reason: "event_id_unreadable", eventId: null };
  const props = body.properties;
  if (body.name !== "call.completed") return { kind: "dropped", reason: "not_call_completed", eventId };
  if (!isRecord(props)) return { kind: "dropped", reason: "body_unreadable", eventId };

  // `=== true` to drop and `=== false` to keep, and nothing else either way. A
  // "keep unless true" rule silently drops everything the day the field goes
  // missing; a "drop unless false" rule silently keeps it. Neither is taken.
  if (props.is_ai_agent === true) return { kind: "dropped", reason: "ai_agent", eventId };
  if (props.is_ai_agent !== false) return { kind: "dropped", reason: "ai_flag_unreadable", eventId };

  if (!("agent_email" in props)) return { kind: "dropped", reason: "agent_email_unreadable", eventId };
  if (props.agent_email === null) return { kind: "dropped", reason: "agent_email_null", eventId };
  if (typeof props.agent_email !== "string") {
    return { kind: "dropped", reason: "agent_email_unreadable", eventId };
  }
  const agentEmail = normalizeEmail(props.agent_email);
  if (agentEmail === "" || !agentEmail.includes("@")) {
    return { kind: "dropped", reason: "agent_email_unreadable", eventId };
  }
  if (!isAllowedEmail(agentEmail, COMPANY_DOMAIN)) {
    return { kind: "dropped", reason: "foreign_domain", eventId };
  }

  // `completed_at` first, and only when it is ABSENT or null does the instant fall
  // back to `originalTimestamp`. A completed_at that is present and unreadable is
  // refused rather than replaced: it means the field changed shape, and quietly
  // reading a neighbour would hide that.
  const completed = props.completed_at;
  const occurredAtMs =
    completed === undefined || completed === null
      ? unixSecondsToMs(body.originalTimestamp)
      : unixSecondsToMs(completed);
  if (occurredAtMs === null) return { kind: "dropped", reason: "timestamp_unreadable", eventId };

  return { kind: "pending", eventId, agentEmail, occurredAtMs };
}

/** One `regal_call_events` row as written. `id` and `received_at` are the table's. */
export interface RegalCallRow {
  event_id: string | null;
  reason: RegalCallReason;
  /** Only on a candidate. */
  agent_email: string | null;
  /** ISO, only on a candidate. */
  occurred_at: string | null;
}

export interface RegalCallStore {
  /** The Slate user id for a normalised address, or null. THROWS on a read error:
   *  answering null would count a failed read as "no Slate user", which is the
   *  finding that says Slate is fine. */
  findUserId: (email: string) => Promise<string | null>;
  /** Insert, relying on the UNIQUE event_id to make a redelivery harmless. THROWS
   *  on any error other than that conflict. */
  insert: (row: RegalCallRow) => Promise<"inserted" | "duplicate">;
}

/**
 * What happened to one received body.
 *
 * A DUPLICATE carries no reason on purpose. The unique event_id made the database
 * ignore the second insert, so the row keeps whatever the FIRST delivery was
 * classified as; the reason this delivery would have been given can differ (the
 * person may have been added to Slate in between), and reporting it would describe
 * a row that was never written.
 */
export type RegalCallOutcome =
  | { status: "recorded"; reason: RegalCallReason }
  | { status: "duplicate"; eventId: string };

async function record(store: RegalCallStore, row: RegalCallRow): Promise<RegalCallOutcome> {
  const written = await store.insert(row);
  if (written === "duplicate" && row.event_id !== null) return { status: "duplicate", eventId: row.event_id };
  return { status: "recorded", reason: row.reason };
}

/** Classify, resolve, record. Throws when the store does; the route logs it. */
export async function processRegalCall(body: unknown, store: RegalCallStore): Promise<RegalCallOutcome> {
  const c = classifyRegalCall(body);
  if (c.kind === "dropped") {
    return record(store, { event_id: c.eventId, reason: c.reason, agent_email: null, occurred_at: null });
  }
  const userId = await store.findUserId(c.agentEmail);
  if (userId === null) {
    return record(store, { event_id: c.eventId, reason: "no_slate_user", agent_email: null, occurred_at: null });
  }
  return record(store, {
    event_id: c.eventId,
    reason: "candidate",
    agent_email: c.agentEmail,
    occurred_at: new Date(c.occurredAtMs).toISOString(),
  });
}

// ------------------------------------------------------------ the call outcome

/**
 * Every reason a `call.completed` body yields no outcome row (#2944). Each one is
 * logged by name: a refusal that read as a zero talk time, or a silently skipped
 * row, would move the show rate with nothing saying why (L11).
 */
export const REGAL_OUTCOME_REFUSALS = [
  "body_unreadable",
  "not_call_completed",
  "event_id_unreadable",
  // No userId at all, or not a string.
  "lead_id_unreadable",
  // A string that is not a Salesforce LEAD id (a Contact, say). Its own reason,
  // because "Regal stopped sending the id" and "this call was about somebody who is
  // not a lead" send a reader to two different places.
  "not_a_lead",
  "ai_flag_unreadable",
  "talk_time_unreadable",
  "started_at_unreadable",
] as const;

export type RegalCallOutcomeRefusal = (typeof REGAL_OUTCOME_REFUSALS)[number];

/** One `regal_call_outcomes` row as written. `id` and `received_at` are the table's. */
export interface RegalCallOutcomeRow {
  event_id: string;
  /** The lead's Salesforce Lead id, as its 15 character case sensitive key. */
  lead_key: string;
  /** ISO, from Regal's unix SECONDS `started_at`. */
  started_at: string;
  talk_time_s: number;
  conversation_happened: boolean | null;
  direction: string | null;
  call_type: string | null;
  disposition: string | null;
  is_ai_agent: boolean;
  agent_email: string | null;
}

export type CallOutcomeExtraction =
  | { kind: "row"; row: RegalCallOutcomeRow }
  | { kind: "refused"; reason: RegalCallOutcomeRefusal; eventId: string | null };

/**
 * The longest talk time read as a number of seconds. A call longer than a day is
 * not a call, and refusing it keeps a unit change (milliseconds) from landing as a
 * plausible looking value or overflowing the integer column.
 */
const MAX_TALK_TIME_S = 24 * 60 * 60;

/** The longest label kept. Dispositions are short names; anything past this is not one. */
const MAX_LABEL_LENGTH = 200;

/** An optional label: a non empty string, or null. Never guessed, never refuses the row. */
function readLabel(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (s === "") return null;
  return s.slice(0, MAX_LABEL_LENGTH);
}

/**
 * Read one body into an outcome row, or refuse it by name.
 *
 * The required fields are the ones the show rate is computed FROM: the lead (whose
 * booking this call might be for), the start (whether it falls in the booking's
 * window), the talk time (whether a conversation long enough happened) and the AI
 * flag (a person or the bot). Each is refused rather than defaulted: a missing
 * talk time stored as 0 is a no show that never happened, and an absent AI flag
 * stored as false is a human call that never happened (L506). The labels are
 * optional and stored as null when unreadable, because nothing is computed from
 * them yet and losing the row over one would lose its talk time too.
 *
 * Deliberately NO show logic: whether 299 or 300 seconds counts is the split's
 * rule, applied where the rows are read, so it can change without re-receiving.
 */
export function extractCallOutcome(body: unknown): CallOutcomeExtraction {
  if (!isRecord(body)) return { kind: "refused", reason: "body_unreadable", eventId: null };
  const eventId = readEventId(body.eventId);
  if (body.name !== "call.completed") return { kind: "refused", reason: "not_call_completed", eventId };
  const props = body.properties;
  if (!isRecord(props)) return { kind: "refused", reason: "body_unreadable", eventId };
  if (eventId === null) return { kind: "refused", reason: "event_id_unreadable", eventId: null };

  if (typeof body.userId !== "string" || body.userId.trim() === "") {
    return { kind: "refused", reason: "lead_id_unreadable", eventId };
  }
  const leadId = body.userId.trim();
  if (!isLeadId(leadId)) return { kind: "refused", reason: "not_a_lead", eventId };

  if (typeof props.is_ai_agent !== "boolean") return { kind: "refused", reason: "ai_flag_unreadable", eventId };

  const talk = props.talk_time;
  if (typeof talk !== "number" || !Number.isFinite(talk) || talk < 0 || talk > MAX_TALK_TIME_S) {
    return { kind: "refused", reason: "talk_time_unreadable", eventId };
  }

  // No fallback to ended_at or completed_at: a start that is present and
  // unreadable means the field changed shape, and a neighbour would hide that.
  const startedMs = unixSecondsToMs(props.started_at);
  if (startedMs === null) return { kind: "refused", reason: "started_at_unreadable", eventId };

  const email = typeof props.agent_email === "string" ? normalizeEmail(props.agent_email) : "";
  return {
    kind: "row",
    row: {
      event_id: eventId,
      lead_key: leadIdKey(leadId),
      started_at: new Date(startedMs).toISOString(),
      // The column is an integer; Regal sends whole seconds, and a fraction rounds.
      talk_time_s: Math.round(talk),
      conversation_happened: typeof props.conversation_happened === "boolean" ? props.conversation_happened : null,
      direction: readLabel(props.direction),
      call_type: readLabel(props.type),
      disposition: readLabel(props.disposition),
      is_ai_agent: props.is_ai_agent,
      agent_email: email === "" ? null : email,
    },
  };
}

export interface RegalCallOutcomeStore {
  /** Insert, relying on the UNIQUE event_id to make a redelivery harmless. THROWS
   *  on any error other than that conflict. */
  insertOutcome: (row: RegalCallOutcomeRow) => Promise<"inserted" | "duplicate">;
}

export type RegalCallOutcomeResult =
  | { status: "stored"; eventId: string }
  | { status: "duplicate"; eventId: string }
  | { status: "refused"; reason: RegalCallOutcomeRefusal; eventId: string | null };

/** Extract and store one outcome. Throws when the store does. */
export async function processRegalCallOutcome(
  body: unknown,
  store: RegalCallOutcomeStore,
): Promise<RegalCallOutcomeResult> {
  const x = extractCallOutcome(body);
  if (x.kind === "refused") return { status: "refused", reason: x.reason, eventId: x.eventId };
  const written = await store.insertOutcome(x.row);
  return written === "duplicate"
    ? { status: "duplicate", eventId: x.row.event_id }
    : { status: "stored", eventId: x.row.event_id };
}

/** One half of a delivery, settled: its value, or the error it threw. */
export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

export interface RegalCallDelivery {
  detector: Settled<RegalCallOutcome>;
  outcome: Settled<RegalCallOutcomeResult>;
}

async function settle<T>(work: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Both rows for one received body, each in its OWN failure boundary (#2944).
 *
 * The detector's row and the outcome row answer different questions and must not
 * be able to take each other out: an outcome insert that fails (a missing table on
 * a half applied migration, say) must not stop the detector counting the feed, and
 * a detector failure must not lose a call the show rate needs. Neither ever
 * throws out of here; each half's error comes back for the caller to log.
 */
export async function processRegalCallDelivery(
  body: unknown,
  stores: { detector: RegalCallStore; outcome: RegalCallOutcomeStore },
): Promise<RegalCallDelivery> {
  const [detector, outcome] = await Promise.all([
    settle(() => processRegalCall(body, stores.detector)),
    settle(() => processRegalCallOutcome(body, stores.outcome)),
  ]);
  return { detector, outcome };
}
