/**
 * Is the Regal call feed alive, and can Slate still read it? (#2090)
 *
 * The detector in `regal-calls.ts` answers "is anybody calling while Slate does
 * not route to them", and it goes silent in two ways that are indistinguishable
 * from a clean roster:
 *
 *  - NOTHING ARRIVES. Regal's reporting webhook is configured in Regal's own
 *    console, which nothing in this repo can see. Switched off, pointed elsewhere,
 *    or sending a key Slate refuses (a refused post is never recorded), it produces
 *    exactly the silence a company where everybody is bookable produces. This is
 *    #1459's shape: zero subscribers is silent.
 *  - EVERYTHING ARRIVES UNREADABLE. If Regal drops or renames a field the edge
 *    needs, every event lands in one of the unreadable buckets and not one reaches
 *    the detector (L506).
 *
 * Each is its own CONDITION on its own key with its own ending, judged from the
 * per reason counts of `regal_call_events` (one RPC, `regal_call_reason_counts`),
 * and each refuses to judge when the counts cannot be read.
 *
 * Pure apart from the injected read and dispatcher (scripts/test-regal-call-feed.ts).
 */
import { logAlertSendFailure, logResolveFailure } from "../notify/send-failure.ts";
import { DateTime } from "luxon";
import { formatClockTime, formatLongDate } from "@/lib/date/parse";
import {
  BUSINESS_ZONE,
  lastClosedBusinessDay,
  type BusinessHoursException,
  type BusinessWindow,
} from "@/lib/booking/business-hours";
import {
  REGAL_CALL_REASONS,
  REGAL_CALL_UNREADABLE_REASONS,
  type RegalCallReason,
} from "@/lib/regal/inbound-call";
import type { AlertResolve, ThrottledNotify } from "./alert-deps";

export const REGAL_CALLS_QUIET_KEY = "regal_calls_quiet";
export const REGAL_CALLS_UNREADABLE_KEY = "regal_calls_unreadable";

/** The unreadable alarm looks back a day, so one bad event pages once and the
 *  all clear means a whole day of readable traffic. */
export const REGAL_UNREADABLE_WINDOW_MS = 24 * 60 * 60_000;

/** Events per reason over a window. A reason absent from the map is zero. */
export type RegalReasonCounts = Partial<Record<RegalCallReason, number>>;

/**
 * Each reason as a reader would say it. A `Record` over the vocabulary, so a new
 * reason with no words fails `tsc` rather than rendering as its code (L113).
 */
const REASON_WORDS: Record<RegalCallReason, string> = {
  candidate: "calls by Slate users",
  not_call_completed: "events that were not a completed call",
  ai_agent: "calls by the AI agent",
  agent_email_null: "unanswered dialer attempts with no agent on them",
  foreign_domain: "agents off our domain",
  no_slate_user: "addresses on our domain with no Slate user",
  body_unreadable: "bodies that were not readable JSON",
  event_id_unreadable: "no readable eventId",
  ai_flag_unreadable: "no readable is_ai_agent",
  agent_email_unreadable: "no readable agent_email",
  timestamp_unreadable: "no readable call time",
};

const n = (x: number): string => x.toLocaleString("en-US");
const total = (counts: RegalReasonCounts): number =>
  REGAL_CALL_REASONS.reduce((sum, r) => sum + (counts[r] ?? 0), 0);

/** "calls by the AI agent: 4,120; unanswered dialer attempts ...: 1,800", largest
 *  first. Label then number, so one of anything never needs a plural fixed. */
function breakdown(counts: RegalReasonCounts, reasons: readonly RegalCallReason[]): string {
  return reasons
    .filter((r) => (counts[r] ?? 0) > 0)
    .sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0))
    .map((r) => `${REASON_WORDS[r]}: ${n(counts[r] ?? 0)}`)
    .join("; ");
}

type Day = { isoDate: string; openMs: number; closeMs: number };

function dayWords(day: Day): string {
  const zone = BUSINESS_ZONE;
  const open = formatClockTime(DateTime.fromMillis(day.openMs, { zone }));
  const close = formatClockTime(DateTime.fromMillis(day.closeMs, { zone }));
  const date = formatLongDate(DateTime.fromISO(day.isoDate, { zone })) ?? day.isoDate;
  return open && close ? `${date}, ${open} to ${close} ET` : date;
}

// ------------------------------------------------------------- the quiet alarm

export function formatRegalFeedQuietAlert(day: Day, counts: RegalReasonCounts): string {
  const received = total(counts);
  if (received === 0) {
    return (
      `No call event from Regal has reached Slate since the start of the last business day ` +
      `(${dayWords(day)}), so the check for people calling while Slate does not route to them has had ` +
      `nothing to judge. Nobody is working the phones, or Regal's reporting webhook is switched off, ` +
      `pointed somewhere else, or sending a key Slate refuses (a refused post is not recorded). ` +
      `Check Settings > Integrations in Regal.`
    );
  }
  return (
    `Regal posted ${n(received)} call events since the start of the last business day ` +
    `(${dayWords(day)}), and not one was a call by somebody who is a Slate user (` +
    `${breakdown(counts, REGAL_CALL_REASONS)}). If that mix looks wrong, Regal has probably changed what ` +
    `it sends, and the check for people calling while Slate does not route to them is judging nobody.`
  );
}

export function formatRegalFeedQuietRecovery(candidates: number): string {
  return (
    `Calls by Slate users are reaching Slate from Regal again: ${n(candidates)} since the start of the ` +
    `last business day.`
  );
}

export type RegalFeedQuietResult =
  | { status: "unmeasured"; why: string }
  | { status: "quiet"; day: Day; received: number; paged: boolean }
  | { status: "flowing"; day: Day; candidates: number };

