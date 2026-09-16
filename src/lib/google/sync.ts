import { nanoid } from "nanoid";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { selectAllPages } from "@/lib/supabase/paginate";
import {
  listCalendars,
  syncEvents,
  watchCalendar,
  stopChannel,
  SyncTokenExpired,
  type GoogleEvent,
} from "@/lib/google/calendar";
import { selectableCalendarIds } from "@/lib/google/calendar-select";
import { recomputeBucketsForAgent } from "@/lib/availability/slot-cache";
import {
  isBusyEvent,
  partitionBusyWrites,
  staleBlockIds,
} from "@/lib/google/sync-core";
import {
  claimWindow,
  partitionCalendarsForSync,
  pastDeadline,
  shouldRerun,
  CALENDAR_CLAIM_TTL_MS,
  MAX_SYNC_PASSES,
} from "@/lib/google/sync-coalesce";
import { hydrationWindow } from "@/lib/google/hydration";
import {
  toSyncAgents,
  type SyncAgent,
  type SyncCandidateRow,
} from "@/lib/google/sync-pace";
import { stampLastSynced, type SyncWritesDb } from "@/lib/google/sync-writes";
import {
  nextSyncState,
  laneHealthUpdate,
  LANE_COLUMNS,
  type HealthLane,
  type CalSyncHealth,
  type SyncOutcome,
} from "@/lib/google/sync-health";
import {
  dedupeFailingAgents,
  isPageableFailure,
  applyBlastRadiusHold,
  SYNC_PAGING,
  WATCH_PAGING,
  type FailingAgent,
  type FailingCalendarRow,
} from "@/lib/notify/alerts";
import { reachabilityFromError } from "@/lib/google/reachability-classify";
import { googlePushUrl } from "@/lib/env";
import { parseStampMs } from "@/lib/date/stamp";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import { findExternalCollisions } from "@/lib/google/collision";
import type { AgentCalendar } from "@/lib/db/types";
import { unwrap, unwrapCount } from "@/lib/db/result";
import { chunkIdsByUrlBudget } from "@/lib/db/id-batch";
import { log } from "@/lib/log";
import { externalDoubleBookAlert } from "@/lib/notify/misc-alert-copy";
import { afterResponse } from "@/lib/after-response";

// Renew well before Google's ~7-day watch TTL so a cron outage can't drop push.
const WATCH_RENEW_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000;
// External-double-book detection (#316): only future bookings can be
// double-booked, so scan a forward window; alert at most this often per agent.
const COLLISION_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const COLLISION_ALERT_COOLDOWN_MS = 30 * 60 * 1000;

async function loadAgentEmail(userId: string): Promise<string | null> {
  // error-ok: push-path agent-email lookup; a read error skips this push-triggered
  // sync and the 1-min cron backstop reconverges the calendar.
  const { data } = await supabaseAdmin()
    .from("users")
    .select("email")
    .eq("id", userId)
    .maybeSingle();
  return (data as { email: string | null } | null)?.email ?? null;
}

/**
 * The agent's working-hours timezone, used to anchor all-day Google events to
 * their local day (#616). Mirrors the availability compute's fallback
 * ("America/New_York") so the cached blocks and the booker agree on which local
 * day an all-day OOO/holiday occupies.
 */
async function loadAgentTimezone(userId: string): Promise<string> {
  // error-ok: degrades to the America/New_York roster default (identical to an
  // empty result), so a transient read error can't block all-day event anchoring.
  const { data } = await supabaseAdmin()
    .from("availability_schedules")
    .select("timezone")
    .eq("user_id", userId)
    .limit(1);
  return (
    ((data ?? [])[0] as { timezone: string | null } | undefined)?.timezone ??
    "America/New_York"
  );
}

// Exported so the pool ENTRY path (#2302) reads an agent's calendars through the
// same query the sync lane uses, rather than growing a second copy of it here that
// can drift from this one.
export async function loadAgentCalendars(userId: string): Promise<AgentCalendar[]> {
  // error-ok: a read error yields no calendars for this pass; Google push and the
  // 1-min cron backstop reconverge the agent next tick.
  const { data } = await supabaseAdmin()
    .from("agent_calendars")
    .select("*")
    .eq("user_id", userId);
  return (data ?? []) as AgentCalendar[];
}

/**
 * Detect external Google double-bookings for an agent (#316): an external
 * (`source: gcal`) event overlapping an active Slate booking on the same agent,
 * over a forward window. Slate-vs-Slate is prevented by the unique index, and a
 * booking's own mirrored event is excluded by id, so a hit means someone booked
 * this agent directly in Google over a Slate-held slot. Best-effort: fires a
 * throttled alert so a human can resolve it; never throws into the sync path.
 */
async function detectExternalCollisions(userId: string, email: string): Promise<void> {
  try {
    const db = supabaseAdmin();
    const nowIso = new Date().toISOString();
    const toIso = new Date(Date.now() + COLLISION_WINDOW_MS).toISOString();
    // Active future bookings first — if none, there's nothing to collide with.
    // error-ok: best-effort external-collision scan (never throws into sync); a
    // read error just skips detection this pass and retries next sync.
    const { data: bookingRows } = await db
      // cap-safe: one agent's active bookings inside the short collision window.
      .from("bookings")
      .select("id, gcal_event_id, starts_at, ends_at")
      .eq("assigned_user_id", userId)
      .in("status", ["confirmed", "rescheduled"])
      .gte("starts_at", nowIso)
      .lt("starts_at", toIso);
    const bookings = (bookingRows ?? []) as {
      id: string;
      gcal_event_id: string | null;
      starts_at: string;
      ends_at: string;
    }[];
    if (bookings.length === 0) return;

    // error-ok: best-effort external-collision scan; a read error skips detection
    // this pass and retries next sync.
    const { data: blockRows } = await db
      // cap-safe: one agent's gcal busy blocks inside the short collision window.
      .from("busy_blocks")
      .select("gcal_event_id, starts_at, ends_at")
      .eq("user_id", userId)
      .eq("source", "gcal")
      .lt("starts_at", toIso)
      .gt("ends_at", nowIso);
    const blocks = ((blockRows ?? []) as {
      gcal_event_id: string | null;
      starts_at: string;
      ends_at: string;
    }[]).map((b) => ({
      gcalEventId: b.gcal_event_id,
      // parse-ok: busy_blocks.starts_at/ends_at are NOT NULL timestamptz that
      // Postgres renders, so NaN would mean a schema break, not bad input. Worth
      // naming what a NaN WOULD cost, since this feeds collision detection: an
      // unreadable row would simply not collide, and this alert would stay quiet.
      startMs: Date.parse(b.starts_at),
      endMs: Date.parse(b.ends_at), // parse-ok: NOT NULL timestamptz, as above
    }));

    const collisions = findExternalCollisions(
      blocks,
      bookings.map((b) => ({
        id: b.id,
        gcalEventId: b.gcal_event_id,
        // parse-ok: bookings.starts_at/ends_at are NOT NULL timestamptz, same as
        // the busy-block side above, and carry the same caveat if that ever changes.
        startMs: Date.parse(b.starts_at),
        endMs: Date.parse(b.ends_at), // parse-ok: NOT NULL timestamptz, as above
      })),
    );
    if (collisions.length === 0) return;

    const ids = collisions.map((c) => c.bookingId).join(", ");
    await sendThrottledAlert(
      `external_double_book:${userId}`,
      COLLISION_ALERT_COOLDOWN_MS,
      externalDoubleBookAlert(email, collisions.length, ids),
    ).catch(() => {});
  } catch (err) {
    log.error("sync", { msg: "external-collision detection failed", user_id: userId }, err);
  }
}

