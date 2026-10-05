// Synthetic Google Calendar responses for the 200-agent load test (#273
// Increment 5), gated ENTIRELY behind the SLATE_LOADTEST env flag. It is unset
// in production, so `LOADTEST` is false and none of this runs — the calendar
// client takes its normal real-Google path. With the flag on (only in an
// isolated load-test environment), the sync + watch lanes run end-to-end at 200
// simulated agents without needing real Google accounts.
import type { GoogleEvent, Interval } from "@/lib/google/calendar";
import { parseStampMs } from "@/lib/date/stamp";
import { GoogleHttpError } from "@/lib/google/http-error";
import { keyHash, shouldInject, type FaultTarget } from "@/lib/loadtest-fault";

export const LOADTEST = process.env.SLATE_LOADTEST === "true";

/**
 * Deterministic Google fault injection for the soak (#1050).
 *
 * The stub always succeeded, so the 200-agent soak proved the lanes work when Google
 * works, which is the half that was never in doubt. What it could not say is whether
 * they degrade gracefully: the sync coalescer, the reachability classifier, the
 * failure-streak alerting and the verify-on-book re-route all exist for a Google that
 * fails, and none of them was exercised at scale.
 *
 * `SLATE_LOADTEST_FAULT_PCT` is the percentage of calls that throw, and calendar READS
 * are the `google-read` target, which is what an unset `SLATE_LOADTEST_FAULT_TARGETS`
 * means. Zero (the default) is the previous behaviour exactly, so an existing soak run
 * is unchanged. The percentage, the hash and the gate live in `@/lib/loadtest-fault`,
 * shared with the database, Salesforce and webhook injectors (#3104), and are
 * re-exported here for the callers that already read them from this file.
 *
 * **Calendar WRITES are the `google-write` target, OFF unless named** (#2241, #3104).
 * A failed calendar write on the confirm path is a 500 by design: the event could not
 * be created, so the lead is told to try again. Faulting writes in the ordinary fault
 * pass would make its 5xx count a measurement of the percentage rather than of the
 * code, and the "no 5xx under fault" bar (#2244) would be unreachable for a reason
 * nobody should fix. So writes fail only on a pass that names them, and the judge
 * reads `FAULT_TARGET_CONTRACT`: with a `fails-loud` target faulted it reports the
 * 5xx count rather than barring it, and judges the cron lanes instead. The ordinary
 * pass still reaches the confirm path hard, through `freeBusyMany`: verify-on-book is
 * the branch that re-routes and answers a retriable 503, and it is a read.
 *
 * DETERMINISTIC, not random, and that is the point. A random failure rate makes a soak
 * irreproducible: a run that passed and a run that failed differ by the dice, so
 * neither tells you anything about the code. The verdict is a hash of the call's own
 * key, so the same key fails on every run and a failing agent stays the failing agent
 * across passes. That also matters for what is being tested: the streak alerting fires
 * on CONSECUTIVE failures for one agent, which a per-call coin flip would rarely
 * produce.
 */
export { LOADTEST_FAULT_PCT, shouldFault } from "@/lib/loadtest-fault";

/**
 * The shape of failure a fault raises, chosen by the key so a run covers all three
 * without a caller picking one. Each is a real thing Google does, and the three are the
 * three the reachability classifier distinguishes, so the soak exercises every branch
 * rather than only the transient one:
 *
 *   a 503 backendError, which self-heals and must NOT take an agent out of the pool;
 *   a timeout, which is transient and must not either;
 *   a 403 notACalendarUser, which retrying can never fix (#1396).
 */
export function loadtestFault(key: string): Error {
  const kind = keyHash(key) % 3;
  if (kind === 0) return new Error("Google API error 503: backendError (loadtest fault)");
  if (kind === 1) return new Error("Google API request timed out (loadtest fault)");
  return new Error("Google API error 403: notACalendarUser (loadtest fault)");
}

/** Throw for this key when the configured percentage says so. Called by each stubbed
 *  call, so a fault lands where a real Google failure would: inside the call. Reads
 *  and writes are separate targets, and writes fail only when they are named. */
