import { nanoid } from "nanoid";
import { supabaseAdmin } from "@/lib/supabase/admin";
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
  orderCalendarsForSync,
  pastDeadline,
  shouldRerun,
  CALENDAR_CLAIM_TTL_MS,
  MAX_SYNC_PASSES,
} from "@/lib/google/sync-coalesce";
import {
  toSyncAgents,
  type SyncAgent,
  type SyncCandidateRow,
} from "@/lib/google/sync-pace";
import { stampLastSynced, type SyncWritesDb } from "@/lib/google/sync-writes";
import {
  nextSyncState,
  type CalSyncHealth,
  type SyncOutcome,
} from "@/lib/google/sync-health";
import {
  dedupeFailingAgents,
  type FailingAgent,
  type FailingCalendarRow,
} from "@/lib/notify/alerts";
import { googlePushUrl } from "@/lib/env";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import { findExternalCollisions } from "@/lib/google/collision";
import type { AgentCalendar } from "@/lib/db/types";
import { log } from "@/lib/log";

const BOOTSTRAP_LOOKBACK_MS = 24 * 60 * 60 * 1000;
// Renew well before Google's ~7-day watch TTL so a cron outage can't drop push.
const WATCH_RENEW_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000;
// External-double-book detection (#316): only future bookings can be
// double-booked, so scan a forward window; alert at most this often per agent.
const COLLISION_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const COLLISION_ALERT_COOLDOWN_MS = 30 * 60 * 1000;

async function loadAgentEmail(userId: string): Promise<string | null> {
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

async function loadAgentCalendars(userId: string): Promise<AgentCalendar[]> {
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
    const { data: bookingRows } = await db
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

    const { data: blockRows } = await db
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
      startMs: Date.parse(b.starts_at),
      endMs: Date.parse(b.ends_at),
    }));

    const collisions = findExternalCollisions(
      blocks,
      bookings.map((b) => ({
        id: b.id,
        gcalEventId: b.gcal_event_id,
        startMs: Date.parse(b.starts_at),
        endMs: Date.parse(b.ends_at),
      })),
    );
    if (collisions.length === 0) return;

    const ids = collisions.map((c) => c.bookingId).join(", ");
    await sendThrottledAlert(
      `external_double_book:${userId}`,
      COLLISION_ALERT_COOLDOWN_MS,
      `Slate: possible external double-book for ${email}. ${collisions.length} active Slate booking(s) overlap a Google event booked outside Slate (booking ids: ${ids}). Check the agent's calendar and reschedule one side.`,
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
  const { data: users } = await db
    .from("users")
    .select("id, last_synced_at, deactivated_at")
    .eq("bookable", true)
    .is("deactivated_at", null);
  const rows = (users ?? []) as SyncCandidateRow[];
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const { data: cals } = await db
    .from("agent_calendars")
    .select("user_id")
    .in("user_id", ids);
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
 * Agents whose calendars are PERSISTENTLY failing (#273): one entry per agent,
 * worst calendar kept, for the named alert. `minFailures` matches the
 * consecutive-failure threshold so a transient one-off blip stays quiet.
 */
export async function loadFailingAgents(minFailures = 2): Promise<FailingAgent[]> {
  const db = supabaseAdmin();
  // Two reads joined in code (the codebase convention, cf. loadSyncAgents):
  // the failing calendars, then the users they belong to.
  const { data: cals } = await db
    .from("agent_calendars")
    .select("user_id, consecutive_failures, last_success_at, last_sync_error")
    .gte("consecutive_failures", minFailures);
  const calRows = (cals ?? []) as {
    user_id: string;
    consecutive_failures: number;
    last_success_at: string | null;
    last_sync_error: string | null;
  }[];
  if (calRows.length === 0) return [];

  const { data: users } = await db
    .from("users")
    .select("id, email, bookable, deactivated_at")
    .in("id", [...new Set(calRows.map((c) => c.user_id))]);
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
      email: u?.email ?? null,
      bookable: u?.bookable ?? false,
      deactivated_at: u?.deactivated_at ?? null,
    };
  });
  return dedupeFailingAgents(rows);
}

// Cap rows per DB call so even a huge calendar's bootstrap stays well under the
// Worker's per-request subrequest ceiling (the old one-write-per-event loop did
// 1,000+ serial calls and got killed mid-sync; see partitionBusyWrites).
const WRITE_CHUNK = 500;