/**
 * Every bookable, ACTIVE agent's pacing facts for one cron tick — DB only, no
 * Google calls. Deactivated (offboarded) users are filtered out (#274) so the
 * sync/watch loop never touches an account nobody can fix (and never fires
 * watch-renewal alerts for it). `hasCalendars` distinguishes brand-new agents
 * (need first-time watch setup) from already-onboarded ones; `lastSyncedMs`
 * drives rotation. Two reads: the bookable users, then which of them have any
 * agent_calendars row.
 */
export async function loadSyncAgents(): Promise<SyncAgent[]> {
  const db = supabaseAdmin();
  // Fail loud (unwrap): a swallowed error here returns [] and the cron tick syncs
  // ZERO agents while still recording its heartbeat, so a broken read looks like a
  // healthy quiet minute (the #277 class). A legitimately empty roster still
  // returns [] via unwrap; only a real query error throws.
  const rows = (unwrap(
    await db
      .from("users")
      .select("id, last_synced_at, deactivated_at")
      .eq("bookable", true)
      .is("deactivated_at", null),
    "sync-agents",
  ) ?? []) as SyncCandidateRow[];
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const cals = unwrap(
    await db.from("agent_calendars").select("user_id").in("user_id", ids),
    "sync-agents-calendars",
  );
  const withCalendars = new Set(
    ((cals ?? []) as { user_id: string }[]).map((c) => c.user_id),
  );

  return toSyncAgents(rows, withCalendars);
}

/**
 * Stamp users.last_synced_at = now for every agent processed this tick, in ONE
 * write (#243), for rotation. Best-effort; never throws. The batching + guards
 * live in the dependency-free sync-writes module so they stay node-testable.
 */
export async function markAgentsSynced(userIds: string[]): Promise<void> {
  await stampLastSynced(
    supabaseAdmin() as unknown as SyncWritesDb,
    userIds,
    new Date().toISOString(),
  );
}

/**
 * Agents whose calendars are PERSISTENTLY failing on ONE lane (#273, #1150): one
 * entry per agent, worst calendar kept, for that lane's named alert.
 *
 * The lane decides which columns are read and which paging policy is applied.
 * They are genuinely different questions: the sync lane asks "are this agent's
 * events reaching the availability cache", the watch lane asks "is this agent's
 * Google push channel still being renewed". Sharing one counter (the pre-#1150
 * arrangement) meant the minute-cadence sync lane cleared the watch lane's
 * streak on its next success, so the watch question could never be answered.
 */
export async function loadFailingAgents(
  lane: HealthLane = "sync",
): Promise<FailingAgent[] | null> {
  const db = supabaseAdmin();
  const col = LANE_COLUMNS[lane];
  const policy = lane === "watch" ? WATCH_PAGING : SYNC_PAGING;
  // Two reads joined in code (the codebase convention, cf. loadSyncAgents):
  // the failing calendars, then the users they belong to.
  // #1134: null means "could not determine", NOT "nothing is failing". Both reads
  // still tolerate an error (the every-minute lane retries, so skipping one tick is
  // safe), but an empty list now TRIGGERS a recovery notice (#1133), and a swallowed
  // read error would therefore announce that sync had recovered on the strength of a
  // failed query. An unreadable health signal must never read as health.
  // error-ok: returned as null below, so the caller neither alerts nor all-clears.
  const { data: cals, error: calsError } = await db
    .from("agent_calendars")
    .select(`user_id, ${col.failures}, ${col.lastSuccess}, ${col.error}, ${col.kind}`)
    // The lower of the lane's two per-kind thresholds is the query floor; the
    // per-kind filter below is what actually decides.
    .gte(col.failures, Math.min(policy.gonePageAt, policy.transientPageAt));
  if (calsError) {
    log.warn("sync", { msg: "failing-agent read failed; health unknown this tick" });
    return null;
  }
  // Normalised out of the lane's columns into one shape, so everything below
  // (the threshold filter, the join, the dedup, the formatting) is lane-agnostic.
  const calRows = (cals ?? [])
    .map((row) => {
      const c = row as Record<string, unknown>;
      return {
        user_id: c.user_id as string,
        consecutive_failures: (c[col.failures] as number | null) ?? 0,
        last_success_at: (c[col.lastSuccess] as string | null) ?? null,
        last_sync_error: (c[col.error] as string | null) ?? null,
        last_failure_kind: (c[col.kind] as string | null) ?? null,
      };
    })
    // #916: apply the per-kind paging threshold BEFORE joining/dedup so a gone
    // calendar at streak 2 is never hidden behind a same-agent transient calendar
    // with a longer streak. The query floor above is the lower threshold; a
    // transient calendar must persist to the lane's transient threshold to page.
    .filter((c) => isPageableFailure(c.last_failure_kind, c.consecutive_failures, policy));
  if (calRows.length === 0) return [];

  // #1134: same rule as the read above. Without the agent names there is nothing to
  // alert ABOUT, so a failure here would collapse to an empty list and read as
  // health; return "unknown" instead.
  // error-ok: returned as null below, so the caller neither alerts nor all-clears.
  const { data: users, error: usersError } = await db
    .from("users")
    .select("id, email, bookable, deactivated_at")
    .in("id", [...new Set(calRows.map((c) => c.user_id))]);
  if (usersError) {
    log.warn("sync", { msg: "failing-agent name read failed; health unknown this tick" });
    return null;
  }
  const byId = new Map(
    ((users ?? []) as {
      id: string;
      email: string | null;
      bookable: boolean;
      deactivated_at: string | null;
    }[]).map((u) => [u.id, u]),
  );

  const rows: FailingCalendarRow[] = calRows.map((c) => {
    const u = byId.get(c.user_id);
    return {
      consecutive_failures: c.consecutive_failures,
      last_success_at: c.last_success_at,
      last_sync_error: c.last_sync_error,
      last_failure_kind: c.last_failure_kind,
      email: u?.email ?? null,
      bookable: u?.bookable ?? false,
      deactivated_at: u?.deactivated_at ?? null,
    };
  });
  // #1133: the per-kind streak filter above is per-ROW and cannot see how many
  // AGENTS are affected, which is the difference between "one flaky calendar" and
  // "something is systemically broken". So the blast-radius hold is applied last,
  // after dedup: a lone transient agent waits out the lane's hold, several page
  // at once on the fast threshold, and a gone account is never held.
  //
  // The hold is per-LANE (#1150). It used to be assumed that a watch failure's
  // pass count was topped up by the 1-minute sync lane sharing the column, which
  // is the coupling that made the watch alert unreachable in the first place. Now
  // each lane accumulates on its own cadence and WATCH_PAGING sizes the hold for
  // ~5 minutes a pass. A delayed watch page stays safe by construction: it means
  // Google push is degraded, and availability is already on the backup cron.
  return applyBlastRadiusHold(dedupeFailingAgents(rows), Date.now(), policy);
}

/**
 * Rows per UPSERT call, so even a huge calendar's bootstrap stays well under the
 * Worker's per-request subrequest ceiling (the old one-write-per-event loop did
 * 1,000+ serial calls and got killed mid-sync; see partitionBusyWrites).
 *
 * An upsert sends its rows in the request BODY, which has no comparable size limit,
 * so a row count is the right unit here. The DELETE below is a different problem
 * with a different unit and deliberately does NOT share this constant: its ids
 * travel in the query string (#1268).
 */
const UPSERT_CHUNK = 500;

/**
 * Event ids of this agent's active Slate bookings (#166) — the Google events
 * Slate created itself. The sync skips these so a Slate booking isn't mirrored
 * into a second source=gcal block alongside its own source=slate block (the
 * double-count). Matched by the booking's stored gcal_event_id (exact, not a
 * name heuristic), so there are no false skips of externally-booked events.
 */