export function faultIfDue(key: string, target: FaultTarget = "google-read"): void {
  if (shouldInject(target, key)) throw loadtestFault(key);
}

/**
 * A synthetic calendar write that changes nothing (#2241) and fails when the
 * `google-write` target says so (#3104).
 *
 * Keyed on the operation and the event id, so the same event's move fails on every
 * run and a retry of it meets the same answer, which is what makes the durable retry
 * paths (`pending_event_deletions`, the outbox's resume) the thing under test rather
 * than a lucky second attempt.
 */
export function stubEventWrite(op: string, eventId: string): void {
  faultIfDue(`${op}:${eventId}`, "google-write");
}

/**
 * The key a sync read is judged by: the CALENDAR, and nothing that changes between
 * passes (#3103).
 *
 * It used to be `sync:<timeMin>:<syncToken>`, and the stub mints a new token on every
 * call, so a calendar's verdict was redrawn each pass. The `sync_failures` page needs
 * one agent failing on CONSECUTIVE passes, which a per pass draw almost never gives,
 * so the fault leg's page had never fired on any run. Keyed on the calendar alone,
 * the same share of calendars fails on every pass, which is what the comment above
 * `faultIfDue` always said the fault was for.
 */
export function syncFaultKey(calendarId: string): string {
  return `sync:${calendarId}`;
}

/**
 * The failure a faulted sync read raises: a `403 notACalendarUser`, as the
 * GoogleHttpError the classifier reads, so the lane records it as not-provisioned
 * (#3103).
 *
 * Always that one shape, not drawn from the three, and it is a timing decision rather
 * than a preference. A transient kind pages only at TRANSIENT_PAGE_AT, four
 * consecutive passes, which at the load test Worker's roughly 90 second sync cadence
 * is about 270 seconds after the first failure, and the first failure can itself land
 * a whole pass into a five minute fault window. A definitive kind pages at the second
 * consecutive pass, so it is the only kind the window can see page. The production
 * rule is not touched. `scripts/test-loadtest-sync-fault-streak.ts` drives both kinds
 * through the real predicate.
 *
 * And a GoogleHttpError, not a plain Error: the classifier reads a kind only from the
 * status and reason it carries, so a plain Error saying "403" is recorded as transient
 * whatever its message says.
 */
export function loadtestSyncFault(): GoogleHttpError {
  return new GoogleHttpError(
    "Google API error 403: notACalendarUser (loadtest fault)",
    403,
    "notACalendarUser",
  );
}

// How many busy events a bootstrap sync returns per calendar (realistic batch
// the sync lane then writes to busy_blocks). Incrementals return ~nothing.
const HORIZON_MS = 4 * 86_400_000;

/**
 * The synthetic calendar's fixed grid of meetings (#1542): every 18 hours from 30 days behind
 * to 60 days ahead. Fixed, and independent of whatever window a fetch asks for, so a narrower
 * fetch genuinely returns fewer events. At the real 22 day bootstrap window this yields about
 * 30, which is the realistic per-calendar batch the soak was built around.
 */
const CALENDAR_GRID_STEP_MS = 18 * 60 * 60_000;
const CALENDAR_GRID_PAST_MS = 30 * 86_400_000;
const CALENDAR_GRID_SLOTS = Math.floor((30 + 60) * 86_400_000 / CALENDAR_GRID_STEP_MS);

/**
 * One owned primary calendar (what listCalendars would surface).
 *
 * The id is the EMAIL, because that is what Google returns (#2380): calendarList
 * reports the primary calendar's id as the account's address, and
 * `selectableCalendarIds` stores exactly that. This used to return the literal
 * "primary", which made the whole load run self-consistent about a value
 * production never holds, so the soak could not see a reconcile comparing a
 * stored email against the alias and deleting the agent's real calendar.
 */
export function stubCalendarList(email = "unknown"): {
  id: string;
  accessRole: string;
  primary: boolean;
  selected: boolean;
  summary: string;
}[] {
  faultIfDue(`calendarList:${email}`);
  return [
    { id: email, accessRole: "owner", primary: true, selected: true, summary: "primary" },
  ];
}