/**
 * Event ids of this agent's active Slate bookings (#166) — the Google events
 * Slate created itself. The sync skips these so a Slate booking isn't mirrored
 * into a second source=gcal block alongside its own source=slate block (the
 * double-count). Matched by the booking's stored gcal_event_id (exact, not a
 * name heuristic), so there are no false skips of externally-booked events.
 */
async function loadSlateBookingEventIds(userId: string): Promise<Set<string>> {
  const { data } = await supabaseAdmin()
    .from("bookings")
    .select("gcal_event_id")
    .eq("assigned_user_id", userId)
    .in("status", ["confirmed", "rescheduled"])
    .not("gcal_event_id", "is", null);
  return new Set(
    ((data ?? []) as { gcal_event_id: string | null }[])
      .map((r) => r.gcal_event_id)
      .filter((id): id is string => !!id),
  );
}

/** Upsert/delete gcal-sourced busy blocks for a batch of events on one calendar. */
async function applyEvents(
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
  for (let i = 0; i < upserts.length; i += WRITE_CHUNK) {
    const { error } = await db
      .from("busy_blocks")
      .upsert(upserts.slice(i, i + WRITE_CHUNK), {
        onConflict: "user_id,gcal_event_id",
      });
    if (error) throw new Error(`busy_blocks bulk upsert failed: ${error.message}`);
  }
  for (let i = 0; i < deletes.length; i += WRITE_CHUNK) {
    const { error } = await db
      .from("busy_blocks")
      .delete()
      .eq("user_id", userId)
      .in("gcal_event_id", deletes.slice(i, i + WRITE_CHUNK));
    if (error) throw new Error(`busy_blocks bulk delete failed: ${error.message}`);
  }
}

/**
 * After a FULL resync, drop cached gcal blocks for this calendar whose event no
 * longer exists. Incremental syncs carry per-event cancellations, but a full
 * resync (bootstrap or expired token) just returns the current set, so events
 * deleted while the token was stale would otherwise linger and over-block.
 */
async function purgeVanished(
  userId: string,
  calendarId: string,
  events: GoogleEvent[],
  slateEventIds: Set<string>,
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
  const { data } = await db
    .from("busy_blocks")
    .select("id, gcal_event_id")
    .eq("user_id", userId)
    .eq("calendar_id", calendarId)
    .eq("source", "gcal");
  const stale = staleBlockIds(
    (data ?? []) as { id: string; gcal_event_id: string | null }[],
    seen,
  );
  if (stale.length) {
    await db.from("busy_blocks").delete().in("id", stale);
  }
}

/** The current diagnostics snapshot for a calendar (#273). */
function healthOf(cal: AgentCalendar): CalSyncHealth {
  return {
    consecutive_failures: cal.consecutive_failures,
    last_success_at: cal.last_success_at,
    last_sync_error: cal.last_sync_error,
  };
}

/**
 * Persist the next diagnostics state for one calendar, plus any extra columns
 * (sync_token, watch fields) written in the same update. Never throws - a
 * diagnostics write must not break or mask the sync/watch it describes.
 */
async function recordCalHealth(
  calId: string,
  prev: CalSyncHealth,
  outcome: SyncOutcome,
  extra: Record<string, unknown> = {},
): Promise<void> {
  try {
    await supabaseAdmin()
      .from("agent_calendars")
      .update({ ...nextSyncState(prev, outcome, new Date().toISOString()), ...extra })
      .eq("id", calId);
  } catch (err) {
    log.error("sync", { msg: "recordCalHealth failed", cal_id: calId }, err);
  }
}