export async function loadSlateBookingEventIds(userId: string): Promise<Set<string>> {
  // Paginate rather than trust a single page: this set had no time filter and was
  // cap-safe only while past bookings reliably aged into `completed` (#834). At the
  // 200-agent target a busy agent's active bookings could cross PostgREST's
  // 1,000-row page, and a truncated set would let a Slate-owned event slip through
  // and get mirrored as a duplicate source=gcal block, the exact #166 double-count.
  // selectAllPages throws on a read error instead of returning a short list that
  // would read as "nothing to skip".
  const db = supabaseAdmin();
  const rows = await selectAllPages<{ gcal_event_id: string | null }>(
    "sync slate booking event ids",
    (from, to) =>
      db
        .from("bookings")
        .select("gcal_event_id")
        .eq("assigned_user_id", userId)
        .in("status", ["confirmed", "rescheduled"])
        .not("gcal_event_id", "is", null)
        .range(from, to),
  );
  return new Set(
    rows.map((r) => r.gcal_event_id).filter((id): id is string => !!id),
  );
}

/** Upsert/delete gcal-sourced busy blocks for a batch of events on one calendar. */
export async function applyEvents(
  userId: string,
  calendarId: string,
  events: GoogleEvent[],
  slateEventIds: Set<string>,
  timeZone: string,
): Promise<void> {
  const db = supabaseAdmin();
  const { upserts, deletes } = partitionBusyWrites(
    userId,
    calendarId,
    events,
    slateEventIds,
    timeZone,
  );
  // Throw on any failure so syncCalendar never advances the sync token past an
  // event it failed to record - a swallowed error loses the event for good (the
  // delta is consumed) and the cache silently drifts from Google.
  //
  // Keyed on (user_id, calendar_id, gcal_event_id) so the same event id invited
  // to two of an agent's watched calendars keeps a distinct block per calendar,
  // instead of one calendar's sync overwriting the other's row (#619).
  for (let i = 0; i < upserts.length; i += UPSERT_CHUNK) {
    const { error } = await db
      .from("busy_blocks")
      .upsert(upserts.slice(i, i + UPSERT_CHUNK), {
        onConflict: "user_id,calendar_id,gcal_event_id",
      });
    if (error) throw new Error(`busy_blocks bulk upsert failed: ${error.message}`);
  }
  // Scope deletes to THIS calendar (#619): a cancellation delta from one calendar
  // must not remove the block for the same event still present on another.
  //
  // Batched by BYTES, not by a row count (#1268). These ids ride in the query string,
  // where an oversized batch is REFUSED at the transport rather than merely slow, and
  // Google event ids are neither uuids nor one length (measured: 43 characters on
  // average in this very table, reaching 181). Sharing the upsert's 500 sent roughly
  // 21,500 bytes at the average against a limit measured between 13,028 accepted and
  // 14,878 refused, so any delete past roughly 230 average-length ids failed.
  //
  // The consequence of that failure is why it matters more than a retry: `applyEvents`
  // throws, `syncCalendar` never advances this calendar's sync token, and the same
  // pass retries forever, so the agent's cached availability silently stops updating.
  for (const chunk of chunkIdsByUrlBudget(deletes)) {
    const { error } = await db
      .from("busy_blocks")
      .delete()
      .eq("user_id", userId)
      .eq("calendar_id", calendarId)
      .in("gcal_event_id", chunk);
    if (error) throw new Error(`busy_blocks bulk delete failed: ${error.message}`);
  }
}

/**
 * After a FULL resync, drop cached gcal blocks for this calendar whose event no
 * longer exists. Incremental syncs carry per-event cancellations, but a full
 * resync (bootstrap or expired token) just returns the current set, so events
 * deleted while the token was stale would otherwise linger and over-block.
 */
export async function purgeVanished(
  userId: string,
  calendarId: string,
  events: GoogleEvent[],
  slateEventIds: Set<string>,
  /**
   * The bounds the pass that produced `events` actually sent (#1261). Passed in, never
   * re-read from `sync_window_to`: a stored value larger than what was sent would extend
   * the reconcile past the fetch, which is the only way this can over-delete.
   */
  window: { timeMinIso: string; timeMaxIso: string },
): Promise<void> {
  const db = supabaseAdmin();
  // Exclude Slate-owned events from `seen` (#166): they should never have a
  // gcal mirror, so a legacy one left from before the fix is treated as stale
  // and purged on the next full resync (the source=slate block is untouched —
  // this query only deletes source=gcal rows).
  const seen = new Set(
    events
      .filter((e) => e.id && isBusyEvent(e) && !slateEventIds.has(e.id))
      .map((e) => e.id as string),
  );
  // Reconcile against the cached gcal blocks the fetch COVERED, paged (#834). Paged
  // because the set must be seen whole: a stale block sitting past PostgREST's 1,000-row
  // page would never be seen and would over-block the agent forever, which is the
  // orphaned-block bug this function exists to prevent. selectAllPages throws on a read
  // error rather than returning a short list that would leave real orphans behind.
  //
  // #1261 narrowed the read to the fetched window. The old comment here said a time filter
  // "can't stand in, since a vanished event's stale block may lie outside any window", and
  // that was correct while the bootstrap was unbounded above: everything was fetched, so
  // everything could be judged. Now the fetch carries a timeMax, blocks outside it were
  // never in the answer, and judging them would delete busy time for meetings still in the
  // calendar. Narrowing here also bounds the read itself, which matters: one agent holds
  // 22,137 blocks.
  //
  // The bounds map to the SAME two fields Google uses, so this set is exactly the fetch's:
  // timeMin bounds the END time, timeMax bounds the START time.
  const blocks = await selectAllPages<{
    id: string;
    gcal_event_id: string | null;
    starts_at: string;
    ends_at: string;
  }>("sync purge vanished busy_blocks", (from, to) =>
    db
      .from("busy_blocks")
      .select("id, gcal_event_id, starts_at, ends_at")
      .eq("user_id", userId)
      .eq("calendar_id", calendarId)
      .eq("source", "gcal")
      .gt("ends_at", window.timeMinIso)
      .lt("starts_at", window.timeMaxIso)
      .range(from, to),
  );
  // The window is applied AGAIN, in the pure judge. Not redundant defensively: the filter
  // above bounds the READ (and its cost), while this is the rule that decides a DELETE, and
  // it is the half that is unit-tested against straddling and out-of-window blocks. A
  // mistake in the query shape therefore cannot widen what gets deleted.
  const stale = staleBlockIds(blocks, seen, window);
  // Chunked by BYTES, not by a row count (#1321), because the ids travel in the
  // query string and an oversized batch is REFUSED, not merely slow (#1259: 350
  // uuids measured accepted, 400 refused). A count only holds while every id is
  // the same length, and carrying one over from a call site with shorter keys is
  // the mistake that shipped three times. A
  // bootstrap routinely produces a big stale set: the fetch's timeMin excludes every
  // block that ended more than a day ago, so all of those come back as vanished, and
  // one agent holds 22,137 blocks.
  //
  // unwrapCount, not a bare await: an unchecked delete error leaves the stale blocks
  // in place while the sync reports success and advances its token, so the agent stays
  // falsely busy with nothing anywhere saying the cleanup failed.
  for (const chunk of chunkIdsByUrlBudget(stale)) {
    unwrapCount(
      await db.from("busy_blocks").delete({ count: "exact" }).in("id", chunk),
      "purgeVanished stale busy_blocks",
    );
  }
}

/**
 * The current diagnostics snapshot for one LANE of a calendar (#273, #1150).
 * Written out longhand per lane rather than indexed through LANE_COLUMNS so the
 * types stay real: a typo here is a compile error, not a silent undefined that
 * would reset the streak to 1 on every failure.
 */