export interface RegalFeedQuietDeps {
  hours: { zone: string; rules: BusinessWindow[]; exceptions: BusinessHoursException[] };
  /** Per reason counts received at or after `sinceIso`. THROWS on a read error. */
  loadCounts: (sinceIso: string) => Promise<RegalReasonCounts>;
  armed: boolean;
  notify: ThrottledNotify;
  resolve: AlertResolve<unknown>;
  cooldownMs: number;
  nowMs: number;
}

/**
 * Quiet means no candidate since the OPEN of the last whole business day. It
 * fires after that day's close and keeps firing (on its cooldown) until one call
 * from a Slate user arrives, which is the measured healthy result that clears it.
 */
export async function runRegalFeedQuietCheck(deps: RegalFeedQuietDeps): Promise<RegalFeedQuietResult> {
  const day = lastClosedBusinessDay(deps.hours, deps.nowMs);
  if (!day) return { status: "unmeasured", why: "no open business day in the last two weeks" };
  let counts: RegalReasonCounts;
  try {
    counts = await deps.loadCounts(new Date(day.openMs).toISOString());
  } catch (err) {
    return { status: "unmeasured", why: err instanceof Error ? err.message : String(err) };
  }
  const candidates = counts.candidate ?? 0;
  if (candidates === 0) {
    if (deps.armed) {
      await deps.notify(REGAL_CALLS_QUIET_KEY, deps.cooldownMs, formatRegalFeedQuietAlert(day, counts)).catch(logAlertSendFailure(REGAL_CALLS_QUIET_KEY));
    }
    return { status: "quiet", day, received: total(counts), paged: deps.armed };
  }
  if (deps.armed) {
    await deps.resolve(REGAL_CALLS_QUIET_KEY, formatRegalFeedQuietRecovery(candidates)).catch(logResolveFailure(REGAL_CALLS_QUIET_KEY));
  }
  return { status: "flowing", day, candidates };
}

// -------------------------------------------------------- the unreadable alarm

export function formatRegalFeedUnreadableAlert(counts: RegalReasonCounts): string {
  const bad = REGAL_CALL_UNREADABLE_REASONS.reduce((sum, r) => sum + (counts[r] ?? 0), 0);
  return (
    `${n(bad)} call ${bad === 1 ? "event" : "events"} from Regal in the last 24 hours could not be read ` +
    `(${breakdown(counts, REGAL_CALL_UNREADABLE_REASONS)}). Regal has probably changed what it sends, and ` +
    `every event like that is invisible to the check for people calling while Slate does not route to ` +
    `them. The bodies are not kept, because they carry lead data, so compare a fresh call.completed ` +
    `event in Regal's event schema with the fields src/lib/regal/inbound-call.ts reads.`
  );
}

export function formatRegalFeedUnreadableRecovery(): string {
  return `Every call event Regal posted to Slate in the last 24 hours was readable.`;
}

export type RegalFeedUnreadableResult =
  | { status: "unmeasured"; why: string }
  | { status: "unreadable-events"; counts: RegalReasonCounts; paged: boolean }
  | { status: "clean"; received: number };

export interface RegalFeedUnreadableDeps {
  loadCounts: (sinceIso: string) => Promise<RegalReasonCounts>;
  armed: boolean;
  notify: ThrottledNotify;
  resolve: AlertResolve<unknown>;
  cooldownMs: number;
  nowMs: number;
}

/** Any unreadable reason above zero in the last day pages; a day of none clears. */
export async function runRegalFeedUnreadableCheck(
  deps: RegalFeedUnreadableDeps,
): Promise<RegalFeedUnreadableResult> {
  let counts: RegalReasonCounts;
  try {
    counts = await deps.loadCounts(new Date(deps.nowMs - REGAL_UNREADABLE_WINDOW_MS).toISOString());
  } catch (err) {
    return { status: "unmeasured", why: err instanceof Error ? err.message : String(err) };
  }
  const bad = REGAL_CALL_UNREADABLE_REASONS.some((r) => (counts[r] ?? 0) > 0);
  if (bad) {
    if (deps.armed) {
      await deps
        .notify(REGAL_CALLS_UNREADABLE_KEY, deps.cooldownMs, formatRegalFeedUnreadableAlert(counts))
        .catch(logAlertSendFailure(REGAL_CALLS_UNREADABLE_KEY));
    }
    return { status: "unreadable-events", counts, paged: deps.armed };
  }
  if (deps.armed) {
    await deps.resolve(REGAL_CALLS_UNREADABLE_KEY, formatRegalFeedUnreadableRecovery()).catch(logResolveFailure(REGAL_CALLS_UNREADABLE_KEY));
  }
  return { status: "clean", received: total(counts) };
}

/**
 * The RPC's rows as counts. A reason the vocabulary does not know is REFUSED
 * rather than dropped: the table's CHECK makes it impossible, so meeting one means
 * the migration and the code have drifted, and summing around it would report a
 * total that is not what arrived.
 */
export function countsFromRows(rows: { reason: string; events: number | string }[]): RegalReasonCounts {
  const known = new Set<string>(REGAL_CALL_REASONS);
  const out: RegalReasonCounts = {};
  for (const row of rows) {
    if (!known.has(row.reason)) throw new Error(`regal_call_reason_counts returned an unknown reason: ${row.reason}`);
    const events = Number(row.events);
    if (!Number.isFinite(events) || events < 0) {
      throw new Error(`regal_call_reason_counts returned an unreadable count for ${row.reason}`);
    }
    out[row.reason as RegalCallReason] = events;
  }
  return out;
}