/**
 * A batch of synthetic busy events.
 *
 * It models the two behaviours Google was MEASURED to have (#1252), which are not the same
 * and are the whole reason the hydration rotation exists:
 *
 *   a BOOTSTRAP is SCOPED to the window it asked for, returning `ends_at > timeMin AND
 *   starts_at < timeMax`, which are two DIFFERENT fields: timeMin bounds an event's end,
 *   timeMax its start;
 *
 *   a DELTA is NOT scoped, so an out-of-window event still arrives, exactly once, and
 *   nothing re-adds it later.
 *
 * Modelling both matters because the soak is the only automated path that runs this code at
 * scale (#1542). While the stub ignored the bounds it answered the same way whatever window
 * it was handed, so the soak could not tell a correctly scoped reconcile from one that
 * deletes cached busy time for meetings still in the calendar.
 *
 * The batch deliberately includes an event straddling each bound and one beyond the window,
 * because those are the cases the reconcile predicate exists for and a generator that only
 * produces comfortable interior events would never exercise it.
 */
export function stubSyncEvents(
  calendarId: string,
  syncToken: string | null,
  nowMs: number,
  window: { timeMinIso: string; timeMaxIso: string },
): { events: GoogleEvent[]; nextSyncToken: string | null; truncated: boolean } {
  if (shouldInject("google-read", syncFaultKey(calendarId))) throw loadtestSyncFault();
  const minMs = parseStampMs(window.timeMinIso);
  const maxMs = parseStampMs(window.timeMaxIso);
  // An unreadable window returns NOTHING, not everything. Falling back to the unscoped set
  // would put the soak back where it started while looking like it was testing the bound.
  if (minMs === null || maxMs === null) {
    return { events: [], nextSyncToken: `lt-token-${nowMs}`, truncated: false };
  }

  const make = (id: string, startMs: number, durationMs = 30 * 60_000): GoogleEvent => ({
    id,
    status: "confirmed",
    transparency: "opaque",
    start: { dateTime: new Date(startMs).toISOString() },
    end: { dateTime: new Date(startMs + durationMs).toISOString() },
  });

  if (syncToken) {
    // The delta. One ordinary in-window change, plus one BEYOND the window, because that is
    // what Google really sends and it is the event a later write filter would drop with
    // nothing to re-add it.
    return {
      events: [
        make(`lt-evt-inc-${nowMs}`, nowMs + HORIZON_MS / 2),
        make(`lt-evt-inc-far-${nowMs}`, maxMs + 7 * 86_400_000),
      ],
      nextSyncToken: `lt-token-${nowMs}`,
      truncated: false,
    };
  }

  // The bootstrap. The events sit on a fixed grid around NOW, deliberately NOT derived from
  // the requested window: a calendar's meetings exist at the times they exist, so a narrower
  // fetch must return FEWER of them. Generating the spread across the window instead would
  // return the same count whatever was asked for, which is indistinguishable from ignoring
  // the bound and is the state this replaces.
  const candidates: GoogleEvent[] = [];
  for (let i = 0; i < CALENDAR_GRID_SLOTS; i++) {
    const slotMs = nowMs - CALENDAR_GRID_PAST_MS + i * CALENDAR_GRID_STEP_MS;
    candidates.push(make(`lt-evt-boot-${i}`, slotMs));
  }
  // Straddling each bound: returned by a real fetch, and the cases a reconcile scoped on the
  // wrong field gets wrong.
  candidates.push(make("lt-evt-boot-straddle-lower", minMs - 2 * 60 * 60_000, 4 * 60 * 60_000));
  candidates.push(make("lt-evt-boot-straddle-upper", maxMs - 2 * 60 * 60_000, 4 * 60 * 60_000));
  // Entirely outside, both ways: NOT returned, so a cached block for one must survive the
  // reconcile that follows.
  candidates.push(make("lt-evt-boot-before", minMs - 30 * 86_400_000));
  candidates.push(make("lt-evt-boot-beyond", maxMs + 30 * 86_400_000));

  const events = candidates.filter((e) => {
    const s = parseStampMs(e.start?.dateTime ?? null);
    const en = parseStampMs(e.end?.dateTime ?? null);
    // null, not NaN: an event whose times cannot be read is one we cannot place in or out of
    // the window, and the fail-safe answer is to leave it out of the fetch (L50).
    return s !== null && en !== null && en > minMs && s < maxMs;
  });
  return { events, nextSyncToken: `lt-token-${nowMs}`, truncated: false };
}