function healthOf(cal: AgentCalendar, lane: HealthLane): CalSyncHealth {
  if (lane === "watch") {
    return {
      consecutive_failures: cal.watch_consecutive_failures,
      last_success_at: cal.watch_last_success_at,
      last_sync_error: cal.watch_last_error,
      last_failure_kind: cal.watch_last_failure_kind,
    };
  }
  return {
    consecutive_failures: cal.consecutive_failures,
    last_success_at: cal.last_success_at,
    last_sync_error: cal.last_sync_error,
    last_failure_kind: cal.last_failure_kind,
  };
}

/**
 * Persist the next diagnostics state for one calendar on ONE lane, plus any extra
 * columns (sync_token, watch fields) written in the same update. Never throws - a
 * diagnostics write must not break or mask the sync/watch it describes.
 *
 * The lane picks the column set (#1150), so a sync result physically cannot
 * overwrite the watch lane's streak or the reverse.
 */
async function recordCalHealth(
  calId: string,
  lane: HealthLane,
  prev: CalSyncHealth,
  outcome: SyncOutcome,
  extra: Partial<AgentCalendar> = {},
): Promise<void> {
  try {
    // laneHealthUpdate builds its keys from LANE_COLUMNS, so TypeScript widens
    // them to a string index and cannot see that they are all AgentCalendar
    // columns. The mapping itself is the guarantee, and the node test asserts
    // both lanes produce exactly their own four columns and share none.
    const payload = {
      ...laneHealthUpdate(lane, nextSyncState(prev, outcome, new Date().toISOString())),
      ...extra,
    } as Partial<AgentCalendar>;
    await supabaseAdmin().from("agent_calendars").update(payload).eq("id", calId);
  } catch (err) {
    log.error("sync", { msg: "recordCalHealth failed", cal_id: calId, lane }, err);
  }
}

/** Sync one calendar's changes into busy_blocks; advances its stored sync token. */
async function syncCalendar(
  email: string,
  cal: AgentCalendar,
  timeZone: string,
): Promise<number> {
  // ONE window for this pass, computed once and passed to both the fetch and the reconcile
  // that judges it (#1261). Computing it twice would let the two drift by however long the
  // fetch took, and the reconcile may only ever judge what the fetch actually asked for.
  const window = hydrationWindow(Date.now());
  const prev = healthOf(cal, "sync");

  try {
    let result;
    let full = !cal.sync_token; // bootstrap (no token) is a full sync
    try {
      result = await syncEvents(
        email,
        cal.calendar_id,
        cal.sync_token,
        window.timeMinIso,
        window.timeMaxIso,
      );
    } catch (err: unknown) {
      if (err instanceof SyncTokenExpired) {
        full = true;
        result = await syncEvents(
          email,
          cal.calendar_id,
          null,
          window.timeMinIso,
          window.timeMaxIso,
        );
      } else {
        throw err;
      }
    }

    // A page-capped pass (#171) fetched only the first MAX_SYNC_PAGES pages and
    // advanced no sync token, so the stored token is retained and the next tick
    // re-reads the same delta. Report it (a pathological calendar is the only way
    // to hit this) rather than letting it pass silently.
    if (result.truncated) {
      log.warn("google-sync", {
        msg: "events.list hit the page cap; retained sync token to resume next tick",
        user_id: cal.user_id,
        calendar_id: cal.calendar_id,
      });
    }

    // The agent's own Slate-booking event ids, so the sync skips mirroring them
    // into a duplicate gcal block (#166). Only load when there's something to
    // apply — the common incremental tick has no events, so it skips the query.
    const slateEventIds =
      result.events.length > 0
        ? await loadSlateBookingEventIds(cal.user_id)
        : new Set<string>();
    await applyEvents(cal.user_id, cal.calendar_id, result.events, slateEventIds, timeZone);
    // Never reconcile against a PARTIAL event set (#1259). A page-capped pass read only
    // the first MAX_SYNC_PAGES pages, so every event on the pages it never fetched
    // looks vanished and its cached busy time would be deleted, leaving the agent
    // looking free during real meetings. The stored token is retained above, so the
    // next pass re-reads the same delta and the reconcile happens once it is complete.
    if (full && !result.truncated)
      await purgeVanished(
        cal.user_id,
        cal.calendar_id,
        result.events,
        slateEventIds,
        window,
      );

    // A sync that wrote events may have just mirrored an external Google booking
    // that collides with a Slate booking (#316). Check now (best-effort) so a
    // cross-system double-book is detected, not silent. Covers both the cron and
    // push paths, which both flow through here.
    if (result.events.length > 0) {
      await detectExternalCollisions(cal.user_id, email);
    }

    // Persist the advanced sync token on its OWN write (correctness-critical:
    // it's how the next pass resumes instead of re-bootstrapping). Kept separate
    // from the best-effort diagnostics write so the token still saves even if
    // the diagnostics columns aren't present yet (e.g. migration not applied).
    if (result.nextSyncToken) {
      await supabaseAdmin()
        .from("agent_calendars")
        .update({ sync_token: result.nextSyncToken })
        .eq("id", cal.id);
    }
    await recordCalHealth(cal.id, "sync", prev, { ok: true });
    return result.events.length;
  } catch (err) {
    // Record the failure (streak + message + classification) before rethrowing so
    // the per-agent error handling + alert still fire and the cache never drifts
    // silently. The kind (#916) lets the alert page a genuinely-gone account and
    // back off on a transient blip.
    await recordCalHealth(cal.id, "sync", prev, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      kind: reachabilityFromError(err),
    });
    throw err;
  }
}

/**
 * Re-bootstrap ONE calendar over the current window (#1261).
 *
 * The rotation lane's unit of work. Deliberately separate from `syncCalendar` rather than a
 * flag on it: this always forces a FULL fetch (a token would give a delta, which is the very
 * thing that cannot re-add an event it already delivered once), and it owns two writes
 * `syncCalendar` has no business making.
 *
 * THE ORDER OF THE WRITES IS THE DESIGN.
 *
 * 1. `last_bootstrap_attempt_at` is stamped BEFORE the fetch, so it moves whether or not the
 *    fetch works. It drives rotation fairness only, and a stamp that advanced solely on
 *    success would let a calendar whose delegation is revoked stay the oldest forever and be
 *    selected first on every tick, starving every healthy calendar behind it.
 *
 * 2. `sync_window_to` is written ONLY on success, and in its OWN write, never coupled to the
 *    token. Coupling them means every token write fails while code is deployed ahead of its
 *    migration, and then every calendar re-bootstraps every minute against Google. The token
 *    write is deliberately isolated for exactly that reason and this must not undo it.
 *
 * 3. The token is written CONDITIONALLY on the value this pass started with. A push-driven
 *    sync can advance the token while this fetch is in flight; overwriting it would leave the
 *    stored coverage claiming a window the token does not correspond to. Losing the race is
 *    harmless (the other pass's token is newer and the next rotation re-establishes the
 *    window), so the conditional write simply does nothing.
 *
 * THE BLOCK CONTENTS ARE NOT COVERED BY ANY OF THAT, which is #2411.
 *
 * Points 1 to 3 reason entirely about the token, and a conditional write that does nothing
 * is only harmless for the token. The upsert and the reconcile below are unconditional, so a
 * sync that landed while this fetch was in flight has its work overwritten: an event moved
 * mid-fetch is written back at the time this pass FETCHED, and an event created mid-fetch is
 * missing from `seen`, so its fresh block is judged vanished and deleted. Google delivers an
 * unchanged event exactly ONCE and the other pass already consumed that delta, so nothing
 * re-sends it: the booker offers a time the agent is in a meeting, or withholds a real free
 * one, until the rotation next reaches this calendar, up to a day later.
 *
 * TWO THINGS CLOSE IT, and they close different halves.
 *
 * 4. This pass takes the same `sync_claimed_at` claim `syncByChannel` takes, so a push sync
 *    arriving mid-pass COALESCES instead of writing, and a push that got there first makes
 *    this pass skip. Nothing is stranded by that: this pass writes the token belonging to its
 *    OWN snapshot, so a change made after the snapshot is still pending for that token and
 *    the next incremental tick (within a minute) delivers it. The claim is a timestamp with a
 *    TTL, so a pass that dies holding it is taken over after CALENDAR_CLAIM_TTL_MS rather
 *    than holding the calendar for ever (L366, L409).
 *
 * 5. The stored token is RE-READ after the fetch, and every write below is abandoned if it
 *    moved. The every-minute lane takes no per-calendar claim (100 agents a tick puts a claim
 *    plus release per calendar past the Worker subrequest ceiling four lanes share), so a
 *    pass that listed before this claim landed can still be running, and a claim stolen after
 *    its TTL has the same shape. A token that moved is the exact signature of a writer this
 *    pass cannot see, and the only safe answer is to write nothing: an abandoned pass leaves
 *    the cache as the other writer left it, which is the fresher of the two.
 */