/** Sync one calendar's changes into busy_blocks; advances its stored sync token. */
async function syncCalendar(
  email: string,
  cal: AgentCalendar,
  timeZone: string,
): Promise<number> {
  const bootstrapMin = new Date(
    Date.now() - BOOTSTRAP_LOOKBACK_MS,
  ).toISOString();
  const prev = healthOf(cal);

  try {
    let result;
    let full = !cal.sync_token; // bootstrap (no token) is a full sync
    try {
      result = await syncEvents(email, cal.calendar_id, cal.sync_token, bootstrapMin);
    } catch (err: unknown) {
      if (err instanceof SyncTokenExpired) {
        full = true;
        result = await syncEvents(email, cal.calendar_id, null, bootstrapMin);
      } else {
        throw err;
      }
    }

    // The agent's own Slate-booking event ids, so the sync skips mirroring them
    // into a duplicate gcal block (#166). Only load when there's something to
    // apply — the common incremental tick has no events, so it skips the query.
    const slateEventIds =
      result.events.length > 0
        ? await loadSlateBookingEventIds(cal.user_id)
        : new Set<string>();
    await applyEvents(cal.user_id, cal.calendar_id, result.events, slateEventIds, timeZone);
    if (full)
      await purgeVanished(cal.user_id, cal.calendar_id, result.events, slateEventIds);

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
    await recordCalHealth(cal.id, prev, { ok: true });
    return result.events.length;
  } catch (err) {
    // Record the failure (streak + message) before rethrowing so the per-agent
    // error handling + alert still fire and the cache never drifts silently.
    await recordCalHealth(cal.id, prev, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Pulls calendar changes into busy_blocks across an agent's calendars.
 * `deadlineMs` (#44) stops STARTING new calendars once the tick budget is
 * spent - incrementals run first, bootstraps last - and reports truncation;
 * sync tokens make the next invocation resume where this one stopped.
 */
export async function runIncrementalSync(
  userId: string,
  deadlineMs: number | null = null,
): Promise<{ events: number; truncated: boolean }> {
  const email = await loadAgentEmail(userId);
  if (!email) return { events: 0, truncated: false };
  const timeZone = await loadAgentTimezone(userId);
  const cals = orderCalendarsForSync(await loadAgentCalendars(userId));
  let events = 0;
  for (let i = 0; i < cals.length; i++) {
    if (pastDeadline(Date.now(), deadlineMs)) {
      return { events, truncated: true };
    }
    events += await syncCalendar(email, cals[i], timeZone);
  }
  return { events, truncated: false };
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
      const { data: fresh } = await db
        .from("agent_calendars")
        .select("*")
        .eq("id", cal.id)
        .maybeSingle();
      if (!fresh) break;
      await syncCalendar(email, fresh as AgentCalendar, timeZone);
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
  // bucket they affect so it shows up in <5s. Best-effort (debounced per bucket;
  // the 1-min cron backstop guarantees it regardless).
  void recomputeBucketsForAgent(cal.user_id).catch(() => {});
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
  const dueForRenewal = (c: AgentCalendar) =>
    !c.watch_expiration ||
    Date.parse(c.watch_expiration) - Date.now() < WATCH_RENEW_THRESHOLD_MS;
  if (existing.length > 0 && !existing.some(dueForRenewal)) {
    return { status: "current" };
  }

  try {
    const db = supabaseAdmin();
    // Reconcile the stored calendar set with what the agent actually has.
    // calendarList.list needs the calendar.readonly scope; if the domain-wide
    // delegation doesn't grant it yet (403), fall back to just the primary
    // calendar (works with calendar.events) so sync keeps running. Full
    // multi-calendar activates automatically once the scope is granted.
    let wanted: string[];
    try {
      wanted = selectableCalendarIds(await listCalendars(email));
    } catch {
      wanted = ["primary"];
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
      if (c.watch_channel_id && c.watch_resource_id) {
        await stopChannel(email, c.watch_channel_id, c.watch_resource_id).catch(() => {});
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
      const prev = healthOf(cal);
      try {
        if (cal.watch_channel_id && cal.watch_resource_id) {
          await stopChannel(email, cal.watch_channel_id, cal.watch_resource_id).catch(() => {});
        }
        const channelId = nanoid();
        const { resourceId, expiration } = await watchCalendar(
          email,
          cal.calendar_id,
          channelId,
        );
        await recordCalHealth(cal.id, prev, { ok: true }, {
          watch_channel_id: channelId,
          watch_resource_id: resourceId,
          watch_expiration: expiration,
        });
        renewed = true;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        if (firstError === null) firstError = error;
        await recordCalHealth(cal.id, prev, { ok: false, error });
        // keep going - the agent's other calendars still need their watches.
      }
    }
    if (firstError !== null) return { status: "error", error: firstError };
    return renewed ? { status: "renewed" } : { status: "current" };
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : String(err) };
  }
}