/** A watch registration result (no real channel created). */
export function stubWatch(channelId: string, nowMs: number): {
  resourceId: string | null;
  expiration: string | null;
} {
  return {
    resourceId: `lt-res-${channelId}`,
    expiration: new Date(nowMs + 7 * 86_400_000).toISOString(),
  };
}

/** Verify-on-book free/busy: report no live conflicts under load. */
export function stubFreeBusy(email = "unknown"): Interval[] {
  faultIfDue(`freeBusy:${email}`);
  return [];
}

/**
 * The event id a synthetic create answers with (#2241).
 *
 * The stub gated the read and watch lanes and nothing else, so a booking path load
 * run could not confirm a single booking: `completeReservation` calls `createEvent`
 * live before `insertBooking`. The July soak (#440) never drove a confirm, which is
 * why that was invisible for a year.
 *
 * **When a client id is supplied it is returned VERBATIM**, because that is what
 * real Google does (an insert carrying an `id` creates the event under that id) and
 * because Slate depends on it: `gcal_event_id` is stored as the pinned client id,
 * and the in-place reschedule PATCHes `pin.gcal_client_id` AS the event id. A
 * decorated id would break the move on the second step of every rescheduled
 * booking in the run.
 *
 * It is also the whole of the 409 reuse semantics, with no state to keep. Real
 * Google 409s a duplicate client id and the call GETs the existing event, so one
 * intent yields one event however many times it is retried; a pure function of the
 * client id has exactly that property, and a stub holding a set of created ids
 * would not, because a Worker isolate is not the same isolate on the next request.
 *
 * With no client id the id is derived from the call's own content, so two bookings
 * differ and a retry of one does not. `lt-evt-` marks it as belonging to nothing on
 * any real calendar.
 */
export function stubCreateEvent(
  input: { summary: string; start: string; end: string },
  clientId?: string,
): string {
  const key = `${input.summary}|${input.start}|${input.end}`;
  const id = clientId ?? `lt-evt-${keyHash(key).toString(36)}-${key.length.toString(36)}`;
  // Keyed on the id it answers with, so one intent fails or lands the same way however
  // many times it is retried, exactly as the 409 reuse above behaves.
  faultIfDue(`create:${id}`, "google-write");
  return id;
}

/**
 * The event a synthetic GET answers with (#2241).
 *
 * It reports every id as PRESENT, and deliberately does not model deletion. Two
 * reasons, and the second is the one that decides it:
 *
 * - a stub cannot hold a set of deleted ids across Worker isolates, so a stateful
 *   answer would vary with which isolate served the request, which is the one
 *   thing a load run's verdict must not do;
 * - the single loadtest consumer is `checkCreationOrphans`, which only ALERTS when
 *   the event is confirmed still there. Reporting present is therefore the noisy
 *   direction, never the quiet one, and an alarm that over-reports under a
 *   synthetic Google is the right way round.
 *
 * The window is NOT meaningful: nothing was ever written, so there is no recorded
 * start and end for this to report and it says so by carrying the call's own
 * instant rather than inventing a booking's. `pnpm verify:ooo-protection`, which is
 * the caller that does read the bounds, runs against live Google and never with
 * this flag on.
 */
export function stubEventOnPrimary(eventId: string, nowMs: number): GoogleEvent {
  faultIfDue(`events.get:${eventId}`);
  return {
    id: eventId,
    status: "confirmed",
    transparency: "opaque",
    start: { dateTime: new Date(nowMs).toISOString() },
    end: { dateTime: new Date(nowMs + 30 * 60_000).toISOString() },
  };
}