export type HydrateSkip =
  | "claimed"
  | "claim-unreadable"
  | "token-moved"
  | "token-unreadable"
  | "calendar-gone"
  | "no-mailbox";

export interface HydrateResult {
  ok: boolean;
  events: number;
  /**
   * Set when this pass declined to run or abandoned itself, never when it ran and
   * FAILED. The two are counted differently by the lane: a skip measured nothing, so
   * scoring it as a failure would page about a rotation that is working (#1544), and
   * scoring it as a refresh would report coverage nobody established.
   */
  skipped?: HydrateSkip;
}

export async function hydrateCalendar(cal: AgentCalendar): Promise<HydrateResult> {
  const db = supabaseAdmin();
  const window = hydrationWindow(Date.now());
  const startingToken = cal.sync_token;
  const prev = healthOf(cal, "sync");

  // BEFORE the rotation stamp and before the fetch (see 4 above). Ordering the claim
  // first is what makes a skipped calendar cheap AND retried: no Google call is spent,
  // and `last_bootstrap_attempt_at` does not move, so the calendar stays at the head of
  // the rotation and is picked up by the NEXT tick (15 minutes) rather than going to the
  // back of a day-long queue. Nothing starves behind it either: it is skipped without
  // any IO, so the rest of the batch still runs.
  const { claimIso, staleBeforeIso } = claimWindow(Date.now(), CALENDAR_CLAIM_TTL_MS);
  const { data: claimed, error: claimError } = await db
    .from("agent_calendars")
    .update({ sync_claimed_at: claimIso })
    .eq("id", cal.id)
    .or(`sync_claimed_at.is.null,sync_claimed_at.lt.${staleBeforeIso}`)
    .select("id");
  if (claimError) {
    // Its own outcome, not folded into "claimed" (L11): one says another pass is working
    // on this calendar and the other says the database refused a write, and they send a
    // reader to two different places. Either way nothing has been read or deleted.
    log.warn("hydrate-calendars", {
      msg: "could not take the sync claim, skipping",
      calendar_id: cal.calendar_id,
    });
    return { ok: false, events: 0, skipped: "claim-unreadable" };
  }
  if (!(claimed as { id: string }[] | null)?.length) {
    return { ok: false, events: 0, skipped: "claimed" };
  }

  try {
    // Before the fetch, deliberately (see 1 above). Best effort: a failed stamp costs
    // fairness on one tick, and must not stop the hydration it precedes.
    await db
      .from("agent_calendars")
      .update({ last_bootstrap_attempt_at: new Date().toISOString() })
      .eq("id", cal.id);

    const email = await loadAgentEmail(cal.user_id);
    if (!email) {
      // Not a Google failure, so it must not touch the sync failure streak: doing so would
      // let a missing mailbox back off a calendar that is perfectly reachable.
      log.warn("hydrate-calendars", {
        msg: "no mailbox for agent, skipping",
        user_id: cal.user_id,
      });
      return { ok: false, events: 0, skipped: "no-mailbox" };
    }

    try {
      const timeZone = await loadAgentTimezone(cal.user_id);
      // null token, always: this is a re-bootstrap, not a delta.
      const result = await syncEvents(
        email,
        cal.calendar_id,
        null,
        window.timeMinIso,
        window.timeMaxIso,
      );

      // See 5 above. Read BEFORE the first write, so nothing below can act on a snapshot
      // another writer has already superseded.
      // error-ok is NOT available here: an unreadable token must abandon the pass, because
      // the alternative is deleting cached busy time on the strength of a question nobody
      // answered. Bound with its error rather than unwrapped so the two ways of not
      // knowing keep their own outcomes.
      const { data: currentRow, error: tokenError } = await db
        .from("agent_calendars")
        .select("sync_token")
        .eq("id", cal.id)
        .maybeSingle();
      if (tokenError) {
        log.warn("hydrate-calendars", {
          msg: "could not re-read the sync token, writing nothing",
          calendar_id: cal.calendar_id,
        });
        return { ok: false, events: 0, skipped: "token-unreadable" };
      }
      const current = currentRow as { sync_token: string | null } | null;
      if (current === null) {
        // The watch lane drops a calendar Google no longer lists, row and all (#2380).
        // Re-creating its blocks here would restore cached busy time for a calendar that
        // does not exist.
        return { ok: false, events: 0, skipped: "calendar-gone" };
      }
      if (current.sync_token !== startingToken) {
        log.info("hydrate-calendars", {
          msg: "sync token advanced during the fetch, abandoning this pass",
          calendar_id: cal.calendar_id,
        });
        // Health is deliberately NOT recorded either way. The fetch succeeded, so a failure
        // would back off a perfectly reachable calendar, and a success would report a
        // refresh that never landed.
        return { ok: false, events: 0, skipped: "token-moved" };
      }

      const slateEventIds =
        result.events.length > 0
          ? await loadSlateBookingEventIds(cal.user_id)
          : new Set<string>();
      await applyEvents(cal.user_id, cal.calendar_id, result.events, slateEventIds, timeZone);
      // Never reconcile against a PARTIAL set (#1259): a page-capped pass read only the first
      // pages, so everything beyond them looks vanished and its cached busy time would be
      // deleted, leaving the agent looking free during real meetings.
      if (!result.truncated) {
        await purgeVanished(cal.user_id, cal.calendar_id, result.events, slateEventIds, window);
      }

      // Coverage is only claimed for a pass that actually completed. A truncated pass fetched
      // part of the window, so recording the full window would authorize the prune over a
      // range that was never read.
      if (!result.truncated) {
        await db
          .from("agent_calendars")
          .update({ sync_window_to: window.timeMaxIso })
          .eq("id", cal.id);
      }

      if (result.nextSyncToken) {
        // Conditional on the value this pass started with (see 3 above). `.is` for null,
        // because `.eq` against null matches nothing in PostgREST. The re-read above makes
        // this the expected path rather than the race it was written for, and it stays
        // conditional: the two checks bracket the writes, so a writer that slipped between
        // them still cannot leave a token that disagrees with the blocks just written.
        const q = db
          .from("agent_calendars")
          .update({ sync_token: result.nextSyncToken })
          .eq("id", cal.id);
        await (startingToken === null
          ? q.is("sync_token", null)
          : q.eq("sync_token", startingToken));
      }

      await recordCalHealth(cal.id, "sync", prev, { ok: true });
      return { ok: true, events: result.events.length };
    } catch (err) {
      await recordCalHealth(cal.id, "sync", prev, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        kind: reachabilityFromError(err),
      });
      log.warn("hydrate-calendars", {
        msg: "calendar hydration failed",
        calendar_id: cal.calendar_id,
      }, err);
      return { ok: false, events: 0 };
    }
  } finally {
    // Release only OUR claim, in a `finally` so a throw anywhere above still frees the
    // calendar immediately rather than leaving the next lane to wait out the TTL. After
    // the TTL another pass may legitimately hold a newer one, and the equality on the
    // claim value is what stops this release freeing theirs.
    await db
      .from("agent_calendars")
      .update({ sync_claimed_at: null })
      .eq("id", cal.id)
      .eq("sync_claimed_at", claimIso);
  }
}

/**
 * Pulls calendar changes into busy_blocks across an agent's calendars.
 * `deadlineMs` (#44) stops STARTING new calendars once the tick budget is
 * spent - incrementals run first, bootstraps last - and reports truncation;
 * sync tokens make the next invocation resume where this one stopped.
 *
 * `goneSkipped` (#1187) is how many of this agent's calendars the backoff below
 * held back this tick. The backoff is the point of #1049, but the retries it
 * removes were also the incidental signal that something was wrong: a Workspace
 * change revoking delegation across the fleet now makes this lane QUIETER, not
 * noisier. Reporting the count keeps the SCALE of a revocation observable.
 *
 * `claimSkipped` (#2411) is how many were held back because another pass holds
 * the calendar's claim, which since #2411 includes the once-a-day hydration
 * re-bootstrap. Counted separately from `goneSkipped` for the same reason that
 * one is reported at all: the two say different things (a delegation to repair
 * against a pass that will finish by itself), and one silently answering for the
 * other is how somebody spends a morning on the wrong cause (L11). A calendar
 * skipped here is retried on the NEXT minute, which is inside the claim's own TTL.
 */
export async function runIncrementalSync(
  userId: string,
  deadlineMs: number | null = null,
): Promise<{
  events: number;
  truncated: boolean;
  goneSkipped: number;
  claimSkipped: number;
}> {
  const email = await loadAgentEmail(userId);
  if (!email) return { events: 0, truncated: false, goneSkipped: 0, claimSkipped: 0 };
  const timeZone = await loadAgentTimezone(userId);
  // #1049: sync order, minus calendars established as gone whose turn this is
  // not. A revoked delegation cannot recover without a human, so re-attempting it
  // on all 1440 rotations a day only burns Google calls that can only fail; each
  // one now gets one attempt per GONE_RETRY_INTERVAL_MIN so it still recovers.
  // #2411: minus anything another pass currently holds, so this lane cannot write
  // over a hydration snapshot mid-pass.
  const all = await loadAgentCalendars(userId);
  // Both counts come from the one predicate that made the decision, never re-decided
  // here: a second copy of either rule would drift from the filter it describes.
  const { due: cals, goneSkipped, claimSkipped } = partitionCalendarsForSync(
    all,
    Date.now(),
  );
  let events = 0;
  for (let i = 0; i < cals.length; i++) {
    if (pastDeadline(Date.now(), deadlineMs)) {
      return { events, truncated: true, goneSkipped, claimSkipped };
    }
    events += await syncCalendar(email, cals[i], timeZone);
  }
  return { events, truncated: false, goneSkipped, claimSkipped };
}

/**
 * Sync the calendar whose push channel pinged us (the webhook hot path),
 * coalescing concurrent pings (#30): every ping sets sync_pending, but only
 * the request that wins the sync_claimed_at claim actually syncs - it keeps
 * re-running while new pings land mid-pass (bounded; the 1-minute cron
 * backstop owns anything past the bound), then releases its claim. Losers
 * return immediately knowing the holder will pick their changes up.
 */
export async function syncByChannel(
  channelId: string,
): Promise<"synced" | "coalesced" | "unknown-channel"> {
  const db = supabaseAdmin();
  // error-ok: push-path channel resolution; a read error is treated as
  // unknown-channel and the 1-min cron backstop reconverges the calendar.
  const { data } = await db
    .from("agent_calendars")
    .select("*")
    .eq("watch_channel_id", channelId)
    .maybeSingle();
  const cal = data as AgentCalendar | null;
  if (!cal) return "unknown-channel";

  // Flag the new changes BEFORE trying to claim, so a holder mid-pass is
  // guaranteed to either see the flag or lose nothing (the cron backstops).
  await db.from("agent_calendars").update({ sync_pending: true }).eq("id", cal.id);

  const { claimIso, staleBeforeIso } = claimWindow(Date.now(), CALENDAR_CLAIM_TTL_MS);
  const { data: claimed } = await db
    .from("agent_calendars")
    .update({ sync_claimed_at: claimIso })
    .eq("id", cal.id)
    .or(`sync_claimed_at.is.null,sync_claimed_at.lt.${staleBeforeIso}`)
    .select("id");
  if (!claimed?.length) return "coalesced";

  const email = await loadAgentEmail(cal.user_id);
  try {
    if (!email) return "synced";
    const timeZone = await loadAgentTimezone(cal.user_id);
    for (let pass = 1; pass <= MAX_SYNC_PASSES; pass++) {
      await db.from("agent_calendars").update({ sync_pending: false }).eq("id", cal.id);
      // error-ok: re-read of the calendar we already hold the claim on; a read
      // error breaks this pass and the 1-min cron backstop reconverges it.
      const { data: fresh } = await db
        .from("agent_calendars")
        .select("*")
        .eq("id", cal.id)
        .maybeSingle();
      if (!fresh) break;
      await syncCalendar(email, fresh as AgentCalendar, timeZone);
      // error-ok: post-pass sync_pending check; a read error just ends the rerun
      // loop and the 1-min cron backstop owns anything missed.
      const { data: after } = await db
        .from("agent_calendars")
        .select("sync_pending")
        .eq("id", cal.id)
        .maybeSingle();
      const pendingAgain = Boolean(
        (after as { sync_pending?: boolean } | null)?.sync_pending,
      );
      if (!shouldRerun(pendingAgain, pass)) break;
    }
  } finally {
    // Release only OUR claim - after the TTL another request may hold a newer one.
    await db
      .from("agent_calendars")
      .update({ sync_claimed_at: null })
      .eq("id", cal.id)
      .eq("sync_claimed_at", claimIso);
  }
  // The agent's calendar changed: refresh the precomputed slot rows for every
  // bucket they affect so it shows up in <5s. Through afterResponse (#503) so
  // the recompute survives the isolate teardown after the response instead of a
  // float Cloudflare can drop; the 1-min cron backstops it regardless. The sole
  // caller (the push route) already runs this inside an after(); afterResponse
  // nests safely and degrades to a plain float if a nested schedule is refused.
  afterResponse("sync-recompute", () => recomputeBucketsForAgent(cal.user_id));
  return "synced";
}

/** The calendar ids whose busy time blocks an agent (their stored watched set). */
export async function watchedCalendarIds(userId: string): Promise<string[]> {
  const cals = await loadAgentCalendars(userId);
  return cals.map((c) => c.calendar_id);
}

/** Outcome of an ensureWatches attempt — never throws, so callers can surface it. */
export type WatchResult =
  | { status: "skipped"; reason: string }
  | { status: "current" }
  | { status: "renewed" }
  | { status: "error"; error: string };

/**
 * Reconciles the agent's watched calendar set and registers/renews a push
 * channel per calendar. Cheap on the common path: it only hits the Google
 * calendarList API when a renewal is actually due (or on first run), so the
 * 1-min cron just does a DB read + expiry check most of the time.
 */
export async function ensureWatches(userId: string): Promise<WatchResult> {
  const pushUrl = googlePushUrl();
  if (!pushUrl.startsWith("https://") || pushUrl.includes("localhost")) {
    return { status: "skipped", reason: "non-public-https-app-url" };
  }
  const email = await loadAgentEmail(userId);
  if (!email) return { status: "skipped", reason: "no-agent-email" };

  const existing = await loadAgentCalendars(userId);
  // #1169: fail closed. A corrupt watch_expiration used to parse to NaN, which
  // compared false against the threshold ("not due") forever, so the channel
  // silently lapsed and push updates stopped, exactly the failure this check
  // exists to prevent. Missing OR unreadable both read as due, and the renewal
  // then overwrites the corrupt value.
  const dueForRenewal = (c: AgentCalendar) => {
    const expMs = parseStampMs(c.watch_expiration);
    return expMs === null || expMs - Date.now() < WATCH_RENEW_THRESHOLD_MS;
  };
  if (existing.length > 0 && !existing.some(dueForRenewal)) {
    return { status: "current" };
  }

  try {
    const db = supabaseAdmin();
    // Reconcile the stored calendar set with what the agent actually has.
    let wanted: string[];
    try {
      wanted = selectableCalendarIds(await listCalendars(email));
    } catch (err) {
      // A calendar list we could not READ is not authoritative, in any of the
      // ways it can fail (#2380, generalising the truncation refusal of #171).
      // The reconcile below deletes every stored calendar the list does not
      // name, taking its push channel, its cached busy blocks and its row (with
      // the sync token, sync_window_to and both health streaks) with it, so it
      // may only ever run against Google's own successful answer.
      //
      // This used to fall back to ["primary"] for a domain-wide delegation that
      // did not yet grant calendar.readonly. That reason no longer holds: dwd.ts
      // grants the scope, and classifyCalendarReachability requires THIS listing
      // to succeed before anyone can become bookable, so every agent reaching
      // here has it. What is left is a 5xx, a 429, a rate-limit 403 or a dropped
      // socket, all of which `ok()` throws.
      //
      // And the fallback could never have matched anyway: the stored primary id
      // is the agent's EMAIL (selectableCalendarIds keeps the entry with
      // primary === true and stores its id, which Google reports as the address),
      // never the literal "primary", so reconciling against the alias judged the
      // agent's real calendar vanished and deleted it, then inserted an alias row
      // the verify-on-book free/busy must never see. Until the sync lane
      // bootstrapped that row the booker offered the agent's whole working day.
      //
      // The kind is recorded, not branched on: every failure takes the same
      // refusal, so there is nothing for `isDefinitiveFailure` to decide here.
      // It is on the line because a not-provisioned account and a bad minute at
      // Google send different people to do different things.
      log.warn(
        "sync",
        {
          msg: "calendar list unreadable, reconciling nothing",
          user_id: userId,
          kind: reachabilityFromError(err),
          stored_calendars: existing.length,
        },
        err,
      );
      throw err;
    }
    const wantedSet = new Set(wanted);
    const haveSet = new Set(existing.map((c) => c.calendar_id));

    const toInsert = wanted.filter((id) => !haveSet.has(id));
    if (toInsert.length) {
      await db
        .from("agent_calendars")
        .insert(toInsert.map((calendar_id) => ({ user_id: userId, calendar_id })));
    }
    for (const c of existing) {
      if (wantedSet.has(c.calendar_id)) continue;
      // Say what is being torn down (#2380). This is the most destructive thing
      // the watch lane does and it left no trace at all: a calendar, its push
      // channel and every cached busy block for it, after which the lane reports
      // the watch as renewed. It is a LOG rather than an alert on purpose. Every
      // deletion reaching this line is now one Google's own successful listing
      // says is gone, which is an ordinary calendar removal, and an alert that
      // fires on every ordinary removal is one nobody reads by the second week.
      // What was worth paging about was the fallback that got here on a failed
      // read, and that is refused above rather than reported.
      log.warn("sync", {
        msg: "calendar no longer listed, dropping it with its watch and cached busy time",
        user_id: userId,
        calendar_id: c.calendar_id,
        had_watch: Boolean(c.watch_channel_id && c.watch_resource_id),
      });
      if (c.watch_channel_id && c.watch_resource_id) {
        await stopChannel(email, c.watch_channel_id, c.watch_resource_id).catch((err) =>
        // An un-stopped channel keeps Google notifying us about a calendar we
        // have dropped, so this is worth a trace even though teardown continues.
        log.warn("sync", { msg: "stopChannel failed", channel_id: c.watch_channel_id }, err),
      );
      }
      // Drop cached busy blocks for a calendar the agent no longer has, so a
      // removed calendar can't keep over-blocking their availability.
      await db
        .from("busy_blocks")
        .delete()
        .eq("user_id", userId)
        .eq("calendar_id", c.calendar_id);
      await db.from("agent_calendars").delete().eq("id", c.id);
    }

    // Register/renew watches for the current set. Each calendar is isolated
    // (#273 Phase 1.2): one bad calendar (e.g. a 404 account-gone) must NOT
    // abort the agent's other renewals, and each records its own diagnostics.
    const cals = await loadAgentCalendars(userId);
    let renewed = false;
    let firstError: string | null = null;
    for (const cal of cals) {
      if (!dueForRenewal(cal)) continue;
      const prev = healthOf(cal, "watch");
      try {
        if (cal.watch_channel_id && cal.watch_resource_id) {
          await stopChannel(email, cal.watch_channel_id, cal.watch_resource_id).catch((err) =>
            log.warn(
              "sync",
              { msg: "stopChannel failed", channel_id: cal.watch_channel_id },
              err,
            ),
          );
        }
        const channelId = nanoid();
        const { resourceId, expiration } = await watchCalendar(
          email,
          cal.calendar_id,
          channelId,
        );
        await recordCalHealth(cal.id, "watch", prev, { ok: true }, {
          watch_channel_id: channelId,
          watch_resource_id: resourceId,
          watch_expiration: expiration,
        });
        renewed = true;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        if (firstError === null) firstError = error;
        await recordCalHealth(cal.id, "watch", prev, {
          ok: false,
          error,
          kind: reachabilityFromError(err),
        });
        // keep going - the agent's other calendars still need their watches.
      }
    }
    if (firstError !== null) return { status: "error", error: firstError };
    return renewed ? { status: "renewed" } : { status: "current" };
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

export interface PoolExitCleanup {
  /** Google watch channels we attempted to stop this run (0 once cleaned). */
  watchesStopped: number;
  /** Cached busy_blocks rows removed for the agent. */
  blocksDeleted: number;
  /**
   * Rows left in place because an approved time off owns them (#1471). Reported
   * rather than silently skipped, so the count says what the prune did not do.
   */
  blocksPreserved: number;
}

/**
 * Clean up after an agent leaves the bookable pool (#239, #248). Stops every
 * Google push-watch channel the agent still holds and nulls the watch columns,
 * so Google stops POSTing change notifications to `/api/google/push` for someone
 * we no longer book, and deletes the agent's cached `busy_blocks` (availability
 * never reads them for a non-bookable agent, so they only bloat the table).
 *
 * Idempotent and best-effort per side effect: a failed `stopChannel` is
 * swallowed (the channel auto-expires within days regardless) and the watch
 * columns are still cleared, so a re-run or the periodic reconcile backstop
 * converges. Safe to run twice.
 */
export async function cleanupOnPoolExit(userId: string): Promise<PoolExitCleanup> {
  const db = supabaseAdmin();
  const email = await loadAgentEmail(userId);
  const cals = await loadAgentCalendars(userId);

  let watchesStopped = 0;
  for (const c of cals) {
    if (email && c.watch_channel_id && c.watch_resource_id) {
      await stopChannel(email, c.watch_channel_id, c.watch_resource_id).catch((err) =>
        // An un-stopped channel keeps Google notifying us about a calendar we
        // have dropped, so this is worth a trace even though teardown continues.
        log.warn("sync", { msg: "stopChannel failed", channel_id: c.watch_channel_id }, err),
      );
      watchesStopped++;
    }
  }

  // Clear the watch columns in one write so a re-run/reconcile sees no live watch
  // and doesn't try to stop them again.
  //
  // #1150: the watch HEALTH is cleared in the same write. That counter now
  // persists between renewal attempts (nothing else resets it, which is the whole
  // point), so an agent who left the pool mid-failure would keep the streak
  // indefinitely and page the instant they were made bookable again, before a
  // single renewal had been attempted. Leaving the pool ends the condition, so it
  // ends the streak. The sync lane's health is deliberately untouched: this
  // function is about tearing down push, not about the events feed.
  //
  // The streak is part of the "is anything set" test too, because a FAILED
  // renewal is exactly the case that leaves no channel behind, so keying the
  // write on the channel columns alone would skip precisely the rows that need it.
  const needsClear = cals.some(
    (c) =>
      c.watch_channel_id ||
      c.watch_resource_id ||
      c.watch_expiration ||
      c.watch_consecutive_failures > 0 ||
      c.watch_last_error !== null,
  );
  if (needsClear) {
    await db
      .from("agent_calendars")
      .update({
        watch_channel_id: null,
        watch_resource_id: null,
        watch_expiration: null,
        watch_consecutive_failures: 0,
        watch_last_error: null,
        watch_last_failure_kind: null,
      })
      .eq("user_id", userId);
  }

  // Prune cached busy time. A delete is not a capped read, so this removes every
  // matching row regardless of PostgREST's page cap.
  //
  // #1165: fail loud on a delete error rather than `count ?? 0`. A failed delete
  // returns a null count, and reporting that as `blocksDeleted: 0` is
  // indistinguishable from an agent who simply had no cached busy time, so the
  // stale blocks this exists to remove would linger with nothing noticing. Both
  // callers already handle a throw (the toggle logs it and lets the self-heal
  // backstop retry; the sweep reports the tick as "error").
  //
  // #1471/#1464: scoped to the rows it MEANS. A calendar mirror and a booking's
  // write-through are both meaningless once someone leaves the pool, but the OOO
  // fallback writes a row into this same table that is the only thing blocking
  // approved time off when the agent's calendar event could not be created. An
  // agent toggled out of the pool and back used to lose that cover silently. The
  // preserved rows are counted rather than merely skipped, so an operator reading
  // the result can see something survived (and the reconcile sweep still frees
  // them once the request stops being approved).
  const blocksPreserved = unwrapCount(
    await db
      .from("busy_blocks")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .not("ooo_request_id", "is", null),
    "pool-exit-prune-preserved",
  );
  const blocksDeleted = unwrapCount(
    await db
      .from("busy_blocks")
      .delete({ count: "exact" })
      .eq("user_id", userId)
      .is("ooo_request_id", null),
    "pool-exit-prune",
  );

  return { watchesStopped, blocksDeleted, blocksPreserved };
}

/**
 * Periodic backstop for the pool-exit cleanup (#239/#248). The synchronous hook
 * on the bookable toggle handles the normal path, but an agent can also leave the
 * pool WITHOUT going through it (Salesforce deactivation sets `deactivated_at`
 * directly), and the #238 flip benchmark left ~100 orphaned watches from before
 * the hook existed. This sweep, run on the self-heal lane, mops those up:
 *   1. Agents no longer routable (bookable=false OR deactivated) that still hold a
 *      LIVE push-watch get the full teardown, bounded to `limit` agents per tick
 *      so a large historical backlog can't blow the Worker subrequest ceiling
 *      (rotation catches the rest on later ticks).
 *   2. All non-routable agents' cached busy_blocks are pruned in one bulk delete
 *      (harmless to correctness, but they otherwise accumulate unbounded).
 * Fail-loud on the roster reads (unwrap): a broken read must not read as "nothing
 * to reconcile". Per-agent teardown is best-effort so one bad agent can't stall
 * the sweep.
 */
export async function reconcileOrphanedPoolExits(
  limit: number,
): Promise<{
  scanned: number;
  cleaned: number;
  blocksDeleted: number;
  /** Rows an approved time off owns, deliberately left in place (#1471). */
  blocksPreserved: number;
}> {
  const db = supabaseAdmin();
  // Everyone who has left the bookable pool on either axis. `users` is
  // roster-bounded (a fixed 100-200 agent target), so this can't fill a page.
  const leftRows = (unwrap(
    await db
      .from("users")
      .select("id, deactivated_at, bookable_pending_since")
      .or("bookable.eq.false,deactivated_at.not.is.null"),
    "pool-exit-reconcile",
  ) ?? []) as { id: string; deactivated_at: string | null; bookable_pending_since: string | null }[];
  // #2302: skip anybody an activation is OWED for. The gate establishes their
  // watches and loads their calendar before the bookable write, so for the second
  // or two in between they look exactly like an agent who has left the pool: not
  // bookable, holding a live watch, holding fresh busy blocks. This lane runs every
  // minute, so at that window it would reap a few percent of activations, and the
  // damage is invisible afterwards because `cleanupOnPoolExit` deliberately leaves
  // `sync_window_to` alone, so the coverage monitor goes on reading as healthy over
  // an emptied cache (#1879).
  //
  // The exclusion is no broader than that reason (L324): somebody DEACTIVATED has
  // left, whatever stale mark their row carries, so they are reaped as before.
  const ids = leftRows
    // `== null` rather than `=== null`: a nullable column comes back as null, and
    // an absent key means the same thing, so both have to read as 'no mark'.
    .filter((r) => r.deactivated_at != null || r.bookable_pending_since == null)
    .map((r) => r.id);
  if (ids.length === 0)
    return { scanned: 0, cleaned: 0, blocksDeleted: 0, blocksPreserved: 0 };

  // Of those, which still hold a live push-watch (the #239 load symptom).
  // agent_calendars is roster-bounded too.
  const watchRows = (unwrap(
    await db
      .from("agent_calendars")
      .select("user_id")
      .in("user_id", ids)
      .not("watch_channel_id", "is", null),
    "pool-exit-reconcile-watches",
  ) ?? []) as { user_id: string }[];
  const withWatch = [...new Set(watchRows.map((r) => r.user_id))].slice(0, limit);

  let blocksDeleted = 0;
  let blocksPreserved = 0;
  for (const id of withWatch) {
    const res = await cleanupOnPoolExit(id).catch((err) => {
      log.error("pool-exit-reconcile", { msg: "watch teardown failed", user_id: id }, err);
      return null;
    });
    blocksDeleted += res?.blocksDeleted ?? 0;
    blocksPreserved += res?.blocksPreserved ?? 0;
  }

  // #248 backstop: prune cached busy time for everyone who left the pool (a bulk
  // delete, so already-cleaned agents from the loop above simply match nothing).
  // #1165: fail loud, so a sweep that could not prune reports as "error" on the
  // lane rather than as a tick that found nothing to clean.
  // #1471: same scoping as the per-agent prune. A row owned by an approved time
  // off is the only cover for that window when the calendar write failed, so it
  // survives leaving the pool and is reported rather than silently skipped.
  blocksPreserved += unwrapCount(
    await db
      .from("busy_blocks")
      .select("id", { count: "exact", head: true })
      .in("user_id", ids)
      .not("ooo_request_id", "is", null),
    "pool-exit-reconcile-preserved",
  );
  blocksDeleted += unwrapCount(
    await db
      .from("busy_blocks")
      .delete({ count: "exact" })
      .in("user_id", ids)
      .is("ooo_request_id", null),
    "pool-exit-reconcile-prune",
  );

  return {
    scanned: ids.length,
    cleaned: withWatch.length,
    blocksDeleted,
    blocksPreserved,
  };
}
